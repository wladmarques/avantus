'use strict';

/**
 * Banco de horas da equipe.
 *
 * Regras:
 * - O tempo é contado enquanto o staff está **em serviço**: a sessão abre quando
 *   ele fica DISPONÍVEL e fecha quando passa para AUSENTE/INDISPONÍVEL
 *   (EM_ATENDIMENTO mantém a sessão aberta).
 * - Atraso = diferença entre o início real e o início do turno planejado.
 * - Saída antecipada = diferença entre o fim do turno e a saída real.
 * - Aviso por DM configurável (padrão 5 minutos) antes do turno começar.
 */
const { createLogger } = require('../../utils/logger');
const { formatDuration, formatTime, formatDate, dayKey, startOfDay, addDays, tzParts } = require('../../utils/time');
const { STAFF_STATUS } = require('../../config/theme');
const {
  normalizeShift,
  toShift,
  findActiveShift,
  findNextShift,
  shiftsByWeekday,
  latenessFor,
  earlyLeaveFor,
  minutesToHHMM,
} = require('./shiftSchedule');

const logger = createLogger('hourbank');

const DEFAULT_REMINDER_MINUTES = 5;
const DEFAULT_MAX_SESSION_HOURS = 12;

/** Converte "YYYY-MM-DD" em timestamp da meia-noite local. */
function parseDayStart(value, timeZone) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0);
  return startOfDay(new Date(utc), timeZone);
}

class HourBankService {
  constructor({ db, repo, settings, gateway = null, notifications = null, staff = null, timeZone = undefined }) {
    this.db = db;
    this.repo = repo;
    this.settings = settings;
    this.gateway = gateway;
    this.notifications = notifications;
    this.staff = staff;
    this.timeZone = timeZone;
    this.timer = null;
  }

  /* ------------------------------------------------------------------ */
  /* Configuração                                                        */
  /* ------------------------------------------------------------------ */

  get enabled() {
    const value = this.settings.get('hour_bank_enabled');
    return value === undefined ? true : Boolean(value);
  }

  get reminderMinutes() {
    const value = Number(this.settings.get('hour_bank_reminder_minutes'));
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_REMINDER_MINUTES;
  }

  get maxSessionHours() {
    const value = Number(this.settings.get('hour_bank_max_session_hours'));
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_SESSION_HOURS;
  }

  /* ------------------------------------------------------------------ */
  /* Escala                                                              */
  /* ------------------------------------------------------------------ */

  listShifts(guildId, userId = undefined) {
    return this.repo.listShiftsSync(guildId, userId ?? null).map(toShift);
  }

  /**
   * Salva a escala semanal de um staff (substitui a anterior).
   * @param {{guildId: string, userId: string, staffName?: string, shifts: Array<{weekday:number,start:string,end:string}>}} params
   */
  async setSchedule({ guildId, userId, staffName = null, shifts = [] }) {
    const normalized = shifts.map(normalizeShift);
    await this.db.transaction(async () => {
      this.repo.replaceShiftsSync(guildId, userId, staffName, normalized);
      // O nome vale mesmo sem turno cadastrado (staff recém-adicionado).
      if (staffName) this.repo.upsertNameSync(guildId, userId, staffName, 'painel');
    });
    return this.listShifts(guildId, userId);
  }

  /* ------------------------------------------------------------------ */
  /* Nome exibido                                                        */
  /* ------------------------------------------------------------------ */

  /** Nomes exibidos por staff: Map<userId, nome>. */
  names(guildId) {
    const map = new Map();
    for (const row of this.repo.listNamesSync(guildId)) {
      if (row.staff_name) map.set(row.user_id, row.staff_name);
    }
    return map;
  }

  nameOf(guildId, userId) {
    const row = this.repo.findNameSync(guildId, userId);
    return row?.staff_name ?? null;
  }

  /**
   * Define o nome do staff pelo painel. String vazia/null remove o nome manual
   * (o painel volta a usar o nome do Discord).
   * @returns {Promise<string|null>}
   */
  async setDisplayName({ guildId, userId, staffName = null }) {
    const clean = typeof staffName === 'string' ? staffName.trim().replace(/\s+/g, ' ') : '';
    await this.db.transaction(async () => {
      if (clean) {
        this.repo.upsertNameSync(guildId, userId, clean.slice(0, 60), 'painel');
        // Mantém a escala coerente com o nome novo.
        this.db.run('UPDATE staff_shifts SET staff_name = ? WHERE guild_id = ? AND user_id = ?', [
          clean.slice(0, 60),
          guildId,
          userId,
        ]);
      } else {
        this.repo.deleteNameSync(guildId, userId);
      }
    });
    return clean ? clean.slice(0, 60) : null;
  }

