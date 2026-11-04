'use strict';

/**
 * Janela de reconexão do canal de espera (`wait_voice_grace_*`):
 * quem cai do canal aguardando-atendimento continua na fila pelo tempo
 * configurado no painel web e só é removido se não voltar.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember, addStaffInVoice } = require('./helpers');
const { createWebServer } = require('../src/web/server');

const PASSWORD = 'senha-de-teste';
const PLAYER = '900000000000008001';
const PLAYER2 = '900000000000008002';
const STAFF = '910000000000008001';

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

/** Jogador na fila, dentro do canal de espera. */
async function playerWaiting(env, userId = PLAYER, name = 'Jogador') {
  addMember(env.gateway, userId, { voiceChannelId: env.waitChannelId, displayName: name });
  return env.services.queue.join({ guildId: env.guildId, userId, displayName: name });
}

/** Simula a saída do canal de espera. */
async function leaveWaitChannel(env, userId = PLAYER) {
  return env.services.attendance.handlePlayerVoiceUpdate({
    guildId: env.guildId,
    userId,
    channelId: null,
    oldChannelId: env.waitChannelId,
    attendanceChannelIds: [env.attChannelId],
  });
}

const inQueue = (env, userId = PLAYER) =>
  env.services.engine.getState(env.guildId).waiting.some((row) => row.user_id === userId);

test('desligado (padrão): sair do canal de espera remove da fila na hora', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await playerWaiting(env);
  const result = await leaveWaitChannel(env);

  assert.deepEqual(result, { leftQueue: true });
  assert.equal(inQueue(env), false, 'saiu da fila imediatamente');
  assert.equal(env.services.engine.waitGraceState(env.guildId).length, 0);
});

test('ligado: o jogador continua na fila durante a espera e recebe a DM', async (t) => {
  const env = await createTestEnv({
    settings: { wait_voice_grace_enabled: true, wait_voice_grace_seconds: 30 },
  });
  t.after(env.cleanup);

  const joined = await playerWaiting(env);
  const result = await leaveWaitChannel(env);

  assert.equal(result.graceStarted, true);
  assert.equal(result.seconds, 30);
  assert.equal(inQueue(env), true, 'continua na fila');
  assert.equal(env.services.engine.getState(env.guildId).waiting[0].position, 1);

  const dm = env.gateway.dms.filter((entry) => entry.userId === PLAYER).at(-1);
  assert.ok(dm, 'aviso por DM');
  assert.match(JSON.stringify(dm.payload), /saiu do canal de espera/i);
  assert.match(JSON.stringify(dm.payload), /30s/);

  const grace = env.services.engine.waitGraceState(env.guildId);
  assert.equal(grace.length, 1);
  assert.equal(grace[0].protocol, joined.protocol);
  assert.ok(grace[0].remainingSeconds > 0 && grace[0].remainingSeconds <= 30);

  // Auditoria do início da espera.
  const logs = env.gateway.channelMessages.filter(
    (item) => item.channelId === env.services.settings.get('log_channel_id'),
  );
  assert.ok(
    logs.some((item) => /saiu do canal de espera/i.test(item.payload.embeds[0].description)),
    'auditoria do início da janela de reconexão',
  );
});

test('voltando ao canal dentro do tempo, o lugar na fila é mantido', async (t) => {
  const env = await createTestEnv({
    settings: { wait_voice_grace_enabled: true, wait_voice_grace_seconds: 30 },
  });
  t.after(env.cleanup);

  await playerWaiting(env);
  await leaveWaitChannel(env);
  assert.equal(env.services.engine.waitGraceState(env.guildId).length, 1);

  addMember(env.gateway, PLAYER, { voiceChannelId: env.waitChannelId });
  const back = await env.services.attendance.handlePlayerVoiceUpdate({
    guildId: env.guildId,
    userId: PLAYER,
    channelId: env.waitChannelId,
    oldChannelId: null,
    attendanceChannelIds: [env.attChannelId],
  });

  assert.deepEqual(back, { graceCanceled: true });
  assert.equal(inQueue(env), true, 'continua na fila');
  assert.equal(env.services.engine.waitGraceState(env.guildId).length, 0, 'espera cancelada');

  const dm = env.gateway.dms.filter((entry) => entry.userId === PLAYER).at(-1);
  assert.match(JSON.stringify(dm.payload), /voltou para o canal de espera/i);

  // Passado o tempo, o timeout não remove mais ninguém.
  await env.services.engine._handleWaitGraceTimeout(env.guildId, 1);
  assert.equal(inQueue(env), true);
});

test('não voltando a tempo, o protocolo é encerrado com a desistência', async (t) => {
  const env = await createTestEnv({
    settings: { wait_voice_grace_enabled: true, wait_voice_grace_seconds: 30 },
  });
  t.after(env.cleanup);

  const joined = await playerWaiting(env);
  await leaveWaitChannel(env);
  assert.equal(inQueue(env), true);

  // Fora do canal: o timeout remove.
  addMember(env.gateway, PLAYER, { voiceChannelId: null });
  const closed = await env.services.engine._handleWaitGraceTimeout(env.guildId, joined.attendance.id);

  assert.ok(closed, 'protocolo encerrado');
  assert.equal(closed.outcome, 'JOGADOR_DESISTIU');
  assert.equal(inQueue(env), false);
  assert.equal(env.services.engine.waitGraceState(env.guildId).length, 0);
  assert.ok(
    env.services.cooldowns.check(env.guildId, PLAYER)?.active,
    'bloqueio de reentrada aplicado',
  );
});

