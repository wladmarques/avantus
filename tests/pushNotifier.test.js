'use strict';

/**
 * Aviso no celular do dono (ntfy) quando alguém entra na fila.
 *
 * O foco é o contrato com o ntfy e, principalmente, a promessa de que **push
 * nunca quebra a fila**: falha de rede, HTTP 500, token errado ou configuração
 * incompleta não podem impedir alguém de entrar na fila nem derrubar o painel.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember } = require('./helpers');
const voiceEvent = require('../src/events/voice/voiceStateUpdate');
const {
  PushNotifier,
  buildJoinMessage,
  buildBlockedMessage,
  normalizeEndpoint,
  maskSecret,
} = require('../src/systems/notifications/pushNotifier');

const TOPIC = 'vantus-fila-teste-8j3k9m2x';

/** fetch falso: registra as chamadas e responde o que o teste mandar. */
function fakeFetch(handler = () => ({ ok: true, status: 200 })) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
    const result = handler(url, options, calls.length);
    if (result instanceof Error) throw result;
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      text: async () => result.text ?? '',
    };
  };
  impl.calls = calls;
  return impl;
}

async function makeNotifier(t, { settings = {}, handler } = {}) {
  const env = await createTestEnv({ staff: false });
  t.after(() => env.cleanup());
  await env.services.settings.setMany({
    push_enabled: true,
    push_endpoint: 'https://ntfy.sh',
    push_topic: TOPIC,
    ...settings,
  });
  const fetchImpl = fakeFetch(handler);
  const push = new PushNotifier({ settings: env.services.settings, fetchImpl });
  return { env, push, fetchImpl };
}

/* ------------------------------------------------------------------ */
/* Mensagem                                                            */
/* ------------------------------------------------------------------ */