  /** Nome vindo do próprio Discord (não sobrescreve um nome definido no painel). */
  rememberDiscordName(guildId, userId, staffName) {
    const clean = typeof staffName === 'string' ? staffName.trim() : '';
    if (!clean) return null;
    return this.repo.upsertNameSync(guildId, userId, clean.slice(0, 60), 'discord');
  }

  async clearSchedule({ guildId, userId }) {
    await this.db.transaction(async () => this.repo.deleteShiftsSync(guildId, userId));
  }

  /** Escala agrupada por dia (para o painel). */
  weeklySchedule(guildId, userId) {
    return shiftsByWeekday(this.listShifts(guildId, userId));
  }

  /* ------------------------------------------------------------------ */
  /* Sessões                                                             */
  /* ------------------------------------------------------------------ */

  activeSession(guildId, userId) {
    const row = this.repo.findOpenSync(guildId, userId);
    if (!row) return null;
    return { ...row, elapsedSeconds: Math.max(0, Math.floor((Date.now() - row.started_at) / 1000)) };
  }

  /**
   * Abre a sessão de trabalho (idempotente).
   * @returns {Promise<object|null>} sessão aberta
   */
  async startSession({ guildId, userId, staffName = null, source = 'disponivel', at = Date.now() }) {
    if (!this.enabled) return null;
    const existing = this.repo.findOpenSync(guildId, userId);
    if (existing) return existing;

    const shifts = this.listShifts(guildId, userId);
    const active = findActiveShift(shifts, at, this.timeZone);
    const lateMinutes = active ? latenessFor(active, at) : 0;

    let resolvedName = staffName ?? shifts[0]?.staffName ?? null;
    if (!resolvedName && this.gateway?.getMember) {
      const member = await this.gateway.getMember(guildId, userId).catch(() => null);
      resolvedName = member?.displayName ?? null;
    }

    const created = await this.db.transaction(async () =>
      this.repo.openSync(guildId, userId, {
        staffName: resolvedName,
        startedAt: at,
        source,
        shift: active
          ? { shiftId: active.shift.shiftId, startTs: active.startTs, endTs: active.endTs, lateMinutes }
          : null,
      }),
    );

    logger.info(
      `[banco de horas] ${resolvedName ?? userId} começou a contar${lateMinutes ? ` (atraso de ${lateMinutes} min)` : ''}.`,
    );
    return created;
  }

  /**
   * Fecha a sessão aberta (idempotente).
   * @returns {Promise<object|null>} sessão fechada
   */
  async endSession({ guildId, userId, at = Date.now() }) {
    const open = this.repo.findOpenSync(guildId, userId);
    if (!open) return null;

    const endedAt = Math.max(at, open.started_at);
    const minutes = Math.max(0, Math.round((endedAt - open.started_at) / 60000));
    const shift =
      open.scheduled_start !== null && open.scheduled_start !== undefined
        ? { startTs: Number(open.scheduled_start), endTs: Number(open.scheduled_end) }
        : null;
    const earlyLeaveMinutes = shift ? earlyLeaveFor(shift, endedAt) : 0;

    const closed = await this.db.transaction(async () =>
      this.repo.closeSync(open.id, { endedAt, minutes, earlyLeaveMinutes }),
    );
    logger.info(
      `[banco de horas] ${open.staff_name ?? userId} encerrou a sessão com ${formatDuration(minutes * 60)}.`,
    );
    return closed;
  }

  /**
   * Chamado quando o status do staff muda: abre/fecha a sessão conforme a
   * presença em serviço. Nunca lança erro para não travar a troca de status.
   */
  async syncStatus({ guildId, userId, staffName = null, status }) {
    if (!this.enabled) return null;
    try {
      if (status === STAFF_STATUS.DISPONIVEL) {
        return await this.startSession({ guildId, userId, staffName, source: 'status:disponivel' });
      }
      if (status === STAFF_STATUS.AUSENTE || status === STAFF_STATUS.INDISPONIVEL) {
        return await this.endSession({ guildId, userId });
      }
      // EM_ATENDIMENTO: continua contando (o staff segue em serviço).
      return null;
    } catch (error) {
      logger.error('Falha ao sincronizar o banco de horas com o status', error);
      return null;
    }
  }

