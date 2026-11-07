'use strict';

const { createLogger } = require('../utils/logger');
const { formatTime } = require('../utils/time');

const logger = createLogger('boot:guild');

const SERVICE_DAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const serviceDayLabel = (weekday) => SERVICE_DAYS[Number(weekday)] ?? 'segunda';

/**
 * Decide em qual servidor o bot opera.
 *
 * Ordem: `guild_id` salvo no banco, `GUILD_ID` e `DEV_GUILD_ID` do ambiente —
 * sempre preferindo um servidor em que o bot realmente está. Se o servidor
 * salvo sumiu (banco de teste, servidor antigo, bot removido), o ambiente
 * assume e o banco é corrigido: sem isso o bot ficava preso em "servidor não
 * encontrado" mesmo com o GUILD_ID certo configurado.
 *
 * @returns {{guildId: string|null, source: 'settings'|'env'|'dev'|'settings-unavailable', previous: string|null, switched: boolean}}
 */
function resolveGuildId({ client, services, env = {} }) {
  const saved = services.settings.get('guild_id') || null;
  const fromEnv = (env.guildId || '').trim() || null;
  const fromDev = (env.devGuildId || '').trim() || null;
  const has = (id) => Boolean(id) && client.guilds.cache.has(id);

  if (has(saved)) return { guildId: saved, source: 'settings', previous: saved, switched: false };

  // Servidor salvo não existe mais (ou o bot não está nele): tenta o ambiente.
  for (const [source, candidate] of [
    ['env', fromEnv],
    ['dev', fromDev],
  ]) {
    if (has(candidate)) return { guildId: candidate, source, previous: saved, switched: true };
  }

  return {
    guildId: saved || fromEnv || fromDev,
    source: saved ? 'settings-unavailable' : fromEnv ? 'env' : 'dev',
    previous: saved,
    switched: false,
  };
}

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

  // Canal de avaliações definido no ambiente (pode ser trocado no painel web).
  if (env.evaluationChannelId && !services.settings.get('evaluation_channel_id')) {
    await services.settings.set('evaluation_channel_id', env.evaluationChannelId);
    logger.info(`Avaliações serão publicadas no canal ${env.evaluationChannelId} (EVALUATION_CHANNEL_ID).`);
  }

  // Cargos configurados para o painel da equipe (EQUIPE mostra só estes).
  if (env.staffPanelRoleIds?.length && !(services.settings.get('staff_panel_role_ids') || []).length) {
    await services.settings.set('staff_panel_role_ids', env.staffPanelRoleIds);
    logger.info(`EQUIPE do painel limitada aos cargos ${env.staffPanelRoleIds.join(', ')} (STAFF_PANEL_ROLE_IDS).`);
  }
  if (!(services.settings.get('staff_panel_role_ids') || []).length) {
    logger.warn(
      'EQUIPE do painel mostra todos os staff: defina STAFF_PANEL_ROLE_IDS (ou ' +
        '/config definir chave:staff_panel_role_ids) para listar só um cargo.',
    );
  }
  if ((services.settings.get('staff_panel_role_ids') || []).length) {
    // Carrega os cargos agora e mantém atualizado (cargo trocado no Discord
    // precisa refletir no painel sem reiniciar o bot).
    await services.staff.refreshRoleCache(guildId, { force: true });
    const roleTimer = setInterval(() => {
      services.staff.refreshRoleCache(guildId).catch(() => null);
    }, 5 * 60 * 1000);
    roleTimer.unref?.();
    runtime.staffRoleTimer = roleTimer;
    logger.info('Cargos do painel da equipe sincronizados (atualização a cada 5 min).');
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

module.exports = { startGuild, resolveGuildId };
