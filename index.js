'use strict';

/**
 * VANTUS • Central de Atendimento
 * Ponto de entrada do bot (SquareCloud: MAIN=index.js).
 */

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { env, validateEnv } = require('./src/config/env');
const { createLogger, setLevel, onLog } = require('./src/utils/logger');
const { openDatabase } = require('./src/database/connection');
const { runMigrations } = require('./src/database/migrations');
const { createServices } = require('./src/services');
const { DiscordGateway } = require('./src/services/discordGateway');
const { loadCommands } = require('./src/handlers/commandHandler');
const { loadEvents } = require('./src/handlers/eventHandler');
const { startWebServer } = require('./src/web/server');

const logger = createLogger('boot');
setLevel(env.logLevel);

const runtime = {
  panelTimer: null,
  expireTimer: null,
  stopScheduleWatcher: null,
  stopHourBankWatcher: null,
  webServer: null,
  shuttingDown: false,
};

let db = null;
let client = null;
let services = null;

async function main() {
  const envErrors = validateEnv();
  if (envErrors.length > 0) {
    for (const error of envErrors) logger.error(error);
    logger.error('Configure o arquivo .env (veja .env.example) e reinicie o bot.');
    process.exit(1);
  }

  logger.info('Iniciando VANTUS Atendimento...');

  db = await openDatabase({ filePath: env.dbPath });
  const migration = await runMigrations(db);
  logger.info(`Banco pronto (versão ${migration.currentVersion})`);

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel],
  });

  const gateway = new DiscordGateway(client, { settings: null });
  services = await createServices({ db, gateway });

  // Painel web do banco de horas (independe do Discord: sobe antes do login)
  runtime.webServer = await startWebServer({ services, env, logger });
  services.webPanel = runtime.webServer
    ? { enabled: true, port: runtime.webServer.port }
    : { enabled: false, port: null };
  if (runtime.webServer) logger.info(`Banco de horas disponível na porta ${runtime.webServer.port}`);

  client.commands = loadCommands();
  logger.info(`${client.commands.size} comandos carregados`);

  const context = { client, services, env, runtime };
  loadEvents(client, context);

  // Encaminha erros relevantes para o canal de logs administrativo (com limite).
  const lastSent = { at: 0 };
  onLog(({ level, scope, message }) => {
    if (!services || runtime.shuttingDown) return;
    const now = Date.now();
    if (level === 'error' && now - lastSent.at > 30000) {
      lastSent.at = now;
      const guildId = services.settings.get('guild_id') || env.guildId;
      if (guildId) {
        services.audit
          .log({
            guildId,
            type: 'SYSTEM_ERROR',
            message: `⚠️ Erro no módulo **${scope}**\n\`\`\`\n${String(message).slice(0, 900)}\n\`\`\``,
          })
          .catch(() => null);
      }
    }
  });

  client.on('rateLimit', (info) => {
    logger.warn(`Rate limit: ${info.route} (${info.timeout}ms)`);
  });

  await client.login(env.token);
}

async function shutdown(signal) {
  if (runtime.shuttingDown) return;
  runtime.shuttingDown = true;
  logger.warn(`Encerrando (${signal})...`);

  try {
    if (runtime.panelTimer) clearInterval(runtime.panelTimer);
    if (runtime.expireTimer) clearInterval(runtime.expireTimer);
    if (typeof runtime.stopScheduleWatcher === 'function') runtime.stopScheduleWatcher();
    if (typeof runtime.stopHourBankWatcher === 'function') runtime.stopHourBankWatcher();
    if (runtime.webServer) await runtime.webServer.close();
    for (const timer of services?.engine?.timers?.values?.() ?? []) clearTimeout(timer);
  } catch (error) {
    logger.warn(`Falha ao limpar timers: ${error.message}`);
  }

  try {
    if (client) await client.destroy();
  } catch (error) {
    logger.warn(`Falha ao fechar o client: ${error.message}`);
  }

  try {
    if (db) await db.close();
    logger.info('Banco persistido. Até logo!');
  } catch (error) {
    logger.error('Falha ao persistir o banco', error);
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('Promise rejeitada sem tratamento', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Exceção não tratada', error);
  // Não derrubamos o processo por erros de rede pontuais; o AUTORESTART cobre crashes reais.
});

main().catch(async (error) => {
  logger.error('Falha fatal ao iniciar o bot', error);
  try {
    if (db) await db.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

module.exports = { runtime };
