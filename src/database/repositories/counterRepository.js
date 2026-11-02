'use strict';

/**
 * Contadores atômicos (protocolo de atendimento, sequência da fila).
 * Todas as chamadas devem ocorrer dentro de transações do banco.
 */
class CounterRepository {
  constructor(db) {
    this.db = db;
  }

  nextSync(name) {
    this.db.run(
      `INSERT INTO counters (name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1`,
      [name],
    );
    const row = this.db.get('SELECT value FROM counters WHERE name = ?', [name]);
    return Number(row.value);
  }

  peek(name) {
    const row = this.db.get('SELECT value FROM counters WHERE name = ?', [name]);
    return row ? Number(row.value) : 0;
  }

  async next(name) {
    return this.db.transaction(async () => this.nextSync(name));
  }
}

module.exports = { CounterRepository };
