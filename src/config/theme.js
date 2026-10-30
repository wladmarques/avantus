'use strict';

/**
 * Paleta da identidade visual da VANTUS (referência dos painéis).
 * Superfícies pretas/cinza-escuro com destaque em vermelho.
 */
const PALETTE = {
  INK: 0x090a0b, // fundo da página/mensagem
  BLACK: 0x000000, // corpo do container do painel
  SURFACE: 0x1a1b1d, // cards internos e botões
  BORDER: 0x252629, // bordas e divisórias
  TEXT: 0xe6e6e6, // texto principal
  MUTED: 0xacaeb1, // texto secundário
  RED: 0xff2200, // destaque da marca
  RED_DEEP: 0xd31e03, // vermelho profundo (realce/hover)
};

const COLORS = {
  /** Destaque principal dos painéis (barra lateral, embeds e títulos). */
  ACCENT: PALETTE.RED,
  ORANGE: 0xff7a18,
  PINK: 0xff2d95,
  PURPLE: 0x8b5cf6,
  DARK: 0x12121a,
  SUCCESS: 0x22c55e,
  WARNING: 0xf0b429,
  DANGER: 0xef4444,
  MUTED: 0x6b7280,
  INFO: 0x38bdf8,
};

const BRAND = {
  name: 'VANTUS',
  title: '🎧 ATENDIMENTO | VANTUS',
  footer: 'VANTUS • Central de Atendimento',
  icon: '🎧',
};

const EMOJI = {
  queue: '🎫',
  leave: '❌',
  call: '📞',
  pick: '👤',
  skip: '⏭️',
  back: '🔄',
  finish: '✅',
  remove: '🚫',
  refresh: '🔄',
  status: '📊',
  protocol: '🆔',
  clock: '⏰',
  wait: '⏳',
  staff: '🛡️',
  ping: '🔔',
  check: '✅',
  error: '⛔',
  warn: '⚠️',
  star: '⭐',
};

/** Status de disponibilidade dos staffs */
const STAFF_STATUS = {
  DISPONIVEL: 'DISPONIVEL',
  EM_ATENDIMENTO: 'EM_ATENDIMENTO',
  AUSENTE: 'AUSENTE',
  INDISPONIVEL: 'INDISPONIVEL',
};

const STAFF_STATUS_META = {
  [STAFF_STATUS.DISPONIVEL]: { label: 'DISPONÍVEL', emoji: '🟢', color: COLORS.SUCCESS },
  [STAFF_STATUS.EM_ATENDIMENTO]: { label: 'EM ATENDIMENTO', emoji: '🔴', color: COLORS.DANGER },
  [STAFF_STATUS.AUSENTE]: { label: 'AUSENTE', emoji: '🟡', color: COLORS.WARNING },
  [STAFF_STATUS.INDISPONIVEL]: { label: 'INDISPONÍVEL', emoji: '⚫', color: COLORS.MUTED },
};

/** Resultados possíveis de um atendimento */
const OUTCOMES = {
  CONCLUIDO: 'ATENDIMENTO_CONCLUIDO',
  DESISTIU: 'JOGADOR_DESISTIU',
  DESCONECTOU: 'JOGADOR_DESCONECTOU',
  STAFF_DESCONECTOU: 'STAFF_DESCONECTOU',
  CANCELADO: 'ATENDIMENTO_CANCELADO',
  REMOVIDO: 'JOGADOR_REMOVIDO',
  NAO_COMPARECEU: 'JOGADOR_NAO_COMPARECEU',
};

const OUTCOME_LABELS = {
  [OUTCOMES.CONCLUIDO]: '✅ ATENDIMENTO CONCLUÍDO',
  [OUTCOMES.DESISTIU]: '🚪 JOGADOR DESISTIU',
  [OUTCOMES.DESCONECTOU]: '🔌 JOGADOR DESCONECTOU',
  [OUTCOMES.STAFF_DESCONECTOU]: '🛡️ STAFF DESCONECTOU',
  [OUTCOMES.CANCELADO]: '🚫 ATENDIMENTO CANCELADO',
  [OUTCOMES.REMOVIDO]: '⛔ JOGADOR REMOVIDO',
  [OUTCOMES.NAO_COMPARECEU]: '⌛ JOGADOR NÃO COMPARECEU',
};

/** Status internos da fila/atendimento */
const ATTENDANCE_STATUS = {
  WAITING: 'waiting', // na fila, aguardando
  HOLD: 'hold', // pulado / pendente (fora da fila ativa)
  SERVING: 'serving', // em atendimento
  FINISHED: 'finished', // encerrado (com outcome)
};

const RATING_META = {
  MUITO_BOM: { label: 'Muito bom', emoji: '⭐', color: COLORS.SUCCESS, score: 4 },
  BOM: { label: 'Bom', emoji: '⭐', color: COLORS.INFO, score: 3 },
  REGULAR: { label: 'Regular', emoji: '⭐', color: COLORS.WARNING, score: 2 },
  RUIM: { label: 'Ruim', emoji: '⭐', color: COLORS.DANGER, score: 1 },
};

module.exports = {
  PALETTE,
  COLORS,
  BRAND,
  EMOJI,
  STAFF_STATUS,
  STAFF_STATUS_META,
  OUTCOMES,
  OUTCOME_LABELS,
  ATTENDANCE_STATUS,
  RATING_META,
};
