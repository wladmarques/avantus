'use strict';

/**
 * Painel público da central.
 *
 * Dois layouts:
 *  - `modern`  → Components V2 (cards com barra de destaque, separadores e botões),
 *                igual à referência visual da VANTUS.
 *  - `classic` → embed tradicional (fallback automático se a API do Discord
 *                recusar Components V2).
 *
 * Tudo em JSON puro: os payloads podem ser testados sem conexão com o Discord.
 */
const { COLORS, BRAND } = require('../../config/theme');
const { publicPanelComponents } = require('../components/buttons');
const { formatDuration, formatTime, DAY_KEYS } = require('../../utils/time');

/** MessageFlags.IsComponentsV2 */
const COMPONENTS_V2_FLAG = 32768;

const text = (content) => ({ type: 10, content });
const separator = (spacing = 1, divider = true) => ({ type: 14, divider, spacing });
const card = (accentColor, components) => ({ type: 17, accent_color: accentColor, components });
const thumbnailAccessory = (url) => ({ type: 11, media: { url } });

const STAT_COLORS = [COLORS.ORANGE, COLORS.PURPLE, COLORS.PINK, COLORS.INFO];

const DAY_SHORT = {
  mon: 'Seg',
  tue: 'Ter',
  wed: 'Qua',
  thu: 'Qui',
  fri: 'Sex',
  sat: 'Sáb',
  sun: 'Dom',
};

/** Agrupa dias consecutivos com o mesmo horário: "Seg–Sex: 12:00 às 02:00". */
function describeScheduleCompact(schedule) {
  if (!schedule || typeof schedule !== 'object') return ['Não configurado'];

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

  // Reordena os grupos na ordem da semana (segunda → domingo)
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

function statusBlock({ open, availableStaff, nextOpen }) {
  if (!open) {
    return [
      '**STATUS DA CENTRAL**',
      '## 🔴 CENTRAL FECHADA',
      `-# ${nextOpen ? `Reabre ${nextOpen}.` : 'Confira os horários abaixo.'}`,
    ].join('\n');
  }
  const note =
    availableStaff > 0
      ? `${availableStaff} staff(s) disponível(is) para atender agora.`
      : 'Nenhum staff disponível agora; sua solicitação aguardará a disponibilidade da equipe.';
  return ['**STATUS DA CENTRAL**', '## 🟢 FILA ABERTA', `-# ${note}`].join('\n');
}

/**
 * Layout moderno (Components V2).
 * @returns {{payload: object, format: 'v2'}}
 */
function buildPublicPanelV2({ settings, state, schedule, iconUrl = null, now = new Date() }) {
  const open = schedule.open;
  const available = state.staffCounts.DISPONIVEL ?? 0;
  const estimate = settings.estimateWaitSeconds ?? 0;

  const header = card(open ? COLORS.ORANGE : COLORS.MUTED, [
    {
      type: 9,
      components: [
        text(
          [
            `## ${settings.message_panel_title || BRAND.title}`,
            `-# ${BRAND.footer} • Atualizado ${formatTime(now, undefined)}`,
          ].join('\n'),
        ),
      ],
      ...(iconUrl ? { accessory: thumbnailAccessory(iconUrl) } : {}),
    },
    separator(2),
    text(settings.message_panel_description),
  ]);

  const status = card(open ? COLORS.PURPLE : COLORS.MUTED, [
    text(statusBlock({ open, availableStaff: available, nextOpen: schedule.nextOpen })),
  ]);

  const stats = [
    card(STAT_COLORS[0], [text(`**🎫 NA FILA**\n## ${state.waiting.length}`)]),
    card(STAT_COLORS[1], [text(`**🛡️ STAFFS DISPONÍVEIS**\n## ${available}`)]),
    card(STAT_COLORS[2], [text(`**📞 EM ATENDIMENTO**\n## ${state.serving.length}`)]),
    card(STAT_COLORS[3], [text(`**⏳ ESPERA MÉDIA**\n## ${formatDuration(estimate)}`)]),
  ];

  const scheduleCard = card(COLORS.ORANGE, [
    text(['**🗓️ HORÁRIO DE ATENDIMENTO**', ...describeScheduleCompact(schedule.schedule)].join('\n')),
  ]);

  const waitChannel = settings.wait_channel_id
    ? `Entre em <#${settings.wait_channel_id}> para aguardar atendimento. `
    : 'Entre no canal de voz de espera. ';

  const actionCard = card(open ? COLORS.SUCCESS : COLORS.MUTED, [
    text('**🎙️ Fila por canal de voz**'),
    text(
      `-# ${waitChannel}Você será movido automaticamente quando um staff te chamar. ` +
        'Sair da fila remove você do atendimento.',
    ),
    ...publicPanelComponents(),
  ]);

  return {
    format: 'v2',
    payload: {
      flags: COMPONENTS_V2_FLAG,
      components: [header, status, ...stats, scheduleCard, actionCard],
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
    {
      name: '⏰ HORÁRIO DE ATENDIMENTO',
      value: `**${todayWindow?.text ?? '—'}**`,
      inline: true,
    },
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
};
