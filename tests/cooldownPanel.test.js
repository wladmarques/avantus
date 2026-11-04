'use strict';

/**
 * Painel web: ativar/desativar e configurar o bloqueio (cooldown) que o jogador
 * recebe ao sair da call de espera antes de ser chamado.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestEnv, addMember } = require('./helpers');
const { createWebServer, PUBLIC_DIR } = require('../src/web/server');

const PASSWORD = 'senha-de-teste';
const PLAYER = '900000000000009501';
const PLAYER2 = '900000000000009502';

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

/** Jogador entra na fila e sai pelo canal de espera (desistência). */
async function joinAndLeave(env, userId = PLAYER) {
  addMember(env.gateway, userId, { voiceChannelId: env.waitChannelId, displayName: 'Jogador' });
  await env.services.queue.join({ guildId: env.guildId, userId, displayName: 'Jogador' });
  await env.services.attendance.handlePlayerVoiceUpdate({
    guildId: env.guildId,
    userId,
    channelId: null,
    oldChannelId: env.waitChannelId,
    attendanceChannelIds: [env.attChannelId],
  });
}

test('GET /api/cooldown mostra o bloqueio ativo (padrão 10 min)', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();
  const response = await panel.call('/api/cooldown', { cookie });

  assert.equal(response.status, 200);
  assert.deepEqual(response.json.cooldown, { enabled: true, minutes: 10, lastMinutes: 10 });
  assert.deepEqual(response.json.players, []);
});

test('desativar libera a volta imediata à fila', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();
  const off = await panel.call('/api/cooldown', {
    method: 'PUT',
    cookie,
    body: { enabled: false },
  });

  assert.equal(off.status, 200);
  assert.equal(off.json.cooldown.enabled, false);
  assert.equal(off.json.cooldown.minutes, 0);
  assert.equal(off.json.cooldown.lastMinutes, 10, 'guarda o último tempo');
  assert.equal(env.services.settings.get('rejoin_cooldown_minutes'), 0);

  // Sai da call: nada de bloqueio, e pode voltar na hora.
  await joinAndLeave(env);
  assert.equal(env.services.cooldowns.check(env.guildId, PLAYER).active, false);

  addMember(env.gateway, PLAYER, { voiceChannelId: env.waitChannelId });
  await env.services.queue.join({ guildId: env.guildId, userId: PLAYER, displayName: 'Jogador' });
  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 1, 'voltou para a fila');
});

test('ativar com tempo novo vale na hora e aparece na lista', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();
  const on = await panel.call('/api/cooldown', {
    method: 'PUT',
    cookie,
    body: { enabled: true, minutes: 30 },
  });
  assert.equal(on.json.cooldown.enabled, true);
  assert.equal(on.json.cooldown.minutes, 30);

  await joinAndLeave(env);
  const info = env.services.cooldowns.check(env.guildId, PLAYER);
  assert.equal(info.active, true);
  assert.ok(info.remainingSeconds > 29 * 60, `restante: ${info.remainingSeconds}`);

  const listed = await panel.call('/api/cooldown', { cookie });
  assert.equal(listed.json.cooldown.minutes, 30);
  assert.equal(listed.json.players.length, 1);
  assert.equal(listed.json.players[0].userId, PLAYER);
  assert.ok(listed.json.players[0].remainingSeconds > 0);
  assert.equal(listed.json.players[0].minutes, 30);
});

test('reativar sem informar minutos restaura o último valor usado', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();
  await panel.call('/api/cooldown', { method: 'PUT', cookie, body: { enabled: true, minutes: 25 } });
  await panel.call('/api/cooldown', { method: 'PUT', cookie, body: { enabled: false } });

  const back = await panel.call('/api/cooldown', {
    method: 'PUT',
    cookie,
    body: { enabled: true },
  });
  assert.equal(back.json.cooldown.enabled, true);
  assert.equal(back.json.cooldown.minutes, 25, 'voltou com o último tempo');
  assert.equal(env.services.settings.get('rejoin_cooldown_minutes'), 25);
});

test('minutes: 0 desliga; valores inválidos são recusados', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();

  const zero = await panel.call('/api/cooldown', {
    method: 'PUT',
    cookie,
    body: { minutes: 0 },
  });
  assert.equal(zero.status, 200);
  assert.equal(zero.json.cooldown.enabled, false);

  for (const minutes of [-5, 1441, 2.5, 'abc']) {
    const invalid = await panel.call('/api/cooldown', {
      method: 'PUT',
      cookie,
      body: { minutes },
    });
    assert.equal(invalid.status, 400, `recusa ${minutes}`);
  }

  const empty = await panel.call('/api/cooldown', { method: 'PUT', cookie, body: {} });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /Nada para atualizar/);

  assert.equal(env.services.settings.get('rejoin_cooldown_minutes'), 0, 'nada inválido foi salvo');
});

test('PUT /api/cooldown registra auditoria e exige login', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  assert.equal(
    (await panel.call('/api/cooldown', { method: 'PUT', body: { enabled: false } })).status,
    401,
  );
  assert.equal((await panel.call('/api/cooldown')).status, 401);

  const { cookie } = await panel.login();
  await panel.call('/api/cooldown', { method: 'PUT', cookie, body: { enabled: false } });

  const logs = env.gateway.channelMessages.filter(
    (item) => item.channelId === env.services.settings.get('log_channel_id'),
  );
  assert.ok(
    logs.some((item) => /desativou/i.test(item.payload.embeds[0].description)),
    'auditoria do painel',
  );
});

test('quem já está bloqueado continua listado depois de desligar', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();
  await joinAndLeave(env, PLAYER);
  await joinAndLeave(env, PLAYER2);

  const before = await panel.call('/api/cooldown', { cookie });
  assert.equal(before.json.players.length, 2, 'dois jogadores bloqueados');

  const off = await panel.call('/api/cooldown', { method: 'PUT', cookie, body: { enabled: false } });
  assert.equal(off.json.cooldown.enabled, false);
  // Desligar não apaga o bloqueio vigente de quem já saiu (o tempo é cumprido).
  assert.equal(off.json.players.length, 2);
});

test('o painel tem a seção do bloqueio ligada ao app.js', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');

  for (const id of ['cooldown-enabled', 'cooldown-minutes', 'cooldown-save', 'cooldown-status', 'cooldown-list', 'cooldown-players']) {
    assert.match(html, new RegExp(`id="${id}"`), `HTML contém #${id}`);
    assert.match(app, new RegExp(`'${id}'`), `app.js usa #${id}`);
  }
  assert.match(html, /Bloqueio ao sair da call/);
  assert.match(app, /\/api\/cooldown/);
  assert.match(app, /function saveCooldownConfig/);

  // A antiga seção da janela de reconexão saiu de cena.
  assert.ok(!/Fila e canal de espera/.test(html), 'seção antiga removida');
  assert.ok(!/wait_voice_grace|wait-grace/.test(html + app), 'sem resquícios da janela de reconexão');
});
