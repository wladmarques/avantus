'use strict';

const { STAFF_STATUS } = require('../../config/theme');

/**
 * Disponibilidade dos membros da equipe.
 * `manual = 1` significa que o próprio staff definiu o estado (não é
 * sobrescrito automaticamente ao finalizar um atendimento).
 */
class StaffRepository {
  constructor(db) {
    this.db = db;
  }

  getSync(guildId, userId) {
    return this.db.get('SELECT * FROM staff_status WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  }

  listSync(guildId) {
    return this.db.all('SELECT * FROM staff_status WHERE guild_id = ? ORDER BY updated_at DESC', [guildId]);
  }

  upsertSync(guildId, userId, { status, manual = 0, updatedBy = null }) {
    this.db.run(
      `INSERT INTO staff_status (guild_id, user_id, status, manual, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET
         status = excluded.status,
         manual = excluded.manual,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      [guildId, userId, status, manual ? 1 : 0, Date.now(), updatedBy],
    );
    return this.getSync(guildId, userId);
  }

  /**
   * Liga/desliga o bloqueio do staff.
   * O bloqueio é independente do status: `upsertSync` nunca o sobrescreve.
   */
  setBlockedSync(guildId, userId, { blocked, by = null, reason = null }) {
    if (!this.getSync(guildId, userId)) {
      this.upsertSync(guildId, userId, {
        status: STAFF_STATUS.INDISPONIVEL,
        manual: 1,
        updatedBy: by,
      });
    }
    this.db.run(
      `UPDATE staff_status
          SET blocked = ?, blocked_at = ?, blocked_by = ?, blocked_reason = ?
        WHERE guild_id = ? AND user_id = ?`,
      [blocked ? 1 : 0, blocked ? Date.now() : null, blocked ? by : null, blocked ? reason : null, guildId, userId],
    );
    return this.getSync(guildId, userId);
  }

  /** Remove o staff do quadro (histórico de sessões é preservado). */
  deleteSync(guildId, userId) {
    const row = this.getSync(guildId, userId);
    this.db.run('DELETE FROM staff_status WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    return row;
  }

  /** Status efetivo de um staff: registro no banco ou INDISPONÍVEL. */
  effectiveStatusSync(guildId, userId) {
    const row = this.getSync(guildId, userId);
    return row ? row.status : STAFF_STATUS.INDISPONIVEL;
  }

  countByStatusSync(guildId, status) {
    const row = this.db.get(
      'SELECT COUNT(*) AS total FROM staff_status WHERE guild_id = ? AND status = ?',
      [guildId, status],
    );
    return Number(row?.total || 0);
  }

  resetAllToSync(guildId, status, updatedBy = null, { skipBlocked = false } = {}) {
    this.db.run(
      `UPDATE staff_status SET status = ?, manual = 1, updated_at = ?, updated_by = ?
        WHERE guild_id = ?${skipBlocked ? ' AND blocked = 0' : ''}`,
      [status, Date.now(), updatedBy, guildId],
    );
  }
}

module.exports = { StaffRepository };
