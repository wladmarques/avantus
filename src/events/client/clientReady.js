'use strict';

const { createLogger } = require('../../utils/logger');
const { startGuild, resolveGuildId } = require('../../handlers/guildStart');
const { inviteUrl, isValidClientId } = require('../../utils/invite');

const logger = createLogger('ready');

/** Application ID do bot conectado (o mesmo que aparece na URL da API). */
const applicationIdOf = (client) => client.application?.id ?? client.user?.id ?? null;

/** Link de convite para o bot conectado (usado nas mensagens de erro). */
function joinLink(client) {
  const id = applicationIdOf(client);
  return isValidClientId(id) ? inviteUrl(id) : null;
}

/** Avisa (no log) quando o token conectou um bot diferente do CLIENT_ID configurado. */
function warnIfWrongBot(client, env) {
  const appId = applicationIdOf(client);
  const configured = (env.clientId || '').trim();
  if (!configured || !appId || configured === appId) return;
  logger.warn(
    `O token conectou o bot ${client.user?.tag ?? '?'} (aplicação ${appId}), ` +
      `mas CLIENT_ID está configurado como ${configured}. ` +
      'Use o link de convite da aplicação do token e corrija o CLIENT_ID no .env.',
  );
}

// discord.js 14.27 emite `clientReady` (o antigo `ready` será removido na v15)
module.exports = {
  name: 'clientReady',
  once: true,
  async execute(client, context) {
    const { services, env, runtime } = context;
    const appId = applicationIdOf(client);

    logger.info(
      `Conectado como ${client.user.tag} (aplicação ${appId}, ${client.guilds.cache.size} servidor(es))`,
    );
    warnIfWrongBot(client, env);

    const { guildId, previous, switched, source } = resolveGuildId({ client, services, env });
    if (!guildId) {
      logger.error('GUILD_ID não configurado: o bot não sabe em qual servidor operar.');
      return;
    }

    if (switched) {
      // O servidor salvo no banco não existe mais: adota o do ambiente e
      // corrige o banco, senão o bot ficaria preso no servidor fantasma.
      await services.settings.set('guild_id', guildId);
      logger.warn(
        `Servidor salvo (${previous ?? 'nenhum'}) não está disponível para o bot; ` +
          `usando ${guildId} de ${source === 'dev' ? 'DEV_GUILD_ID' : 'GUILD_ID'}. ` +
          'Configuração do banco atualizada.',
      );
    } else if (!services.settings.get('guild_id')) {
      await services.settings.set('guild_id', guildId);
      logger.info(`Servidor adotado: ${guildId} (${source === 'dev' ? 'DEV_GUILD_ID' : 'GUILD_ID'}).`);
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      // Sem o servidor no cache, o registro de comandos e os painéis falhariam
      // com "Missing Access" (50001) — avisamos com o link certo e esperamos.
      runtime.awaitingGuild = guildId;
      const link = joinLink(client);
      const joined = [...client.guilds.cache.values()].map((item) => `${item.name} (${item.id})`);
      logger.error(
        `O bot ${client.user.tag} não está no servidor configurado (${guildId}). ` +
          (joined.length ? `Servidores atuais: ${joined.join(', ')}. ` : 'Ele não está em nenhum servidor. ') +
          (link
            ? `Convide com: ${link}`
            : 'Gere o convite com `npm run invite` usando o CLIENT_ID do bot.'),
      );
      logger.warn('Comandos e painéis serão configurados assim que o bot entrar no servidor.');
      return;
    }

    runtime.awaitingGuild = null;
    await startGuild({ client, context, guildId });
  },
};
