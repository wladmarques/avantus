'use strict';

const {
  COLORS,
  BRAND,
  ATTENDANCE_STATUS,
  OUTCOME_LABELS,
  STAFF_STATUS,
} = require('../../config/theme');
const { staffPanelComponents } = require('../components/buttons');
const { formatTime, formatDuration, formatDurationShort, DAY_LABELS } = require('../../utils/time');

const MAX_LISTED = 10;
// Limite do bloco EQUIPE: 20 membros por grupo mantém o embed longe do teto
// de 4096 caracteres da descrição mesmo com a equipe inteira registrada.
const MAX_STAFF_LISTED = 20;

/** Status que contam como "de serviço" (o staff está trabalhando agora). */
const DUTY_STATUSES = new Set([STAFF_STATUS.DISPONIVEL, STAFF_STATUS.EM_ATENDIMENTO]);

/** Ordem de exibição dentro de cada grupo: disponível → atendendo → ausente → indisponível. */
const STAFF_STATUS_ORDER = {
  [STAFF_STATUS.DISPONIVEL]: 0,
  [STAFF_STATUS.EM_ATENDIMENTO]: 1,
  [STAFF_STATUS.AUSENTE]: 2,
  [STAFF_STATUS.INDISPONIVEL]: 3,
};

function queueLine(entry) {
  return [
    `**#${String(entry.position).padStart(2, '0')} — ${entry.username}**`,
    `Protocolo: \`#${String(entry.protocol).padStart(4, '0')}\` • Entrada: ${formatTime(new Date(entry.joined_at))}`,
    `Espera: ${formatDuration(entry.waitingSeconds)} • Status: AGUARDANDO${
      entry.order_override ? ' • fora da ordem' : ''
    }`,
  ].join('\n');
}

function servingLine(entry, staffList) {
  const staff = staffList.find((item) => item.userId === entry.staff_id);
  return [
    `**${entry.username}** — protocolo \`#${String(entry.protocol).padStart(4, '0')}\``,
    `Staff: <@${entry.staff_id}>${staff ? '' : ' (desconectado)'} • Início: ${formatTime(
      new Date(entry.started_at ?? Date.now()),
    )} • Duração: ${formatDuration(entry.servingSeconds)}`,
    entry.presence_confirmed
      ? 'Presença: confirmada no canal'
      : 'Presença: aguardando entrar no canal',
  ].join('\n');
}

function staffMemberLine(entry) {
  const label = entry.blocked
    ? 'BLOQUEADO'
    : entry.status === STAFF_STATUS.EM_ATENDIMENTO
      ? 'EM ATENDIMENTO'
      : entry.meta.label;
  return `<@${entry.userId}> — **${label}**`;
}

/** Staff bloqueado pela administração nunca conta como "de serviço". */
function isOnDuty(entry) {
  return !entry.blocked && DUTY_STATUSES.has(entry.status);
}

function staffListLines(entries, emptyText) {
  if (entries.length === 0) return emptyText;
  const shown = entries.slice(0, MAX_STAFF_LISTED).map(staffMemberLine);
  if (entries.length > MAX_STAFF_LISTED) {
    shown.push(`_… e mais ${entries.length - MAX_STAFF_LISTED} staff._`);
  }
  return shown.join('\n');
}

/**
 * EQUIPE separada em dois grupos visuais: quem está **de serviço** (disponível
 * ou em atendimento) e quem está **fora de serviço** (ausente, indisponível ou
 * bloqueado). Assim dá para ver de relance quem está trabalhando agora, sem
 * ler status por status numa lista única.
 */
function buildStaffBlock(staffList) {
  if (staffList.length === 0) return '_Nenhum staff registrado ainda._';

  const ordered = [...staffList].sort(
    (a, b) => (STAFF_STATUS_ORDER[a.status] ?? 9) - (STAFF_STATUS_ORDER[b.status] ?? 9),
  );
  const onDuty = ordered.filter(isOnDuty);
  const offDuty = ordered.filter((entry) => !isOnDuty(entry));

  return [
    `**DE SERVIÇO (${onDuty.length})**`,
    staffListLines(onDuty, '_Ninguém de serviço agora._'),
    '',
    `**FORA DE SERVIÇO (${offDuty.length})**`,
    staffListLines(offDuty, '_Todos de serviço._'),
  ].join('\n');
}

/**
 * Painel exclusivo da equipe: visão completa da fila + controles.
 */
