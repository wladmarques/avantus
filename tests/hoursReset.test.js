'use strict';

/**
 * Painel web: botão "Zerar horas" (um staff ou toda a equipe).
 *
 * Regra: apaga as sessões encerradas e reinicia a sessão aberta a partir de
 * agora — quem está em serviço continua contando, mas do zero.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv } = require('./helpers');
const { createWebServer } = require('../src/web/server');

const PASSWORD = 'senha-de-teste';
const STAFF = '900000000000000900';
const STAFF_2 = '910000000000009801';

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
    return { cookie: String(response.headers.get('set-cookie') || '').split(';')[0] };
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

/** Sessão fechada antiga (2 h de trabalho no dia anterior). */
async function seedClosedSession(env, userId, { hours = 2, daysAgo = 1 } = {}) {
  const start = Date.now() - daysAgo * 86400000 - hours * 3600000;
  return env.db.transaction(async () => {
    env.db.run(
      `INSERT INTO staff_sessions (guild_id, user_id, staff_name, started_at, ended_at, minutes, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'disponivel', ?, ?)`,
      [env.guildId, userId, `Staff ${userId}`, start, start + hours * 3600000, hours * 60, start, start],
    );
  });
}

const totalMinutes = (env, userId) =>
  env.services.hourBank.report(env.guildId, {
    from: '2000-01-01',
    to: null,
  }).staff.find((row) => row.userId === userId)?.totalMinutes ?? 0;

test('POST /api/staff/:id/reset-hours zera as horas de um staff', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  await seedClosedSession(env, STAFF, { hours: 3 });
  await seedClosedSession(env, STAFF_2, { hours: 2 });
  assert.ok(totalMinutes(env, STAFF) >= 180);

  const { cookie } = await panel.login();
  const response = await panel.call(`/api/staff/${STAFF}/reset-hours`, { method: 'POST', cookie });

  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.ok(response.json.sessions >= 1, 'informa quantas sessões foram apagadas');
  assert.equal(totalMinutes(env, STAFF), 0, 'staff zerado');
  assert.ok(totalMinutes(env, STAFF_2) >= 120, 'o outro staff não é afetado');
});

test('POST /api/hours/reset zera as horas de toda a equipe', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  await seedClosedSession(env, STAFF, { hours: 1 });
  await seedClosedSession(env, STAFF_2, { hours: 1 });

  const { cookie } = await panel.login();
  const response = await panel.call('/api/hours/reset', { method: 'POST', cookie });

  assert.equal(response.status, 200);
  assert.equal(totalMinutes(env, STAFF), 0);
  assert.equal(totalMinutes(env, STAFF_2), 0);
});

test('a sessão em andamento continua aberta, recomeçando do zero', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  // DEFAULT_STAFF já está DISPONÍVEL → tem sessão aberta.
  const before = env.services.hourBank.activeSession(env.guildId, STAFF);
  assert.ok(before, 'staff em serviço tem sessão aberta');

  const { cookie } = await panel.login();
  const response = await panel.call(`/api/staff/${STAFF}/reset-hours`, { method: 'POST', cookie });
  assert.equal(response.status, 200);
  assert.equal(response.json.restarted, 1, 'uma sessão em andamento reiniciada');

  const after = env.services.hourBank.activeSession(env.guildId, STAFF);
  assert.ok(after, 'a sessão continua aberta (staff segue em serviço)');
  assert.ok(after.started_at >= before.started_at, 'recomeçou agora');
  assert.equal(
    env.services.hourBank.summary(env.guildId, STAFF).openMinutes ?? 0,
    0,
    'nada de horas antigas na sessão',
  );
});

test('zerar horas exige login', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  assert.equal((await panel.call(`/api/staff/${STAFF}/reset-hours`, { method: 'POST' })).status, 401);
  assert.equal((await panel.call('/api/hours/reset', { method: 'POST' })).status, 401);
});

test('a ação fica registrada na auditoria', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  await seedClosedSession(env, STAFF, { hours: 1 });
  const { cookie } = await panel.login();
  await panel.call('/api/hours/reset', { method: 'POST', cookie });

  const logs = env.services.repositories.audit.listRecentSync(env.guildId, { limit: 20 });
  const entry = logs.find((row) => row.type === 'HOURS_RESET');
  assert.ok(entry, 'evento HOURS_RESET gravado');
  assert.match(entry.message, /toda a equipe/);
});

test('o painel mostra os botões de zerar horas', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { PUBLIC_DIR } = require('../src/web/server');
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');

  assert.match(html, /id="reset-all-hours"/);
  assert.match(html, /id="reset-modal"/);
  assert.match(html, /id="reset-confirm"/);
  assert.match(app, /Zerar horas/);
  assert.match(app, /\/api\/hours\/reset/);
  assert.match(app, /reset-hours/);
});
