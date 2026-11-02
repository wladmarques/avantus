'use strict';

const { createLogger } = require('../utils/logger');
const { formatTime } = require('../utils/time');

const logger = createLogger('boot:guild');

const SERVICE_DAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const serviceDayLabel = (weekday) => SERVICE_DAYS[Number(weekday)] ?? 'segunda';

/**
 * Sobe tudo que depende de um servidor específico: recuperação de estado,
 * painéis, expiração da fila, banco de horas, webhook da escala e horário.
 *
 * Chamado no `clientReady` e também no `guildCreate` — assim, se o bot for
 * convidado depois de ligar, a central sobe sozinha, sem reiniciar.
 */
async function startGuild({ client, context, guildId }) {
  const { services, env, runtime } = context;

  if (runtime.startedGuildId === guildId) return false; // já iniciado

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return false;

  runtime.startedGuildId = guildId;

  if (env.autoRegisterCommands) {
    const { registerCommands } = require('./registerCommands');
    try {
      await registerCommands({
        client,
        token: env.token,
        guildId: env.devGuildId || guildId,
        commands: client.commands,
      });
    } catch (error) {
      logger.error(`Falha ao registrar comandos: ${error.message}`);
    }
  }

  await services.recovery.run(guildId).catch((error) => logger.error('Recuperação falhou', error));

  // Atualização automática dos painéis
  const seconds = services.settings.get('panel_refresh_seconds') || env.panelRefreshSeconds || 30;
  const panelTimer = setInterval(() => {
    services.panels.refresh(guildId).catch((error) => logger.warn(`Painel: ${error.message}`));
  }, seconds * 1000);
  panelTimer.unref?.();
  runtime.panelTimer = panelTimer;
  logger.info(`Atualização de painéis a cada ${seconds}s`);

  // Expirados por tempo máximo de espera
  const expireTimer = setInterval(() => {
    services.queue.expire(guildId).catch((error) => logger.warn(`Expiração: ${error.message}`));
    try {
      services.repositories.cooldowns.purgeExpiredSync();
    } catch (error) {
      logger.warn(`Limpeza de bloqueios: ${error.message}`);
    }
  }, 60 * 1000);
  expireTimer.unref?.();
  runtime.expireTimer = expireTimer;

  // Banco de horas: aviso 5 min antes do turno + fechamento de sessões esquecidas
  runtime.stopHourBankWatcher = services.hourBank.startWatcher(guildId);
  logger.info(`Banco de horas ativo • aviso ${services.hourBank.reminderMinutes} min antes do turno`);

  // Envio automático da escala semanal pelo webhook (ativado no painel)
  runtime.stopScheduleBroadcastWatcher = services.scheduleBroadcast.startWatcher(guildId);
  if (services.scheduleBroadcast.enabled) {
    logger.info(
      `Escala no webhook: envio automático ${serviceDayLabel(services.scheduleBroadcast.day)} às ${services.scheduleBroadcast.time}`,
    );
  }

  // Abertura/fechamento pelo horário configurado
  runtime.stopScheduleWatcher = services.schedule.startWatcher(guildId, (change) => {
    services.central
      .handleScheduleTransition({
        guildId,
        open: change.open,
        previousOpen: change.previousOpen,
      })
      .catch((error) => logger.error('Falha na transição de horário', error));
  });

  logger.info(`Central pronta • ${services.schedule.statusLabel(guildId)} • ${formatTime()}`);

  const missingPanels = ['public', 'staff'].filter((key) => {
    const panel = services.repositories.panels.getSync(guildId, key);
    return !panel?.message_id;
  });
  if (missingPanels.length > 0) {
    logger.warn(
      `Painéis não publicados (${missingPanels.join(', ')}). ` +
        'Rode /setup ou /painel publicar no Discord para publicá-los.',
    );
  }

  await services.panels.refresh(guildId).catch(() => null);
  return true;
}

module.exports = { startGuild };
