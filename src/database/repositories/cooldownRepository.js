'use strict';

/**
 * Bloqueio temporário de reentrada (cooldown).
 * Um jogador que sai da fila antes de ser chamado fica impedido de voltar
 * (pela fila ou pelo canal de espera) até o horário registrado.
 */
class CooldownRepository {
  constructor(db) {
    this.db = db;
  }

  getSync(guildId, userId) {
    return this.db.get('SELECT * FROM cooldowns WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  }

  setSync(guildId, userId, { until, reason = null }) {
    const now = Date.now();
    this.db.run(
      `INSERT INTO cooldowns (guild_id, user_id, until, reason, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET
         until = excluded.until,
         reason = excluded.reason,
         created_at = excluded.created_at`,
      [guildId, userId, until, reason, now],
    );
    return this.getSync(guildId, userId);
  }

  clearSync(guildId, userId) {
    this.db.run('DELETE FROM cooldowns WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  }

  /** Remove registros expirados (limpeza periódica). */
  purgeExpiredSync(now = Date.now()) {
    this.db.run('DELETE FROM cooldowns WHERE until <= ?', [now]);
  }

  listActiveSync(guildId, now = Date.now()) {
    return this.db.all(
      'SELECT * FROM cooldowns WHERE guild_id = ? AND until > ? ORDER BY until ASC',
      [guildId, now],
    );
  }
}

module.exports = { CooldownRepository };
