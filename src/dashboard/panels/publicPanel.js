'use strict';

/**
 * Painel público da central.
 *
 * Layout `modern` (Components V2): UM único card compacto, como a referência
 * visual da VANTUS — cabeçalho com ícone, status, indicadores lado a lado,
 * horário e uma faixa final com o botão principal à direita do texto.
 *
 * Layout `classic`: embed tradicional (fallback automático se a API do
 * Discord recusar Components V2).
 *
 * Tudo em JSON puro: os payloads podem ser testados sem conexão com o Discord.
 */
const { COLORS, BRAND } = require('../../config/theme');
const { publicPanelComponents } = require('../components/buttons');
const { formatDuration, formatTime, DAY_KEYS, tzParts } = require('../../utils/time');

/** MessageFlags.IsComponentsV2 */
const COMPONENTS_V2_FLAG = 32768;

const text = (content) => ({ type: 10, content });
const separator = (spacing = 1, divider = true) => ({ type: 14, divider, spacing });
const card = (accentColor, components) => ({ type: 17, accent_color: accentColor, components });
const button = (customId, label, style, emoji) => ({
  type: 2,
  style,
  custom_id: customId,
  label,
  ...(emoji ? { emoji: { name: emoji } } : {}),
});

const DAY_SHORT = { mon: 'Seg', tue: 'Ter', wed: 'Qua', thu: 'Qui', fri: 'Sex', sat: 'Sáb', sun: 'Dom' };

/** Linha de "chips": cada indicador vira um bloco de código com o valor em negrito. */
function statChips(state, available, estimate) {
  const chip = (label, value) => `\`${label}\` **${value}**`;
  return [
    chip('🎫 NA FILA', state.waiting.length),
    chip('🛡️ STAFFS DISPONÍVEIS', available),
    chip('📞 EM ATENDIMENTO', state.serving.length),
    chip('⏳ ESPERA MÉDIA', formatDuration(estimate)),
  ].join('   ');
}

/** Agrupa dias consecutivos com o mesmo horário: "Seg–Sex: 12:00 às 02:00". */
function describeScheduleCompact(schedule) {
  if (!schedule || typeof schedule !== 'object') return ['-# Não configurado'];

  const groups = [];
  let current = null;
  for (const key of DAY_KEYS.slice(1).concat(DAY_KEYS[0])) {
    const windows = Array.isArray(schedule[key]) ? schedule[key] : [];
    const label = windows.length
      ? windows.map((window) => `${window.open} às ${window.close}`).join(' / ')
      : 'fechado';
    if (current && current.label === label) current.days.push(key);
    else {
      current = { label, days: [key] };
      groups.push(current);
    }
  }

  return groups.map((group) => {
    const days = group.days;
    const first = DAY_SHORT[days[0]];
    const last = DAY_SHORT[days[days.length - 1]];
    const range = days.length === 1 ? first : `${first}–${last}`;
    return group.label === 'fechado'
      ? `-# **${range}:** fechado`
      : `-# **${range}:** ${group.label}`;
  });
}

/** Bloco de status: manchete curta, igual à referência. */
function statusBlock({ open, availableStaff, nextOpen }) {
  if (!open) {
    return [
      '**🔴 STATUS DA CENTRAL**',
      '## CENTRAL FECHADA',
      `-# ${nextOpen ? `Reabre ${nextOpen}.` : 'Confira os horários de atendimento abaixo.'}`,
    ].join('\n');
  }
  if (availableStaff > 0) {
    return [
      '**🟢 STATUS DA CENTRAL**',
      '## ATENDIMENTO DISPONÍVEL',
      `-# ${availableStaff} staff(s) disponível(is) para atender agora.`,
    ].join('\n');
  }
  return [
    '**🟡 STATUS DA CENTRAL**',
    '## AGUARDANDO STAFF',
    '-# Nenhum staff disponível agora; sua solicitação aguardará a equipe.',
  ].join('\n');
}

/**
 * Layout moderno (Components V2) — um único container compacto.
 * @returns {{payload: object, format: 'v2'}}
 */
