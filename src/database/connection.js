'use strict';

/**
 * Camada de conexão SQLite.
 *
 * Usa `sql.js` (SQLite compilado para WebAssembly): nenhuma dependência nativa,
 * nenhum banco externo. O arquivo do banco fica no armazenamento persistente da
 * SquareCloud (pasta da aplicação) e sobrevive a reinicializações e deploys.
 *
 * Gravação atômica: export -> arquivo temporário -> fsync -> rename.
 * Todas as escritas passam por um mutex assíncrono, garantindo que duas
 * operações nunca se intercalem (atomicidade das operações da fila).
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { createLogger } = require('../utils/logger');

const logger = createLogger('database');

class Mutex {
  constructor() {
    this._tail = Promise.resolve();
  }

  run(task) {
    const result = this._tail.then(task, task);
    // mantém a fila viva mesmo se a task falhar
    this._tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class Database {
  constructor({ SQL, filePath, raw }) {
    this.SQL = SQL;
    this.filePath = filePath;
    this.raw = raw;
    this.lock = new Mutex();
    this._lastBackup = 0;
    this._closed = false;
  }

  /* ------------------------------------------------------------------ */
  /* Consultas                                                           */
  /* ------------------------------------------------------------------ */

  all(sql, params = []) {
    const stmt = this.raw.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(sql, params = []) {
    const rows = this.all(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  run(sql, params = []) {
    const stmt = this.raw.prepare(sql);
    try {
      stmt.bind(params);
      stmt.step();
    } finally {
      stmt.free();
    }
    return {
      changes: this.raw.getRowsModified(),
      lastInsertRowid: this._lastInsertRowid(),
    };
  }

  _lastInsertRowid() {
    const row = this.get('SELECT last_insert_rowid() AS id');
    return row ? Number(row.id) : 0;
  }

  exec(sql) {
    this.raw.run(sql);
  }

  /**
   * Executa um bloco de operações de forma atômica e serializada.
   * Se `fn` lançar erro, a transação é revertida e nada é persistido.
   */
  async transaction(fn) {
    return this.lock.run(async () => {
      this.raw.run('BEGIN IMMEDIATE');
      try {
        const result = await fn();
        this.raw.run('COMMIT');
        await this.persist();
        return result;
      } catch (error) {
        try {
          this.raw.run('ROLLBACK');
        } catch (rollbackError) {
          logger.error('Falha ao reverter transação', rollbackError);
        }
        throw error;
      }
    });
  }

  /** Executa uma leitura dentro do mutex (consistência). */
  async read(fn) {
    return this.lock.run(async () => fn());
  }

  /* ------------------------------------------------------------------ */
  /* Persistência                                                        */
  /* ------------------------------------------------------------------ */

  async persist() {
    if (this._closed) return;
    const data = Buffer.from(this.raw.export());
    const tmpPath = `${this.filePath}.tmp`;
    const handle = await fsp.open(tmpPath, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmpPath, this.filePath);

    const now = Date.now();
    if (now - this._lastBackup > 5 * 60 * 1000) {
      this._lastBackup = now;
      await fsp.copyFile(this.filePath, `${this.filePath}.bak`).catch((err) => {
        logger.warn('Não foi possível gerar backup do banco', err.message);
      });
    }
  }

  async close() {
    if (this._closed) return;
    await this.persist();
    this._closed = true;
    this.raw.close();
  }

  /* ------------------------------------------------------------------ */
  /* Manutenção                                                          */
  /* ------------------------------------------------------------------ */

  /** Cópia física do banco (usada pelo comando /backup). */
  async snapshot(destination) {
    const data = Buffer.from(this.raw.export());
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, data);
    return destination;
  }
}

/**
 * Abre (ou cria) o banco de dados.
 * @param {{filePath: string}} options
 */
async function openDatabase({ filePath }) {
  const SQL = await initSqlJs();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });

  let raw = null;
  if (fs.existsSync(filePath)) {
    try {
      raw = new SQL.Database(await fsp.readFile(filePath));
      // valida integridade mínima
      raw.exec('SELECT count(*) FROM sqlite_master;');
      logger.info(`Banco carregado de ${filePath}`);
    } catch (error) {
      logger.error(`Banco corrompido em ${filePath}, tentando backup...`, error.message);
      raw = null;
    }
  }

  if (!raw && fs.existsSync(`${filePath}.bak`)) {
    try {
      raw = new SQL.Database(await fsp.readFile(`${filePath}.bak`));
      raw.exec('SELECT count(*) FROM sqlite_master;');
      logger.warn(`Banco restaurado a partir do backup ${filePath}.bak`);
    } catch (error) {
      logger.error('Backup também está inválido', error.message);
      raw = null;
    }
  }

  if (!raw) {
    raw = new SQL.Database();
    logger.info(`Novo banco criado em ${filePath}`);
  }

  raw.run('PRAGMA foreign_keys = ON;');
  const db = new Database({ SQL, filePath, raw });
  return db;
}

module.exports = { openDatabase, Database, Mutex };
