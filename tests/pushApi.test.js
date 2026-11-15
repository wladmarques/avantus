'use strict';

/**
 * API do aviso no celular (ntfy) no painel web.
 *
 * Cobre o caminho do administrador: ler a configuração, salvar (com validação
 * de tópico/endereço), remover o token, disparar o teste e ver o resultado.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv } = require('./helpers');
const { createWebServer } = require('../src/web/server');

const PASSWORD = 'vantus';

async function openPanel(t, { settings = {} } = {}) {
  const env = await createTestEnv({ staff: false, settings });
  const { server } = createWebServer({
    services: env.services,
    env: { guildId: env.guildId },
    password: PASSWORD,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const { token } = await login.json();

  const call = async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await env.cleanup();
  });

  return { env, call };
}

test('a configuração do push exige login', async (t) => {
  const env = await createTestEnv({ staff: false });
  const { server } = createWebServer({
    services: env.services,
    env: { guildId: env.guildId },
    password: PASSWORD,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/push`);
  assert.equal(response.status, 401);
  await new Promise((resolve) => server.close(resolve));
  await env.cleanup();
});

test('vem desligado por padrão, com endereço do ntfy sugerido', async (t) => {
  const { call } = await openPanel(t);
  const { status, data } = await call('/api/push');
  assert.equal(status, 200);
  assert.equal(data.enabled, false);
  assert.equal(data.ready, false);
  assert.equal(data.endpoint, 'https://ntfy.sh');
  assert.equal(data.topic, '');
  assert.equal(data.hasToken, false);
  assert.equal(data.events.queueJoin, true);
  assert.equal(data.events.queueBlocked, true);
});

test('salvar tópico inválido devolve erro em português', async (t) => {
  const { call } = await openPanel(t);
  const { status, data } = await call('/api/push', {
    method: 'PUT',
    body: { topic: 'tópico com espaço!' },
  });
  assert.equal(status, 400);
  assert.match(data.error, /Tópico inválido/);
});

test('salvar endereço inválido devolve erro', async (t) => {
  const { call } = await openPanel(t);
  const { status, data } = await call('/api/push', {
    method: 'PUT',
    body: { endpoint: 'ntfy.sh' },
  });
  assert.equal(status, 400);
  assert.match(data.error, /Endereço inválido/);
});

test('salva, liga e devolve o token mascarado', async (t) => {
  const { call, env } = await openPanel(t);
  const { status, data } = await call('/api/push', {
    method: 'PUT',
    body: {
      enabled: true,
      endpoint: 'https://ntfy.sh/',
      topic: 'vantus-fila-abc123',
      token: 'tk_segredo1234',
      events: { queueJoin: true, queueBlocked: false },
    },
  });

  assert.equal(status, 200);
  assert.equal(data.ready, true);
  assert.equal(data.topic, 'vantus-fila-abc123');
  assert.equal(data.hasToken, true);
  assert.equal(JSON.stringify(data).includes('tk_segredo1234'), false);
  assert.equal(data.events.queueBlocked, false);
  // o token fica no banco inteiro (só a resposta é mascarada)
  assert.equal(env.services.settings.get('push_token'), 'tk_segredo1234');

  const saved = await call('/api/push');
  assert.equal(saved.data.enabled, true);
  assert.equal(saved.data.ready, true);
});

test('remover token mantém o resto da configuração', async (t) => {
  const { call, env } = await openPanel(t);
  await call('/api/push', {
    method: 'PUT',
    body: { enabled: true, topic: 'vantus-fila-abc123', token: 'tk_segredo1234' },
  });
  const { status, data } = await call('/api/push', { method: 'PUT', body: { clearToken: true } });
  assert.equal(status, 200);
  assert.equal(data.hasToken, false);
  assert.equal(env.services.settings.get('push_token'), '');
  assert.equal(data.topic, 'vantus-fila-abc123');
  assert.equal(data.enabled, true);
});

test('o teste do painel envia pelo ntfy e mostra o status', async (t) => {
  const { call, env } = await openPanel(t);
  const bodies = [];
  env.services.push.fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => '' };
  };

  await call('/api/push', {
    method: 'PUT',
    body: { enabled: true, topic: 'vantus-fila-abc123' },
  });

  const { status, data } = await call('/api/push/test', { method: 'POST' });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.match(data.lastStatus, /ok 200/);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].title, /Teste/);
});

test('falha no teste devolve 400 com a mensagem do ntfy', async (t) => {
  const { call, env } = await openPanel(t);
  env.services.push.fetchImpl = async () => ({ ok: false, status: 401, text: async () => '' });

  await call('/api/push', { method: 'PUT', body: { enabled: true, topic: 'vantus-fila-abc123' } });
  const { status, data } = await call('/api/push/test', { method: 'POST' });
  assert.equal(status, 400);
  assert.match(data.error, /token/);
});

test('teste sem tópico explica o que falta', async (t) => {
  const { call } = await openPanel(t);
  const { status, data } = await call('/api/push/test', { method: 'POST' });
  assert.equal(status, 400);
  assert.match(data.error, /tópico/i);
});
