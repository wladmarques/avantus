'use strict';

const { STAFF_STATUS, STAFF_STATUS_META } = require('../../config/theme');

/**
 * Disponibilidade da equipe.
 * - DISPONIVEL / AUSENTE / INDISPONIVEL podem ser definidos manualmente.
 * - EM_ATENDIMENTO é aplicado automaticamente pelo sistema (manual = 0).
 */
class StaffService {
  constructor({ db, repo, gateway, hourBank = null }) {
    this.db = db;
    this.repo = repo;
    this.gateway = gateway;
    this.hourBank = hourBank;
  }

  /** Mantém o banco de horas alinhado com o status (nunca lança erro). */
  async _syncHourBank(guildId, userId, status) {
    if (!this.hourBank?.syncStatus) return null;
    try {
      return await this.hourBank.syncStatus({ guildId, userId, status });
    } catch {
      return null;
    }
  }

  async setStatus({ guildId, userId, status, updatedBy = null, manual = true }) {
    if (!STAFF_STATUS_META[status]) throw new Error(`Status inválido: ${status}`);
    const row = await this.db.transaction(async () =>
      this.repo.upsertSync(guildId, userId, { status, manual: manual ? 1 : 0, updatedBy }),
    );
    await this._syncHourBank(guildId, userId, status);
    return row;
  }

  async markBusy(guildId, userId) {
    const row = await this.db.transaction(async () =>
      this.repo.upsertSync(guildId, userId, {
        status: STAFF_STATUS.EM_ATENDIMENTO,
        manual: 0,
        updatedBy: 'sistema',
      }),
    );
    await this._syncHourBank(guildId, userId, STAFF_STATUS.EM_ATENDIMENTO);
    return row;
  }

  /** Libera o staff após um atendimento, respeitando status manual. */
  async release(guildId, userId, { autoAvailable = true } = {}) {
    const current = this.repo.getSync(guildId, userId);
    if (!autoAvailable) return current;
    // Se o staff definiu manualmente AUSENTE/INDISPONIVEL, respeitamos.
    if (current && current.manual === 1 && current.status !== STAFF_STATUS.EM_ATENDIMENTO) {
      return current;
    }
    const row = await this.db.transaction(async () =>
      this.repo.upsertSync(guildId, userId, {
        status: STAFF_STATUS.DISPONIVEL,
        manual: 0,
        updatedBy: 'sistema',
      }),
    );
    await this._syncHourBank(guildId, userId, STAFF_STATUS.DISPONIVEL);
    return row;
  }

  async markUnavailableFromVoice(guildId, userId) {
    const current = this.repo.getSync(guildId, userId);
    if (current && current.status === STAFF_STATUS.AUSENTE) return current;
    const row = await this.db.transaction(async () =>
      this.repo.upsertSync(guildId, userId, {
        status: STAFF_STATUS.INDISPONIVEL,
        manual: 0,
        updatedBy: 'sistema',
      }),
    );
    await this._syncHourBank(guildId, userId, STAFF_STATUS.INDISPONIVEL);
    return row;
  }

  get(guildId, userId) {
    const row = this.repo.getSync(guildId, userId);
    return {
      userId,
      status: row ? row.status : STAFF_STATUS.INDISPONIVEL,
      manual: row ? row.manual === 1 : false,
      updatedAt: row ? row.updated_at : null,
      updatedBy: row ? row.updated_by : null,
    };
  }

  list(guildId) {
    return this.repo.listSync(guildId).map((row) => ({
      userId: row.user_id,
      status: row.status,
      manual: row.manual === 1,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      meta: STAFF_STATUS_META[row.status] ?? STAFF_STATUS_META.INDISPONIVEL,
    }));
  }

  counts(guildId) {
    const list = this.repo.listSync(guildId);
    const result = {
      total: list.length,
      [STAFF_STATUS.DISPONIVEL]: 0,
      [STAFF_STATUS.EM_ATENDIMENTO]: 0,
      [STAFF_STATUS.AUSENTE]: 0,
      [STAFF_STATUS.INDISPONIVEL]: 0,
    };
    for (const row of list) {
      if (result[row.status] !== undefined) result[row.status] += 1;
    }
    return result;
  }

  async setManualStatusForAll(guildId, status, updatedBy) {
    const userIds = this.repo.listSync(guildId).map((row) => row.user_id);
    const result = await this.db.transaction(async () => this.repo.resetAllToSync(guildId, status, updatedBy));
    for (const userId of userIds) await this._syncHourBank(guildId, userId, status);
    return result;
  }
}

module.exports = { StaffService };
