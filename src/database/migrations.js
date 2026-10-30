'use strict';

/**
 * Migrações versionadas. Cada entrada roda uma única vez (controle em
 * schema_migrations) e é aplicada dentro de uma transação.
 */
const migrations = [
  {
    version: 1,
    name: 'estrutura_inicial',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS counters (
          name TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS attendance (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          protocol INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          staff_id TEXT,
          staff_tag TEXT,
          status TEXT NOT NULL,
          outcome TEXT,
          joined_at INTEGER NOT NULL,
          started_at INTEGER,
          ended_at INTEGER,
          wait_seconds INTEGER,
          duration_seconds INTEGER,
          queue_seq INTEGER NOT NULL,
          wait_channel_id TEXT,
          voice_channel_id TEXT,
          presence_confirmed INTEGER NOT NULL DEFAULT 0,
          order_override INTEGER NOT NULL DEFAULT 0,
          order_reason TEXT,
          hold_reason TEXT,
          note TEXT,
          closed_by TEXT,
          last_position_notified INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS ux_attendance_protocol
          ON attendance(guild_id, protocol);

        CREATE UNIQUE INDEX IF NOT EXISTS ux_attendance_active_user
          ON attendance(guild_id, user_id)
          WHERE status IN ('waiting', 'hold', 'serving');

        CREATE INDEX IF NOT EXISTS ix_attendance_queue
          ON attendance(guild_id, status, queue_seq);

        CREATE INDEX IF NOT EXISTS ix_attendance_period
          ON attendance(guild_id, joined_at, ended_at);

        CREATE TABLE IF NOT EXISTS staff_status (
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          status TEXT NOT NULL,
          manual INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          updated_by TEXT,
          PRIMARY KEY (guild_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS evaluations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          attendance_id INTEGER NOT NULL,
          protocol INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          staff_id TEXT,
          staff_tag TEXT,
          rating TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (attendance_id) REFERENCES attendance(id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS ux_evaluations_attendance
          ON evaluations(attendance_id);

        CREATE INDEX IF NOT EXISTS ix_evaluations_period
          ON evaluations(guild_id, created_at);

        CREATE TABLE IF NOT EXISTS audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          type TEXT NOT NULL,
          actor_id TEXT,
          actor_tag TEXT,
          target_id TEXT,
          protocol INTEGER,
          message TEXT NOT NULL,
          metadata TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS ix_audit_period
          ON audit_events(guild_id, created_at);

        CREATE TABLE IF NOT EXISTS panels (
          key TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          channel_id TEXT,
          message_id TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (key, guild_id)
        );
      `);
    },
  },
  {
    version: 2,
    name: 'indices_de_desempenho',
    up(db) {
      db.exec(`
        -- Regra "um atendimento por staff" é aplicada na camada de serviço
        -- (pode ser liberada pela configuração allow_staff_multi).
        DROP INDEX IF EXISTS ux_attendance_serving_staff;

        CREATE INDEX IF NOT EXISTS ix_attendance_staff
          ON attendance(guild_id, staff_id, status);

        CREATE INDEX IF NOT EXISTS ix_attendance_outcome
          ON attendance(guild_id, outcome, ended_at);

        CREATE INDEX IF NOT EXISTS ix_audit_type
          ON audit_events(guild_id, type, created_at);
      `);
    },
  },
  {
    version: 3,
    name: 'formato_dos_paineis',
    up(db) {
      // Guarda o layout publicado ('v2' = Components V2, 'embed' = clássico)
      // para o bot saber quando precisa recriar a mensagem após trocar o estilo.
      db.exec('ALTER TABLE panels ADD COLUMN format TEXT;');
    },
  },
  {
    version: 4,
    name: 'cooldown_de_reentrada',
    up(db) {
      // Quem sai da fila antes de ser chamado fica bloqueado por um tempo.
      db.exec(`
        CREATE TABLE IF NOT EXISTS cooldowns (
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          until INTEGER NOT NULL,
          reason TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (guild_id, user_id)
        );

        CREATE INDEX IF NOT EXISTS ix_cooldowns_until ON cooldowns(guild_id, until);
      `);
    },
  },
];

/**
 * Aplica as migrações pendentes.
 * @param {import('./connection').Database} db
 */
async function runMigrations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER NOT NULL);');
  const appliedRows = db.all('SELECT version FROM schema_migrations');
  const applied = new Set(appliedRows.map((row) => Number(row.version)));

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    await db.transaction(async () => {
      migration.up(db);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        Date.now(),
      ]);
    });
  }

  const pending = migrations.filter((m) => !applied.has(m.version));
  return { applied: pending.map((m) => m.name), currentVersion: migrations.at(-1)?.version ?? 0 };
}

module.exports = { runMigrations, migrations };