  /** Fecha sessões esquecidas abertas (proteção contra queda do bot). */
  async closeStaleSessions(guildId, now = Date.now()) {
    const limit = this.maxSessionHours * 3600000;
    const open = this.repo.listOpenSync(guildId).filter((row) => now - row.started_at > limit);
    for (const row of open) {
      await this.endSession({ guildId, userId: row.user_id, at: row.started_at + limit });
      logger.warn(
        `[banco de horas] Sessão de ${row.staff_name ?? row.user_id} fechada automaticamente (limite de ${this.maxSessionHours}h).`,
      );
    }
    return open.length;
  }

  /* ------------------------------------------------------------------ */
  /* Avisos antes do turno                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Procura turnos que começam dentro da antecedência configurada e devolve os
   * que ainda não receberam aviso.
   */
  dueReminders(guildId, now = Date.now()) {
    const minutes = this.reminderMinutes;
    if (minutes <= 0) return [];

    const horizon = minutes * 60000;
    const shifts = this.listShifts(guildId);
    const byUser = new Map();
    for (const shift of shifts) {
      if (!byUser.has(shift.userId)) byUser.set(shift.userId, []);
      byUser.get(shift.userId).push(shift);
    }

    const due = [];
    for (const [userId, userShifts] of byUser) {
      const next = findNextShift(userShifts, now, {
        horizonMs: horizon + 60 * 1000,
        timeZone: this.timeZone,
      });
      if (!next) continue;
      // Só avisa se o turno começa daqui a até X minutos (e ainda não começou).
      const diff = next.startTs - now;
      if (diff < 0 || diff > horizon) continue;
      if (this.repo.wasReminderSentSync(guildId, userId, next.shift.shiftId, next.dayKey)) continue;
      due.push({ userId, staffName: next.shift.staffName, occurrence: next, minutesAhead: Math.round(diff / 60000) });
    }
    return due;
  }

  /** Envia os avisos pendentes por DM. */
  async dispatchReminders(guildId, now = Date.now()) {
    const due = this.dueReminders(guildId, now);
    for (const item of due) {
      const { occurrence } = item;
      try {
        if (this.notifications?.shiftReminder) {
          await this.notifications.shiftReminder({
            guildId,
            userId: item.userId,
            shift: occurrence.shift,
            startsAt: occurrence.startTs,
            minutesAhead: this.reminderMinutes,
          });
        }
        await this.db.transaction(async () =>
          this.repo.markReminderSentSync(
            guildId,
            item.userId,
            occurrence.shift.shiftId,
            occurrence.dayKey,
            now,
          ),
        );
      } catch (error) {
        logger.warn(`Falha ao avisar ${item.userId} sobre o turno: ${error.message}`);
      }
    }
    return due.length;
  }

