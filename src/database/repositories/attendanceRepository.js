'use strict';

/**
 * Repositório de atendimentos/protocolos.
 * Um registro nasce como `waiting`, pode virar `hold` (pulado),
 * `serving` (em atendimento) e termina como `finished` + outcome.
 */
class AttendanceRepository {
  constructor(db) {
    this.db = db;
  }

  createSync(payload) {
    const now = Date.now();
    this.db.run(
      `INSERT INTO attendance (
        guild_id, protocol, user_id, username, status, outcome, joined_at,
        queue_seq, wait_channel_id, created_at, updated_at, staff_id, staff_tag
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.guildId,
        payload.protocol,
        payload.userId,
        payload.username,
        payload.status || 'waiting',
        payload.joinedAt ?? now,
        payload.queueSeq,
        payload.waitChannelId ?? null,
        now,
        now,
        payload.staffId ?? null,
        payload.staffTag ?? null,
      ],
    );
    return this.findByIdSync(payload.guildId, this.db._lastInsertRowid());
  }

  findByIdSync(guildId, id) {
    return this.db.get('SELECT * FROM attendance WHERE guild_id = ? AND id = ?', [guildId, Number(id)]);
  }

  findByProtocolSync(guildId, protocol) {
    return this.db.get('SELECT * FROM attendance WHERE guild_id = ? AND protocol = ?', [
      guildId,
      Number(protocol),
    ]);
  }

  findActiveByUserSync(guildId, userId) {
    return this.db.get(
      `SELECT * FROM attendance
        WHERE guild_id = ? AND user_id = ? AND status IN ('waiting', 'hold', 'serving')
        LIMIT 1`,
      [guildId, userId],
    );
  }

  findServingByStaffSync(guildId, staffId) {
    return this.db.get(
      `SELECT * FROM attendance WHERE guild_id = ? AND staff_id = ? AND status = 'serving' LIMIT 1`,
      [guildId, staffId],
    );
  }

  listWaitingSync(guildId) {
    return this.db.all(
      `SELECT * FROM attendance WHERE guild_id = ? AND status = 'waiting' ORDER BY queue_seq ASC, id ASC`,
      [guildId],
    );
  }

  listHoldSync(guildId) {
    return this.db.all(
      `SELECT * FROM attendance WHERE guild_id = ? AND status = 'hold' ORDER BY updated_at ASC`,
      [guildId],
    );
  }

  listServingSync(guildId) {
    return this.db.all(
      `SELECT * FROM attendance WHERE guild_id = ? AND status = 'serving' ORDER BY started_at ASC`,
      [guildId],
    );
  }

  countByStatusSync(guildId, status) {
    const row = this.db.get(
      'SELECT COUNT(*) AS total FROM attendance WHERE guild_id = ? AND status = ?',
      [guildId, status],
    );
    return Number(row?.total || 0);
  }

  /** Próximo da fila respeitando ordem de chegada (exclui quem saiu do servidor). */
  peekNextSync(guildId) {
    return this.db.get(
      `SELECT * FROM attendance
        WHERE guild_id = ? AND status = 'waiting'
        ORDER BY queue_seq ASC, id ASC LIMIT 1`,
      [guildId],
    );
  }

  updateSync(guildId, id, fields) {
    const allowed = [
      'protocol',
      'username',
      'status',
      'outcome',
      'staff_id',
      'staff_tag',
      'started_at',
      'ended_at',
      'wait_seconds',
      'duration_seconds',
      'queue_seq',
      'voice_channel_id',
      'presence_confirmed',
      'order_override',
      'order_reason',
      'hold_reason',
      'note',
      'closed_by',
      'last_position_notified',
      'wait_channel_id',
    ];
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!allowed.includes(key)) throw new Error(`Campo inválido no update: ${key}`);
      sets.push(`${key} = ?`);
      params.push(value);
    }
    if (sets.length === 0) return this.findByIdSync(guildId, id);
    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(guildId, Number(id));
    this.db.run(`UPDATE attendance SET ${sets.join(', ')} WHERE guild_id = ? AND id = ?`, params);
    return this.findByIdSync(guildId, id);
  }

  /** Lista encerrados em um período (para estatísticas/histórico). */
  listFinishedByPeriodSync(guildId, from, to, { limit = 5000 } = {}) {
    return this.db.all(
      `SELECT * FROM attendance
        WHERE guild_id = ? AND status = 'finished' AND ended_at >= ? AND ended_at < ?
        ORDER BY ended_at DESC LIMIT ?`,
      [guildId, from, to, limit],
    );
  }

  listAllFinishedSync(guildId, { limit = 100 } = {}) {
    return this.db.all(
      `SELECT * FROM attendance WHERE guild_id = ? AND status = 'finished'
        ORDER BY ended_at DESC LIMIT ?`,
      [guildId, limit],
    );
  }

  listActiveSync(guildId) {
    return this.db.all(
      `SELECT * FROM attendance WHERE guild_id = ? AND status IN ('waiting', 'hold', 'serving')
        ORDER BY queue_seq ASC`,
      [guildId],
    );
  }

  /** Histórico completo de um jogador. */
  listByUserSync(guildId, userId, { limit = 20 } = {}) {
    return this.db.all(
      'SELECT * FROM attendance WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?',
      [guildId, userId, limit],
    );
  }

  /** Cálculo de espera média com base em atendimentos recentes. */
  averageWaitSync(guildId, since, field = 'wait_seconds') {
    const row = this.db.get(
      `SELECT AVG(${field}) AS avg_value, COUNT(*) AS total FROM attendance
        WHERE guild_id = ? AND status = 'finished' AND wait_seconds IS NOT NULL
          AND ended_at >= ?`,
      [guildId, since],
    );
    return { average: Number(row?.avg_value || 0), total: Number(row?.total || 0) };
  }
}

module.exports = { AttendanceRepository };
