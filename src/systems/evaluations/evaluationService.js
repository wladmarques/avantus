'use strict';

const { AppError, ERRORS } = require('../../services/errors');
const { ATTENDANCE_STATUS, RATING_META, COLORS } = require('../../config/theme');
const { card } = require('../../dashboard/embeds/cards');
const {
  resolvePeriod,
  formatDateTime,
  formatDuration,
  dayKey,
  startOfDay,
  addDays,
  tzParts,
} = require('../../utils/time');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('evaluations');

const VALID_RATINGS = Object.keys(RATING_META);
const RATING_ORDER = VALID_RATINGS;

/** Segunda-feira da semana da data informada (AAAA-MM-DD, fuso do bot). */
function weekStartKey(reference = Date.now(), timeZone = undefined) {
  const { weekday } = tzParts(new Date(reference), timeZone);
  const offsetToMonday = weekday === 0 ? -6 : 1 - weekday;
  return dayKey(addDays(new Date(reference), offsetToMonday), timeZone);
}

class EvaluationService {
  constructor({ db, repos, settings, audit, gateway = null, notifications = null }) {
    this.db = db;
    this.repos = repos;
    this.settings = settings;
    this.audit = audit;
    this.gateway = gateway;
    this.notifications = notifications;
  }

  /* ------------------------------------------------------------------ */
  /* Canal de avaliações                                                 */
  /* ------------------------------------------------------------------ */

  /** Canal configurado para receber as avaliações (null = não publica). */
  get channelId() {
    const value = this.settings.get('evaluation_channel_id');
    return value ? String(value).trim() || null : null;
  }

  async setChannelId(channelId) {
    const value = channelId ? String(channelId).trim() : null;
    if (value && !/^\d{5,25}$/.test(value)) {
      throw new Error('ID de canal inválido (use o ID numérico do Discord).');
    }
    await this.settings.set('evaluation_channel_id', value);
    return value;
  }

