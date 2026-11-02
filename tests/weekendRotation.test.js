'use strict';

/**
 * Escala em dois blocos:
 *   - dias úteis (segunda a sexta) com o mesmo horário;
 *   - fim de semana **revezando** entre os grupos A e B (uma semana cada).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv } = require('./helpers');
const {
  normalizeShift,
  weekParity,
  findActiveShift,
  findNextShift,
  toShift,
} = require('../src/systems/hourbank/shiftSchedule');
const { buildWeeklySchedule } = require('../src/systems/hourbank/scheduleBroadcast');
const { tzParts, dayKey } = require('../src/utils/time');

const TZ = 'America/Sao_Paulo';
const STAFF_A = '980000000000001001';
const STAFF_B = '980000000000001002';
const MINUTE = 60000;

/** Timestamp de 12:00 UTC num dia (para varrer dias sem depender de fuso). */
const dayTs = (offsetDays) => Date.UTC(2026, 0, 5, 15, 0, 0) + offsetDays * 86400000;

/** Primeiro sábado (timestamp às 15:00 UTC) cujo fim de semana é do grupo informado. */
function saturdayOf(parity) {
  for (let offset = 0; offset < 28; offset += 1) {
    const ts = dayTs(offset);
    if (tzParts(new Date(ts), TZ).weekday !== 6) continue;
    if (weekParity(ts, TZ) === parity) return ts;
  }
  throw new Error(`sem sábado no grupo ${parity}`);
}

/** Segunda-feira (15:00 UTC) da semana do sábado informado. */
function mondayOf(ts) {
  const { weekday } = tzParts(new Date(ts), TZ);
  return ts - (weekday === 0 ? 6 : weekday - 1) * 86400000;
}

const weekendShift = (parity, { start = '12:00', end = '18:00' } = {}) =>
  toShift({
    id: 1,
    user_id: STAFF_A,
    staff_name: 'pedrosa17',
    weekday: 6,
    start_minutes: Number(start.slice(0, 2)) * 60,
    end_minutes: Number(end.slice(0, 2)) * 60,
    parity,
  });

test('paridade: semanas alternam A/B e o turno respeita o grupo', () => {
  assert.equal(normalizeShift({ weekday: 6, start: '12:00', end: '18:00' }).parity, null);
  assert.equal(normalizeShift({ weekday: 6, start: '12:00', end: '18:00', parity: 'a' }).parity, 'A');
  assert.equal(normalizeShift({ weekday: 0, start: '12:00', end: '18:00', parity: 'B' }).parity, 'B');
  assert.equal(normalizeShift({ weekday: 0, start: '12:00', end: '18:00', parity: null }).parity, null);
  assert.throws(() => normalizeShift({ weekday: 6, start: '12:00', end: '18:00', parity: 'C' }), /Grupo de fim de semana/);

  const satA = saturdayOf('A');
  const satB = saturdayOf('B');
  const mondayA = mondayOf(satA);
  const mondayB = mondayOf(satB);
  assert.notEqual(weekParity(mondayA, TZ), weekParity(mondayB, TZ), 'semanas seguidas alternam');
  assert.equal(weekParity(mondayA, TZ), weekParity(mondayA + 2 * 86400000, TZ), 'mesma semana, mesmo grupo');
  assert.notEqual(weekParity(mondayA, TZ), weekParity(mondayA + 7 * 86400000, TZ), 'semanas vizinhas alternam');
});

test('turno de fim de semana só vale na semana do seu grupo', () => {
  const satA = saturdayOf('A');
  const satB = saturdayOf('B');
  const shift = weekendShift('A');
  const at = (ts, hour = 15) => ts + (hour - 12) * 3600000; // satA/satB foram gerados às 15:00 UTC

  assert.ok(findActiveShift([shift], at(satA), TZ), 'sábado do grupo A: em serviço');
  assert.equal(findActiveShift([shift], at(satB), TZ), null, 'sábado do grupo B: folga');

  // Turno sem grupo vale sempre.
  const everyWeekend = weekendShift(null);
  assert.ok(findActiveShift([everyWeekend], at(satA), TZ));
  assert.ok(findActiveShift([everyWeekend], at(satB), TZ));
});

test('próximo turno pula o fim de semana do outro grupo', () => {
  const satA = saturdayOf('A');
  const satB = saturdayOf('B');
  const shift = weekendShift('A');

  // Segunda da semana B: o sábado seguinte é do B (folga) → próxima ocorrência é a do A.
  const mondayB = mondayOf(satB);
  const next = findNextShift([shift], mondayB, { horizonMs: 15 * 24 * 3600000, timeZone: TZ });
  assert.equal(weekParity(next.startTs, TZ), 'A', 'só encontra fins de semana do grupo A');
  assert.notEqual(dayKey(new Date(next.startTs), TZ), dayKey(new Date(satB), TZ), 'o sábado do grupo B é pulado');
  assert.ok(next.startTs - mondayB >= 11 * 86400000, 'pula o fim de semana de folga');

  // Na semana A, o sábado da própria semana é o próximo.
  const mondayA = mondayOf(satA);
  const sameWeek = findNextShift([shift], mondayA, { horizonMs: 7 * 24 * 3600000, timeZone: TZ });
  assert.equal(dayKey(new Date(sameWeek.startTs), TZ), dayKey(new Date(satA), TZ));
});

