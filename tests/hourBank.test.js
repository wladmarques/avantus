'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, countDms } = require('./helpers');
const { tzParts } = require('../src/utils/time');

const STAFF = '950000000000001001';
const MINUTE = 60 * 1000;

/** Turno que começa daqui a `minutesAhead` minutos (ou agora, se 0). */
function shiftStartingSoon(minutesAhead = 0, durationMinutes = 120) {
  const now = new Date();
  const p = tzParts(now);
  let weekday = p.weekday;
  let start = p.hour * 60 + p.minute + minutesAhead;
  if (start >= 24 * 60) {
    start -= 24 * 60;
    weekday = (weekday + 1) % 7;
  }
  let end = start + durationMinutes;
  if (end >= 24 * 60) end -= 24 * 60;
  const hhmm = (value) =>
    `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  return { weekday, start: hhmm(start), end: hhmm(end) };
}

test('escala: cadastra, lista e substitui os turnos do staff', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF,
    staffName: 'pedrosa17',
    shifts: [
      { weekday: 1, start: '12:00', end: '18:00' },
      { weekday: 3, start: '22:00', end: '02:00' },
    ],
  });

  const shifts = env.services.hourBank.listShifts(env.guildId, STAFF);
  assert.equal(shifts.length, 2);
  const overnight = shifts.find((shift) => shift.weekday === 3);
  assert.equal(overnight.overnight, true);
  assert.equal(overnight.durationMinutes, 240, '22:00 → 02:00 = 4 horas');
  assert.equal(shifts.find((shift) => shift.weekday === 1).durationMinutes, 360);

  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF,
    shifts: [{ weekday: 5, start: '08:00', end: '12:00' }],
  });
  const replaced = env.services.hourBank.listShifts(env.guildId, STAFF);
  assert.equal(replaced.length, 1, 'a escala é substituída, não acumulada');
  assert.equal(replaced[0].weekday, 5);
});

test('escala recusa horários inválidos', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await assert.rejects(
    () =>
      env.services.hourBank.setSchedule({
        guildId: env.guildId,
        userId: STAFF,
        shifts: [{ weekday: 1, start: '25:00', end: '18:00' }],
      }),
    /Horário inválido/,
  );

  await assert.rejects(
    () =>
      env.services.hourBank.setSchedule({
        guildId: env.guildId,
        userId: STAFF,
        shifts: [{ weekday: 1, start: '12:00', end: '12:00' }],
      }),
    /não podem ser iguais/,
  );
});

test('ficar disponível abre a sessão e sair de serviço fecha com as horas', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'DISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });

  let active = env.services.hourBank.activeSession(env.guildId, STAFF);
  assert.ok(active, 'sessão aberta ao ficar disponível');

  // Simula 90 minutos de serviço.
  env.db.run('UPDATE staff_sessions SET started_at = ? WHERE id = ?', [Date.now() - 90 * MINUTE, active.id]);

  // Em atendimento continua contando.
  await env.services.staff.markBusy(env.guildId, STAFF);
  active = env.services.hourBank.activeSession(env.guildId, STAFF);
  assert.ok(active, 'EM_ATENDIMENTO mantém a sessão aberta');

  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'AUSENTE',
    updatedBy: 'teste',
    manual: true,
  });

  assert.equal(env.services.hourBank.activeSession(env.guildId, STAFF), null, 'sessão fechada');
  const sessions = env.services.hourBank.sessions(env.guildId, { userId: STAFF });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].open, false);
  assert.ok(sessions[0].minutes >= 89 && sessions[0].minutes <= 91, `minutos: ${sessions[0].minutes}`);
});

test('sessão é idempotente (não abre duas ao repetir o status)', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  for (let index = 0; index < 3; index += 1) {
    await env.services.staff.setStatus({
      guildId: env.guildId,
      userId: STAFF,
      status: 'DISPONIVEL',
      updatedBy: 'teste',
      manual: true,
    });
  }

  const sessions = env.services.hourBank.sessions(env.guildId, { userId: STAFF });
  assert.equal(sessions.length, 1, 'apenas uma sessão aberta');
});

test('atraso é calculado em relação ao início do turno', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  // Turno que já começou há 25 minutos.
  const shift = shiftStartingSoon(-25, 180);
  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF,
    staffName: 'atrasado',
    shifts: [shift],
  });

  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'DISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });

  const active = env.services.hourBank.activeSession(env.guildId, STAFF);
  assert.ok(active.late_minutes >= 24 && active.late_minutes <= 26, `atraso: ${active.late_minutes}`);

  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'INDISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });

  const report = env.services.hourBank.report(env.guildId);
  const item = report.staff.find((row) => row.userId === STAFF);
  assert.ok(item, 'staff aparece no relatório');
  assert.ok(item.lateCount >= 1, 'atraso contabilizado');
  assert.ok(item.lateMinutes >= 24);
});

test('sem turno no horário a sessão não gera atraso', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'DISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });

  const active = env.services.hourBank.activeSession(env.guildId, STAFF);
  assert.equal(active.late_minutes, 0);
});

test('relatório agrega horas, sessões e dias por staff', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  const now = Date.now();
  // Duas sessões hoje: 60 e 120 minutos.
  await env.services.hourBank.startSession({
    guildId: env.guildId,
    userId: STAFF,
    staffName: 'ana',
    at: now - 200 * MINUTE,
  });
  env.db.run('UPDATE staff_sessions SET started_at = ? WHERE ended_at IS NULL', [now - 200 * MINUTE]);
  await env.services.hourBank.endSession({ guildId: env.guildId, userId: STAFF, at: now - 140 * MINUTE });
  await env.services.hourBank.startSession({ guildId: env.guildId, userId: STAFF, staffName: 'ana', at: now - 130 * MINUTE });
  await env.services.hourBank.endSession({ guildId: env.guildId, userId: STAFF, at: now - 10 * MINUTE });

  const report = env.services.hourBank.report(env.guildId);
  const item = report.staff.find((row) => row.userId === STAFF);
  assert.equal(item.sessions, 2);
  assert.equal(item.totalMinutes, 180, '60 + 120 minutos');
  assert.equal(item.totalLabel, '3h');
  assert.equal(item.days.length, 1);
  assert.ok(item.entryLabel !== '—' && item.exitLabel !== '—', 'entrada e saída preenchidas');
});

test('resumo do staff traz hoje, semana, atrasos e próximo turno', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF,
    shifts: [shiftStartingSoon(90, 60)],
  });
  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'DISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });
  env.db.run('UPDATE staff_sessions SET started_at = ?', [Date.now() - 45 * MINUTE]);

  const summary = env.services.hourBank.summary(env.guildId, STAFF);
  assert.ok(summary.todayMinutes >= 44);
  assert.ok(summary.weekMinutes >= summary.todayMinutes);
  assert.ok(summary.active, 'sessão em andamento');
  assert.ok(summary.nextShift, 'próximo turno identificado');
  assert.equal(summary.shifts.length, 1);
});

test('aviso de 5 minutos antes do turno é enviado uma única vez', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  const shift = shiftStartingSoon(5, 120);
  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF,
    staffName: 'pontual',
    shifts: [shift],
  });

  const before = countDms(env.gateway, STAFF);
  const sent = await env.services.hourBank.dispatchReminders(env.guildId);
  assert.equal(sent, 1, 'um aviso enviado');
  assert.equal(countDms(env.gateway, STAFF), before + 1);

  const dm = env.gateway.dms.at(-1);
  const payload = JSON.stringify(dm.payload);
  assert.match(payload, /turno começa em breve/i);

  const again = await env.services.hourBank.dispatchReminders(env.guildId);
  assert.equal(again, 0, 'não duplica o aviso');
});

test('sem turno próximo não há aviso', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF,
    shifts: [shiftStartingSoon(180, 60)],
  });

  assert.equal(env.services.hourBank.dueReminders(env.guildId).length, 0);
});

test('aviso desligado (0 minutos) não envia nada', async (t) => {
  const env = await createTestEnv({ staff: false, settings: { hour_bank_reminder_minutes: 0 } });
  t.after(env.cleanup);

  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF,
    shifts: [shiftStartingSoon(2, 60)],
  });

  assert.equal(env.services.hourBank.dueReminders(env.guildId).length, 0);
});

test('sessão esquecida é fechada no limite configurado', async (t) => {
  const env = await createTestEnv({ staff: false, settings: { hour_bank_max_session_hours: 2 } });
  t.after(env.cleanup);

  await env.services.hourBank.startSession({ guildId: env.guildId, userId: STAFF, staffName: 'esquecido' });
  env.db.run('UPDATE staff_sessions SET started_at = ? WHERE ended_at IS NULL', [Date.now() - 5 * 60 * MINUTE]);

  const closed = await env.services.hourBank.closeStaleSessions(env.guildId);
  assert.equal(closed, 1);
  const sessions = env.services.hourBank.sessions(env.guildId, { userId: STAFF });
  assert.equal(sessions[0].minutes, 120, 'fechada com o limite de 2h');
});

test('visão do painel lista staff, escala e totais', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF,
    staffName: 'painel',
    shifts: [shiftStartingSoon(-30, 120)],
  });
  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'DISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });

  const overview = env.services.hourBank.overview(env.guildId);
  const row = overview.staff.find((item) => item.userId === STAFF);
  assert.ok(row);
  assert.equal(row.available, true);
  assert.ok(row.session, 'sessão em andamento');
  assert.equal(row.shifts.length, 1);
  assert.equal(row.weekly.length, 7);
  assert.ok(row.currentShift, 'turno atual identificado');
  assert.equal(row.totals.lateMinutes >= 29, true);
});

test('banco de horas desligado não cria sessões', async (t) => {
  const env = await createTestEnv({ staff: false, settings: { hour_bank_enabled: false } });
  t.after(env.cleanup);

  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'DISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });

  assert.equal(env.services.hourBank.activeSession(env.guildId, STAFF), null);
});