test('a mensagem de entrada traz nome, posição, protocolo e horário', () => {
  const built = buildJoinMessage(
    {
      userName: 'Pedro',
      position: 1,
      queueSize: 3,
      protocol: 7,
      at: new Date('2026-11-12T23:00:00Z'),
    },
    { timeZone: 'America/Sao_Paulo' },
  );

  assert.equal(built.title, 'Pedro entrou na fila');
  assert.match(built.message, /Pedro entrou na fila/);
  assert.match(built.message, /Posição 1º de 3/);
  assert.match(built.message, /Protocolo #0007/);
  assert.match(built.message, /12\/11\/2026/);
  // sem emoji: o aviso do celular segue o estilo enxuto dos painéis
  assert.doesNotMatch(built.message, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
});

test('a mensagem de fila bloqueada explica o motivo', () => {
  const built = buildBlockedMessage({
    userName: 'Pedro',
    reason: 'Nenhum staff em serviço (fila fechada)',
    at: new Date('2026-11-12T23:00:00Z'),
  });
  assert.equal(built.title, 'Pedro não entrou na fila');
  assert.match(built.message, /tentou entrar na fila/);
  assert.match(built.message, /Nenhum staff em serviço/);
});

/* ------------------------------------------------------------------ */
/* Envio                                                               */
/* ------------------------------------------------------------------ */

test('entrada na fila publica um JSON no tópico configurado', async (t) => {
  const { push, fetchImpl } = await makeNotifier(t);

  const result = await push.queueJoined({
    guildId: 'g',
    userId: '123',
    userName: 'Pedro',
    protocol: 7,
    position: 1,
    queueSize: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(fetchImpl.calls.length, 1);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://ntfy.sh');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.body.topic, TOPIC);
  assert.match(call.body.title, /Pedro entrou na fila/);
  // primeira da fila tem prioridade alta (aparece com mais destaque no celular)
  assert.equal(call.body.priority, 'high');
  assert.equal(call.options.headers.authorization, undefined);
});

test('token configurado vai no header Bearer, nunca na URL', async (t) => {
  const { push, fetchImpl } = await makeNotifier(t, { settings: { push_token: 'tk_segredo123' } });
  await push.queueJoined({ userName: 'Pedro', position: 2, queueSize: 2, protocol: 8 });

  const [call] = fetchImpl.calls;
  assert.equal(call.options.headers.authorization, 'Bearer tk_segredo123');
  assert.doesNotMatch(call.url, /tk_segredo123/);
  assert.equal(call.body.priority, 'default');
});

test('desligado ou sem tópico não envia nada', async (t) => {
  const { push, fetchImpl, env } = await makeNotifier(t);

  await env.services.settings.set('push_enabled', false);
  assert.deepEqual(await push.queueJoined({ userName: 'Pedro', position: 1 }), {
    skipped: 'Notificações desligadas no painel.',
  });

  await env.services.settings.setMany({ push_enabled: true, push_topic: '' });
  assert.match((await push.queueJoined({ userName: 'Pedro', position: 1 })).skipped, /tópico/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('evento desligado no painel não envia', async (t) => {
  const { push, fetchImpl } = await makeNotifier(t, { settings: { push_on_queue_join: false } });
  assert.deepEqual(await push.queueJoined({ userName: 'Pedro', position: 1 }), {
    skipped: 'evento desligado',
  });
  assert.equal(fetchImpl.calls.length, 0);
});

test('falha de rede não lança e registra o erro no painel', async (t) => {
  const { push, env } = await makeNotifier(t, {
    handler: () => new Error('ECONNREFUSED'),
  });

  const result = await push.queueJoined({ userName: 'Pedro', position: 1, protocol: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /Não foi possível falar com o ntfy/);

  const config = push.config();
  assert.match(config.lastStatus, /falhou/);
  assert.match(config.lastError, /ECONNREFUSED/);
  assert.ok(config.lastAt > 0);
  assert.equal(env.services.settings.get('push_last_error').includes('ECONNREFUSED'), true);
});

test('HTTP 401 sugere conferir o token', async (t) => {
  const { push } = await makeNotifier(t, { handler: () => ({ ok: false, status: 401 }) });
  const result = await push.queueJoined({ userName: 'Pedro', position: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.error, /token/);
});

test('o painel recebe o token mascarado e nunca o valor inteiro', async (t) => {
  const { push } = await makeNotifier(t, { settings: { push_token: 'tk_abcdefgh1234' } });
  const config = push.config();
  assert.equal(config.hasToken, true);
  assert.equal(config.tokenMask, maskSecret('tk_abcdefgh1234'));
  assert.equal(JSON.stringify(config).includes('tk_abcdefgh1234'), false);
  assert.equal(config.ready, true);
});

test('endereço inválido desliga o aviso com motivo claro', async (t) => {
  const { push, fetchImpl } = await makeNotifier(t, { settings: { push_endpoint: 'ntfy.sh' } });
  assert.equal(push.config().ready, false);
  assert.match(push.config().disabledReason, /URL/);
  assert.equal(normalizeEndpoint('https://ntfy.example.com/'), 'https://ntfy.example.com');
  assert.equal(normalizeEndpoint('ftp://x'), null);
  await push.queueJoined({ userName: 'Pedro', position: 1 });
  assert.equal(fetchImpl.calls.length, 0);
});

test('o teste do painel falha com mensagem pronta quando não está configurado', async (t) => {
  const { push } = await makeNotifier(t, { settings: { push_topic: '' } });
  await assert.rejects(() => push.sendTest(), /tópico/i);
});

test('o teste do painel envia a mensagem de exemplo', async (t) => {
  const { push, fetchImpl } = await makeNotifier(t);
  const result = await push.sendTest();
  assert.equal(result.ok, true);
  assert.match(fetchImpl.calls[0].body.title, /Teste/);
});

/* ------------------------------------------------------------------ */
/* Integração com a fila                                               */
/* ------------------------------------------------------------------ */

/** Membro mínimo aceito pelo evento de voz (mesmo formato de voiceAutoJoin). */
function fakeMember(userId, displayName) {
  return {
    id: userId,
    displayName,
    user: { id: userId, username: displayName, bot: false },
    roles: { cache: new Map() },
    permissions: { has: () => false },
    guild: { ownerId: 'owner' },
  };
}

/** Simula o Discord avisando que a pessoa entrou (ou saiu) do canal de espera. */
function moveVoice(env, { userId, displayName, from = null, to = env.waitChannelId }) {
  const member = fakeMember(userId, displayName);
  return voiceEvent.execute(
    { guild: { id: env.guildId }, id: userId, member, channelId: from },
    { guild: { id: env.guildId }, id: userId, member, channelId: to },
    { services: env.services },
  );
}

test('entrar na fila dispara o aviso, e a fila funciona com o ntfy fora do ar', async (t) => {
  const env = await createTestEnv({ staff: true });
  t.after(() => env.cleanup());
  await env.services.settings.setMany({
    push_enabled: true,
    push_endpoint: 'https://ntfy.sh',
    push_topic: TOPIC,
  });

  const calls = [];
  env.services.push.fetchImpl = async (url, options) => {
    calls.push(JSON.parse(options.body));
    throw new Error('ntfy fora do ar');
  };

  addMember(env.gateway, '700000000000000001', { voiceChannelId: env.waitChannelId, displayName: 'Pedro' });

  const created = await env.services.queue.join({
    guildId: env.guildId,
    userId: '700000000000000001',
    displayName: 'Pedro',
    source: 'painel',
  });

  assert.equal(created.position, 1);
  assert.equal(calls.length, 1, 'um aviso por pessoa que entra');
  assert.equal(calls[0].topic, TOPIC);
  assert.match(calls[0].title, /Pedro entrou na fila/);

  // A fila continua íntegra mesmo com o push falhando.
  const state = env.services.engine.getState(env.guildId);
  assert.equal(state.waiting.length, 1);
  assert.equal(state.waiting[0].user_id, '700000000000000001');
});

test('cada pessoa que entra gera uma mensagem própria', async (t) => {
  const env = await createTestEnv({ staff: true });
  t.after(() => env.cleanup());
  await env.services.settings.setMany({
    push_enabled: true,
    push_endpoint: 'https://ntfy.sh',
    push_topic: TOPIC,
  });

  const titles = [];
  env.services.push.fetchImpl = async (_url, options) => {
    titles.push(JSON.parse(options.body).title);
    return { ok: true, status: 200, text: async () => '' };
  };

  for (const [userId, name] of [
    ['700000000000000011', 'Pedro'],
    ['700000000000000012', 'Lucas'],
  ]) {
    addMember(env.gateway, userId, { voiceChannelId: env.waitChannelId, displayName: name });
    await env.services.queue.join({ guildId: env.guildId, userId, displayName: name, source: 'painel' });
  }

  assert.deepEqual(titles, ['Pedro entrou na fila', 'Lucas entrou na fila']);
});

test('entrar na call com a central fechada avisa que a fila foi bloqueada', async (t) => {
  const env = await createTestEnv({ staff: true, settings: { central_manual: 'closed' } });
  t.after(() => env.cleanup());
  await env.services.settings.setMany({
    push_enabled: true,
    push_endpoint: 'https://ntfy.sh',
    push_topic: TOPIC,
  });

  const bodies = [];
  env.services.push.fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => '' };
  };

  addMember(env.gateway, '700000000000000021', { voiceChannelId: env.waitChannelId, displayName: 'Pedro' });
  await moveVoice(env, { userId: '700000000000000021', displayName: 'Pedro' });

  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 0, 'não entrou na fila');
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].title, /Pedro não entrou na fila/);
  assert.match(bodies[0].message, /Central fechada/);
});

test('central sem staff também avisa como fila bloqueada', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(() => env.cleanup());
  await env.services.settings.setMany({
    push_enabled: true,
    push_endpoint: 'https://ntfy.sh',
    push_topic: TOPIC,
  });

  const bodies = [];
  env.services.push.fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => '' };
  };

  addMember(env.gateway, '700000000000000041', { voiceChannelId: env.waitChannelId, displayName: 'Pedro' });
  await moveVoice(env, { userId: '700000000000000041', displayName: 'Pedro' });

  assert.equal(bodies.length, 1);
  assert.match(bodies[0].message, /Nenhum staff em serviço/);
});

test('sair da call não gera aviso de push', async (t) => {
  const env = await createTestEnv({ staff: true });
  t.after(() => env.cleanup());
  await env.services.settings.setMany({
    push_enabled: true,
    push_endpoint: 'https://ntfy.sh',
    push_topic: TOPIC,
  });

  let calls = 0;
  env.services.push.fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => '' };
  };

  addMember(env.gateway, '700000000000000031', { voiceChannelId: env.waitChannelId, displayName: 'Pedro' });
  await moveVoice(env, { userId: '700000000000000031', displayName: 'Pedro' });
  assert.equal(calls, 1);

  // Sai do canal de espera (regra fixa: sai da fila na hora, sem novo push).
  await moveVoice(env, {
    userId: '700000000000000031',
    displayName: 'Pedro',
    from: env.waitChannelId,
    to: null,
  });
  assert.equal(calls, 1, 'saída não dispara aviso');
  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 0);
});
