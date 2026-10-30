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
