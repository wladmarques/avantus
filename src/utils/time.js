'use strict';

const { env } = require('../config/env');

const TZ = env.timezone || 'America/Sao_Paulo';
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = {
  sun: 'Domingo',
  mon: 'Segunda',
  tue: 'Terça',
  wed: 'Quarta',
  thu: 'Quinta',
  fri: 'Sexta',
  sat: 'Sábado',
};

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});

/** Partes da data no fuso configurado. */
function tzParts(date = new Date(), timeZone = TZ) {
  const fmt = timeZone === TZ ? partsFormatter : new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = Number.parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  return {
    year: Number.parseInt(get('year'), 10),
    month: Number.parseInt(get('month'), 10),
    day: Number.parseInt(get('day'), 10),
    hour,
    minute: Number.parseInt(get('minute'), 10),
    second: Number.parseInt(get('second'), 10),
    weekday: weekdayMap[get('weekday')] ?? 0,
  };
}

/** Chave YYYY-MM-DD no fuso local. */
function dayKey(date = new Date(), timeZone = TZ) {
  const p = tzParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** HH:MM no fuso local. */
function formatTime(date = new Date(), timeZone = TZ) {
  const p = tzParts(date, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** DD/MM/YYYY no fuso local. */
function formatDate(date = new Date(), timeZone = TZ) {
  const p = tzParts(date, timeZone);
  return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}/${p.year}`;
}

function formatDateTime(date = new Date(), timeZone = TZ) {
  return `${formatDate(date, timeZone)} ${formatTime(date, timeZone)}`;
}

function dayLabel(weekday) {
  return DAY_LABELS[DAY_KEYS[weekday]] || '—';
}

/** Converte "HH:MM" em minutos desde 00:00. */
function toMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Formata segundos em texto humano (pt-BR). */
function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    return restMinutes === 0
      ? `${hours}h`
      : `${hours}h ${String(restMinutes).padStart(2, '0')}min`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Versão curta: 08m, 1h05, 12s */
function formatDurationShort(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes).padStart(2, '0')}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}`;
}

/** Offset (em minutos) de um fuso em relação ao UTC. */
function timezoneOffsetMinutes(date, timeZone = TZ) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const get = (type) => Number.parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  const asUTC = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
    get('second'),
  );
  return (asUTC - date.getTime()) / 60000;
}

/** Timestamp (ms) da meia-noite local de uma data. */
function startOfDay(date = new Date(), timeZone = TZ) {
  const p = tzParts(date, timeZone);
  const guess = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  let offset = timezoneOffsetMinutes(new Date(guess), timeZone);
  let ts = guess - offset * 60000;
  const check = tzParts(new Date(ts), timeZone);
  if (check.hour !== 0 || check.day !== p.day) {
    offset = timezoneOffsetMinutes(new Date(ts), timeZone);
    ts = guess - offset * 60000;
  }
  return ts;
}

function addDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function formatScheduleEntry(entry) {
  if (!entry) return null;
  return `${entry.open} às ${entry.close}`;
}

/** Texto legível de uma agenda semanal. */
function describeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return 'Não configurado';
  const lines = [];
  for (const key of DAY_KEYS) {
    const windows = Array.isArray(schedule[key]) ? schedule[key] : [];
    const label = DAY_LABELS[key];
    if (windows.length === 0) {
      lines.push(`**${label}:** fechado`);
    } else {
      lines.push(`**${label}:** ${windows.map(formatScheduleEntry).join(' e ')}`);
    }
  }
  return lines.join('\n');
}

/**
 * Verifica se a central está aberta segundo a agenda.
 * Janelas com close <= open atravessam a madrugada.
 * @returns {{open: boolean, current: object|null, nextOpen: string|null}}
 */
