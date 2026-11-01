'use strict';

const { AppError, ERRORS } = require('../../services/errors');
const { ATTENDANCE_STATUS, RATING_META, COLORS } = require('../../config/theme');
const { resolvePeriod } = require('../../utils/time');

const VALID_RATINGS = Object.keys(RATING_META);

class EvaluationService {
  constructor({ db, repos, settings, audit }) {
    this.db = db;
    this.repos = repos;
    this.settings = settings;
    this.audit = audit;
  }

  async submit({ guildId, userId, attendanceId, rating }) {
    if (!VALID_RATINGS.includes(rating)) {
      throw new AppError(ERRORS.ERRO_INTERNO, 'Avaliação inválida.');
    }

    const result = await this.db.transaction(() => {
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

      return this.repos.evaluations.createSync({
        guildId,
        attendanceId: row.id,
        protocol: row.protocol,
        userId,
        staffId: row.staff_id,
        staffTag: row.staff_tag,
        rating,
      });
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

    return result;
  }

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
}

module.exports = { EvaluationService, VALID_RATINGS };
