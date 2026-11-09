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
           (guild_id, user_id, staff_name, weekday, start_minutes, end_minutes, parity, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          guildId,
          userId,
          staffName ?? null,
          shift.weekday,
          shift.startMinutes,
          shift.endMinutes,
          shift.parity ?? null,
          now,
          now,
        ],
      );
    }
    return this.listShiftsSync(guildId, userId);
  }

  deleteShiftsSync(guildId, userId) {
    this.db.run('DELETE FROM staff_shifts WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  }

  /* ------------------------------------------------------------------ */
  /* Nome exibido                                                        */
  /* ------------------------------------------------------------------ */

  listNamesSync(guildId) {
    return this.db.all('SELECT * FROM staff_names WHERE guild_id = ?', [guildId]);
  }

  findNameSync(guildId, userId) {
    return this.db.get('SELECT * FROM staff_names WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  }

  /**
   * Grava o nome exibido. Um nome definido pelo painel (`painel`) nunca é
   * sobrescrito pela resolução automática do Discord (`discord`).
   */
  upsertNameSync(guildId, userId, staffName, source = 'painel') {
    const now = Date.now();
    this.db.run(
      `INSERT INTO staff_names (guild_id, user_id, staff_name, source, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET
         staff_name = excluded.staff_name,
         source = excluded.source,
         updated_at = excluded.updated_at
       WHERE staff_names.source <> 'painel' OR excluded.source = 'painel'`,
      [guildId, userId, staffName, source, now],
    );
    return this.findNameSync(guildId, userId);
  }

  deleteNameSync(guildId, userId) {
    this.db.run('DELETE FROM staff_names WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
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

  /**
   * Apaga as sessões já encerradas (zerar horas sem perder a sessão em
   * andamento de quem está em serviço agora).
   */
  deleteClosedSessionsSync(guildId, userId = null) {
    const sql = userId
      ? 'DELETE FROM staff_sessions WHERE guild_id = ? AND user_id = ? AND ended_at IS NOT NULL'
      : 'DELETE FROM staff_sessions WHERE guild_id = ? AND ended_at IS NOT NULL';
    const params = userId ? [guildId, userId] : [guildId];
    return this.db.run(sql, params).changes;
  }

  /**
   * Reinicia a sessão aberta: a contagem recomeça do zero a partir de `at`,
   * sem perder o vínculo com o turno em andamento.
   */
  restartOpenSessionsSync(guildId, userId = null, at = Date.now()) {
    const sql = `UPDATE staff_sessions
                    SET started_at = ?, minutes = NULL, late_minutes = 0, early_leave_minutes = 0,
                        updated_at = ?
                  WHERE guild_id = ? AND ended_at IS NULL${userId ? ' AND user_id = ?' : ''}`;
    const params = userId ? [at, at, guildId, userId] : [at, at, guildId];
    return this.db.run(sql, params).changes;
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

  /* ------------------------------------------------------------------ */
  /* Não entrada em serviço (faltas e atrasos)                           */
  /* ------------------------------------------------------------------ */

  findAbsenceSync(guildId, userId, shiftId, shiftDay) {
    return this.db.get(
      `SELECT * FROM staff_absences
        WHERE guild_id = ? AND user_id = ? AND shift_id = ? AND shift_day = ?`,
      [guildId, userId, shiftId, shiftDay],
    );
  }

  /**
   * Abre o registro de ausência (idempotente pela chave
   * `guild_id + user_id + shift_id + shift_day`).
   */
  openAbsenceSync(guildId, userId, {
    staffName = null,
    shiftId = null,
    shiftDay,
    scheduledStart,
    scheduledEnd,
    detectedAt = Date.now(),
  }) {
    const now = Date.now();
    this.db.run(
      `INSERT INTO staff_absences
         (guild_id, user_id, staff_name, shift_id, shift_day, scheduled_start, scheduled_end,
          detected_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id, shift_id, shift_day) DO NOTHING`,
      [guildId, userId, staffName, shiftId, shiftDay, scheduledStart, scheduledEnd, detectedAt, now, now],
    );
    return this.findAbsenceSync(guildId, userId, shiftId, shiftDay);
  }

  markAbsenceNotifiedSync(id, notifiedAt = Date.now()) {
    this.db.run('UPDATE staff_absences SET notified_at = ?, updated_at = ? WHERE id = ?', [
      notifiedAt,
      Date.now(),
      id,
    ]);
    return this.db.get('SELECT * FROM staff_absences WHERE id = ?', [id]);
  }

  /**
   * Marca que o staff apareceu (entrou em serviço) depois do horário.
   *
   * Só considera o registro cujo **turno contém** o instante da chegada — senão
   * uma falta de ontem seria fechada como "atraso" por alguém que entrou em
   * serviço hoje.
   */
  markAbsenceReturnedSync(guildId, userId, { returnedAt = Date.now(), lateMinutes = 0 } = {}) {
    const row = this.db.get(
      `SELECT * FROM staff_absences
        WHERE guild_id = ? AND user_id = ? AND returned_at IS NULL
          AND scheduled_start <= ? AND scheduled_end > ?
        ORDER BY scheduled_start DESC LIMIT 1`,
      [guildId, userId, returnedAt, returnedAt],
    );
    if (!row) return null;
    this.db.run(
      `UPDATE staff_absences
          SET returned_at = ?, returned_late_minutes = ?, updated_at = ?
        WHERE id = ?`,
      [returnedAt, lateMinutes, Date.now(), row.id],
    );
    return this.db.get('SELECT * FROM staff_absences WHERE id = ?', [row.id]);
  }

  /** Registros de ausência do período (por início do turno). */
  listAbsencesSync(guildId, { from = 0, to = Number.MAX_SAFE_INTEGER, userId = null } = {}) {
    const params = [guildId, from, to];
    let sql = `SELECT * FROM staff_absences
                WHERE guild_id = ? AND scheduled_start >= ? AND scheduled_start <= ?`;
    if (userId) {
      sql += ' AND user_id = ?';
      params.push(userId);
    }
    sql += ' ORDER BY scheduled_start DESC';
    return this.db.all(sql, params);
  }

  /** Ausências ainda sem aviso enviado (para o watcher não repetir). */
  listPendingAbsencesSync(guildId) {
    return this.db.all(
      `SELECT * FROM staff_absences
        WHERE guild_id = ? AND notified_at IS NULL AND returned_at IS NULL
        ORDER BY scheduled_start ASC`,
      [guildId],
    );
  }
}

module.exports = { HourBankRepository };
