'use strict';

/**
 * Painel web do banco de horas: autenticação, API e edição de escala.
 * Sobe um servidor HTTP real em porta efêmera (127.0.0.1).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv } = require('./helpers');
const { createWebServer } = require('../src/web/server');

const PASSWORD = 'senha-de-teste';
const STAFF = '960000000000001001';

async function startPanel(env, { password = PASSWORD } = {}) {
  const { server } = createWebServer({
    services: env.services,
    env: { timezone: 'America/Sao_Paulo', guildId: env.guildId },
    password,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const call = async (path, { method = 'GET', body, cookie } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text, headers: response.headers };
  };

  const login = async () => {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const cookie = String(response.headers.get('set-cookie') || '').split(';')[0];
    return { status: response.status, cookie };
  };

  return {
    base,
    call,
    login,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('API exige login (401 sem sessão)', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const response = await panel.call('/api/overview');
  assert.equal(response.status, 401);
  assert.match(response.json.error, /Sessão expirada/);
});

test('senha errada e senha correta', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const wrong = await panel.call('/api/login', { method: 'POST', body: { password: 'errada' } });
  assert.equal(wrong.status, 401);

  const { status, cookie } = await panel.login();
  assert.equal(status, 200);
  assert.match(cookie, /vantus_session=/);

  const overview = await panel.call('/api/overview', { cookie });
  assert.equal(overview.status, 200);
  assert.equal(overview.json.guildId, env.guildId);
  assert.ok(Array.isArray(overview.json.staff));
});

test('painel desativado sem senha configurada', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env, { password: null });
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const login = await panel.call('/api/login', { method: 'POST', body: { password: 'x' } });
  assert.equal(login.status, 503);
  const page = await panel.call('/');
  assert.equal(page.status, 503);
});

test('salvar escala pelo painel e refletir na API', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();

  const saved = await panel.call(`/api/staff/${STAFF}/shifts`, {
    method: 'PUT',
    cookie,
    body: {
      staffName: 'pedrosa17',
      shifts: [
        { weekday: 1, start: '12:00', end: '18:00' },
        { weekday: 6, start: '20:00', end: '23:30' },
      ],
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.shifts.length, 2);

  const overview = await panel.call('/api/overview', { cookie });
  const row = overview.json.staff.find((item) => item.userId === STAFF);
  assert.ok(row, 'staff aparece no painel após cadastrar a escala');
  assert.equal(row.staffName, 'pedrosa17');
  assert.equal(row.weekly.length, 7);
  const monday = row.weekly.find((day) => day.weekday === 1);
  assert.deepEqual(monday.shifts, [{ start: '12:00', end: '18:00' }]);

  const invalid = await panel.call(`/api/staff/${STAFF}/shifts`, {
    method: 'PUT',
    cookie,
    body: { shifts: [{ weekday: 9, start: '10:00', end: '12:00' }] },
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /Dia da semana inválido/);

  const removed = await panel.call(`/api/staff/${STAFF}/shifts`, { method: 'DELETE', cookie });
  assert.equal(removed.status, 200);
  const after = await panel.call(`/api/sessions?userId=${STAFF}`, { cookie });
  assert.equal(after.status, 200);
});

test('relatório e sessões exigem sessão válida e trazem os dados', async (t) => {
  const env = await createTestEnv({ staff: false });
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();
  const now = Date.now();
  await env.services.hourBank.startSession({ guildId: env.guildId, userId: STAFF, staffName: 'ana', at: now - 90 * 60000 });
  await env.services.hourBank.endSession({ guildId: env.guildId, userId: STAFF, at: now - 30 * 60000 });

  const report = await panel.call('/api/report', { cookie });
  assert.equal(report.status, 200);
  const item = report.json.staff.find((row) => row.userId === STAFF);
  assert.equal(item.sessions, 1);
  assert.equal(item.totalMinutes, 60);

  const sessions = await panel.call(`/api/sessions?userId=${STAFF}`, { cookie });
  assert.equal(sessions.status, 200);
  assert.equal(sessions.json.sessions.length, 1);
  assert.equal(sessions.json.sessions[0].open, false);
  assert.ok(sessions.json.sessions[0].entry);
  assert.ok(sessions.json.sessions[0].exit);
});

test('logout invalida a sessão', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();
  const logout = await panel.call('/api/logout', { method: 'POST', cookie });
  assert.equal(logout.status, 200);

  // O cookie antigo continua sendo enviado pelo cliente, mas o token foi removido.
  const after = await panel.call('/api/overview', { cookie });
  assert.equal(after.status, 401);
});

test('interface e assets são servidos para usuários autenticados', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const page = await panel.call('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /Banco de horas/);

  const css = await panel.call('/styles.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const js = await panel.call('/app.js');
  assert.equal(js.status, 200);
  assert.match(js.text, /api\/overview/);

  const health = await panel.call('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
});
