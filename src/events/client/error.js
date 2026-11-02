'use strict';

const { createLogger } = require('../../utils/logger');

const logger = createLogger('client');

module.exports = {
  name: 'error',
  async execute(error, context) {
    logger.error('Erro no client do Discord', error);
    const { services } = context ?? {};
    const guildId = services?.settings?.get('guild_id');
    if (services && guildId) {
      await services.audit
        .log({
          guildId,
          type: 'CLIENT_ERROR',
          message: `⚠️ Falha na conexão com o Discord: **${String(error?.message ?? error).slice(0, 400)}**`,
        })
        .catch(() => null);
    }
  },
};
