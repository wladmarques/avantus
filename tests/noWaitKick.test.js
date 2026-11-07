'use strict';

/**
 * Regressão: o bot NUNCA tira o jogador do canal de aguardando atendimento e
 * nunca impede que ele entre/volte.
 *
 * Sintoma relatado: o bot expulsava jogadores da sala de aguardando e eles
 * ficavam sem conseguir entrar de novo (bloqueio de reentrada). Agora:
 *   - sair da fila (por comando, por remoção da equipe ou ao sair do canal)
 *     não desconecta ninguém;
 *   - entrar no canal de espera sempre coloca na fila, sem bloqueio;
 *   - não existe mais configuração de bloqueio de reentrada.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember } = require('./helpers');

const PLAYER = '900000000000009301';
const PLAYER_2 = '900000000000009302';
const STAFF = '910000000000009301';

/** Entra na fila pelo canal de espera. */
async function joinByVoice(env, userId) {
  addMember(env.gateway, userId, { voiceChannelId: env.waitChannelId });
  return env.services.attendance.handlePlayerVoiceUpdate({
    guildId: env.guildId,
    userId,
    channelId: env.waitChannelId,
    oldChannelId: null,
    attendanceChannelIds: [env.attChannelId],
    displayName: `Jogador ${userId}`,
  });
}

const disconnectsOf = (env, userId) => env.gateway.disconnects.filter((row) => row.userId === userId);

test('sair da fila pelo comando não desconecta o jogador do canal', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await joinByVoice(env, PLAYER);
  await env.services.queue.leave({
    guildId: env.guildId,
    userId: PLAYER,
    actorId: PLAYER,
    reason: 'teste',
  });

  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 0, 'saiu da fila');
  assert.equal(disconnectsOf(env, PLAYER).length, 0, 'continua no canal de voz');
});

test('jogador removido da fila pela equipe não é expulso do canal', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  await addStaffOnDuty(env);

  const joined = await joinByVoice(env, PLAYER);
  const state = env.services.engine.getState(env.guildId);

  await env.services.queue.remove({
    guildId: env.guildId,
    attendanceId: state.waiting[0].id,
    actorId: STAFF,
    actorTag: 'Staff',
    reason: 'teste',
  });

  assert.equal(disconnectsOf(env, PLAYER).length, 0, 'não foi desconectado');
  assert.equal(joined.autoJoined, true);
});

test('fechar a central limpando a fila não desconecta ninguém', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await joinByVoice(env, PLAYER);
  await joinByVoice(env, PLAYER_2);

  await env.services.engine.clearQueue({
    guildId: env.guildId,
    actorId: 'teste',
    actorTag: 'Teste',
    reason: 'Central encerrada',
  });

  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 0);
  assert.equal(env.gateway.disconnects.length, 0, 'ninguém é expulso do canal');
});

test('tempo máximo de espera remove da fila sem expulsar do canal', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  await env.services.settings.set('max_wait_minutes', 1);

  const joined = await joinByVoice(env, PLAYER);
  env.db.run('UPDATE attendance SET joined_at = ? WHERE id = ?', [
    Date.now() - 5 * 60000,
    joined.attendance ? joined.attendance.id : env.services.repositories.attendance.listWaitingSync(env.guildId)[0].id,
  ]);

  await env.services.queue.expire(env.guildId);
  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 0);
  assert.equal(disconnectsOf(env, PLAYER).length, 0, 'não foi desconectado');
});

test('entrar no canal de espera sempre coloca na fila — sem bloqueio de reentrada', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await joinByVoice(env, PLAYER);
  // Sai da fila ao sair do canal.
  await env.services.attendance.handlePlayerVoiceUpdate({
    guildId: env.guildId,
    userId: PLAYER,
    channelId: null,
    oldChannelId: env.waitChannelId,
    attendanceChannelIds: [env.attChannelId],
  });
  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 0);

  // Volta imediatamente.
  const again = await joinByVoice(env, PLAYER);
  assert.equal(again.autoJoined, true, 'voltou na hora');
  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 1);
  assert.equal(env.gateway.disconnects.length, 0, 'ninguém foi expulso');
});

test('não existe mais configuração de bloqueio de reentrada', async () => {
  const { SETTINGS } = require('../src/config/settings');
  assert.equal(SETTINGS.rejoin_cooldown_minutes, undefined);
  assert.equal(SETTINGS.rejoin_cooldown_last_minutes, undefined);

  const { ERRORS } = require('../src/services/errors');
  assert.equal(ERRORS.EM_COOLDOWN, undefined);
});

test('o painel web não tem mais a seção de bloqueio nem a API', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { PUBLIC_DIR } = require('../src/web/server');
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8');

  for (const text of [html, app, server]) {
    assert.ok(!/cooldown/i.test(text), 'nenhuma referência ao bloqueio de reentrada');
  }
});

/** Coloca um staff em serviço (necessário para entrar na fila). */
async function addStaffOnDuty(env) {
  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'DISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });
}
