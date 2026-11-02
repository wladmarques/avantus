'use strict';

/**
 * Divulgação da escala semanal em um canal do Discord via **webhook**.
 *
 * O desenho da mensagem segue a identidade da VANTUS: fundo escuro, sem emojis,
 * barra de destaque vermelha (`#ff2200`) e uma linha por staff em cada dia.
 * A semana vai de **segunda a domingo** no fuso configurado no bot.
 */

const { EmbedBuilder } = require('discord.js');
const { PALETTE } = require('../../config/theme');
const { createLogger } = require('../../utils/logger');
const { tzParts, startOfDay, addDays, dayKey } = require('../../utils/time');
const { minutesToHHMM, weekParity } = require('./shiftSchedule');

const logger = createLogger('hourbank');

const SETTING_KEY = 'hour_bank_webhook_url';
const LAST_WEEK_KEY = 'hour_bank_webhook_last_week';
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // segunda → domingo
const WEEKDAY_LABELS = {
  0: 'Domingo',
  1: 'Segunda',
  2: 'Terça',
  3: 'Quarta',
  4: 'Quinta',
  5: 'Sexta',
  6: 'Sábado',
};

const WEBHOOK_PATTERN =
  /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d{5,25}\/[\w-]{20,}$/;

/** A URL informada é um webhook válido do Discord? */
function isValidWebhookUrl(value) {
  return typeof value === 'string' && WEBHOOK_PATTERN.test(value.trim());
}

/** Webhook configurado (string vazia quando não há). */
function getWebhookUrl(settings) {
  const value = settings?.get ? settings.get(SETTING_KEY) : null;
  return typeof value === 'string' ? value.trim() : '';
}

/** Grava (ou limpa) o webhook. Lança erro se a URL não for válida. */
async function setWebhookUrl(settings, value) {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (clean && !isValidWebhookUrl(clean)) {
    throw new Error('Webhook inválido. Use o endereço completo do Discord (https://discord.com/api/webhooks/...).');
  }
  await settings.set(SETTING_KEY, clean || null);
  return clean;
}

/**
 * Segunda e domingo da semana de referência.
 * @returns {{startTs: number, endTs: number, days: Array<{weekday: number, ts: number, key: string, dateLabel: string}>}}
 */
function weekWindow(now = Date.now(), timeZone = undefined) {
  const ts = now instanceof Date ? now.getTime() : Number(now);
  const { weekday } = tzParts(new Date(ts), timeZone);
  const offsetToMonday = weekday === 0 ? -6 : 1 - weekday;
  const startTs = startOfDay(addDays(new Date(ts), offsetToMonday), timeZone);

  const days = WEEK_ORDER.map((day, index) => {
    const dayTs = startOfDay(addDays(new Date(startTs), index), timeZone);
    const parts = tzParts(new Date(dayTs), timeZone);
    return {
      weekday: day,
      ts: dayTs,
      key: dayKey(new Date(dayTs), timeZone),
      dateLabel: `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}`,
    };
  });

  return { startTs: days[0].ts, endTs: days[6].ts, days };
}

/** Nome exibido do staff: painel/Discord → escala → sessão → menção. */
function staffLabel(hourBank, guildId, shift, names) {
  return (
    names.get(shift.userId) ||
    shift.staffName ||
    hourBank.nameOf(guildId, shift.userId) ||
    `<@${shift.userId}>`
  );
}

/** Junta turnos encostados do mesmo staff: 11:00–13:00 + 13:00–15:00 → 11:00–15:00. */
function mergeRanges(entries) {
  const sorted = [...entries].sort((a, b) => a.startMinutes - b.startMinutes);
  const ranges = [];
  for (const entry of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last.endMinutes === entry.startMinutes) {
      last.endMinutes = entry.endMinutes;
    } else {
      ranges.push({ startMinutes: entry.startMinutes, endMinutes: entry.endMinutes });
    }
  }
  return ranges.map((range) => {
    const overnight = range.endMinutes <= range.startMinutes;
    return `${minutesToHHMM(range.startMinutes)}–${minutesToHHMM(range.endMinutes)}${overnight ? ' (+1 dia)' : ''}`;
  });
}

/** Uma linha por staff no dia, com os horários agrupados. */
function dayLines(entries) {
  const byStaff = new Map();
  for (const entry of entries) {
    if (!byStaff.has(entry.userId)) byStaff.set(entry.userId, { name: entry.name, shifts: [] });
    byStaff.get(entry.userId).shifts.push(entry);
  }
  return [...byStaff.values()]
    .map((staff) => ({
      name: staff.name,
      firstStart: Math.min(...staff.shifts.map((shift) => shift.startMinutes)),
      ranges: mergeRanges(staff.shifts),
    }))
    .sort((a, b) => a.firstStart - b.firstStart || a.name.localeCompare(b.name))
    .map((staff) => `${staff.name} — ${staff.ranges.join(' · ')}`);
}

/** Nome do campo para um intervalo de dias: "Segunda · 26/10", "Sábado e domingo · …". */
function rangeLabel(days, from, to) {
  const first = days[from];
  const last = days[to];
  const firstLabel = WEEKDAY_LABELS[first.weekday];
  if (from === to) return `${firstLabel} · ${first.dateLabel}`;
  const lastLabel = WEEKDAY_LABELS[last.weekday].toLowerCase();
  if (to === from + 1) return `${firstLabel} e ${lastLabel} · ${first.dateLabel} e ${last.dateLabel}`;
  return `${firstLabel} a ${lastLabel} · ${first.dateLabel}–${last.dateLabel}`;
}