function evaluateSchedule(schedule, date = new Date(), timeZone = TZ) {
  const p = tzParts(date, timeZone);
  const nowMinutes = p.hour * 60 + p.minute;
  const todayKey = DAY_KEYS[p.weekday];
  const windows = Array.isArray(schedule?.[todayKey]) ? schedule[todayKey] : [];

  for (const window of windows) {
    const open = toMinutes(window.open);
    const close = toMinutes(window.close);
    if (open === null || close === null) continue;
    if (open === close) continue; // janela inválida/24h ignorada
    if (open < close) {
      if (nowMinutes >= open && nowMinutes < close) {
        return { open: true, current: { ...window, day: todayKey }, nextOpen: null };
      }
    } else if (nowMinutes >= open) {
      // atravessa a madrugada: aberto até o dia seguinte
      return { open: true, current: { ...window, day: todayKey, crossesMidnight: true }, nextOpen: null };
    }
  }

  // janela iniciada ontem que atravessou a madrugada
  const yesterdayKey = DAY_KEYS[(p.weekday + 6) % 7];
  const yesterdayWindows = Array.isArray(schedule?.[yesterdayKey]) ? schedule[yesterdayKey] : [];
  for (const window of yesterdayWindows) {
    const open = toMinutes(window.open);
    const close = toMinutes(window.close);
    if (open === null || close === null || open === close) continue;
    if (close < open && nowMinutes < close) {
      return {
        open: true,
        current: { ...window, day: yesterdayKey, crossesMidnight: true },
        nextOpen: null,
      };
    }
  }

  // Descobre a próxima abertura (até 7 dias à frente)
  const nextOpen = findNextOpen(schedule, p, date, timeZone);
  return { open: false, current: null, nextOpen };
}

function findNextOpen(schedule, parts, date, timeZone) {
  const nowMinutes = parts.hour * 60 + parts.minute;
  for (let offset = 0; offset <= 7; offset += 1) {
    const weekday = (parts.weekday + offset) % 7;
    const windows = Array.isArray(schedule?.[DAY_KEYS[weekday]]) ? schedule[DAY_KEYS[weekday]] : [];
    const candidates = windows
      .map((w) => ({ ...w, openMinutes: toMinutes(w.open) }))
      .filter((w) => w.openMinutes !== null && (offset > 0 || w.openMinutes > nowMinutes))
      .sort((a, b) => a.openMinutes - b.openMinutes);
    if (candidates.length > 0) {
      const next = candidates[0];
      const label = offset === 0 ? 'hoje' : offset === 1 ? 'amanhã' : DAY_LABELS[DAY_KEYS[weekday]].toLowerCase();
      return `${label} às ${next.open}`;
    }
  }
  return null;
}

/** Período de tempo para relatórios. */
function resolvePeriod(period, timeZone = TZ) {
  const now = new Date();
  const startOfToday = startOfDay(now, timeZone);
  switch (period) {
    case 'hoje':
      return { from: startOfToday, to: now.getTime() + 1, label: 'Hoje' };
    case '7d':
      return { from: startOfToday - 6 * 86400000, to: now.getTime() + 1, label: 'Últimos 7 dias' };
    case '30d':
      return { from: startOfToday - 29 * 86400000, to: now.getTime() + 1, label: 'Últimos 30 dias' };
    case 'mes':
      return {
        from: startOfDay(new Date(Date.UTC(tzParts(now).year, tzParts(now).month - 1, 1)), timeZone),
        to: now.getTime() + 1,
        label: 'Mês atual',
      };
    case 'total':
    default:
      return { from: 0, to: now.getTime() + 1, label: 'Todo o período' };
  }
}

/** Converte "DD/MM/AAAA" (fuso local) em timestamp de início do dia. */
function parseLocalDate(value, timeZone = TZ) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || '').trim());
  if (!match) return null;
  const [, day, month, year] = match;
  const guess = Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0);
  const offset = timezoneOffsetMinutes(new Date(guess), timeZone);
  return guess - offset * 60000;
}

module.exports = {
  TZ,
  DAY_KEYS,
  DAY_LABELS,
  tzParts,
  dayKey,
  formatTime,
  formatDate,
  formatDateTime,
  dayLabel,
  toMinutes,
  formatDuration,
  formatDurationShort,
  describeSchedule,
  evaluateSchedule,
  resolvePeriod,
  parseLocalDate,
  startOfDay,
  addDays,
};
