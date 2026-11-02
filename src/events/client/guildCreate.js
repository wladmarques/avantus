'use strict';

const { createLogger } = require('../../utils/logger');
const { startGuild } = require('../../handlers/guildStart');

const logger = createLogger('ready');

module.exports = {
  name: 'guildCreate',
  async execute(guild, context) {
    const { services, env, runtime } = context;
    const guildId = services.settings.get('guild_id') || env.guildId;

    logger.info(`Entrou no servidor ${guild.name} (${guild.id}).`);
    if (!guildId || guild.id !== guildId) return;

    // Bot convidado depois de ligar: sobe a central sem precisar reiniciar.
    runtime.awaitingGuild = null;
    await startGuild({ client: guild.client, context, guildId });
  },
};