test('escala semanal: dias úteis iguais e fim de semana revezado na API do painel', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  const shifts = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '12:00', end: '20:00' }));
  for (const weekday of [6, 0]) shifts.push({ weekday, start: '10:00', end: '16:00', parity: 'A' });

  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF_A,
    staffName: 'pedrosa17',
    shifts,
  });

  const stored = env.services.hourBank.listShifts(env.guildId, STAFF_A);
  assert.equal(stored.length, 7);
  const weekend = stored.filter((shift) => shift.weekday === 0 || shift.weekday === 6);
  assert.deepEqual(weekend.map((shift) => shift.parity), ['A', 'A']);
  const weekdays = stored.filter((shift) => shift.weekday >= 1 && shift.weekday <= 5);
  assert.deepEqual(weekdays.map((shift) => shift.start), ['12:00', '12:00', '12:00', '12:00', '12:00']);

  const overview = env.services.hourBank.overview(env.guildId);
  assert.match(overview.weekParity, /^[AB]$/, 'painel sabe o grupo desta semana');
  const row = overview.staff.find((item) => item.userId === STAFF_A);
  const saturday = row.weekly.find((day) => day.weekday === 6);
  assert.deepEqual(saturday.shifts, [{ start: '10:00', end: '16:00', parity: 'A' }]);

  // Paridade inválida é recusada.
  await assert.rejects(
    () =>
      env.services.hourBank.setSchedule({
        guildId: env.guildId,
        userId: STAFF_A,
        shifts: [{ weekday: 6, start: '10:00', end: '16:00', parity: 'X' }],
      }),
    /Grupo de fim de semana/,
  );
});

test('webhook: fim de semana mostra só o grupo da semana publicada', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  const build = (userId, name, parity) => {
    const shifts = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '12:00', end: '20:00' }));
    for (const weekday of [6, 0]) shifts.push({ weekday, start: '10:00', end: '16:00', parity });
    return env.services.hourBank.setSchedule({
      guildId: env.guildId,
      userId,
      staffName: name,
      shifts,
    });
  };
  // Ambos aparecem nos dias úteis; no fim de semana, só um por semana.
  await build(STAFF_A, 'pedrosa17', 'A');
  await build(STAFF_B, 'mika', 'B');

  const satA = saturdayOf('A');
  const satB = saturdayOf('B');

  const weekA = buildWeeklySchedule({
    hourBank: env.services.hourBank,
    guildId: env.guildId,
    timeZone: TZ,
    now: satA - 5 * 86400000 + 15 * 3600000, // segunda da semana A
  });
  const weekB = buildWeeklySchedule({
    hourBank: env.services.hourBank,
    guildId: env.guildId,
    timeZone: TZ,
    now: satB - 5 * 86400000 + 15 * 3600000,
  });

  assert.equal(weekA.week.parity, 'A');
  assert.equal(weekB.week.parity, 'B');

  // Dias úteis iguais viram um único bloco; sábado e domingo, outro.
  const weekdayFieldA = weekA.payload.embeds[0].fields.find((field) => field.name.startsWith('Segunda a sexta'));
  const weekendFieldA = weekA.payload.embeds[0].fields.find((field) => field.name.startsWith('Sábado e domingo'));
  assert.ok(weekdayFieldA, 'dias úteis agrupados em uma linha do tempo');
  assert.ok(weekendFieldA, 'sábado e domingo agrupados');
  assert.match(weekendFieldA.value, /pedrosa17/);
  assert.doesNotMatch(weekendFieldA.value, /mika/, 'grupo B folga no fim de semana A');
  assert.match(weekdayFieldA.value, /pedrosa17/);
  assert.match(weekdayFieldA.value, /mika/, 'dias úteis valem para todos');

  const weekendFieldB = weekB.payload.embeds[0].fields.find((field) => field.name.startsWith('Sábado e domingo'));
  assert.match(weekendFieldB.value, /mika/);
  assert.doesNotMatch(weekendFieldB.value, /pedrosa17/, 'grupo A folga no fim de semana B');
});

test('sessão em fim de semana de folga não conta atraso', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  // Só trabalha no fim de semana A; a sessão de teste cai no fim de semana B.
  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF_A,
    staffName: 'pedrosa17',
    shifts: [{ weekday: 6, start: '12:00', end: '18:00', parity: 'A' }],
  });

  const satB = saturdayOf('B');
  const startedAt = satB + 2 * 3600000; // 14:00 no sábado do grupo B (turno 12:00 → 18:00)
  const session = await env.services.hourBank.startSession({
    guildId: env.guildId,
    userId: STAFF_A,
    at: startedAt,
  });
  assert.equal(session.late_minutes, 0, 'fora do grupo, não existe turno previsto');
  await env.services.hourBank.endSession({ guildId: env.guildId, userId: STAFF_A, at: startedAt + 3600000 });

  // No sábado do grupo A existe turno: 2h de atraso.
  const satA = saturdayOf('A');
  const onDuty = await env.services.hourBank.startSession({
    guildId: env.guildId,
    userId: STAFF_A,
    at: satA + 2 * 3600000,
  });
  assert.equal(onDuty.late_minutes, 120);
});
