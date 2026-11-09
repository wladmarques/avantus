'use strict';

/**
 * Não entrada em serviço (faltas e atrasos de turno).
 *
 * A regra: passou a tolerância (`hour_bank_absence_minutes`) do início do turno
 * e o staff não entrou em serviço → o bot **registra** a ausência e **avisa os
 * cargos** configurados. Se ele aparecer depois, o registro passa a "atrasou X";
 * se o turno terminar sem ele, vira "faltou".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv } = require('./helpers');
const { tzParts } = require('../src/utils/time');

const STAFF = '960000000000001001';
const ROLE_A = '1560793864330158240';
const ROLE_B = '1566903222088499251';
const MINUTE = 60 * 1000;

/** Turno de hoje que começou `minutesAgo` minutos atrás e dura `duration`. */
function shiftStartedAgo(minutesAgo = 30, duration = 180) {
  const now = new Date();
  const p = tzParts(now);
  const weekday = p.weekday;
  let start = p.hour * 60 + p.minute - minutesAgo;
  if (start < 0) start += 24 * 60;
  const end = (start + duration) % (24 * 60);
  const hhmm = (value) =>
    `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  return { weekday, start: hhmm(start), end: hhmm(end) };
}

async function withSchedule(t, shift, options = {}) {
  const env = await createTestEnv({ staff: false, ...options });
  t.after(env.cleanup);
  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF,
    staffName: 'pedrosa17',
    shifts: [shift],
  });
  return env;
}

/** Mensagens de canal que citam os cargos de administração. */
const alertMessages = (env) =>
  env.gateway.channelMessages.filter((message) =>
    String(message.payload?.content ?? '').includes(`<@&${ROLE_A}>`),
  );

test('staff escalado que não entrou em serviço é registrado e os cargos são avisados', async (t) => {
  const env = await withSchedule(t, shiftStartedAgo(30));

  const result = await env.services.hourBank.checkAbsences(env.guildId);
  assert.equal(result.registered, 1, 'um registro de ausência');
  assert.equal(result.notified, 1, 'um aviso enviado');

  const [absence] = env.services.hourBank.absences(env.guildId);
  assert.equal(absence.userId, STAFF);
  assert.equal(absence.status, 'ATRASADO');
  assert.ok(absence.lateMinutes >= 29, `atraso de ${absence.lateMinutes} min`);
  assert.match(absence.statusLabel, /atrasado há/);

  const [alert] = alertMessages(env);
  assert.ok(alert, 'mensagem com menção de cargo');
  const mentioned = alert.payload.content;
  assert.ok(mentioned.includes(`<@&${ROLE_A}>`), 'avisa o primeiro cargo');
  assert.ok(mentioned.includes(`<@&${ROLE_B}>`), 'avisa o segundo cargo');
  assert.deepEqual(alert.payload.allowed_mentions.roles, [ROLE_A, ROLE_B]);
  assert.equal(alert.channelId, env.services.settings.get('staff_channel_id'));
  assert.match(alert.payload.embeds[0].description, /pedrosa17/);
  assert.match(alert.payload.embeds[0].description, /não entrou em serviço|ainda não entrou em serviço/);
});

test('o aviso não se repete a cada verificação', async (t) => {
  const env = await withSchedule(t, shiftStartedAgo(30));

  assert.equal((await env.services.hourBank.checkAbsences(env.guildId)).notified, 1);
  assert.equal(alertMessages(env).length, 1);

  const second = await env.services.hourBank.checkAbsences(env.guildId);
  assert.equal(second.registered, 0, 'não duplica o registro');
  assert.equal(second.notified, 0, 'não repete o aviso');
  assert.equal(alertMessages(env).length, 1);
});

test('quem entra em serviço depois tem o registro marcado como atraso', async (t) => {
  const env = await withSchedule(t, shiftStartedAgo(30));
  await env.services.hourBank.checkAbsences(env.guildId);

  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'DISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });

  const [absence] = env.services.hourBank.absences(env.guildId);
  assert.equal(absence.status, 'ATRASOU');
  assert.ok(absence.returnedAt, 'guarda a hora da chegada');
  assert.match(absence.statusLabel, /atrasou/);
});

test('quem já estava disponível no início do turno não é marcado', async (t) => {
  const env = await withSchedule(t, shiftStartedAgo(30));

  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'DISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });
  // A sessão começou agora; o turno começou antes — mas a pessoa está em
  // serviço, então não é ausência.
  const result = await env.services.hourBank.checkAbsences(env.guildId);
  assert.equal(result.registered, 0);
  assert.equal(alertMessages(env).length, 0);
});

test('turno que termina sem ninguém vira "faltou"', async (t) => {
  const env = await withSchedule(t, shiftStartedAgo(120, 60)); // começou há 2h, durou 1h
  await env.services.hourBank.checkAbsences(env.guildId);

  const [absence] = env.services.hourBank.absences(env.guildId);
  assert.equal(absence.status, 'FALTOU');
  assert.equal(absence.statusLabel, 'faltou');

  const [alert] = alertMessages(env);
  assert.match(alert.payload.embeds[0].title, /não compareceu/);
  assert.match(alert.payload.embeds[0].description, /o turno terminou/);
});

test('tolerância 0 desliga o registro', async (t) => {
  const env = await withSchedule(t, shiftStartedAgo(30), {
    settings: { hour_bank_absence_minutes: 0 },
  });
  const result = await env.services.hourBank.checkAbsences(env.guildId);
  assert.equal(result.registered, 0);
  assert.equal(env.services.hourBank.absences(env.guildId).length, 0);
});

test('sem canal configurado o registro acontece, mas nada é enviado', async (t) => {
  const env = await withSchedule(t, shiftStartedAgo(30), {
    settings: { staff_channel_id: null, hour_bank_absence_channel_id: null },
  });
  const result = await env.services.hourBank.checkAbsences(env.guildId);
  assert.equal(result.registered, 1, 'o registro é a parte importante');
  assert.equal(result.notified, 0);
  assert.equal(env.services.hourBank.absences(env.guildId).length, 1);
});

test('canal e cargos do aviso vêm das configurações', async (t) => {
  const env = await withSchedule(t, shiftStartedAgo(30), {
    settings: {
      hour_bank_absence_channel_id: '300000000000000009',
      hour_bank_absence_role_ids: ['500000000000000077'],
    },
  });
  await env.services.hourBank.checkAbsences(env.guildId);

  const alert = env.gateway.channelMessages.find((message) =>
    String(message.payload?.content ?? '').includes('<@&500000000000000077>'),
  );
  assert.ok(alert, 'usa os cargos configurados');
  assert.equal(alert.channelId, '300000000000000009');
});

test('turnos de outros dias não entram no registro', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);
  const today = tzParts(new Date()).weekday;
  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF,
    shifts: [{ weekday: (today + 3) % 7, start: '12:00', end: '18:00' }],
  });

  const result = await env.services.hourBank.checkAbsences(env.guildId);
  assert.equal(result.registered, 0);
});

test('staff bloqueado pela administração não é cobrado', async (t) => {
  const env = await withSchedule(t, shiftStartedAgo(30));
  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'INDISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });
  // Bloqueio: o staff não pode ficar disponível, então não é falta dele.
  const { blockStaff } = require('../src/systems/staff/staffAdmin');
  await blockStaff({
    services: env.services,
    guildId: env.guildId,
    userId: STAFF,
    reason: 'teste',
  });

  const result = await env.services.hourBank.checkAbsences(env.guildId);
  assert.equal(result.registered, 0);
  assert.equal(env.services.hourBank.absences(env.guildId).length, 0);
});

test('o painel web recebe as ausências no /api/overview', async (t) => {
  const env = await withSchedule(t, shiftStartedAgo(90, 60));
  await env.services.hourBank.checkAbsences(env.guildId);

  const overview = env.services.hourBank.overview(env.guildId);
  assert.equal(overview.absences.length, 1);
  assert.equal(overview.absencesSummary.total, 1);
  assert.equal(overview.absencesSummary.missed, 1, 'turno encerrado sem comparecer');
  assert.equal(overview.absences[0].staffName, 'pedrosa17');
  assert.match(overview.absences[0].day, /^\d{2}\/\d{2}\/\d{4}$/);
});

test('a rota /api/absences entrega a lista para o painel web', async (t) => {
  const env = await withSchedule(t, shiftStartedAgo(90, 60));
  await env.services.hourBank.checkAbsences(env.guildId);

  const { createWebServer } = require('../src/web/server');
  const { server } = createWebServer({
    services: env.services,
    env: { timezone: 'America/Sao_Paulo', guildId: env.guildId },
    password: 'senha-de-teste',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'senha-de-teste' }),
  });
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];

  const response = await fetch(`${base}/api/absences`, { headers: { cookie } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.absences.length, 1);
  assert.equal(body.absences[0].status, 'FALTOU');
  assert.equal(body.alert.graceMinutes, 10);
  assert.deepEqual(body.alert.roleIds, [ROLE_A, ROLE_B]);
});

test('o registro sobrevive ao reinício (nada de falta duplicada)', async (t) => {
  const env = await withSchedule(t, shiftStartedAgo(30));
  await env.services.hourBank.checkAbsences(env.guildId);

  // Simula um reinício: mesmo banco, serviço recriado.
  const { createServices } = require('../src/services');
  const restarted = await createServices({ db: env.db, gateway: env.gateway });
  const result = await restarted.hourBank.checkAbsences(env.guildId);
  assert.equal(result.registered, 0);
  assert.equal(restarted.hourBank.absences(env.guildId).length, 1);
  assert.equal(alertMessages(env).length, 1, 'um único aviso no canal');
});

test('a hora do turno vai no aviso e no painel', async (t) => {
  const shift = shiftStartedAgo(30);
  const env = await withSchedule(t, shift);
  await env.services.hourBank.checkAbsences(env.guildId);

  const [absence] = env.services.hourBank.absences(env.guildId);
  assert.equal(absence.startLabel, shift.start);
  assert.equal(absence.endLabel, shift.end);
  const [alert] = alertMessages(env);
  assert.match(alert.payload.embeds[0].description, new RegExp(shift.start));
});
