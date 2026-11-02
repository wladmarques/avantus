'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel = LEVELS.info;
const listeners = new Set();

function setLevel(level) {
  if (level in LEVELS) currentLevel = LEVELS[level];
}

/**
 * Permite que módulos (ex.: logs no Discord) escutem eventos de nível
 * warn/error sem acoplar o logger ao client.
 */
function onLog(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function stamp() {
  return new Date().toISOString();
}

function emit(level, scope, message, meta) {
  if (LEVELS[level] > currentLevel) return;
  const line = `[${stamp()}] [${level.toUpperCase()}] [${scope}] ${message}`;
  const stream = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (meta === undefined) stream(line);
  else stream(line, meta);

  if (level === 'warn' || level === 'error') {
    for (const listener of listeners) {
      try {
        listener({ level, scope, message, meta, at: new Date() });
      } catch (err) {
        console.error('[logger] listener falhou:', err);
      }
    }
  }
}

function createLogger(scope = 'app') {
  return {
    info: (message, meta) => emit('info', scope, message, meta),
    warn: (message, meta) => emit('warn', scope, message, meta),
    error: (message, meta) => emit('error', scope, message, meta),
    debug: (message, meta) => emit('debug', scope, message, meta),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}

module.exports = { createLogger, setLevel, onLog, LEVELS };