/**
 * Agrupa dias consecutivos com exatamente a mesma escala.
 *
 * Como os dias úteis usam o mesmo horário (e sábado/domingo também), a semana
 * inteira costuma virar dois blocos em vez de sete colunas repetidas.
 */
function groupDays(week, byDay) {
  const groups = [];
  let current = null;
  week.days.forEach((day, index) => {
    const lines = dayLines(byDay.get(day.weekday) ?? []);
    if (!lines.length) {
      current = null;
      return;
    }
    const key = lines.join('\n');
    if (current && current.key === key && current.to === index - 1) {
      current.to = index;
      return;
    }
    current = { key, lines, from: index, to: index };
    groups.push(current);
  });
  return groups;
}

/**
 * Monta a mensagem (payload pronto para o webhook) com a escala da semana.
 * Sem emojis: apenas dias, horários e nomes.
 * @returns {{payload: object, week: object, staffCount: number, shiftCount: number}}
 */
function buildWeeklySchedule({ hourBank, guildId, timeZone = undefined, now = Date.now() }) {
  const week = weekWindow(now, timeZone);
  const shifts = hourBank.listShifts(guildId);
  const names = hourBank.names(guildId);
  const parity = weekParity(week.days[0].ts, timeZone);

  const byDay = new Map(week.days.map((day) => [day.weekday, []]));
  for (const shift of shifts) {
    const weekday = Number(shift.weekday);
    const bucket = byDay.get(weekday);
    if (!bucket) continue;
    // Fim de semana revezado: só entra quem trabalha na semana publicada.
    const day = week.days.find((item) => item.weekday === weekday);
    if (shift.parity && shift.parity !== weekParity(day.ts, timeZone)) continue;
    bucket.push({
      userId: shift.userId,
      name: staffLabel(hourBank, guildId, shift, names),
      startMinutes: Number(shift.startMinutes),
      endMinutes: Number(shift.endMinutes),
    });
  }

  const groups = groupDays(week, byDay);
  const fields = groups.map((group) => ({
    name: rangeLabel(week.days, group.from, group.to),
    value: group.lines.join('\n').slice(0, 1024),
    inline: false,
  }));

  const staffIds = new Set(
    [...byDay.values()].flat().map((entry) => entry.userId),
  );
  const hasOvernight = groups.some((group) => group.lines.some((line) => line.includes('(+1 dia)')));

  const description = [
    `**${week.days[0].dateLabel} a ${week.days[6].dateLabel}** · fim de semana **${parity}**`,
    hasOvernight
      ? 'Horários no fuso do bot. Turnos com "+1 dia" terminam no dia seguinte.'
      : 'Horários no fuso do bot.',
  ];
  if (!groups.length) description.push('Ninguém escalado nesta semana.');

  const embed = new EmbedBuilder()
    .setColor(PALETTE.RED)
    .setTitle('ESCALA DA SEMANA')
    .setDescription(description.join('\n'))
    .addFields(fields)
    .setFooter({ text: 'VANTUS • Banco de horas' })
    .setTimestamp(new Date(now));

  return {
    payload: { embeds: [embed.toJSON()], allowed_mentions: { parse: [] } },
    week: {
      startKey: week.days[0].key,
      endKey: week.days[6].key,
      startLabel: week.days[0].dateLabel,
      endLabel: week.days[6].dateLabel,
      parity,
    },
    staffCount: staffIds.size,
    shiftCount: shifts.length,
  };
}

/** POST no webhook (timeout curto para não travar o painel). */
async function postWebhook(url, payload, { timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `O Discord recusou a mensagem (HTTP ${response.status})${detail ? `: ${detail.slice(0, 140)}` : ''}.`,
      );
    }
    return { ok: true, status: response.status };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('O Discord não respondeu a tempo (10s).');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Envia a escala da semana para o webhook configurado.
 * Lança erro com mensagem pronta para o painel quando não há webhook ou o envio falha.
 */
async function sendWeeklySchedule({ settings, hourBank, guildId, timeZone = undefined, now = Date.now() }) {
  const url = getWebhookUrl(settings);
  if (!url) throw new Error('Nenhum webhook cadastrado. Informe a URL e salve antes de enviar.');
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('O webhook salvo não é uma URL válida. Salve novamente pelo painel.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('O webhook precisa ser um endereço http(s).');
  }

  const built = buildWeeklySchedule({ hourBank, guildId, timeZone, now });
  await postWebhook(url, built.payload);
  // Registra a semana publicada — evita repetir a mesma escala (manual ou automática).
  await settings.set(LAST_WEEK_KEY, built.week.startKey);
  logger.info(
    `Escala da semana enviada pelo webhook (${built.staffCount} staff, ${built.shiftCount} turno(s)).`,
  );

  return {
    ok: true,
    week: built.week,
    staffCount: built.staffCount,
    shiftCount: built.shiftCount,
  };
}

module.exports = {
  SETTING_KEY,
  LAST_WEEK_KEY,
  isValidWebhookUrl,
  getWebhookUrl,
  setWebhookUrl,
  weekWindow,
  buildWeeklySchedule,
  postWebhook,
  sendWeeklySchedule,
};