function buildPublicPanelV2({ settings, state, schedule, iconUrl = null, now = new Date() }) {
  const open = schedule.open;
  const available = state.staffCounts.DISPONIVEL ?? 0;
  const estimate = settings.estimateWaitSeconds ?? 0;

  const subtitle = String(settings.message_panel_description || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((line) => `-# ${line}`)
    .join('\n');

  const header = {
    type: 9,
    components: [
      text(
        [
          `## ${settings.message_panel_title || BRAND.title}`,
          subtitle || `-# ${BRAND.footer} • Atualizado ${formatTime(now)}`,
        ].join('\n'),
      ),
    ],
    ...(iconUrl ? { accessory: { type: 11, media: { url: iconUrl } } } : {}),
  };

  const waitChannel = settings.wait_channel_id
    ? `Entre em <#${settings.wait_channel_id}> para aguardar atendimento. `
    : 'Entre no canal de voz de espera. ';
  const cooldownMinutes = Number(settings.rejoin_cooldown_minutes) || 0;
  let exitNote;
  if (settings.leave_queue_on_wait_exit === false) {
    exitNote = 'Sair do canal não remove você da fila.';
  } else if (cooldownMinutes > 0) {
    exitNote = `Sair da espera remove você da fila e bloqueia a reentrada por ${cooldownMinutes} min.`;
  } else {
    exitNote = 'Sair da espera remove você da fila.';
  }

  const footer = {
    type: 9,
    components: [
      text(
        [
          '**🎙️ Fila por canal de voz**',
          `-# ${waitChannel}Você será movido automaticamente quando um staff estiver disponível. ${exitNote}`,
        ].join('\n'),
      ),
    ],
    accessory: button('pub:join', 'Entrar na Fila', 3, '🎟️'),
  };

  const extras = open
    ? {
        type: 1,
        components: [
          button('pub:status', 'Minha posição', 2, '📊'),
          button('pub:leave', 'Sair da fila', 2, '🚪'),
        ],
      }
    : null;

  const components = [
    header,
    separator(2),
    text(statusBlock({ open, availableStaff: available, nextOpen: schedule.nextOpen })),
    text(statChips(state, available, estimate)),
    separator(1),
    text(
      ['**🗓️ HORÁRIO DE ATENDIMENTO**', ...describeScheduleCompact(schedule.schedule)].join('\n'),
    ),
    separator(1),
    footer,
    ...(extras ? [extras] : []),
  ];

  return {
    format: 'v2',
    payload: {
      flags: COMPONENTS_V2_FLAG,
      components: [card(open ? COLORS.ORANGE : COLORS.MUTED, components)],
    },
  };
}

/**
 * Layout clássico (embed) — usado como fallback.
 * @returns {{payload: object, format: 'embed'}}
 */
function buildPublicPanelClassic({ settings, state, schedule, todayWindow, now = new Date() }) {
  const open = schedule.open;
  const available = state.staffCounts.DISPONIVEL ?? 0;
  const estimate = settings.estimateWaitSeconds ?? 0;

  const fields = [
    { name: '📊 STATUS DA CENTRAL', value: open ? '🟢 **ABERTA**' : '📕 **FECHADA**', inline: true },
    { name: '🎫 NA FILA', value: `**${state.waiting.length}** jogador(es)`, inline: true },
    { name: '🛡️ STAFFS DISPONÍVEIS', value: `**${available}** em serviço`, inline: true },
    { name: '📞 EM ATENDIMENTO', value: `**${state.serving.length}** ativo(s)`, inline: true },
    { name: '⏳ ESPERA MÉDIA', value: `**${formatDuration(estimate)}**`, inline: true },
    { name: '⏰ HORÁRIO DE ATENDIMENTO', value: `**${todayWindow?.text ?? '—'}**`, inline: true },
  ];

  const embed = {
    color: open ? COLORS.ORANGE : COLORS.MUTED,
    title: settings.message_panel_title || BRAND.title,
    description: [
      settings.message_panel_description,
      open ? null : `\n🔒 **Central fechada**${schedule.nextOpen ? ` • reabre ${schedule.nextOpen}` : ''}`,
    ]
      .filter(Boolean)
      .join('\n'),
    fields,
    footer: { text: `${BRAND.footer} • Atualizado ${formatTime(now)}` },
    timestamp: now.toISOString(),
  };

  return { format: 'embed', payload: { embeds: [embed], components: publicPanelComponents() } };
}

/**
 * Escolhe o layout conforme a configuração (com fallback automático).
 * @param {'modern'|'classic'} style
 */
function buildPublicPanel(context) {
  const style = context.style === 'classic' ? 'classic' : 'modern';
  return style === 'classic' ? buildPublicPanelClassic(context) : buildPublicPanelV2(context);
}

module.exports = {
  COMPONENTS_V2_FLAG,
  buildPublicPanel,
  buildPublicPanelV2,
  buildPublicPanelClassic,
  describeScheduleCompact,
  statChips,
};
