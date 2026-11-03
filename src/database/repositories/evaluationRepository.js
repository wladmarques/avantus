'use strict';

class EvaluationRepository {
  constructor(db) {
    this.db = db;
  }

  createSync({ guildId, attendanceId, protocol, userId, staffId, staffTag, rating }) {
    this.db.run(
      `INSERT INTO evaluations (guild_id, attendance_id, protocol, user_id, staff_id, staff_tag, rating, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [guildId, attendanceId, protocol, userId, staffId ?? null, staffTag ?? null, rating, Date.now()],
    );
    return this.findByAttendanceSync(guildId, attendanceId);
  }

  findByAttendanceSync(guildId, attendanceId) {
    return this.db.get(
      'SELECT * FROM evaluations WHERE guild_id = ? AND attendance_id = ?',
      [guildId, Number(attendanceId)],
    );
  }

  /** Atendimentos finalizados do jogador que ainda não foram avaliados. */
  pendingByUserSync(guildId, userId, { limit = 5 } = {}) {
    return this.db.all(
      `SELECT a.* FROM attendance a
        LEFT JOIN evaluations e ON e.guild_id = a.guild_id AND e.attendance_id = a.id
        WHERE a.guild_id = ? AND a.user_id = ? AND a.status = 'finished' AND e.id IS NULL
        ORDER BY a.id DESC LIMIT ?`,
      [guildId, String(userId), limit],
    );
  }

  listByPeriodSync(guildId, from, to, { limit = 200 } = {}) {
    return this.db.all(
      `SELECT * FROM evaluations WHERE guild_id = ? AND created_at >= ? AND created_at < ?
        ORDER BY created_at DESC LIMIT ?`,
      [guildId, from, to, limit],
    );
  }

  summarySync(guildId, from, to) {
    return this.db.all(
      `SELECT rating, COUNT(*) AS total, staff_id, staff_tag
        FROM evaluations WHERE guild_id = ? AND created_at >= ? AND created_at < ?
        GROUP BY rating`,
      [guildId, from, to],
    );
  }

  byStaffSync(guildId, from, to) {
    return this.db.all(
      `SELECT staff_id, staff_tag, COUNT(*) AS total, AVG(
          CASE rating
            WHEN 'MUITO_BOM' THEN 4
            WHEN 'BOM' THEN 3
            WHEN 'REGULAR' THEN 2
            ELSE 1
          END
        ) AS avg_score
        FROM evaluations
        WHERE guild_id = ? AND created_at >= ? AND created_at < ? AND staff_id IS NOT NULL
        GROUP BY staff_id, staff_tag ORDER BY total DESC`,
      [guildId, from, to],
    );
  }
}

module.exports = { EvaluationRepository };