test('reconexão de última hora: o timeout não remove quem já voltou para a call', async (t) => {
  const env = await createTestEnv({
    settings: { wait_voice_grace_enabled: true, wait_voice_grace_seconds: 30 },
  });
  t.after(env.cleanup);

  const joined = await playerWaiting(env);
  await leaveWaitChannel(env);

  // Voltou para a call, mas o evento de voz ainda não chegou.
  addMember(env.gateway, PLAYER, { voiceChannelId: env.waitChannelId });
  const result = await env.services.engine._handleWaitGraceTimeout(env.guildId, joined.attendance.id);

  assert.equal(result, null, 'nada foi encerrado');
  assert.equal(inQueue(env), true, 'segue na fila');
});

test('quem está em espera é chamado normalmente e a espera é cancelada', async (t) => {
  const env = await createTestEnv({
    settings: { wait_voice_grace_enabled: true, wait_voice_grace_seconds: 30 },
  });
  t.after(env.cleanup);

  const joined = await playerWaiting(env);
  await leaveWaitChannel(env);
  addStaffInVoice(env.gateway, STAFF);

  await env.services.attendance.callNext({
    guildId: env.guildId,
    staffId: STAFF,
    staffTag: 'Staff Teste',
  });

  assert.equal(env.services.engine.waitGraceState(env.guildId).length, 0, 'espera cancelada na chamada');
  const record = env.services.repositories.attendance.findByIdSync(env.guildId, joined.attendance.id);
  assert.equal(record.status, 'serving');
});

test('a espera vale só para o canal de espera e não afeta o atendimento', async (t) => {
  const env = await createTestEnv({
    settings: { wait_voice_grace_enabled: true, wait_voice_grace_seconds: 30 },
  });
  t.after(env.cleanup);

  await playerWaiting(env, PLAYER);
  await playerWaiting(env, PLAYER2, 'Outro');
  await leaveWaitChannel(env, PLAYER);

  assert.equal(env.services.engine.waitGraceState(env.guildId).length, 1);
  assert.equal(inQueue(env, PLAYER), true);
  assert.equal(inQueue(env, PLAYER2), true, 'o outro jogador não é afetado');
  assert.deepEqual(
    env.services.engine.getState(env.guildId).waiting.map((row) => row.user_id),
    [PLAYER, PLAYER2],
    'ordem da fila preservada',
  );
});

/* ------------------------------------------------------------------ */
/* Painel web                                                          */
/* ------------------------------------------------------------------ */

test('GET /api/queue devolve a configuração e quem está em espera', async (t) => {
  const env = await createTestEnv({
    settings: { wait_voice_grace_enabled: true, wait_voice_grace_seconds: 45 },
  });
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  await playerWaiting(env);
  await leaveWaitChannel(env);

  const { cookie } = await panel.login();
  const response = await panel.call('/api/queue', { cookie });

  assert.equal(response.status, 200);
  assert.deepEqual(response.json.waitGrace, { enabled: true, seconds: 45 });
  assert.equal(response.json.players.length, 1);
  assert.equal(response.json.players[0].userId, PLAYER);
  assert.equal(response.json.players[0].protocol, 1);
  assert.ok(response.json.players[0].remainingSeconds > 0);
});

test('PUT /api/queue liga, desliga e ajusta o tempo', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();

  const enabled = await panel.call('/api/queue', {
    method: 'PUT',
    cookie,
    body: { waitGraceEnabled: true, waitGraceSeconds: 90 },
  });
  assert.equal(enabled.status, 200);
  assert.deepEqual(enabled.json.waitGrace, { enabled: true, seconds: 90 });
  assert.equal(env.services.settings.get('wait_voice_grace_enabled'), true);
  assert.equal(env.services.settings.get('wait_voice_grace_seconds'), 90);

  // A configuração vale imediatamente para o motor.
  await playerWaiting(env);
  const left = await leaveWaitChannel(env);
  assert.equal(left.graceStarted, true);
  assert.equal(left.seconds, 90);

  const disabled = await panel.call('/api/queue', {
    method: 'PUT',
    cookie,
    body: { waitGraceEnabled: false },
  });
  assert.equal(disabled.json.waitGrace.enabled, false);

  const invalid = await panel.call('/api/queue', {
    method: 'PUT',
    cookie,
    body: { waitGraceSeconds: 5 },
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /entre 10 e 900/);

  assert.equal(env.services.settings.get('wait_voice_grace_seconds'), 90, 'valor inválido não é salvo');

  const empty = await panel.call('/api/queue', { method: 'PUT', cookie, body: {} });
  assert.equal(empty.status, 400);

  assert.equal((await panel.call('/api/queue')).status, 401, 'exige login');
});

test('o painel tem a seção da fila ligada ao app.js', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { PUBLIC_DIR } = require('../src/web/server');
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');

  for (const id of [
    'wait-grace-enabled',
    'wait-grace-seconds',
    'queue-save',
    'queue-status',
    'queue-grace-list',
    'queue-players',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `HTML contém #${id}`);
    assert.match(app, new RegExp(`'${id}'`), `app.js usa #${id}`);
  }
  assert.match(html, /Fila e canal de espera/);
  assert.match(app, /\/api\/queue/);
  assert.match(app, /function saveQueueConfig/);
});
