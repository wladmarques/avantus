'use strict';

/**
 * Persistência do banco de horas: escala semanal, sessões de trabalho e
 * controle dos avisos enviados antes do turno.
 */
class HourBankRepository {
  constructor(db) {
    this.db = db;
  }

  /* ------------------------------------------------------------------ */
  /* Escala                                                              */
  /* ------------------------------------------------------------------ */

  listShiftsSync(guildId, userId = null) {
    if (userId) {
      return this.db.all(
        'SELECT * FROM staff_shifts WHERE guild_id = ? AND user_id = ? ORDER BY weekday, start_minutes',
        [guildId, userId],
      );
    }
    return this.db.all(
      'SELECT * FROM staff_shifts WHERE guild_id = ? ORDER BY user_id, weekday, start_minutes',
      [guildId],
    );
  }

  /** Substitui toda a escala do staff (operação atômica dentro da transação). */
  replaceShiftsSync(guildId, userId, staffName, shifts) {
    const now = Date.now();
    this.db.run('DELETE FROM staff_shifts WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    for (const shift of shifts) {
      this.db.run(
        `INSERT INTO staff_shifts
           (guild_id, user_id, staff_name, weekday, start_minutes, end_minutes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [guildId, userId, staffName ?? null, shift.weekday, shift.startMinutes, shift.endMinutes, now, now],
      );
    }
    return this.listShiftsSync(guildId, userId);
  }

  deleteShiftsSync(guildId, userId) {
    this.db.run('DELETE FROM staff_shifts WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  }

  /* ------------------------------------------------------------------ */
  /* Sessões                                                             */
  /* ------------------------------------------------------------------ */

  findOpenSync(guildId, userId) {
    return this.db.get(
      `SELECT * FROM staff_sessions
        WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL
        ORDER BY started_at DESC LIMIT 1`,
      [guildId, userId],
    );
  }

  listOpenSync(guildId) {
    return this.db.all(
      'SELECT * FROM staff_sessions WHERE guild_id = ? AND ended_at IS NULL ORDER BY started_at ASC',
      [guildId],
    );
  }

  openSync(guildId, userId, { staffName = null, startedAt, source = 'disponivel', shift = null }) {
    const now = Date.now();
    this.db.run(
      `INSERT INTO staff_sessions
         (guild_id, user_id, staff_name, started_at, ended_at, minutes, source, shift_id,
          scheduled_start, scheduled_end, late_minutes, early_leave_minutes, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        guildId,
        userId,
        staffName,
        startedAt,
        source,
        shift?.shiftId ?? null,
        shift?.startTs ?? null,
        shift?.endTs ?? null,
        shift?.lateMinutes ?? 0,
        now,
        now,
      ],
    );
    return this.findOpenSync(guildId, userId);
  }

  closeSync(id, { endedAt, minutes, earlyLeaveMinutes = 0 }) {
    this.db.run(
      `UPDATE staff_sessions
          SET ended_at = ?, minutes = ?, early_leave_minutes = ?, updated_at = ?
        WHERE id = ?`,
      [endedAt, minutes, earlyLeaveMinutes, Date.now(), id],
    );
    return this.db.get('SELECT * FROM staff_sessions WHERE id = ?', [id]);
  }

  findByIdSync(id) {
    return this.db.get('SELECT * FROM staff_sessions WHERE id = ?', [id]);
  }

  /**
   * Sessões do período. `from`/`to` são timestamps (ms) e o filtro considera
   * qualquer sessão que tenha overlap com a janela (inclusive a que ainda está aberta).
   */
  listSessionsSync(guildId, { from = 0, to = Number.MAX_SAFE_INTEGER, userId = null } = {}) {
    const params = [guildId, to, from];
    let sql = `SELECT * FROM staff_sessions
                WHERE guild_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)`;
    if (userId) {
      sql += ' AND user_id = ?';
      params.push(userId);
    }
    sql += ' ORDER BY started_at DESC';
    return this.db.all(sql, params);
  }

  /* ------------------------------------------------------------------ */
  /* Avisos antes do turno                                               */
  /* ------------------------------------------------------------------ */

  wasReminderSentSync(guildId, userId, shiftId, shiftDay) {
    const row = this.db.get(
      'SELECT 1 AS sent FROM staff_shift_reminders WHERE guild_id = ? AND user_id = ? AND shift_id = ? AND shift_day = ?',
      [guildId, userId, shiftId, shiftDay],
    );
    return Boolean(row);
  }

  markReminderSentSync(guildId, userId, shiftId, shiftDay, sentAt = Date.now()) {
    this.db.run(
      `INSERT INTO staff_shift_reminders (guild_id, user_id, shift_id, shift_day, sent_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id, shift_id, shift_day) DO UPDATE SET sent_at = excluded.sent_at`,
      [guildId, userId, shiftId, shiftDay, sentAt],
    );
  }

  /** Limpa avisos antigos (mantém apenas os últimos dias). */
  purgeRemindersSync(before = Date.now() - 7 * 24 * 60 * 60 * 1000) {
    this.db.run('DELETE FROM staff_shift_reminders WHERE sent_at < ?', [before]);
  }
}

module.exports = { HourBankRepository };
