'use strict';

/**
 * Horário de funcionamento pelo painel web.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestEnv } = require('./helpers');
const { createWebServer, PUBLIC_DIR } = require('../src/web/server');

const PASSWORD = 'senha-de-teste';
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

async function startPanel(env) {
  const { server } = createWebServer({
    services: env.services,
    env: { timezone: 'America/Sao_Paulo', guildId: env.guildId },
    password: PASSWORD,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const login = async () => {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = String(response.headers.get('set-cookie') || '').split(';')[0];
    return { cookie };
  };

  const call = async (pathname, { method = 'GET', body, cookie } = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json };
  };

  return { call, login, close: () => new Promise((resolve) => server.close(resolve)) };
}

const everyDay = (open, close) =>
  Object.fromEntries(DAYS.map((key) => [key, [{ open, close }]]));

test('GET /api/schedule devolve os 7 dias e o status da central', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();
  const response = await panel.call('/api/schedule', { cookie });

  assert.equal(response.status, 200);
  assert.equal(response.json.days.length, 7);
  assert.deepEqual(
    response.json.days.map((day) => day.key),
    DAYS,
  );
  assert.equal(response.json.days[1].label, 'Segunda');
  assert.ok(response.json.status.label === 'ABERTA' || response.json.status.label === 'FECHADA');
  assert.equal(response.json.centralManual, 'open');
  for (const key of DAYS) assert.ok(Array.isArray(response.json.schedule[key]), `${key} é lista`);
});

test('PUT /api/schedule salva o horário e reflete na central', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();
  const schedule = {
    mon: [{ open: '10:00', close: '16:00' }],
    tue: [{ open: '10:00', close: '16:00' }],
    wed: [{ open: '12:00', close: '18:00' }, { open: '20:00', close: '02:00' }],
    thu: [],
    fri: [{ open: '18:00', close: '02:00' }],
    sat: [{ open: '14:00', close: '00:00' }],
    sun: [],
  };

  const response = await panel.call('/api/schedule', {
    method: 'PUT',
    cookie,
    body: { schedule, centralManual: 'auto' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(env.services.settings.get('schedule'), schedule);
  assert.equal(env.services.settings.get('central_manual'), 'auto');
  assert.deepEqual(response.json.schedule.wed, schedule.wed, 'turnos múltiplos preservados');
  const thu = response.json.days.find((day) => day.key === 'thu');
  assert.equal(thu.windows.length, 0, 'quinta fechada');
  const wed = response.json.days.find((day) => day.key === 'wed');
  assert.equal(wed.windows.length, 2, 'quarta com dois turnos');

  // A auditoria registra a mudança.
  const logs = env.gateway.channelMessages.filter((item) => item.channelId === env.gateway.settings.get('log_channel_id'));
  assert.ok(
    logs.some((item) => /painel web.*horário de funcionamento/i.test(item.payload.embeds[0].description)),
    'auditoria do painel',
  );
});

test('PUT /api/schedule valida horários e dias', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();
  const before = env.services.settings.get('schedule');

  const invalidTime = await panel.call('/api/schedule', {
    method: 'PUT',
    cookie,
    body: { schedule: { mon: [{ open: '25:00', close: '26:00' }] } },
  });
  assert.equal(invalidTime.status, 400);
  assert.match(invalidTime.json.error, /Horário inválido/);

  const sameTime = await panel.call('/api/schedule', {
    method: 'PUT',
    cookie,
    body: { schedule: { tue: [{ open: '12:00', close: '12:00' }] } },
  });
  assert.equal(sameTime.status, 400);
  assert.match(sameTime.json.error, /não podem ser iguais/);

  const unknownDay = await panel.call('/api/schedule', {
    method: 'PUT',
    cookie,
    body: { schedule: { funday: [{ open: '12:00', close: '13:00' }] } },
  });
  assert.equal(unknownDay.status, 400);
  assert.match(unknownDay.json.error, /Dia desconhecido/);

  const badManual = await panel.call('/api/schedule', {
    method: 'PUT',
    cookie,
    body: { centralManual: 'talvez' },
  });
  assert.equal(badManual.status, 400);

  assert.deepEqual(env.services.settings.get('schedule'), before, 'nada foi salvo com erro');
});

test('dia fechado força a central fechada; forçar aberta vence o horário', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();

  const closed = await panel.call('/api/schedule', {
    method: 'PUT',
    cookie,
    body: { schedule: everyDay('00:01', '00:02'), centralManual: 'auto' },
  });
  assert.equal(closed.status, 200);
  // Fora do turno de 1 minuto → fechada (ou aberta só se o minuto bater).
  assert.equal(typeof closed.json.status.open, 'boolean');

  const emptyWeek = await panel.call('/api/schedule', {
    method: 'PUT',
    cookie,
    body: { schedule: Object.fromEntries(DAYS.map((key) => [key, []])), centralManual: 'auto' },
  });
  assert.equal(emptyWeek.json.status.open, false, 'sem nenhum turno a central fica fechada');

  const forced = await panel.call('/api/schedule', {
    method: 'PUT',
    cookie,
    body: { centralManual: 'open' },
  });
  assert.equal(forced.json.status.open, true, 'forçar aberta');
  assert.equal(forced.json.status.manual, true);
});

test('API de horário exige login', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  assert.equal((await panel.call('/api/schedule')).status, 401);
  assert.equal((await panel.call('/api/schedule', { method: 'PUT', body: {} })).status, 401);
});

test('o painel tem a seção de horário ligada ao app.js', async () => {
  const app = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

  for (const id of ['schedule-days', 'schedule-save', 'schedule-status', 'schedule-today', 'central-manual']) {
    assert.match(html, new RegExp(`id="${id}"`), `HTML contém #${id}`);
    assert.match(app, new RegExp(`\\$\\('${id}'\\)`), `app.js usa #${id}`);
  }
  assert.match(html, /<h2>Horário de funcionamento<\/h2>/);
  assert.match(app, /\/api\/schedule/);
  assert.match(app, /function collectSchedule/);
  assert.match(app, /function buildDay/);
});
