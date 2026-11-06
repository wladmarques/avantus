'use strict';

/**
 * Entrar no canal de atendimento NÃO coloca o staff em serviço:
 * o status é definido pelo próprio staff (painel da equipe / `/status`).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember, addStaffInVoice } = require('./helpers');

const STAFF = '910000000000009001';
const PLAYER = '900000000000009001';

/** Staff na call de atendimento, mas fora de serviço. */
async function staffInCallOffDuty(env, userId = STAFF) {
  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId,
    status: 'INDISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });
  await addStaffInVoice(env, userId, { available: false });
  return env.services.staff.get(env.guildId, userId);
}

const callNext = (env, userId = STAFF) =>
  env.services.attendance.callNext({ guildId: env.guildId, staffId: userId, staffTag: 'Staff' });

test('entrar na call não abre sessão do banco de horas', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await staffInCallOffDuty(env);
  await env.services.attendance.handleStaffVoiceUpdate({
    guildId: env.guildId,
    userId: STAFF,
    channelId: env.attChannelId,
    attendanceChannelIds: [env.attChannelId],
  });

  assert.equal(env.services.staff.get(env.guildId, STAFF).status, 'INDISPONIVEL');
  assert.equal(env.services.hourBank.activeSession(env.guildId, STAFF), null, 'nada de horas contando');
});

test('entrar na call não muda um status já definido (ausente continua ausente)', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'AUSENTE',
    updatedBy: STAFF,
    manual: true,
  });
  await addStaffInVoice(env, STAFF, { available: false });

  await env.services.attendance.handleStaffVoiceUpdate({
    guildId: env.guildId,
    userId: STAFF,
    channelId: env.attChannelId,
    attendanceChannelIds: [env.attChannelId],
  });

  assert.equal(env.services.staff.get(env.guildId, STAFF).status, 'AUSENTE');
});

test('staff fora de serviço não consegue chamar jogador', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await staffInCallOffDuty(env);
  addMember(env.gateway, PLAYER, { voiceChannelId: env.waitChannelId });
  await env.services.queue.join({ guildId: env.guildId, userId: PLAYER, displayName: 'Jogador' });

  await assert.rejects(
    () => callNext(env),
    (error) => {
      assert.equal(error.code, 'STAFF_FORA_DE_SERVICO');
      assert.match(error.userMessage, /fora de serviço/i);
      assert.match(error.userMessage, /MEU STATUS/);
      return true;
    },
  );

  const state = env.services.engine.getState(env.guildId);
  assert.equal(state.serving.length, 0, 'ninguém foi chamado');
  assert.equal(state.waiting.length, 1, 'jogador segue na fila');
  assert.equal(env.services.staff.get(env.guildId, STAFF).status, 'INDISPONIVEL');
});

test('depois de se colocar em serviço, o staff chama normalmente', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await staffInCallOffDuty(env);
  addMember(env.gateway, PLAYER, { voiceChannelId: env.waitChannelId });
  await env.services.queue.join({ guildId: env.guildId, userId: PLAYER, displayName: 'Jogador' });

  // Ação explícita do staff (equivale a MEU STATUS → Disponível).
  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'DISPONIVEL',
    updatedBy: STAFF,
    manual: true,
  });

  const called = await callNext(env);
  assert.equal(called.attendance.status, 'serving');
  assert.equal(env.services.staff.get(env.guildId, STAFF).status, 'EM_ATENDIMENTO');
  assert.ok(env.services.hourBank.activeSession(env.guildId, STAFF), 'horas contando');
});

test('com allow_staff_multi o staff já em atendimento pode chamar outro', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await env.services.settings.set('allow_staff_multi', true);
  await addStaffInVoice(env, STAFF);
  for (const player of [PLAYER, '900000000000009002']) {
    addMember(env.gateway, player, { voiceChannelId: env.waitChannelId });
    await env.services.queue.join({ guildId: env.guildId, userId: player, displayName: 'Jogador' });
  }

  await callNext(env);
  const second = await callNext(env);
  assert.ok(second.attendance.id);
  assert.equal(env.services.engine.getState(env.guildId).serving.length, 2);
});

test('quem já está em atendimento sem allow_staff_multi recebe STAFF_OCUPADO (não "fora de serviço")', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await addStaffInVoice(env, STAFF);
  for (const player of [PLAYER, '900000000000009003']) {
    addMember(env.gateway, player, { voiceChannelId: env.waitChannelId });
    await env.services.queue.join({ guildId: env.guildId, userId: player, displayName: 'Jogador' });
  }

  await callNext(env);
  await assert.rejects(
    () => callNext(env),
    (error) => error.code === 'STAFF_OCUPADO',
  );
});

test('a configuração staff_auto_status_on_voice_join existe e vem desligada', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  assert.equal(env.services.settings.get('staff_auto_status_on_voice_join'), false);
});
