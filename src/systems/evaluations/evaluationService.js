'use strict';

const { AppError, ERRORS } = require('../../services/errors');
const { ATTENDANCE_STATUS, RATING_META, COLORS } = require('../../config/theme');
const { card } = require('../../dashboard/embeds/cards');
const { resolvePeriod, formatDateTime, formatDuration } = require('../../utils/time');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('evaluations');

const VALID_RATINGS = Object.keys(RATING_META);
const RATING_ORDER = VALID_RATINGS;

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
    if (!row) throw new AppError(ERRORS.ATENDIMENTO_NAO_ENCONTRADO, 'Atendimento não encontrado.');
    if (row.user_id !== userId) {
      throw new AppError(ERRORS.ERRO_INTERNO, 'Esta avaliação não pertence a você.');
    }
    return this.submit({ guildId, userId, attendanceId: row.id, rating });
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

  /** Avaliações em ordem (mais recentes primeiro) — usado pelo painel web. */
  list(guildId, { from, to, limit = 200 } = {}) {
    return this.repos.evaluations.listByPeriodSync(guildId, from, to, { limit });
  }

  /** Média (0–4), distribuição e ranking por staff no período. */
  stats(guildId, { from, to }) {
    const entries = this.repos.evaluations.listByPeriodSync(guildId, from, to, { limit: 20000 });
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

module.exports = { EvaluationService, VALID_RATINGS, RATING_ORDER };