  /** Watcher de 1 minuto: avisos + fechamento de sessões esquecidas. */
  startWatcher(guildId, { intervalMs = 60000 } = {}) {
    const tick = async () => {
      try {
        await this.dispatchReminders(guildId);
        await this.closeStaleSessions(guildId);
        this.repo.purgeRemindersSync();
      } catch (error) {
        logger.error('Falha no watcher do banco de horas', error);
      }
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    this.timer = timer;
    return () => clearInterval(timer);
  }

  stopWatcher() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ------------------------------------------------------------------ */
  /* Relatórios                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Relatório de horas por staff no período.
   * @param {{guildId: string, from?: string, to?: string}} params datas YYYY-MM-DD
   */
  report(guildId, { from = null, to = null, now = Date.now() } = {}) {
    const toTs = parseDayStart(to, this.timeZone);
    const fromTs = parseDayStart(from, this.timeZone);
    const startTs = fromTs ?? startOfDay(new Date(now - 6 * 24 * 3600000), this.timeZone);
    const endTs = toTs ? toTs + 24 * 3600000 - 1 : now;

    const rows = this.repo.listSessionsSync(guildId, { from: startTs, to: endTs });
    const shifts = this.listShifts(guildId);
    const names = this.names(guildId);
    const shiftsByUser = new Map();
    for (const shift of shifts) {
      if (!shiftsByUser.has(shift.userId)) shiftsByUser.set(shift.userId, []);
      shiftsByUser.get(shift.userId).push(shift);
    }

    const byUser = new Map();
    for (const row of rows) {
      const key = row.user_id;
      if (!byUser.has(key)) {
        byUser.set(key, {
          userId: row.user_id,
          staffName: row.staff_name ?? null,
          totalMinutes: 0,
          sessions: 0,
          lateCount: 0,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          scheduledMinutes: 0,
          firstStart: null,
          lastEnd: null,
          days: new Map(),
        });
      }
      const entry = byUser.get(key);
      const endedAt = row.ended_at ?? now;
      const minutes = row.minutes !== null && row.minutes !== undefined
        ? Number(row.minutes)
        : Math.max(0, Math.round((endedAt - row.started_at) / 60000));

      entry.staffName = entry.staffName ?? row.staff_name ?? null;
      entry.totalMinutes += minutes;
      entry.sessions += 1;
      entry.lateMinutes += Number(row.late_minutes) || 0;
      entry.earlyLeaveMinutes += Number(row.early_leave_minutes) || 0;
      if ((Number(row.late_minutes) || 0) > 0) entry.lateCount += 1;
      if (row.scheduled_start && row.scheduled_end) {
        entry.scheduledMinutes += Math.round((Number(row.scheduled_end) - Number(row.scheduled_start)) / 60000);
      }
      if (entry.firstStart === null || row.started_at < entry.firstStart) entry.firstStart = row.started_at;
      if (entry.lastEnd === null || endedAt > entry.lastEnd) entry.lastEnd = endedAt;

      const key2 = dayKey(new Date(row.started_at), this.timeZone);
      const day = entry.days.get(key2) ?? { day: key2, minutes: 0, sessions: 0 };
      day.minutes += minutes;
      day.sessions += 1;
      entry.days.set(key2, day);
    }

    // Staff com escala ou só com nome cadastrado continua aparecendo no painel.
    for (const [userId, userShifts] of shiftsByUser) {
      if (byUser.has(userId)) continue;
      byUser.set(userId, {
        userId,
        staffName: names.get(userId) ?? userShifts[0]?.staffName ?? null,
        totalMinutes: 0,
        sessions: 0,
        lateCount: 0,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        scheduledMinutes: 0,
        firstStart: null,
        lastEnd: null,
        days: new Map(),
      });
    }

    for (const userId of names.keys()) {
      if (byUser.has(userId)) continue;
      byUser.set(userId, {
        userId,
        staffName: names.get(userId),
        totalMinutes: 0,
        sessions: 0,
        lateCount: 0,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        scheduledMinutes: 0,
        firstStart: null,
        lastEnd: null,
        days: new Map(),
      });
    }

    // Nome salvo no painel/Discord tem prioridade sobre o nome congelado na sessão.
    for (const entry of byUser.values()) {
      entry.staffName = names.get(entry.userId) ?? entry.staffName ?? null;
    }

    const staff = [...byUser.values()]
      .map((entry) => ({
        ...entry,
        days: [...entry.days.values()].sort((a, b) => a.day.localeCompare(b.day)),
        totalLabel: formatDuration(entry.totalMinutes * 60),
        averageLabel: entry.sessions ? formatDuration((entry.totalMinutes / entry.sessions) * 60) : '0s',
        entryLabel: entry.firstStart ? formatTime(new Date(entry.firstStart)) : '—',
        exitLabel: entry.lastEnd ? formatTime(new Date(entry.lastEnd)) : '—',
        shifts: (shiftsByUser.get(entry.userId) ?? []).map((shift) => ({
          weekday: shift.weekday,
          weekdayLabel: shift.weekdayLabel,
          start: shift.start,
          end: shift.end,
          overnight: shift.overnight,
          durationMinutes: shift.durationMinutes,
        })),
      }))
      .sort((a, b) => b.totalMinutes - a.totalMinutes || String(a.staffName).localeCompare(String(b.staffName)));

    return {
      period: {
        from: formatDate(new Date(startTs), this.timeZone),
        to: formatDate(new Date(endTs), this.timeZone),
        fromTs: startTs,
        toTs: endTs,
      },
      totals: {
        minutes: staff.reduce((sum, item) => sum + item.totalMinutes, 0),
        sessions: staff.reduce((sum, item) => sum + item.sessions, 0),
        lateCount: staff.reduce((sum, item) => sum + item.lateCount, 0),
        lateMinutes: staff.reduce((sum, item) => sum + item.lateMinutes, 0),
        staffCount: staff.length,
      },
      staff,
    };
  }

  /** Sessões detalhadas (entrada/saída/atraso) de um staff ou de todos. */
  sessions(guildId, { userId = null, from = null, to = null, now = Date.now() } = {}) {
    const toTs = parseDayStart(to, this.timeZone);
    const fromTs = parseDayStart(from, this.timeZone);
    const startTs = fromTs ?? startOfDay(new Date(now - 6 * 24 * 3600000), this.timeZone);
    const endTs = toTs ? toTs + 24 * 3600000 - 1 : now;

    return this.repo
      .listSessionsSync(guildId, { from: startTs, to: endTs, userId })
      .map((row) => {
        const endedAt = row.ended_at ?? null;
        const minutes = row.minutes !== null && row.minutes !== undefined
          ? Number(row.minutes)
          : Math.max(0, Math.round(((endedAt ?? now) - row.started_at) / 60000));
        return {
          id: row.id,
          userId: row.user_id,
          staffName: row.staff_name ?? null,
          day: dayKey(new Date(row.started_at), this.timeZone),
          startedAt: row.started_at,
          endedAt,
          entry: formatTime(new Date(row.started_at), this.timeZone),
          exit: endedAt ? formatTime(new Date(endedAt), this.timeZone) : null,
          minutes,
          label: formatDuration(minutes * 60),
          lateMinutes: Number(row.late_minutes) || 0,
          earlyLeaveMinutes: Number(row.early_leave_minutes) || 0,
          open: endedAt === null,
          scheduledStart: row.scheduled_start
            ? formatTime(new Date(Number(row.scheduled_start)), this.timeZone)
            : null,
          scheduledEnd: row.scheduled_end
            ? formatTime(new Date(Number(row.scheduled_end)), this.timeZone)
            : null,
          source: row.source ?? null,
        };
      });
  }

  /** Situação resumida de um staff (usada no comando /banco). */
  summary(guildId, userId, { now = Date.now() } = {}) {
    const todayStart = startOfDay(new Date(now), this.timeZone);
    const weekStart = todayStart - 6 * 24 * 3600000;
    const today = this.repo.listSessionsSync(guildId, { from: todayStart, to: now, userId });
    const week = this.repo.listSessionsSync(guildId, { from: weekStart, to: now, userId });
    const sum = (rows) =>
      rows.reduce((total, row) => {
        const minutes = row.minutes !== null && row.minutes !== undefined
          ? Number(row.minutes)
          : Math.max(0, Math.round(((row.ended_at ?? now) - row.started_at) / 60000));
        return total + minutes;
      }, 0);

    const lateMinutes = week.reduce((total, row) => total + (Number(row.late_minutes) || 0), 0);
    const lateCount = week.filter((row) => (Number(row.late_minutes) || 0) > 0).length;
    const active = this.activeSession(guildId, userId);
    const next = findNextShift(this.listShifts(guildId, userId), now, { timeZone: this.timeZone });
    const p = tzParts(new Date(now), this.timeZone);

    return {
      todayMinutes: sum(today),
      weekMinutes: sum(week),
      weekSessions: week.length,
      lateMinutes,
      lateCount,
      active,
      nextShift: next
        ? {
            weekdayLabel: next.shift.weekdayLabel,
            start: next.shift.start,
            end: next.shift.end,
            dayKey: next.dayKey,
            startTs: next.startTs,
            minutesAhead: Math.round((next.startTs - now) / 60000),
          }
        : null,
      shifts: this.listShifts(guildId, userId),
      todayLabel: formatDate(new Date(now), this.timeZone),
      nowLabel: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`,
      todayStart,
      weekStart,
    };
  }

  /** Visão completa para o painel web: staff + status + escala + horas. */
  overview(guildId, { now = Date.now(), from = null, to = null } = {}) {
    if (!this.staff) return { staff: [], report: this.report(guildId, { from, to, now }) };

    const report = this.report(guildId, { from, to, now });
    const reportByUser = new Map(report.staff.map((item) => [item.userId, item]));
    const names = this.names(guildId);
    const shifts = this.listShifts(guildId);
    const shiftsByUser = new Map();
    for (const shift of shifts) {
      if (!shiftsByUser.has(shift.userId)) shiftsByUser.set(shift.userId, []);
      shiftsByUser.get(shift.userId).push(shift);
    }

    const staffRows = new Map();
    for (const row of this.staff.list(guildId)) {
      staffRows.set(row.userId, {
        userId: row.userId,
        staffName: null,
        status: row.status,
        statusLabel: row.meta?.label ?? row.status,
        available: row.status === STAFF_STATUS.DISPONIVEL,
      });
    }
    for (const userId of [...shiftsByUser.keys(), ...names.keys()]) {
      if (!staffRows.has(userId)) {
        staffRows.set(userId, {
          userId,
          staffName: null,
          status: STAFF_STATUS.INDISPONIVEL,
          statusLabel: 'SEM STATUS',
          available: false,
        });
      }
    }

    const staff = [...staffRows.values()].map((row) => {
      const userShifts = shiftsByUser.get(row.userId) ?? [];
      const activeShift = findActiveShift(userShifts, now, this.timeZone);
      const activeSession = this.activeSession(guildId, row.userId);
      const next = findNextShift(userShifts, now, { timeZone: this.timeZone });
      const stats = reportByUser.get(row.userId);
      return {
        ...row,
        staffName:
          names.get(row.userId) ??
          row.staffName ??
          userShifts[0]?.staffName ??
          stats?.staffName ??
          null,
        shifts: userShifts.map((shift) => ({
          weekday: shift.weekday,
          weekdayLabel: shift.weekdayLabel,
          start: shift.start,
          end: shift.end,
          overnight: shift.overnight,
        })),
        weekly: shiftsByWeekday(userShifts).map((day) => ({
          weekday: day.weekday,
          label: day.label,
          short: day.short,
          shifts: day.shifts.map((shift) => ({ start: shift.start, end: shift.end })),
        })),
        currentShift: activeShift
          ? {
              start: minutesToHHMM(activeShift.shift.startMinutes),
              end: minutesToHHMM(activeShift.shift.endMinutes),
              startLabel: formatTime(new Date(activeShift.startTs), this.timeZone),
              endLabel: formatTime(new Date(activeShift.endTs), this.timeZone),
            }
          : null,
        nextShift: next
          ? {
              dayKey: next.dayKey,
              start: next.shift.start,
              end: next.shift.end,
              startTs: next.startTs,
              minutesAhead: Math.round((next.startTs - now) / 60000),
            }
          : null,
        session: activeSession
          ? {
              startedAt: activeSession.started_at,
              entry: formatTime(new Date(activeSession.started_at), this.timeZone),
              elapsedSeconds: activeSession.elapsedSeconds,
              lateMinutes: Number(activeSession.late_minutes) || 0,
            }
          : null,
        totals: {
          minutes: stats?.totalMinutes ?? 0,
          label: stats?.totalLabel ?? '0s',
          sessions: stats?.sessions ?? 0,
          lateMinutes: stats?.lateMinutes ?? 0,
          lateCount: stats?.lateCount ?? 0,
          earlyLeaveMinutes: stats?.earlyLeaveMinutes ?? 0,
          entryLabel: stats?.entryLabel ?? '—',
          exitLabel: stats?.exitLabel ?? '—',
        },
      };
    });

    staff.sort((a, b) => Number(b.available) - Number(a.available) || b.totals.minutes - a.totals.minutes);

    return {
      generatedAt: now,
      period: report.period,
      totals: report.totals,
      staff,
    };
  }

  /** Limpa sessões antigas do banco (manutenção opcional). */
  async purgeSessionsBefore(guildId, timestamp) {
    await this.db.transaction(async () =>
      this.db.run('DELETE FROM staff_sessions WHERE guild_id = ? AND ended_at IS NOT NULL AND ended_at < ?', [
        guildId,
        timestamp,
      ]),
    );
  }

  /** Último dia útil (para testes/relatórios): meia-noite local deslocada. */
  dayStart(offsetDays = 0, now = Date.now()) {
    return startOfDay(addDays(new Date(now), offsetDays), this.timeZone);
  }
}

module.exports = { HourBankService, parseDayStart, DEFAULT_REMINDER_MINUTES, DEFAULT_MAX_SESSION_HOURS };
