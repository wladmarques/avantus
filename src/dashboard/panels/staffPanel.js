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

/**
 * Linha do bloco EQUIPE: nome + horário da escala.
 *
 * O rótulo de status (DISPONÍVEL/INDISPONÍVEL) saiu do painel — o grupo onde a
 * pessoa aparece já diz se ela está de serviço. No lugar entra o horário da
 * escala (`hoje 14:00 às 22:00`, `amanhã 22:00 às 02:00`, `sem escala`).
 * Só dois complementos continuam aparecendo, porque não são disponibilidade:
 * `em atendimento` (está com um jogador) e `bloqueado` (punição da staff).
 */
function staffMemberLine(entry, escalas) {
  const { label: escala } = escalaOf(entry, escalas);
  const notes = [];
  if (entry.status === STAFF_STATUS.EM_ATENDIMENTO) notes.push('em atendimento');
  if (entry.blocked) notes.push('bloqueado');
  return `<@${entry.userId}> — ${escala}${notes.length ? ` • ${notes.join(' • ')}` : ''}`;
}

/** Chave de ordenação de quem não tem turno: vai sempre para o fim da lista. */
const SEM_ESCALA_KEY = Number.POSITIVE_INFINITY;

/**
 * Resumo da escala do staff: `{ label, sortKey }`.
 *
 * Aceita tanto o objeto devolvido por `scheduleSummary()` quanto uma string
 * simples (`sortKey` infinito), para o painel continuar montável em testes e
 * em qualquer chamada antiga que passe só o texto.
 */
function escalaOf(entry, escalas) {
  const value =
    escalas && typeof escalas.get === 'function' ? escalas.get(entry.userId) : escalas?.[entry.userId];
  if (!value) return { label: 'sem escala', sortKey: SEM_ESCALA_KEY };
  if (typeof value === 'string') return { label: value, sortKey: SEM_ESCALA_KEY };
  const sortKey = Number.isFinite(value.sortKey) ? value.sortKey : SEM_ESCALA_KEY;
  return { label: value.label || 'sem escala', sortKey };
}

/**
 * Ordem da EQUIPE: **pelo horário da escala**, do turno mais cedo para o mais
 * tarde. Quem não tem escala vai para o fim. Status e id só desempatam (dois
 * staffs no mesmo horário mantêm uma ordem estável entre atualizações).
 */
function compareStaff(a, b, escalas) {
  const escalaA = escalaOf(a, escalas);
  const escalaB = escalaOf(b, escalas);
  if (escalaA.sortKey !== escalaB.sortKey) return escalaA.sortKey - escalaB.sortKey;
  const porStatus = (STAFF_STATUS_ORDER[a.status] ?? 9) - (STAFF_STATUS_ORDER[b.status] ?? 9);
  if (porStatus !== 0) return porStatus;
  return String(a.userId).localeCompare(String(b.userId));
}

function sortBySchedule(entries, escalas) {
  return [...entries].sort((a, b) => compareStaff(a, b, escalas));
}

/** Staff bloqueado pela administração nunca conta como "de serviço". */
function isOnDuty(entry) {
  return !entry.blocked && DUTY_STATUSES.has(entry.status);
}

function staffListLines(entries, emptyText, escalas) {
  if (entries.length === 0) return emptyText;
  const shown = entries.slice(0, MAX_STAFF_LISTED).map((entry) => staffMemberLine(entry, escalas));
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
 *
 * Dentro de cada grupo a lista segue a **ordem do horário da escala**: o turno
 * mais cedo vem primeiro (13:12 → 15:36 → 16:48 → 20:24 …). Quem está de turno
 * agora já começou, então aparece naturalmente no topo do grupo.
 */
function buildStaffBlock(staffList, escalas = null) {
  if (staffList.length === 0) return '_Nenhum staff registrado ainda._';

  const onDuty = sortBySchedule(
    staffList.filter(isOnDuty),
    escalas,
  );
  const offDuty = sortBySchedule(
    staffList.filter((entry) => !isOnDuty(entry)),
    escalas,
  );

  return [
    `**DE SERVIÇO (${onDuty.length})**`,
    staffListLines(onDuty, '_Ninguém de serviço agora._', escalas),
    '',
    `**FORA DE SERVIÇO (${offDuty.length})**`,
    staffListLines(offDuty, '_Todos de serviço._', escalas),
  ].join('\n');
}

/**
 * Painel exclusivo da equipe: visão completa da fila + controles.
 */
function buildStaffPanel({
  state,
  overview,
  schedule,
  todayWindow,
  now = new Date(),
  escalas = null,
}) {
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

  const staffBlock = buildStaffBlock(state.staffList, escalas);

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
