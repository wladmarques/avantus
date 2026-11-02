'use strict';

const { executeCommand } = require('../handlers/commandHandler');
const { PUBLIC_BUTTON_HANDLERS } = require('./buttons/publicButtons');
const { STAFF_BUTTON_HANDLERS } = require('./buttons/staffButtons');
const { EVAL_PREFIX, handleEvaluation } = require('./buttons/evaluationButtons');
const { handleSelect } = require('./selectMenus/staffSelects');
const { handleModal } = require('./modals/staffModals');
const { respondError, ephemeral } = require('../handlers/respond');
const { createLogger } = require('../utils/logger');

const logger = createLogger('interactions');

const BUTTON_HANDLERS = { ...PUBLIC_BUTTON_HANDLERS, ...STAFF_BUTTON_HANDLERS };

/**
 * Ponto único de entrada das interações.
 * IDs de componentes são persistentes: continuam válidos após reinício.
 */
async function handleInteraction(interaction, context) {
  try {
    if (interaction.isAutocomplete()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (command?.autocomplete) return await command.autocomplete({ interaction, ...context });
      return await interaction.respond([]).catch(() => null);
    }

    if (interaction.isChatInputCommand()) {
      return await executeCommand(interaction, context);
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith(EVAL_PREFIX)) {
        return await handleEvaluation(interaction, context);
      }
      const handler = BUTTON_HANDLERS[interaction.customId];
      if (!handler) {
        logger.warn(`Botão sem handler: ${interaction.customId}`);
        return await interaction
          .reply(ephemeral({ content: 'Este botão não está mais disponível. Atualize o painel.' }))
          .catch(() => null);
      }
      return await handler(interaction, context);
    }

    if (interaction.isStringSelectMenu()) {
      return await handleSelect(interaction, context);
    }

    if (interaction.isModalSubmit()) {
      return await handleModal(interaction, context);
    }
  } catch (error) {
    logger.error(`Falha ao processar interação ${interaction.customId ?? interaction.commandName}`, error);
    await respondError(interaction, error);
  }
  return null;
}

module.exports = { handleInteraction, BUTTON_HANDLERS };
