'use strict';

/**
 * Registra os slash commands manualmente:
 *   npm run deploy:commands
 * Útil quando AUTO_REGISTER_COMMANDS=false.
 */
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { env, validateEnv } = require('../src/config/env');
const { loadCommands } = require('../src/handlers/commandHandler');
const { registerCommands } = require('../src/handlers/registerCommands');
const { createLogger } = require('../src/utils/logger');

const logger = createLogger('deploy');

async function main() {
  const errors = validateEnv();
  if (errors.length > 0) {
    errors.forEach((error) => logger.error(error));
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(env.token);
  await new Promise((resolve) => client.once(Events.ClientReady, resolve));

  const commands = loadCommands();
  const total = await registerCommands({
    client,
    token: env.token,
    guildId: env.devGuildId || env.guildId,
    commands,
  });

  logger.info(`${total} comandos publicados.`);
  await client.destroy();
  process.exit(0);
}

main().catch((error) => {
  logger.error('Falha ao publicar comandos', error);
  process.exit(1);
});
