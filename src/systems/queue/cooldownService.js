'use strict';

const { AppError, ERRORS } = require('../../services/errors');
const { formatDuration } = require('../../utils/time');

/**
 * Regra: quem entra na fila (pelo painel ou pelo canal de voz) e sai antes de
 * ser chamado só pode voltar depois de X minutos (padrão 10).
 */
class CooldownService {
  constructor({ db, repo, settings }) {
    this.db = db;
    this.repo = repo;
    this.settings = settings;
  }

  get minutes() {
    const value = this.settings.get('rejoin_cooldown_minutes');
    return Number.isFinite(value) ? value : 10;
  }

  /**
   * @returns {{active: boolean, remainingSeconds: number, until: number|null, reason: string|null}}
   */
  check(guildId, userId, now = Date.now()) {
    if (this.minutes <= 0) {
      return { active: false, remainingSeconds: 0, until: null, reason: null };
    }
    const row = this.repo.getSync(guildId, userId);
    if (!row) return { active: false, remainingSeconds: 0, until: null, reason: null };

    const remaining = Number(row.until) - now;
    if (remaining <= 0) return { active: false, remainingSeconds: 0, until: null, reason: null };

    return {
      active: true,
      remainingSeconds: Math.ceil(remaining / 1000),
      until: Number(row.until),
      reason: row.reason ?? null,
    };
  }

  /** Aplica o bloqueio (chamado quando o jogador desiste antes de ser chamado). */
  async apply({ guildId, userId, reason = null, now = Date.now() }) {
    if (this.minutes <= 0) return null;
    const until = now + this.minutes * 60000;
    await this.db.transaction(async () => this.repo.setSync(guildId, userId, { until, reason }));
    return { until, minutes: this.minutes };
  }

  async clear(guildId, userId) {
    await this.db.transaction(async () => this.repo.clearSync(guildId, userId));
  }

  /** Mensagem uniforme para o jogador. */
  message(info) {
    return (
      `⏳ Você saiu da fila antes de ser chamado. Aguarde **${formatDuration(info.remainingSeconds)}** ` +
      'para entrar novamente.'
    );
  }

  /** Lança erro de domínio quando o jogador está bloqueado. */
  assertAllowed(guildId, userId) {
    const info = this.check(guildId, userId);
    if (!info.active) return;
    throw new AppError(ERRORS.EM_COOLDOWN, this.message(info), {
      remainingSeconds: info.remainingSeconds,
      until: info.until,
    });
  }
}

module.exports = { CooldownService };
