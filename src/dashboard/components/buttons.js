'use strict';

/**
 * Fábricas de componentes (JSON puro) com IDs persistentes.
 * Os mesmos IDs continuam válidos após reiniciar o bot.
 */
const { RATING_META } = require('../../config/theme');

const STYLES = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4, LINK: 5 };

/** Estilo de cada nota (verde = nota boa, vermelho = nota ruim). */
const RATING_STYLES = {
  MUITO_BOM: STYLES.SUCCESS,
  BOM: STYLES.PRIMARY,
  REGULAR: STYLES.SECONDARY,
  RUIM: STYLES.DANGER,
};

function button(customId, label, { style = STYLES.SECONDARY, emoji = null, disabled = false } = {}) {
  const payload = { type: 2, custom_id: customId, style, label, disabled };
  if (emoji) payload.emoji = { name: emoji };
  return payload;
}

function actionRow(components) {
  return { type: 1, components };
}

function selectMenu(customId, placeholder, options, { minValues = 1, maxValues = 1, disabled = false } = {}) {
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: customId,
        placeholder,
        min_values: minValues,
        max_values: maxValues,
        disabled,
        options: options.slice(0, 25),
      },
    ],
  };
}

const IDs = {
  // painel público
  PUBLIC_JOIN: 'pub:join',
  PUBLIC_EVALUATE: 'pub:evaluate',
  PUBLIC_LEAVE: 'pub:leave',
  PUBLIC_STATUS: 'pub:status',
  // painel staff
  STAFF_CALL_NEXT: 'staff:call_next',
  STAFF_CALL_SPECIFIC: 'staff:call_specific',
  STAFF_SKIP: 'staff:skip',
  STAFF_RETURN: 'staff:return',
  STAFF_FINISH: 'staff:finish',
  STAFF_REMOVE: 'staff:remove',
  STAFF_REFRESH: 'staff:refresh',
  STAFF_MY_STATUS: 'staff:my_status',
  STAFF_REACTIVATE: 'staff:reactivate',
  STAFF_PANEL_OPEN: 'staff:panel',
  // selects
  SELECT_CALL: 'staff:select:call',
  SELECT_SKIP: 'staff:select:skip',
  SELECT_RETURN: 'staff:select:return',
  SELECT_FINISH: 'staff:select:finish',
  SELECT_REMOVE: 'staff:select:remove',
  SELECT_REACTIVATE: 'staff:select:reactivate',
  SELECT_STATUS: 'staff:select:status',
  // modais
  MODAL_SKIP: 'staff:modal:skip',
  MODAL_REMOVE: 'staff:modal:remove',
  MODAL_CALL: 'staff:modal:call',
  MODAL_FINISH: 'staff:modal:finish',
  MODAL_RETURN: 'staff:modal:return',
  // avaliação
  EVAL_PREFIX: 'eval',
};

function publicPanelComponents({ joinDisabled = false } = {}) {
  return [
    actionRow([
      button(IDs.PUBLIC_JOIN, 'ENTRAR NA FILA', { style: STYLES.SECONDARY, emoji: '🎫', disabled: joinDisabled }),
      button(IDs.PUBLIC_LEAVE, 'SAIR DA FILA', { style: STYLES.SECONDARY, emoji: '❌' }),
      button(IDs.PUBLIC_STATUS, 'MINHA POSIÇÃO', { style: STYLES.SECONDARY, emoji: '📊' }),
    ]),
    // Sempre disponível: o jogador avalia o último atendimento mesmo depois
    // de fechar a DM.
    actionRow([button(IDs.PUBLIC_EVALUATE, 'AVALIAR ATENDIMENTO', { style: STYLES.SECONDARY })]),
  ];
}

function staffPanelComponents({ hasQueue = false, hasServing = false, hasHold = false } = {}) {
  // Paleta da referência: todos os botões na mesma superfície escura neutra,
  // diferenciados pelo ícone (o Discord não permite cor personalizada nos botões).
  return [
    actionRow([
      button(IDs.STAFF_CALL_NEXT, 'CHAMAR PRÓXIMO', { style: STYLES.SECONDARY, disabled: !hasQueue }),
      button(IDs.STAFF_CALL_SPECIFIC, 'CHAMAR ESPECÍFICO', { style: STYLES.SECONDARY, disabled: !hasQueue }),
      button(IDs.STAFF_SKIP, 'PULAR JOGADOR', { style: STYLES.SECONDARY, disabled: !hasQueue }),
    ]),
    actionRow([
      button(IDs.STAFF_RETURN, 'DEVOLVER À FILA', { style: STYLES.SECONDARY, disabled: !hasServing }),
      button(IDs.STAFF_FINISH, 'FINALIZAR', { style: STYLES.SECONDARY, disabled: !hasServing }),
      button(IDs.STAFF_REMOVE, 'REMOVER DA FILA', { style: STYLES.SECONDARY, disabled: !hasQueue && !hasServing }),
    ]),
    actionRow([
      button(IDs.STAFF_MY_STATUS, 'MEU STATUS', { style: STYLES.SECONDARY }),
      button(IDs.STAFF_REACTIVATE, 'REATIVAR PENDENTE', { style: STYLES.SECONDARY, disabled: !hasHold }),
      button(IDs.STAFF_REFRESH, 'ATUALIZAR PAINEL', { style: STYLES.SECONDARY }),
    ]),
  ];
}

/**
 * Botões de nota (1 a 4 estrelas) de um atendimento.
 * O custom_id carrega o atendimento: `eval:<id>:<NOTA>` (persistente).
 */
function ratingButtons(attendanceId, { protocol = null } = {}) {
  return Object.entries(RATING_META).map(([rating, meta]) => {
    const prefix = protocol ? `#${String(protocol).padStart(4, '0')} ` : '';
    return button(`eval:${attendanceId}:${rating}`, `${prefix}${meta.label}`, {
      style: RATING_STYLES[rating] ?? STYLES.SECONDARY,
    });
  });
}

function ratingRow(attendanceId, options = {}) {
  return actionRow(ratingButtons(attendanceId, options));
}

module.exports = {
  STYLES,
  RATING_STYLES,
  IDs,
  button,
  actionRow,
  selectMenu,
  ratingButtons,
  ratingRow,
  publicPanelComponents,
  staffPanelComponents,
};