function buildStaffPanel({ state, overview, schedule, todayWindow, now = new Date() }) {
  const waiting = state.waiting;
  const hold = state.hold;
  const serving = state.serving;

  const queueBlock =
    waiting.length === 0
      ? '_Nenhum jogador aguardando._'
      : waiting
          .slice(0, MAX_LISTED)
          .map(queueLine)
          .join('\n\n') +
        (waiting.length > MAX_LISTED
          ? `\n\n_… e mais ${waiting.length - MAX_LISTED} jogador(es)._`
          : '');

  const servingBlock =
    serving.length === 0 ? '_Nenhum atendimento em andamento._' : serving.map((entry) => servingLine(entry, state.staffList)).join('\n\n');

  const holdBlock =
    hold.length === 0
      ? null
      : hold
          .map(
            (entry) =>
              `**${entry.username}** • \`#${String(entry.protocol).padStart(4, '0')}\` • ${
                entry.hold_reason ?? 'sem motivo'
              }`,
          )
          .join('\n');

  const staffBlock = buildStaffBlock(state.staffList);

  const desc = [
    `**CENTRAL ${schedule.open ? 'ABERTA' : 'FECHADA'}** • ${formatTime(now)} • Hoje: ${todayWindow.text}`,
    '',
    '**FILA DE ESPERA**',
    queueBlock,
    '',
    '**EM ATENDIMENTO**',
    servingBlock,
    holdBlock ? '\n**PENDENTES**\n' + holdBlock : null,
    '',
    '**EQUIPE**',
    staffBlock,
  ]
    .filter((line) => line !== null)
    .join('\n');

  const fields = [
    { name: 'Aguardando', value: `**${waiting.length}**`, inline: true },
    { name: 'Em atendimento', value: `**${serving.length}**`, inline: true },
    { name: 'Disponíveis', value: `**${state.staffCounts.DISPONIVEL}**`, inline: true },
    { name: 'Ocupados', value: `**${state.staffCounts.EM_ATENDIMENTO}**`, inline: true },
    { name: 'Espera média', value: `**${formatDuration(state.avgWaitSeconds)}**`, inline: true },
    {
      name: 'Atendimento médio',
      value: `**${formatDuration(overview.avgDurationSeconds)}**`,
      inline: true,
    },
    { name: 'Hoje', value: `**${overview.concluded}** concluído(s)`, inline: true },
    {
      name: 'Avaliação',
      value: overview.evaluations ? `**${overview.avgRating.toFixed(2)}/4**` : '—',
      inline: true,
    },
    { name: 'Pendentes', value: `**${hold.length}**`, inline: true },
  ];

  const embed = {
    color: COLORS.ACCENT,
    title: 'PAINEL DA EQUIPE | VANTUS',
    description: desc,
    fields,
    footer: { text: `${BRAND.footer} • Painel restrito à equipe • Atualização automática` },
    timestamp: now.toISOString(),
  };

  return {
    embeds: [embed],
    components: staffPanelComponents({
      hasQueue: waiting.length > 0,
      hasServing: serving.length > 0,
      hasHold: hold.length > 0,
    }),
  };
}

/** Opções de select para os menus da staff. */
function queueSelectOptions(state, { mode = 'call' } = {}) {
  const waiting = state.waiting.slice(0, 25).map((entry) => ({
    label: `#${String(entry.position).padStart(2, '0')} • ${entry.username}`.slice(0, 100),
    description: `Protocolo #${String(entry.protocol).padStart(4, '0')} • esperando ${formatDurationShort(
      entry.waitingSeconds,
    )}`.slice(0, 100),
    value: String(entry.id),
  }));

  if (waiting.length > 0) return waiting;

  if (mode === 'call') return [];
  return [];
}

function servingSelectOptions(state) {
  return state.serving.slice(0, 25).map((entry) => ({
    label: `${entry.username} • #${String(entry.protocol).padStart(4, '0')}`.slice(0, 100),
    description: `Staff <@${entry.staff_id}> • ${formatDurationShort(entry.servingSeconds)}`.slice(0, 100),
    value: String(entry.id),
  }));
}

function holdSelectOptions(state) {
  return state.hold.slice(0, 25).map((entry) => ({
    label: `${entry.username} • #${String(entry.protocol).padStart(4, '0')}`.slice(0, 100),
    description: `Motivo: ${entry.hold_reason ?? 'não informado'}`.slice(0, 100),
    value: String(entry.id),
  }));
}

module.exports = {
  buildStaffPanel,
  queueSelectOptions,
  servingSelectOptions,
  holdSelectOptions,
  MAX_LISTED,
};