  /** Publica a avaliação no canal configurado. Nunca lança erro. */
  async publish(guildId, evaluation, { attendance = null } = {}) {
    const channelId = this.channelId;
    if (!channelId || !this.gateway?.sendChannelMessage) return false;

    const meta = RATING_META[evaluation.rating] ?? RATING_META.REGULAR;
    const protocol = String(evaluation.protocol).padStart(4, '0');
    const duration = Number(attendance?.duration_seconds) || 0;

    const embed = card({
      title: `${meta.emoji} Nova avaliação`,
      description: [
        `**Nota:** ${meta.label} · ${meta.score}/4`,
        `**Protocolo:** #${protocol}`,
        `**Jogador:** <@${evaluation.user_id}>${attendance?.username ? ` (${attendance.username})` : ''}`,
        `**Atendente:** ${evaluation.staff_id ? `<@${evaluation.staff_id}>` : evaluation.staff_tag ?? 'não registrado'}`,
        duration ? `**Duração do atendimento:** ${formatDuration(duration)}` : null,
        `**Avaliado em:** ${formatDateTime(new Date(evaluation.created_at))}`,
      ]
        .filter(Boolean)
        .join('\n'),
      color: meta.color ?? COLORS.PURPLE,
      footer: 'VANTUS • Avaliações',
    });

    try {
      await this.gateway.sendChannelMessage(guildId, channelId, { embeds: [embed] });
      return true;
    } catch (error) {
      logger.warn(`Não foi possível publicar a avaliação no canal ${channelId}: ${error.message}`);
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Envio da avaliação                                                 */
  /* ------------------------------------------------------------------ */

  async submit({ guildId, userId, attendanceId, rating }) {
    if (!VALID_RATINGS.includes(rating)) {
      throw new AppError(ERRORS.ERRO_INTERNO, 'Avaliação inválida.');
    }

    const { result, attendance } = await this.db.transaction(() => {
      const row = this.repos.attendance.findByIdSync(guildId, attendanceId);
      if (!row) throw new AppError(ERRORS.ATENDIMENTO_NAO_ENCONTRADO, 'Atendimento não encontrado.');
      if (row.user_id !== userId) {
        throw new AppError(ERRORS.ERRO_INTERNO, 'Esta avaliação não pertence a você.');
      }
      if (row.status !== ATTENDANCE_STATUS.FINISHED) {
        throw new AppError(ERRORS.ATENDIMENTO_NAO_EM_ANDAMENTO, 'O atendimento ainda não foi encerrado.');
      }
      const existing = this.repos.evaluations.findByAttendanceSync(guildId, row.id);
      if (existing) {
        throw new AppError(ERRORS.ERRO_INTERNO, 'Você já avaliou este atendimento. Obrigado!');
      }

      const created = this.repos.evaluations.createSync({
        guildId,
        attendanceId: row.id,
        protocol: row.protocol,
        userId,
        staffId: row.staff_id,
        staffTag: row.staff_tag,
        rating,
      });
      return { result: created, attendance: row };
    });

    await this.audit.log({
      guildId,
      type: 'EVALUATION',
      actorId: userId,
      targetId: result.staff_id,
      protocol: result.protocol,
      message: `⭐ O jogador avaliou o atendimento #${String(result.protocol).padStart(4, '0')} como **${RATING_META[rating].label}**.`,
      color: RATING_META[rating].color ?? COLORS.PURPLE,
      metadata: { rating, staffId: result.staff_id },
    });

    // Canal de avaliações (setting `evaluation_channel_id`).
    await this.publish(guildId, result, { attendance });
    await this.maybeAlertLowAverage(guildId);

    return result;
  }

  /**
   * Avaliação pelo comando `/avaliar` — usada quando o jogador fechou a DM.
   * Aceita o protocolo ou o ID do atendimento.
   */
  async submitByProtocol({ guildId, userId, protocol = null, attendanceId = null, rating }) {
    let row = null;
    if (attendanceId) row = this.repos.attendance.findByIdSync(guildId, Number(attendanceId));
    if (!row && protocol) {
      row = this.repos.attendance.findByProtocolSync(guildId, Number(protocol));
    }
    if (!row && !protocol && !attendanceId) {
      // Sem protocolo: pega o atendimento encerrado mais recente sem nota.
      row = this.pending(guildId, userId, { limit: 1 })[0] ?? null;
      if (!row) {
        throw new AppError(
          ERRORS.ATENDIMENTO_NAO_ENCONTRADO,
          'Você não tem atendimentos aguardando avaliação.',
        );
      }
    }
    if (!row) throw new AppError(ERRORS.ATENDIMENTO_NAO_ENCONTRADO, 'Atendimento não encontrado.');
    if (row.user_id !== userId) {
      throw new AppError(ERRORS.ERRO_INTERNO, 'Esta avaliação não pertence a você.');
    }
    return this.submit({ guildId, userId, attendanceId: row.id, rating });
  }

  /* ------------------------------------------------------------------ */
  /* Aviso de média baixa                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Publica um aviso no canal de avaliações quando a média dos últimos 7 dias
   * fica abaixo de `evaluations_alert_min_average` (0 = desligado).
   * Um aviso por semana (`evaluations_alert_last_week`), para não virar spam.
   */
  async maybeAlertLowAverage(guildId, { now = Date.now(), timeZone = undefined } = {}) {
    const threshold = Number(this.settings.get('evaluations_alert_min_average')) || 0;
    if (threshold <= 0) return null;

    const channelId = this.channelId;
    if (!channelId || !this.gateway?.sendChannelMessage) return null;

    const minSample = Number(this.settings.get('evaluations_alert_min_sample')) || 3;
    const weekKey = weekStartKey(now, timeZone);
    if (this.settings.get('evaluations_alert_last_week') === weekKey) return null;

    const weekAgo = startOfDay(new Date(now), timeZone) - 6 * 86400000;
    const stats = this.stats(guildId, { from: weekAgo, to: now });
    if (stats.total < minSample || stats.average === null) return null;
    if (stats.average >= threshold) return null;

    const worst = [...stats.byStaff].sort((a, b) => (a.average ?? 4) - (b.average ?? 4))[0] ?? null;
    const embed = card({
      title: '⚠️ Média das avaliações abaixo do esperado',
      description: [
        `**Média dos últimos 7 dias:** ${stats.average.toFixed(2)}/4 (limite ${threshold.toFixed(2)})`,
        `**Avaliações:** ${stats.total} • **Notas boas:** ${stats.positiveRate ?? 0}%`,
        worst && worst.average !== null
          ? `**Menor média:** ${worst.staffName || `<@${worst.staffId}>`} — ${worst.average.toFixed(2)}/4 (${worst.total})`
          : null,
        '',
        'Vale revisar os atendimentos recentes com a equipe.',
      ]
        .filter(Boolean)
        .join('\n'),
      color: COLORS.WARNING,
      footer: 'VANTUS • Avaliações',
    });

    try {
      await this.gateway.sendChannelMessage(guildId, channelId, { embeds: [embed] });
      await this.settings.set('evaluations_alert_last_week', weekKey);
      logger.warn(
        `Média das avaliações em ${stats.average.toFixed(2)}/4 (limite ${threshold}) — aviso enviado ao canal ${channelId}.`,
      );
      await this.audit
        .log({
          guildId,
          type: 'EVALUATION_ALERT',
          message:
            `⚠️ **Média das avaliações abaixo do esperado:** ${stats.average.toFixed(2)}/4 ` +
            `(limite ${threshold.toFixed(2)}, ${stats.total} avaliação(ões) nos últimos 7 dias).`,
          color: COLORS.WARNING,
          metadata: { average: stats.average, threshold, total: stats.total },
        })
        .catch(() => null);
      return { average: stats.average, threshold, total: stats.total, weekKey };
    } catch (error) {
      logger.warn(`Não foi possível publicar o aviso de avaliações: ${error.message}`);
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Consultas                                                           */
  /* ------------------------------------------------------------------ */

  summary(guildId, period = '30d') {
    const range = resolvePeriod(period);
    const entries = this.repos.evaluations.listByPeriodSync(guildId, range.from, range.to, {
      limit: 20000,
    });
    const byRating = entries.reduce((acc, row) => {
      acc[row.rating] = (acc[row.rating] || 0) + 1;
      return acc;
    }, {});
    const byStaff = this.repos.evaluations.byStaffSync(guildId, range.from, range.to);
    return { range, total: entries.length, byRating, byStaff, recent: entries.slice(0, 10) };
  }

  /** Atendimentos finalizados que o jogador ainda pode avaliar (mais recente primeiro). */
  pending(guildId, userId, { limit = 5 } = {}) {
    if (!userId) return [];
    return this.repos.evaluations.pendingByUserSync(guildId, String(userId), { limit });
  }

  /** Avaliações em ordem (mais recentes primeiro) — usado pelo painel web. */
  list(guildId, { from, to, limit = 200, staffId = null } = {}) {
    const entries = this.repos.evaluations.listByPeriodSync(guildId, from, to, {
      limit: staffId ? 20000 : limit,
    });
    const filtered = staffId ? entries.filter((row) => row.staff_id === String(staffId)) : entries;
    return filtered.slice(0, limit);
  }

  /** Média (0–4), distribuição e ranking por staff no período. */
  stats(guildId, { from, to, staffId = null }) {
    const all = this.repos.evaluations.listByPeriodSync(guildId, from, to, { limit: 20000 });
    const entries = staffId ? all.filter((row) => row.staff_id === String(staffId)) : all;
    const byRating = {};
    for (const key of RATING_ORDER) byRating[key] = 0;
    let score = 0;
    for (const row of entries) {
      byRating[row.rating] = (byRating[row.rating] ?? 0) + 1;
      score += RATING_META[row.rating]?.score ?? 0;
    }
    const positive = (byRating.MUITO_BOM ?? 0) + (byRating.BOM ?? 0);
    return {
      total: entries.length,
      average: entries.length ? Number((score / entries.length).toFixed(2)) : null,
      positiveRate: entries.length ? Math.round((positive / entries.length) * 100) : null,
      byRating,
      byStaff: this.repos.evaluations.byStaffSync(guildId, from, to).map((row) => ({
        staffId: row.staff_id,
        staffName: row.staff_tag ?? null,
        total: Number(row.total) || 0,
        average: row.avg_score === null ? null : Number(Number(row.avg_score).toFixed(2)),
      })),
    };
  }
}

module.exports = { EvaluationService, VALID_RATINGS, RATING_ORDER, weekStartKey };
