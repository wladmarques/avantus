'use strict';

const SNOWFLAKE = /^\d{17,20}$/;

function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

/** Extrai um ID de menção (<@123>) ou devolve o próprio valor. */
function normalizeId(value) {
  if (typeof value !== 'string') return null;
  const mention = /^<[@#&!]*(\d{17,20})>$/.exec(value.trim());
  if (mention) return mention[1];
  return isSnowflake(value.trim()) ? value.trim() : null;
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  const ids = value.map(normalizeId).filter(Boolean);
  return [...new Set(ids)];
}

function isValidHHMM(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function isPositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0;
}

/** Valida a agenda semanal (JSON). */
function isValidSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return false;
  const allowed = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  for (const key of Object.keys(schedule)) {
    if (!allowed.includes(key)) return false;
    if (!Array.isArray(schedule[key])) return false;
    for (const window of schedule[key]) {
      if (!window || !isValidHHMM(window.open) || !isValidHHMM(window.close)) return false;
    }
  }
  return true;
}

/** Sanitiza texto vindo de usuário antes de publicar em embeds. */
function sanitizeText(value, maxLength = 500) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, maxLength).trim();
}

module.exports = {
  isSnowflake,
  normalizeId,
  normalizeIdList,
  isValidHHMM,
  isValidSchedule,
  clampInt,
  isPositiveInt,
  sanitizeText,
};
