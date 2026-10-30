'use strict';

const { errorEmbed } = require('../dashboard/embeds/cards');
const { createLogger } = require('../utils/logger');

const logger = createLogger('respond');

/** Responde respeitando o estado da interação (reply / editReply / followUp). */
async function respond(interaction, payload) {
  const body = typeof payload === 'string' ? { content: payload } : payload;
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(body);
    return await interaction.reply(body);
  } catch (error) {
    logger.warn(`Falha ao responder interação: ${error.message}`);
    return null;
  }
}

/** Resposta efêmera (somente quem clicou vê). */
function ephemeral(payload) {
  const body = typeof payload === 'string' ? { content: payload } : payload;
  return { ...body, flags: 64 };
}

/** Erro amigável ao usuário. */
async function respondError(interaction, error) {
  const message =
    error?.userMessage ||
    'Ocorreu um erro inesperado. A equipe foi notificada e o problema será verificado.';
  if (!error?.userMessage) logger.error('Erro não tratado na interação', error);
  return respond(interaction, ephemeral({ embeds: errorEmbed(message) }));
}

/** Defer seguro (evita "interação expirada" em operações demoradas). */
async function defer(interaction, { ephemeral: isEphemeral = true } = {}) {
  if (interaction.deferred || interaction.replied) return;
  try {
    if (isEphemeral) await interaction.deferReply({ flags: 64 });
    else await interaction.deferReply();
  } catch (error) {
    logger.debug(`defer falhou: ${error.message}`);
  }
}

module.exports = { respond, respondError, ephemeral, defer };
