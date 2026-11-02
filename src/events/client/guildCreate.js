'use strict';

const { createLogger } = require('../../utils/logger');
const { startGuild, resolveGuildId } = require('../../handlers/guildStart');

const logger = createLogger('ready');

module.exports = {
  name: 'guildCreate',
  async execute(guild, context) {
    const { services, env, runtime } = context;
    const { guildId, switched } = resolveGuildId({ client: guild.client, services, env });

    logger.info(`Entrou no servidor ${guild.name} (${guild.id}).`);
    if (!guildId || guild.id !== guildId) return;

    if (switched) {
      await services.settings.set('guild_id', guildId);
      logger.warn(`Servidor adotado pelo GUILD_ID do ambiente: ${guildId}.`);
    }

    // Bot convidado depois de ligar: sobe a central sem precisar reiniciar.
    runtime.awaitingGuild = null;
    await startGuild({ client: guild.client, context, guildId });
  },
};
