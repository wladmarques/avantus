'use strict';

/**
 * Painel público da central.
 *
 * Layout `modern` (Components V2): um único container escuro com barra de
 * destaque laranja, cabeçalho compacto, bloco de status, indicadores, faixa de
 * horário e rodapé com o botão "Entrar na Fila" à direita.
 *
 * Limitação da API do Discord: containers não podem ser aninhados nem
 * organizados em colunas — por isso os 4 indicadores aparecem em uma linha
 * compacta em vez de 4 cards lado a lado (o layout de referência completo está
 * disponível em `npm run preview:panel`).
 *
 * Layout `classic`: embed tradicional (fallback automático).
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
const button = (customId, label, style, emoji, disabled = false) => ({
  type: 2,
  style,
  custom_id: customId,
  label,
  disabled,
  ...(emoji ? { emoji: { name: emoji } } : {}),
});

const DAY_SHORT = { mon: 'Seg', tue: 'Ter', wed: 'Qua', thu: 'Qui', fri: 'Sex', sat: 'Sáb', sun: 'Dom' };

/** Ícone do cabeçalho: usa o do título quando já existe, senão adiciona o headset. */
function titleWithIcon(title) {
  const value = String(title || BRAND.title).trim();
  // Mantém o emoji do título quando ele já começa com um.
  const startsWithEmoji = /^[\p{Extended_Pictographic}]/u.test(value);
  return startsWithEmoji ? value : `🎧 ${value}`;
}

/** Espera média no formato curto usado no painel: "0 min", "8 min", "45s". */
function formatEstimate(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value === 0) return '0 min';
  if (value < 60) return `${value}s`;
  return `${Math.round(value / 60)} min`;
}

/**
 * Indicadores em uma linha compacta: rótulo em negrito + valor.
 * Sem emojis e sem etiquetas de código — segue o visual minimalista.
 */
function statLine(state, available, estimate) {
  const item = (label, value) => `**${label}** ${value}`;
  return [
    item('NA FILA', state.waiting.length),
    item('STAFFS DISPONÍVEIS', available),
    item('EM ANDAMENTO', state.serving.length),
    item('ESPERA MÉDIA', formatEstimate(estimate)),
  ].join('  •  ');
}

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

  return groups.map((group) => {
    const days = group.days;
    const first = DAY_SHORT[days[0]];
    const last = DAY_SHORT[days[days.length - 1]];
    const range = days.length === 1 ? first : `${first}–${last}`;
    return { range, label: group.label };
  });
}

/**
 * Bloco de status: rótulo pequeno com indicador + manchete em destaque.
 * @returns {{indicator: string, headline: string, note: string}}
 */
function statusInfo({ open, availableStaff, nextOpen }) {
  if (!open) {
    return {
      indicator: '🔴',
      headline: 'ATENDIMENTO INDISPONÍVEL',
      note: nextOpen ? `Central fechada • reabre ${nextOpen}` : 'Central fechada no momento',
    };
  }
  if (availableStaff > 0) {
    return {
      indicator: '🟢',
      headline: 'ATENDIMENTO DISPONÍVEL',
      note: `${availableStaff} staff(s) disponível(is) para atender`,
    };
  }
  return {
    indicator: '🟡',
    headline: 'ATENDIMENTO INDISPONÍVEL',
    note: 'Fila aberta • aguardando staff disponível',
  };
}

/**
 * Layout moderno (Components V2).
 * @returns {{payload: object, format: 'v2'}}
 */
