'use strict';

const { STAFF_STATUS, STAFF_STATUS_META } = require('../../config/theme');
const { AppError, ERRORS } = require('../../services/errors');

/**
 * Disponibilidade da equipe.
 * - DISPONIVEL / AUSENTE / INDISPONIVEL podem ser definidos manualmente.
 * - EM_ATENDIMENTO é aplicado automaticamente pelo sistema (manual = 0).
 */
class StaffService {
  constructor({ db, repo, gateway, hourBank = null, settings = null }) {
    this.db = db;
    this.repo = repo;
    this.gateway = gateway;
    this.hourBank = hourBank;
    this.settings = settings;
    // Cargos por membro (userId → [roleId]), carregados do Discord.
    this.roleCache = new Map();
    this.roleCacheAt = new Map();
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
    // Staff bloqueado pela administração não pode entrar em serviço.
    if (status === STAFF_STATUS.DISPONIVEL && this.isBlocked(guildId, userId)) {
      throw new AppError(
        ERRORS.STAFF_BLOQUEADO,
        'Seu acesso ao serviço está bloqueado pela administração. Fale com um administrador.',
      );
    }
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
    // Bloqueado volta para INDISPONÍVEL, nunca para disponível.
    if (current && current.blocked === 1) {
      const row = await this.db.transaction(async () =>
        this.repo.upsertSync(guildId, userId, {
          status: STAFF_STATUS.INDISPONIVEL,
          manual: 1,
          updatedBy: 'sistema (bloqueado)',
        }),
      );
      await this._syncHourBank(guildId, userId, STAFF_STATUS.INDISPONIVEL);
      return row;
    }
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
      blocked: row ? row.blocked === 1 : false,
      blockedAt: row?.blocked_at ?? null,
      blockedBy: row?.blocked_by ?? null,
      blockedReason: row?.blocked_reason ?? null,
    };
  }

  /** Staff bloqueado não entra em serviço (nem pelo Discord). */
  isBlocked(guildId, userId) {
    const row = this.repo.getSync(guildId, userId);
    return row ? row.blocked === 1 : false;
  }

  /** Liga/desliga o bloqueio (não mexe no status; use staffAdmin para isso). */
  async setBlocked(guildId, userId, { blocked, by = null, reason = null }) {
    await this.db.transaction(async () =>
      this.repo.setBlockedSync(guildId, userId, { blocked, by, reason }),
    );
    return this.get(guildId, userId);
  }

  /* ------------------------------------------------------------------ */
  /* Cargos exibidos no painel da equipe                                 */
  /* ------------------------------------------------------------------ */

  /** Cargos configurados para aparecer em EQUIPE (vazio = todos). */
  panelRoleIds() {
    const value = this.settings?.get ? this.settings.get('staff_panel_role_ids') : null;
    return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
  }

  /**
   * Recarrega os cargos dos membros no Discord.
   * Falha silenciosa: sem cache, o painel continua listando todos.
   */
  async refreshRoleCache(guildId) {
    if (typeof this.gateway?.listMemberRoles !== 'function') return null;
    try {
      const roles = await this.gateway.listMemberRoles(guildId);
      if (!roles) return null;
      this.roleCache.set(guildId, roles);
      this.roleCacheAt.set(guildId, Date.now());
      return roles;
    } catch {
      return null;
    }
  }

  /**
   * Lista para o painel da equipe: aplica o filtro de cargos quando configurado.
   * Sem cache carregado (cold start) não esconde ninguém.
   */
  listForPanel(guildId) {
    const rows = this.list(guildId);
    const roleIds = this.panelRoleIds();
    if (roleIds.length === 0) return rows;

    const cache = this.roleCache.get(guildId);
    if (!cache) return rows;

    return rows.filter((row) => {
      const roles = cache.get(row.userId);
      if (!roles) return false; // não é membro do servidor (ou saiu)
      return roles.some((roleId) => roleIds.includes(roleId));
    });
  }

  /** Contadores do painel a partir da lista já filtrada. */
  panelCounts(guildId, list = null) {
    const rows = list ?? this.listForPanel(guildId);
    const counts = {
      total: rows.length,
      [STAFF_STATUS.DISPONIVEL]: 0,
      [STAFF_STATUS.EM_ATENDIMENTO]: 0,
      [STAFF_STATUS.AUSENTE]: 0,
      [STAFF_STATUS.INDISPONIVEL]: 0,
    };
    for (const row of rows) {
      if (counts[row.status] !== undefined) counts[row.status] += 1;
    }
    return counts;
  }

  /** Estado do painel (lista + contadores) respeitando o filtro de cargos. */
  panelState(guildId) {
    const list = this.listForPanel(guildId);
    return { list, counts: this.panelCounts(guildId, list) };
  }

  list(guildId) {
    return this.repo.listSync(guildId).map((row) => ({
      userId: row.user_id,
      status: row.status,
      manual: row.manual === 1,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      blocked: row.blocked === 1,
      blockedAt: row.blocked_at ?? null,
      blockedReason: row.blocked_reason ?? null,
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
    // Bloqueados nunca são promovidos a DISPONÍVEL em massa.
    const userIds = this.repo
      .listSync(guildId)
      .filter((row) => !(status === STAFF_STATUS.DISPONIVEL && row.blocked === 1))
      .map((row) => row.user_id);
    const result = await this.db.transaction(async () =>
      this.repo.resetAllToSync(guildId, status, updatedBy, { skipBlocked: status === STAFF_STATUS.DISPONIVEL }),
    );
    for (const userId of userIds) await this._syncHourBank(guildId, userId, status);
    return result;
  }
}

module.exports = { StaffService };
