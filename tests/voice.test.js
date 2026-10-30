'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember, addStaffInVoice } = require('./helpers');

const PLAYER = '900000000000005001';
const STAFF = '910000000000005001';

async function servingEnv(t, extra = {}) {
  const env = await createTestEnv(extra);
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER, { voiceChannelId: env.waitChannelId });
  addStaffInVoice(env.gateway, STAFF);
  await env.services.queue.join({ guildId: env.guildId, userId: PLAYER, displayName: 'Voz' });
  const call = await env.services.attendance.callNext({
    guildId: env.guildId,
    staffId: STAFF,
    staffTag: 'Staff Voz',
  });
  return { env, call };
}

test('jogador no canal de atendimento tem presença confirmada pelo evento de voz', async (t) => {
  const { env } = await servingEnv(t);

  await env.services.attendance.handlePlayerVoiceUpdate({
    guildId: env.guildId,
    userId: PLAYER,
    channelId: env.attChannelId,
    attendanceChannelIds: [env.attChannelId],
  });

  assert.equal(env.services.engine.getState(env.guildId).serving[0].presence_confirmed, 1);
});

test('desconexão do jogador durante tolerância encerra o atendimento', async (t) => {
  const { env, call } = await servingEnv(t, { settings: { voice_disconnect_grace_seconds: 30 } });

  await env.services.attendance.handlePlayerVoiceUpdate({
    guildId: env.guildId,
    userId: PLAYER,
    channelId: null,
    attendanceChannelIds: [env.attChannelId],
  });
  assert.ok(env.services.engine.timers.has(`voice:${call.attendance.id}`), 'timer de tolerância criado');

  await env.services.engine._handleVoiceDisconnectTimeout(env.guildId, call.attendance.id);

  const record = env.services.repositories.attendance.findByIdSync(env.guildId, call.attendance.id);
  assert.equal(record.outcome, 'JOGADOR_DESCONECTOU');
  assert.equal(env.services.staff.get(env.guildId, STAFF).status, 'DISPONIVEL');
});

test('staff conectado a canal válido fica disponível automaticamente', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'INDISPONIVEL',
    manual: true,
  });

  await env.services.attendance.handleStaffVoiceUpdate({
    guildId: env.guildId,
    userId: STAFF,
    channelId: env.attChannelId,
    attendanceChannelIds: [env.attChannelId],
  });

  assert.equal(env.services.staff.get(env.guildId, STAFF).status, 'DISPONIVEL');
});

test('staff que desconecta do canal durante atendimento é marcado indisponível', async (t) => {
  const { env } = await servingEnv(t);

  await env.services.attendance.handleStaffVoiceUpdate({
    guildId: env.guildId,
    userId: STAFF,
    channelId: null,
    attendanceChannelIds: [env.attChannelId],
  });

  const status = env.services.staff.get(env.guildId, STAFF).status;
  assert.equal(status, 'INDISPONIVEL');
});

test('staff que não retorna à voz tem atendimento encerrado e jogador devolvido à fila', async (t) => {
  const { env, call } = await servingEnv(t, { settings: { voice_disconnect_grace_seconds: 30 } });
  addStaffInVoice(env.gateway, STAFF);
  env.gateway.staffVoice.set(STAFF, { channelId: null });

  await env.services.engine._handleStaffReturnTimeout(env.guildId, STAFF, call.attendance.id);

  const record = env.services.repositories.attendance.findByIdSync(env.guildId, call.attendance.id);
  assert.equal(record.outcome, 'STAFF_DESCONECTOU');
  const state = env.services.engine.getState(env.guildId);
  assert.equal(state.waiting.length, 1);
  assert.equal(state.waiting[0].user_id, PLAYER);
});

test('jogador que sai do canal de espera permanece na fila', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER, { voiceChannelId: env.waitChannelId });
  await env.services.queue.join({ guildId: env.guildId, userId: PLAYER, displayName: 'Espera' });

  await env.services.attendance.handlePlayerVoiceUpdate({
    guildId: env.guildId,
    userId: PLAYER,
    channelId: null,
    attendanceChannelIds: [env.attChannelId],
  });

  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 1);
  const events = env.services.audit.recent(env.guildId);
  assert.ok(events.some((event) => event.type === 'PLAYER_LEFT_WAIT_VOICE'));
});
