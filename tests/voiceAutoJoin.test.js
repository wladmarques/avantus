'use strict';

/**
 * Regressão: fila por voz (entrada automática ao entrar no canal de espera).
 *
 * Diferente de tests/voice.test.js (que chama o motor diretamente), aqui o
 * caminho é o de produção: o evento `voiceStateUpdate` do Discord → fachada
 * `services.attendance` → motor. É esse encanamento que precisa continuar vivo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember, countDms } = require('./helpers');
const voiceEvent = require('../src/events/voice/voiceStateUpdate');

const PLAYER = '920000000000001001';
const OTHER_GUILD = '199999999999999999';

function fakeMember(userId, { displayName = 'Jogador Teste', roles = [] } = {}) {
  return {
    id: userId,
    displayName,
    user: { id: userId, username: displayName, bot: false },
    roles: { cache: new Map(roles.map((role) => [role, { id: role }])) },
    permissions: { has: () => false },
    guild: { ownerId: 'owner' },
  };
}

function dispatch(env, { userId = PLAYER, from = null, to = env.waitChannelId, member, guildId = env.guildId }) {
  const resolvedMember = member === undefined ? fakeMember(userId) : member;
  return voiceEvent.execute(
    { guild: { id: guildId }, id: userId, member: resolvedMember, channelId: from },
    { guild: { id: guildId }, id: userId, member: resolvedMember, channelId: to },
    { services: env.services },
  );
}

test('evento voiceStateUpdate coloca o jogador na fila ao entrar no canal de espera', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER);
  env.gateway.members.set(PLAYER, { inGuild: true, voiceChannelId: env.waitChannelId, displayName: 'Jogador Teste' });

  await dispatch(env, { from: null, to: env.waitChannelId });

  const state = env.services.engine.getState(env.guildId);
  assert.equal(state.waiting.length, 1, 'jogador entrou na fila pelo evento de voz');
  assert.equal(state.waiting[0].user_id, PLAYER);

  const events = env.services.audit.recent(env.guildId);
  assert.ok(events.some((event) => event.type === 'QUEUE_JOIN_VOICE'));
  assert.ok(countDms(env.gateway, PLAYER) > 0, 'jogador recebe a confirmação com protocolo');
});

test('evento de voz de outro servidor é ignorado sem quebrar', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER);

  await dispatch(env, { from: null, to: env.waitChannelId, guildId: OTHER_GUILD });

  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 0);
});

test('com auto_queue_on_voice_join desligado o jogador não entra e o motivo é registrado', async (t) => {
  const env = await createTestEnv({ settings: { auto_queue_on_voice_join: false } });
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER);

  const result = await env.services.attendance.handlePlayerVoiceUpdate({
    guildId: env.guildId,
    userId: PLAYER,
    channelId: env.waitChannelId,
    oldChannelId: null,
    attendanceChannelIds: [env.attChannelId],
    displayName: 'Desligado',
  });

  assert.deepEqual(result, { skipped: 'entrada automática desativada' });
  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 0);
});

test('sem canal de espera configurado nada é lançado e o jogador não entra', async (t) => {
  const env = await createTestEnv({ settings: { wait_channel_id: null } });
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER);

  const result = await env.services.attendance.handlePlayerVoiceUpdate({
    guildId: env.guildId,
    userId: PLAYER,
    channelId: '299999999999999999',
    oldChannelId: null,
    attendanceChannelIds: [env.attChannelId],
    displayName: 'Sem canal',
  });

  assert.equal(result, null);
  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 0);
});

test('entrar em outro canal de voz não coloca o jogador na fila', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER);

  await dispatch(env, { from: null, to: '299999999999999999' });

  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 0);
});

test('fila cheia avisa o jogador em vez de falhar em silêncio', async (t) => {
  const env = await createTestEnv({ settings: { max_queue_size: 1 } });
  t.after(env.cleanup);

  addMember(env.gateway, '920000000000002001');
  await env.services.queue.join({
    guildId: env.guildId,
    userId: '920000000000002001',
    displayName: 'Primeiro',
  });

  addMember(env.gateway, PLAYER);
  const result = await env.services.attendance.handlePlayerVoiceUpdate({
    guildId: env.guildId,
    userId: PLAYER,
    channelId: env.waitChannelId,
    oldChannelId: null,
    attendanceChannelIds: [env.attChannelId],
    displayName: 'Segundo',
  });

  assert.equal(result.skipped, 'erro');
  assert.equal(result.code, 'FILA_CHEIA');
  assert.ok(countDms(env.gateway, PLAYER) > 0, 'jogador é avisado por mensagem privada');

  const dm = env.gateway.dms.at(-1);
  assert.match(JSON.stringify(dm.payload), /Não foi possível entrar na fila/);
  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 1);
});

test('jogador em bloqueio de reentrada é removido do canal de espera', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER);

  await env.services.cooldowns.apply({ guildId: env.guildId, userId: PLAYER, reason: 'teste' });

  const result = await env.services.attendance.handlePlayerVoiceUpdate({
    guildId: env.guildId,
    userId: PLAYER,
    channelId: env.waitChannelId,
    oldChannelId: null,
    attendanceChannelIds: [env.attChannelId],
    displayName: 'Bloqueado',
  });

  assert.equal(result.cooldownBlocked, true, 'bloqueio barrado antes de qualquer tentativa de fila');
  assert.ok(result.remainingSeconds > 0);
  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 0);
  assert.ok(countDms(env.gateway, PLAYER) > 0, 'aviso do bloqueio é enviado');
});

test('membro fora do cache é resolvido pelo gateway e entra na fila', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER, { voiceChannelId: env.waitChannelId, displayName: 'Cache frio' });

  // newState.member = null (cache frio): antes o evento era descartado silenciosamente.
  await dispatch(env, { member: null });

  const state = env.services.engine.getState(env.guildId);
  assert.equal(state.waiting.length, 1, 'entrou na fila mesmo sem o membro em cache');
  assert.equal(state.waiting[0].user_id, PLAYER);
});

test('membro que não está mais no servidor é ignorado sem erro', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await dispatch(env, { member: null });

  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 0);
});
