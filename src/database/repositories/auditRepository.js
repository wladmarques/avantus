'use strict';

class AuditRepository {
  constructor(db) {
    this.db = db;
  }

  insertSync({ guildId, type, actorId = null, actorTag = null, targetId = null, protocol = null, message, metadata = null }) {
    this.db.run(
      `INSERT INTO audit_events (guild_id, type, actor_id, actor_tag, target_id, protocol, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [guildId, type, actorId, actorTag, targetId, protocol, message, metadata ? JSON.stringify(metadata) : null, Date.now()],
    );
  }

  listByProtocolSync(guildId, protocol) {
    return this.db.all(
      'SELECT * FROM audit_events WHERE guild_id = ? AND protocol = ? ORDER BY created_at ASC',
      [guildId, Number(protocol)],
    );
  }

  listRecentSync(guildId, { limit = 50, type = null } = {}) {
    if (type) {
      return this.db.all(
        'SELECT * FROM audit_events WHERE guild_id = ? AND type = ? ORDER BY created_at DESC LIMIT ?',
        [guildId, type, limit],
      );
    }
    return this.db.all(
      'SELECT * FROM audit_events WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?',
      [guildId, limit],
    );
  }
}

module.exports = { AuditRepository };
