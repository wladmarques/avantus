'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateSchedule,
  describeSchedule,
  formatDuration,
  toMinutes,
  dayKey,
  resolvePeriod,
  startOfDay,
  DAY_KEYS,
} = require('../src/utils/time');

const SCHEDULE = {
  mon: [{ open: '12:00', close: '02:00' }],
  tue: [{ open: '12:00', close: '02:00' }],
  wed: [{ open: '12:00', close: '02:00' }],
  thu: [{ open: '12:00', close: '02:00' }],
  fri: [{ open: '12:00', close: '02:00' }],
  sat: [{ open: '12:00', close: '00:00' }],
  sun: [{ open: '12:00', close: '00:00' }],
};

// America/Sao_Paulo = UTC-3 (sem horário de verão)
const at = (iso) => new Date(iso);

test('central aberta dentro da janela', () => {
  // segunda-feira 05/01/2026 13:00 local
  const result = evaluateSchedule(SCHEDULE, at('2026-01-05T16:00:00Z'));
  assert.equal(result.open, true);
});

test('central fechada depois do horário', () => {
  // segunda-feira 03:00 local
  const result = evaluateSchedule(SCHEDULE, at('2026-01-05T06:00:00Z'));
  assert.equal(result.open, false);
  assert.ok(result.nextOpen);
});

test('janela que atravessa a madrugada continua aberta no dia seguinte', () => {
  // terça-feira 01:00 local (janela de segunda 12:00–02:00)
  const result = evaluateSchedule(SCHEDULE, at('2026-01-06T04:00:00Z'));
  assert.equal(result.open, true);
  assert.equal(result.current.crossesMidnight, true);
});

test('dia sem janela fica fechado', () => {
  const schedule = { ...SCHEDULE, sun: [] };
  // domingo 11/01/2026 15:00 local
  const result = evaluateSchedule(schedule, at('2026-01-11T18:00:00Z'));
  assert.equal(result.open, false);
});

test('descrição da agenda e utilitários de tempo', () => {
  const text = describeSchedule(SCHEDULE);
  assert.match(text, /Segunda.*12:00 às 02:00/);
  assert.match(text, /Sábado.*12:00 às 00:00/);
  assert.equal(toMinutes('02:30'), 150);
  assert.equal(toMinutes('99:00'), null);
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(95), '1 minuto');
  assert.equal(formatDuration(600), '10 minutos');
  assert.equal(formatDuration(5400), '1h 30min');
  assert.equal(DAY_KEYS.length, 7);
});

test('fuso horário: início do dia e chave do dia em São Paulo', () => {
  const reference = at('2026-01-06T02:30:00Z'); // 23:30 de 05/01 em SP
  assert.equal(dayKey(reference), '2026-01-05');
  const midnight = startOfDay(reference);
  assert.equal(new Date(midnight).toISOString(), '2026-01-05T03:00:00.000Z');
});

test('períodos de relatório', () => {
  const hoje = resolvePeriod('hoje');
  assert.ok(hoje.from < hoje.to);
  const semana = resolvePeriod('7d');
  assert.ok(hoje.from - semana.from >= 5 * 86400000);
  assert.equal(resolvePeriod('30d').label, 'Últimos 30 dias');
});