function buildPublicPanelV2({ settings, state, schedule, now = new Date() }) {
  const open = schedule.open;
  const available = state.staffCounts.DISPONIVEL ?? 0;
  const estimate = settings.estimateWaitSeconds ?? 0;
  const status = statusInfo({ open, availableStaff: available, nextOpen: schedule.nextOpen });
  // Entrar na fila só é possível com a central aberta E com staff disponível.
  const canJoin = Boolean(open) && available > 0;
  const unavailableNote = !open
    ? schedule.nextOpen
      ? `central fechada • reabre ${schedule.nextOpen}`
      : 'central fechada'
    : 'sem staff em serviço';

  const description = String(settings.message_panel_description || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2);

  const waitChannel = settings.wait_channel_id
    ? `Entre em <#${settings.wait_channel_id}> para aguardar atendimento. `
    : 'Entre no canal de voz de espera. ';
  const cooldownMinutes = Number(settings.rejoin_cooldown_minutes) || 0;
  const exitNote =
    cooldownMinutes > 0
      ? `Sair da espera remove você da fila e bloqueia a reentrada por ${cooldownMinutes} min.`
      : 'Sair da espera remove você da fila.';

  const scheduleLines = describeScheduleCompact(schedule.schedule)
    .slice(0, 3)
    .map((entry) => `-# ${entry.range}: ${entry.label}`);

  const components = [
    // Cabeçalho compacto (sem avatar/thumbnail)
    text([`## ${titleWithIcon(settings.message_panel_title)}`, ...description.map((line) => `-# ${line}`)].join('\n')),
    separator(1),

    // Bloco de status
    text(
      [
        `-# ${status.indicator} STATUS DA CENTRAL`,
        `## ${status.headline}`,
        `-# ${status.note}`,
      ].join('\n'),
    ),

    // Indicadores (rótulos sem emoji)
    text(statLine(state, available, estimate)),

    // Faixa de horário
    text(['-# **HORÁRIO DE ATENDIMENTO:**', ...scheduleLines].join('\n')),

    // Divisor único, como na referência
    separator(2),

    // Rodapé: texto à esquerda, botão à direita
    {
      type: 9,
      components: [
        text(
          ['**🎧 Fila por canal de voz**', `-# ${waitChannel}Você será movido automaticamente quando houver staff disponível. ${exitNote}`].join('\n'),
        ),
      ],
      accessory: button('pub:join', 'Entrar na Fila', 2, '🎟️', !canJoin),
    },
    text(
      canJoin
        ? '-# Use `/sair` para desistir da fila e `/posicao` para ver a sua posição.'
        : `-# ⛔ Entrada na fila indisponível: ${unavailableNote}.`,
    ),
  ];

  return {
    format: 'v2',
    payload: {
      flags: COMPONENTS_V2_FLAG,
      components: [card(open ? COLORS.ACCENT : COLORS.MUTED, components)],
    },
  };
}

/**
 * Layout clássico (embed) — fallback.
 * @returns {{payload: object, format: 'embed'}}
 */
function buildPublicPanelClassic({ settings, state, schedule, todayWindow, now = new Date() }) {
  const open = schedule.open;
  const available = state.staffCounts.DISPONIVEL ?? 0;
  const estimate = settings.estimateWaitSeconds ?? 0;
  const status = statusInfo({ open, availableStaff: available, nextOpen: schedule.nextOpen });

  const fields = [
    { name: '📊 STATUS DA CENTRAL', value: `${status.indicator} ${status.headline}`, inline: false },
    { name: 'NA FILA', value: `**${state.waiting.length}**`, inline: true },
    { name: 'STAFFS DISPONÍVEIS', value: `**${available}**`, inline: true },
    { name: 'EM ANDAMENTO', value: `**${state.serving.length}**`, inline: true },
    { name: 'ESPERA MÉDIA', value: `**${formatEstimate(estimate)}**`, inline: true },
    { name: 'HORÁRIO DE ATENDIMENTO', value: `**${todayWindow?.text ?? '—'}**`, inline: false },
  ];

  const embed = {
    color: open ? COLORS.ACCENT : COLORS.MUTED,
    title: titleWithIcon(settings.message_panel_title),
    description: [
      settings.message_panel_description,
      open ? null : `\n🔒 ${status.note}`,
    ]
      .filter(Boolean)
      .join('\n'),
    fields,
    footer: { text: `${BRAND.footer} • Atualizado ${formatTime(now)}` },
    timestamp: now.toISOString(),
  };

  const canJoin = Boolean(open) && available > 0;
  return {
    format: 'embed',
    payload: { embeds: [embed], components: publicPanelComponents({ joinDisabled: !canJoin }) },
  };
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
  statLine,
  statusInfo,
  titleWithIcon,
  formatEstimate,
};
