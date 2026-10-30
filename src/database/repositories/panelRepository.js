'use strict';

/**
 * Referências das mensagens persistentes dos painéis.
 * Garante que o bot edite a mensagem existente em vez de duplicá-la.
 */
class PanelRepository {
  constructor(db) {
    this.db = db;
  }

  getSync(guildId, key) {
    return this.db.get('SELECT * FROM panels WHERE guild_id = ? AND key = ?', [guildId, key]);
  }

  saveSync(guildId, key, { channelId, messageId }) {
    this.db.run(
      `INSERT INTO panels (key, guild_id, channel_id, message_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key, guild_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         message_id = excluded.message_id,
         updated_at = excluded.updated_at`,
      [key, guildId, channelId, messageId, Date.now()],
    );
    return this.getSync(guildId, key);
  }

  clearSync(guildId, key) {
    this.db.run('DELETE FROM panels WHERE guild_id = ? AND key = ?', [guildId, key]);
  }
}

module.exports = { PanelRepository };
