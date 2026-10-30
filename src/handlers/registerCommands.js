'use strict';

const { REST, Routes } = require('discord.js');
const { createLogger } = require('../utils/logger');

const logger = createLogger('commands:register');

/**
 * Registra os slash commands. Por padrão usamos registro por servidor
 * (aplica na hora); use GUILD_ID vazio para registro global.
 */
async function registerCommands({ client, token, guildId, commands }) {
  const body = [...commands.values()].map((command) => command.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(token);

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body });
    logger.info(`${body.length} comandos registrados no servidor ${guildId}`);
    return body.length;
  }

  await rest.put(Routes.applicationCommands(client.user.id), { body });
  logger.info(`${body.length} comandos globais registrados`);
  return body.length;
}

module.exports = { registerCommands };
