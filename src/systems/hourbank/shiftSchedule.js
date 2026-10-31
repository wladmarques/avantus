'use strict';

/**
 * Utilitários de escala do banco de horas.
 *
 * Turnos são guardados como `weekday` (0 = domingo … 6 = sábado) e minutos
 * desde 00:00. Um turno em que `end <= start` atravessa a meia-noite
 * (ex.: 22:00 → 02:00), exatamente como a agenda da central.
 */
const { startOfDay, addDays, dayKey, tzParts, DAY_KEYS, DAY_LABELS } = require('../../utils/time');

const MINUTES_IN_DAY = 24 * 60;
const WEEKDAY_LABELS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const WEEKDAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/** "HH:MM" → minutos desde 00:00 (null quando inválido). */
function parseHHMM(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Minutos → "HH:MM". */
function minutesToHHMM(minutes) {
  const safe = ((Math.round(Number(minutes) || 0) % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function durationMinutes(startMinutes, endMinutes) {
  const duration = (endMinutes - startMinutes + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  return duration === 0 ? MINUTES_IN_DAY : duration;
}

/** Normaliza um turno vindo do painel/comando. Lança erro quando inválido. */
function normalizeShift(input) {
  const weekday = Number(input?.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new Error('Dia da semana inválido (use 0 = domingo … 6 = sábado).');
  }
  const startMinutes = parseHHMM(input?.start);
  const endMinutes = parseHHMM(input?.end);
  if (startMinutes === null || endMinutes === null) {
    throw new Error('Horário inválido: use o formato HH:MM.');
  }
  if (startMinutes === endMinutes) {
    throw new Error('O horário de início e de fim não podem ser iguais.');
  }
  return { weekday, startMinutes, endMinutes };
}

/** Linha do banco → objeto de turno usado pelo serviço/painel. */
function toShift(row) {
  const weekday = Number(row.weekday);
  const startMinutes = Number(row.start_minutes);
  const endMinutes = Number(row.end_minutes);
  return {
    shiftId: Number(row.id),
    userId: row.user_id,
    staffName: row.staff_name ?? null,
    weekday,
    weekdayLabel: WEEKDAY_LABELS[weekday] ?? '—',
    weekdayShort: WEEKDAY_SHORT[weekday] ?? '—',
    startMinutes,
    endMinutes,
    start: minutesToHHMM(startMinutes),
    end: minutesToHHMM(endMinutes),
    durationMinutes: durationMinutes(startMinutes, endMinutes),
    overnight: endMinutes <= startMinutes,
  };
}

/** Meia-noite local deslocada em `offset` dias (referência estável para o turno). */
function localDayShifted(ts, offset, timeZone = undefined) {
  const midnight = startOfDay(new Date(ts), timeZone);
  return new Date(midnight + offset * 24 * 3600000);
}

/**
 * Janela real (timestamps) de uma ocorrência do turno.
 * @param {object} shift turno normalizado (`toShift`)
 * @param {Date|number} reference instante de referência
 * @param {number} dayOffset deslocamento em dias (-1 = ontem, 0 = hoje, 1 = amanhã)
 */
function occurrenceFor(shift, reference, dayOffset = 0, timeZone = undefined) {
  const ts = reference instanceof Date ? reference.getTime() : Number(reference);
  const day = localDayShifted(ts, dayOffset, timeZone);
  const startTs = startOfDay(day, timeZone) + shift.startMinutes * 60000;
  return {
    shift,
    startTs,
    endTs: startTs + durationMinutes(shift.startMinutes, shift.endMinutes) * 60000,
    dayKey: dayKey(new Date(startTs), timeZone),
  };
}

/** Dia da semana local (0 = domingo) de uma referência deslocada. */
function weekdayOf(reference, dayOffset, timeZone = undefined) {
  const ts = reference instanceof Date ? reference.getTime() : Number(reference);
  return tzParts(localDayShifted(ts, dayOffset, timeZone), timeZone).weekday;
}

/**
 * Turno em andamento no instante informado (considera turnos que viram o dia).
 * @returns {{shift: object, startTs: number, endTs: number, lateMinutes: number}|null}
 */
function findActiveShift(shifts, now = new Date(), timeZone = undefined) {
  const ts = now instanceof Date ? now.getTime() : Number(now);
  let best = null;
  for (const shift of shifts) {
    // offset -1 cobre turnos que começaram ontem e atravessam a meia-noite.
    for (const offset of [-1, 0]) {
      if (weekdayOf(ts, offset, timeZone) !== shift.weekday) continue;
      const occurrence = occurrenceFor(shift, ts, offset, timeZone);
      if (ts >= occurrence.startTs && ts < occurrence.endTs) {
        if (!best || occurrence.startTs > best.startTs) best = { ...occurrence, lateMinutes: 0 };
      }
    }
  }
  return best;
}

/**
 * Próxima ocorrência de turno a partir de `now` (para o aviso com antecedência).
 * @returns {{shift: object, startTs: number, endTs: number, dayKey: string}|null}
 */
function findNextShift(shifts, now = new Date(), { horizonMs = 24 * 3600000, timeZone = undefined } = {}) {
  const ts = now instanceof Date ? now.getTime() : Number(now);
  let best = null;
  for (const shift of shifts) {
    for (const offset of [-1, 0, 1, 2]) {
      if (weekdayOf(ts, offset, timeZone) !== shift.weekday) continue;
      const occurrence = occurrenceFor(shift, ts, offset, timeZone);
      if (occurrence.startTs < ts) continue;
      if (occurrence.startTs - ts > horizonMs) continue;
      if (!best || occurrence.startTs < best.startTs) best = occurrence;
    }
  }
  return best;
}

/** Turnos de um dia da semana (para exibição/painel). */
function shiftsByWeekday(shifts) {
  const days = Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    label: WEEKDAY_LABELS[weekday],
    short: WEEKDAY_SHORT[weekday],
    shifts: [],
  }));
  for (const shift of shifts) {
    if (days[shift.weekday]) days[shift.weekday].shifts.push(shift);
  }
  for (const day of days) day.shifts.sort((a, b) => a.startMinutes - b.startMinutes);
  return days;
}

/**
 * Atraso (em minutos) de um início real em relação ao turno planejado.
 * Sem turno previsto para o instante → 0.
 */
function latenessFor(shift, startedAt) {
  if (!shift) return 0;
  return Math.max(0, Math.round((startedAt - shift.startTs) / 60000));
}

/** Saída antecipada (minutos) em relação ao fim do turno. */
function earlyLeaveFor(shift, endedAt) {
  if (!shift) return 0;
  return Math.max(0, Math.round((shift.endTs - endedAt) / 60000));
}

module.exports = {
  MINUTES_IN_DAY,
  WEEKDAY_LABELS,
  WEEKDAY_SHORT,
  DAY_KEYS,
  DAY_LABELS,
  parseHHMM,
  minutesToHHMM,
  durationMinutes,
  normalizeShift,
  toShift,
  occurrenceFor,
  findActiveShift,
  findNextShift,
  weekdayOf,
  localDayShifted,
  shiftsByWeekday,
  latenessFor,
  earlyLeaveFor,
};
