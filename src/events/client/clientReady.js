'use strict';

const { createLogger } = require('../../utils/logger');
const { registerCommands } = require('../../handlers/registerCommands');
const { formatTime } = require('../../utils/time');

const logger = createLogger('ready');

// discord.js 14.27 emite `clientReady` (o antigo `ready` será removido na v15)
module.exports = {
  name: 'clientReady',
  once: true,
  async execute(client, context) {
    const { services, env, runtime } = context;
    logger.info(`Conectado como ${client.user.tag} (${client.guilds.cache.size} servidor(es))`);

    const guildId = services.settings.get('guild_id') || env.guildId;
    if (!guildId) {
      logger.error('GUILD_ID não configurado: o bot não sabe em qual servidor operar.');
      return;
    }
    if (!services.settings.get('guild_id')) {
      await services.settings.set('guild_id', guildId);
    }

    if (env.autoRegisterCommands) {
      try {
        await registerCommands({
          client,
          token: env.token,
          guildId: env.devGuildId || guildId,
          commands: client.commands,
        });
      } catch (error) {
        logger.error('Falha ao registrar comandos', error);
      }
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      logger.error(`O bot não está no servidor ${guildId}.`);
      return;
    }

    await services.recovery.run(guildId).catch((error) => logger.error('Recuperação falhou', error));

    // Atualização automática dos painéis
    const startPanels = () => {
      const seconds = services.settings.get('panel_refresh_seconds') || env.panelRefreshSeconds || 30;
      const timer = setInterval(() => {
        services.panels.refresh(guildId).catch((error) => logger.warn(`Painel: ${error.message}`));
      }, seconds * 1000);
      timer.unref?.();
      runtime.panelTimer = timer;
      logger.info(`Atualização de painéis a cada ${seconds}s`);
    };
    startPanels();

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

    logger.info(
      `Central pronta • ${services.schedule.statusLabel(guildId)} • ${formatTime()}`,
    );

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
  },
};
