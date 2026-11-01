'use strict';

const { assertStaff, isStaff } = require('../config/permissions');
const { AppError, ERRORS } = require('../services/errors');
const { queueSelectOptions, servingSelectOptions, holdSelectOptions } = require('../dashboard/panels/staffPanel');
const { selectMenu, button, actionRow, STYLES } = require('../dashboard/components/buttons');
const { ephemeral } = require('../handlers/respond');
const { card } = require('../dashboard/embeds/cards');
const { COLORS } = require('../config/theme');

/** Garante que quem interagiu é da equipe. */
function guardStaff(interaction, services) {
  assertStaff(interaction.member, services.settings);
}

function guardAdmin(interaction, services) {
  const { assertAdmin } = require('../config/permissions');
  assertAdmin(interaction.member, services.settings);
}

function displayName(member) {
  return member?.displayName || member?.user?.username || 'Staff';
}

/** Estado atual + opções de select conforme o modo. */
function buildSelect(services, guildId, mode) {
  const state = services.engine.getState(guildId);

  const configs = {
    call: {
      customId: 'staff:select:call',
      placeholder: 'Escolha o jogador para chamar fora da ordem',
      options: queueSelectOptions(state, { mode: 'call' }),
    },
    skip: {
      customId: 'staff:select:skip',
      placeholder: 'Escolha o jogador que será pulado',
      options: queueSelectOptions(state, { mode: 'skip' }),
    },
    return: {
      customId: 'staff:select:return',
      placeholder: 'Escolha o atendimento para devolver à fila',
      options: servingSelectOptions(state),
    },
    finish: {
      customId: 'staff:select:finish',
      placeholder: 'Escolha o atendimento para finalizar',
      options: servingSelectOptions(state),
    },
    remove: {
      customId: 'staff:select:remove',
      placeholder: 'Escolha quem será removido do atendimento',
      options: [...servingSelectOptions(state), ...queueSelectOptions(state, { mode: 'remove' })],
    },
    reactivate: {
      customId: 'staff:select:reactivate',
      placeholder: 'Escolha o jogador pendente para reativar',
      options: holdSelectOptions(state),
    },
  };

  const config = configs[mode];
  if (!config) throw new AppError(ERRORS.ERRO_INTERNO, 'Menu inválido.');

  if (config.options.length === 0) {
    const messages = {
      call: 'Não há jogadores aguardando na fila.',
      skip: 'Não há jogadores aguardando na fila.',
      return: 'Não há atendimentos em andamento.',
      finish: 'Não há atendimentos em andamento.',
      remove: 'Não há jogadores na fila ou em atendimento.',
      reactivate: 'Não há jogadores pendentes.',
    };
    return { empty: true, message: messages[mode] };
  }

  const embed = card({
    title: '🛡️ Selecione um registro',
    description: config.placeholder,
    color: COLORS.PURPLE,
  });

  return {
    empty: false,
    payload: ephemeral({
      embeds: [embed],
      components: [selectMenu(config.customId, config.placeholder, config.options)],
    }),
  };
}

async function refreshPanels(services, guildId) {
  await services.panels.refresh(guildId).catch(() => null);
}

const STATUS_OPTIONS = [
  { label: 'Disponível', value: 'DISPONIVEL', emoji: { name: '🟢' }, description: 'Apto a receber atendimentos' },
  { label: 'Ausente', value: 'AUSENTE', emoji: { name: '🟡' }, description: 'Temporariamente ausente' },
  { label: 'Indisponível', value: 'INDISPONIVEL', emoji: { name: '⚫' }, description: 'Fora de serviço' },
];

module.exports = {
  guardStaff,
  guardAdmin,
  displayName,
  buildSelect,
  refreshPanels,
  isStaff,
  STATUS_OPTIONS,
};
