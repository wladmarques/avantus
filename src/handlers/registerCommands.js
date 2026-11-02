'use strict';

const { REST, Routes } = require('discord.js');
const { createLogger } = require('../utils/logger');
const { inviteUrl, isValidClientId } = require('../utils/invite');

const logger = createLogger('commands:register');

/**
 * Registra os slash commands. Por padrão usamos registro por servidor
 * (aplica na hora); use GUILD_ID vazio para registro global.
 */
async function registerCommands({ client, token, guildId, commands }) {
  const body = [...commands.values()].map((command) => command.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(token);

  const applicationId = client.application?.id ?? client.user.id;

  if (guildId) {
    if (!client.guilds.cache.has(guildId)) {
      // Registrar em um servidor onde o bot não está devolve 50001 (Missing Access).
      const hint = isValidClientId(applicationId) ? ` Convide com: ${inviteUrl(applicationId)}` : '';
      throw new Error(`o bot não está no servidor ${guildId}; comandos não registrados.${hint}`);
    }
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body });
    logger.info(`${body.length} comandos registrados no servidor ${guildId}`);
    return body.length;
  }

  await rest.put(Routes.applicationCommands(applicationId), { body });
  logger.info(`${body.length} comandos globais registrados`);
  return body.length;
}

module.exports = { registerCommands };
