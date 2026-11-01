'use strict';

const { SETTINGS, serializeValue, deserializeValue, defaultSettings } = require('../../config/settings');

/**
 * Configurações persistidas no banco com cache em memória.
 * Somente leituras (get/getAll) são síncronas; escritas são serializadas
 * pelo mutex do banco.
 */
class SettingsRepository {
  constructor(db) {
    this.db = db;
    this.cache = null;
  }

  /** Carrega (ou recarrega) todo o conjunto de configurações. */
  load() {
    const rows = this.db.all('SELECT key, value FROM settings');
    const values = defaultSettings();
    for (const row of rows) {
      const def = SETTINGS[row.key];
      values[row.key] = def ? deserializeValue(row.value, def.default) : deserializeValue(row.value, null);
    }
    this.cache = values;
    return values;
  }

  ensureDefaults() {
    const existing = new Set(this.db.all('SELECT key FROM settings').map((r) => r.key));
    const now = Date.now();
    for (const [key, value] of Object.entries(defaultSettings())) {
      if (existing.has(key)) continue;
      this.db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [
        key,
        serializeValue(value),
        now,
      ]);
    }
    this.load();
  }

  get(key) {
    if (!this.cache) this.load();
    if (!(key in SETTINGS)) return undefined;
    return this.cache[key];
  }

  getAll() {
    if (!this.cache) this.load();
    return { ...this.cache };
  }

  /** Requer que já estejamos dentro de uma transação. */
  setSync(key, value) {
    const now = Date.now();
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, serializeValue(value), now],
    );
    if (!this.cache) this.load();
    this.cache[key] = value;
  }

  async set(key, value) {
    await this.db.transaction(async () => {
      this.setSync(key, value);
    });
    return value;
  }

  async setMany(entries) {
    await this.db.transaction(async () => {
      for (const [key, value] of Object.entries(entries)) {
        if (!(key in SETTINGS)) throw new Error(`Configuração desconhecida: ${key}`);
        this.setSync(key, value);
      }
    });
  }
}

module.exports = { SettingsRepository };
