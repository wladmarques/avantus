'use strict';

const { COLORS } = require('../../config/theme');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('audit');

/**
 * Auditoria: grava no banco (fonte de verdade) e publica no canal de logs.
 * Nenhuma ação administrativa pode ocorrer sem registro.
 */
class AuditService {
  constructor({ db, repo, settings, gateway, notifications }) {
    this.db = db;
    this.repo = repo;
    this.settings = settings;
    this.gateway = gateway;
    this.notifications = notifications;
    this._queue = [];
    this._flushing = false;
  }

  /** Registro persistente + envio ao canal de logs (best effort). */
  async log(event) {
    const {
      guildId,
      type,
      actorId = null,
      actorTag = null,
      targetId = null,
      protocol = null,
      message,
      metadata = null,
      color = COLORS.PURPLE,
    } = event;

    try {
      await this.db.transaction(async () =>
        this.repo.insertSync({ guildId, type, actorId, actorTag, targetId, protocol, message, metadata }),
      );
    } catch (error) {
      logger.error(`Falha ao gravar auditoria (${type})`, error);
    }

    const channelId = this.settings.get('log_channel_id');
    if (!channelId) return;

    const embed = {
      color,
      description: message,
      footer: { text: `VANTUS • ${type}` },
      timestamp: new Date().toISOString(),
      fields: [
        actorId ? { name: 'Responsável', value: `<@${actorId}>`, inline: true } : null,
        targetId ? { name: 'Jogador alvo', value: `<@${targetId}>`, inline: true } : null,
        protocol ? { name: 'Protocolo', value: `#${String(protocol).padStart(4, '0')}`, inline: true } : null,
      ].filter(Boolean),
    };

    try {
      await this.gateway.sendChannelMessage(guildId, channelId, { embeds: [embed] });
    } catch (error) {
      logger.warn(`Não foi possível enviar log para o canal ${channelId}: ${error.message}`);
    }
  }

  history(guildId, protocol) {
    return this.repo.listByProtocolSync(guildId, protocol);
  }

  recent(guildId, options) {
    return this.repo.listRecentSync(guildId, options);
  }
}

module.exports = { AuditService };
