'use strict';

const { STAFF_STATUS, STAFF_STATUS_META } = require('../../config/theme');
const { AppError, ERRORS } = require('../../services/errors');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('staff');

// Rajadas de sincronização (evento de cargo + timer) viram uma única consulta.
const ROLE_SYNC_MIN_INTERVAL_MS = 20 * 1000;

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
    this.roleSyncError = new Map();
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
   *
   * Regra de ouro: **nunca trocar um cache bom por um vazio por causa de erro
   * de API**. Se a consulta falhar (rate limit, queda do gateway) ou voltar
   * vazia, mantemos a última lista conhecida — senão o painel esconde a equipe
   * inteira, os "Disponíveis" caem para 0 e a entrada na fila fecha sozinha
   * até a próxima sincronização ("sumiu todo mundo e voltou do nada").
   *
   * @returns {Promise<Map<string, string[]>|null>} cargos por membro
   */
  async refreshRoleCache(guildId, { force = false } = {}) {
    if (typeof this.gateway?.listMemberRoles !== 'function') return null;

    // Sem filtro configurado o cache não é usado: nem vale gastar uma consulta.
    const roleIds = this.panelRoleIds();
    if (roleIds.length === 0) {
      this.roleCache.delete(guildId);
      this.roleCacheAt.delete(guildId);
      this.roleSyncError.delete(guildId);
      return null;
    }

    const previous = this.roleCache.get(guildId) ?? null;
    const lastAt = this.roleCacheAt.get(guildId) ?? 0;
    if (!force && previous && Date.now() - lastAt < ROLE_SYNC_MIN_INTERVAL_MS) {
      return previous;
    }

    let roles = null;
    try {
      roles = await this.gateway.listMemberRoles(guildId, { roleIds });
    } catch (error) {
      roles = null;
      this.roleSyncError.set(guildId, error.message);
    }

    if (!roles) {
      this.roleSyncError.set(guildId, this.roleSyncError.get(guildId) ?? 'lista de membros indisponível');
      logger.warn(
        'Não foi possível sincronizar os cargos do painel da equipe; mantendo a última lista conhecida.',
      );
      return previous;
    }

    // Resposta vazia com equipe já conhecida é sinal de problema (API parcial),
    // não de "todo mundo perdeu o cargo": preserva a lista anterior.
    if (roles.size === 0 && previous && previous.size > 0) {
      this.roleSyncError.set(guildId, 'lista de membros vazia');
      logger.warn(
        'Sincronização de cargos voltou vazia; mantendo a equipe anterior no painel (evita sumir todo mundo).',
      );
      return previous;
    }

    this.roleCache.set(guildId, roles);
    this.roleCacheAt.set(guildId, Date.now());
    this.roleSyncError.delete(guildId);
    return roles;
  }

  /**
   * IDs de quem **faz parte da escala** (tem algum cargo de `staff_panel_role_ids`,
   * ex.: `1566903220968624188`).
   *
   * Diferente de `listForPanel`, aqui não há fallback: se o filtro não está
   * configurado ou o cache de cargos ainda não chegou, devolve `null` e quem
   * chama decide o que fazer (o painel web cai na regra "tem turno cadastrado").
   *
   * @returns {Set<string>|null}
   */
  rosterIds(guildId) {
    const roleIds = this.panelRoleIds();
    if (roleIds.length === 0) return null;
    const cache = this.roleCache.get(guildId);
    if (!cache) return null;
    const ids = new Set();
    for (const [userId, roles] of cache) {
      if (Array.isArray(roles) && roles.some((roleId) => roleIds.includes(roleId))) ids.add(userId);
    }
    return ids;
  }

  /**
   * Lista para o painel da equipe: aplica o filtro de cargos quando configurado.
   * Sem cache carregado (cold start) não esconde ninguém, e o filtro nunca
   * esvazia a EQUIPE inteira por causa de cache incompleto.
   */
  listForPanel(guildId) {
    const rows = this.list(guildId);
    const roleIds = this.panelRoleIds();
    if (roleIds.length === 0) return rows;

    const cache = this.roleCache.get(guildId);
    if (!cache) return rows;

    const filtered = rows.filter((row) => {
      const roles = cache.get(row.userId);
      if (!roles) return false; // não é membro do servidor (ou saiu)
      return roles.some((roleId) => roleIds.includes(roleId));
    });

    if (filtered.length === 0 && rows.length > 0) {
      logger.warn(
        'Filtro de cargos esvaziaria a EQUIPE do painel; mantendo todos os staff registrados.',
      );
      return rows;
    }
    return filtered;
  }

  /** Estado do cache de cargos (usado pelo /diagnostico). */
  roleCacheInfo(guildId) {
    const cache = this.roleCache.get(guildId);
    const at = this.roleCacheAt.get(guildId) ?? null;
    return {
      synced: Boolean(cache),
      members: cache ? cache.size : 0,
      ageSeconds: at ? Math.max(0, Math.round((Date.now() - at) / 1000)) : null,
      error: this.roleSyncError.get(guildId) ?? null,
      roleIds: this.panelRoleIds(),
    };
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
