'use strict';

const { OUTCOMES } = require('../../config/theme');
const { resolvePeriod, dayKey, tzParts, formatDuration } = require('../../utils/time');

const RATING_SCORE = { MUITO_BOM: 4, BOM: 3, REGULAR: 2, RUIM: 1 };
const RATING_LABEL = { MUITO_BOM: 'Muito bom', BOM: 'Bom', REGULAR: 'Regular', RUIM: 'Ruim' };

/**
 * Relatórios e desempenho da equipe.
 * Todos os números vêm do banco (nenhum dado em memória).
 */
class StatisticsService {
  constructor({ db, repos, settings }) {
    this.db = db;
    this.repos = repos;
    this.settings = settings;
  }

  /** @param {string} guildId @param {string} period hoje|7d|30d|mes|total|custom */
  summary(guildId, period = 'hoje', custom = null) {
    const range = custom ?? resolvePeriod(period);
    const rows = this.repos.attendance.listFinishedByPeriodSync(guildId, range.from, range.to, {
      limit: 20000,
    });
    const evaluations = this.repos.evaluations.listByPeriodSync(guildId, range.from, range.to, {
      limit: 20000,
    });

    const byOutcome = rows.reduce((acc, row) => {
      acc[row.outcome] = (acc[row.outcome] || 0) + 1;
      return acc;
    }, {});

    const concluded = rows.filter((row) => row.outcome === OUTCOMES.CONCLUIDO);
    const waits = rows.map((row) => row.wait_seconds).filter((value) => Number.isFinite(value));
    const durations = concluded
      .map((row) => row.duration_seconds)
      .filter((value) => Number.isFinite(value) && value > 0);

    const ratings = evaluations.map((row) => RATING_SCORE[row.rating]).filter(Boolean);
    const byHour = new Array(24).fill(0);
    const byDayMap = new Map();
    for (const row of rows) {
      const parts = tzParts(new Date(row.joined_at));
      byHour[parts.hour] += 1;
      const key = dayKey(new Date(row.ended_at ?? row.joined_at));
      byDayMap.set(key, (byDayMap.get(key) || 0) + 1);
    }

    return {
      range,
      total: rows.length,
      concluded: concluded.length,
      byOutcome,
      desistencias: byOutcome[OUTCOMES.DESISTIU] ?? 0,
      cancelados: byOutcome[OUTCOMES.CANCELADO] ?? 0,
      removidos: byOutcome[OUTCOMES.REMOVIDO] ?? 0,
      naoCompareceu: byOutcome[OUTCOMES.NAO_COMPARECEU] ?? 0,
      desconectou: byOutcome[OUTCOMES.DESCONECTOU] ?? 0,
      staffDesconectou: byOutcome[OUTCOMES.STAFF_DESCONECTOU] ?? 0,
      avgWaitSeconds: average(waits),
      maxWaitSeconds: waits.length ? Math.max(...waits) : 0,
      avgDurationSeconds: average(durations),
      totalEvaluations: ratings.length,
      avgRating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0,
      byHour,
      byDay: [...byDayMap.entries()]
        .map(([date, total]) => ({ date, total }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      ranking: this.ranking(guildId, range, rows, evaluations),
      ratingDistribution: evaluations.reduce((acc, row) => {
        acc[row.rating] = (acc[row.rating] || 0) + 1;
        return acc;
      }, {}),
    };
  }

  ranking(guildId, range, rows, evaluations) {
    const minSample = this.settings.get('stats_ranking_min_sample') || 3;
    const staffMap = new Map();

    for (const row of rows) {
      if (!row.staff_id) continue;
      const entry = staffMap.get(row.staff_id) ?? {
        staffId: row.staff_id,
        staffTag: row.staff_tag,
        total: 0,
        concluded: 0,
        durations: [],
        waits: [],
        ratings: [],
      };
      entry.total += 1;
      if (row.outcome === OUTCOMES.CONCLUIDO) {
        entry.concluded += 1;
        if (Number.isFinite(row.duration_seconds)) entry.durations.push(row.duration_seconds);
      }
      if (Number.isFinite(row.wait_seconds)) entry.waits.push(row.wait_seconds);
      staffMap.set(row.staff_id, entry);
    }

    for (const evaluation of evaluations) {
      if (!evaluation.staff_id) continue;
      const entry = staffMap.get(evaluation.staff_id);
      if (!entry) continue;
      const score = RATING_SCORE[evaluation.rating];
      if (score) entry.ratings.push(score);
    }

    return [...staffMap.values()]
      .map((entry) => {
        const avgRating = entry.ratings.length ? average(entry.ratings) : 0;
        // Peso principal: volume concluído. A avaliação ajusta até 20%.
        // O tempo de atendimento é informativo e NÃO penaliza atendimentos longos.
        const score = entry.concluded * (0.8 + 0.2 * (avgRating / 4));
        return {
          staffId: entry.staffId,
          staffTag: entry.staffTag,
          total: entry.total,
          concluded: entry.concluded,
          avgDurationSeconds: average(entry.durations),
          avgWaitSeconds: average(entry.waits),
          evaluations: entry.ratings.length,
          avgRating,
          score: Number(score.toFixed(2)),
          eligible: entry.concluded >= minSample,
        };
      })
      .sort((a, b) => {
        if (b.eligible !== a.eligible) return b.eligible ? 1 : -1;
        if (b.score !== a.score) return b.score - a.score;
        return b.avgRating - a.avgRating;
      });
  }

  /** Totais do dia (usados no painel da staff). */
  todayOverview(guildId) {
    const summary = this.summary(guildId, 'hoje');
    return {
      concluded: summary.concluded,
      total: summary.total,
      avgWaitSeconds: summary.avgWaitSeconds,
      avgDurationSeconds: summary.avgDurationSeconds,
      avgRating: summary.avgRating,
      evaluations: summary.totalEvaluations,
    };
  }

  /** Bloco de texto pronto para os embeds. */
  formatSummary(summary) {
    const outcomes = Object.entries(summary.byOutcome)
      .map(([key, value]) => `• ${key.replaceAll('_', ' ').toLowerCase()}: **${value}**`)
      .join('\n');

    const hours = summary.byHour
      .map((total, hour) => ({ hour, total }))
      .filter((entry) => entry.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 3)
      .map((entry) => `${String(entry.hour).padStart(2, '0')}h (${entry.total})`)
      .join(', ');

    return {
      outcomes: outcomes || '—',
      peakHours: hours || '—',
      avgWait: formatDuration(summary.avgWaitSeconds),
      maxWait: formatDuration(summary.maxWaitSeconds),
      avgDuration: formatDuration(summary.avgDurationSeconds),
      rating: summary.totalEvaluations
        ? `${summary.avgRating.toFixed(2)} / 4 (${summary.totalEvaluations} avaliações)`
        : 'Sem avaliações',
      distribution: Object.entries(summary.ratingDistribution)
        .map(([rating, total]) => `${RATING_LABEL[rating] ?? rating}: **${total}**`)
        .join(' • ') || '—',
    };
  }
}

function average(list) {
  if (!list || list.length === 0) return 0;
  return list.reduce((total, value) => total + value, 0) / list.length;
}

module.exports = { StatisticsService, RATING_SCORE, RATING_LABEL };
