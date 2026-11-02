'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember, addStaffInVoice } = require('./helpers');

const PLAYER = '900000000000001001';
const STAFF = '910000000000001001';

async function setupWithServing(t, options = {}) {
  const env = await createTestEnv(options);
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER, { voiceChannelId: env.waitChannelId });
  addStaffInVoice(env.gateway, STAFF);
  await env.services.queue.join({ guildId: env.guildId, userId: PLAYER, displayName: 'Jogador Teste' });
  const result = await env.services.attendance.callNext({
    guildId: env.guildId,
    staffId: STAFF,
    staffTag: 'Staff Teste',
  });
  return { env, result };
}

test('chamada move o jogador, muda status do staff e registra início', async (t) => {
  const { env, result } = await setupWithServing(t);

  assert.equal(result.attendance.status, 'serving');
  assert.ok(result.attendance.started_at > 0);
  assert.equal(env.services.staff.get(env.guildId, STAFF).status, 'EM_ATENDIMENTO');
  assert.ok(
    env.gateway.moves.some((move) => move.userId === PLAYER && move.channelId === env.attChannelId),
  );
  assert.ok(
    env.gateway.access.some(
      (entry) => entry.action === 'grant' && entry.userId === PLAYER && entry.channelId === env.attChannelId,
    ),
  );
});

test('presença confirmada quando o jogador entra no canal de atendimento', async (t) => {
  const { env, result } = await setupWithServing(t);

  const updated = await env.services.attendance.confirmPresence({
    guildId: env.guildId,
    userId: PLAYER,
    channelId: env.attChannelId,
  });

  assert.equal(updated.presence_confirmed, 1);
  const state = env.services.engine.getState(env.guildId);
  assert.equal(state.serving[0].presence_confirmed, 1);
  assert.equal(result.attendance.protocol, state.serving[0].protocol);
});

test('finalizar encerra com resultado concluído, libera staff e envia avaliação', async (t) => {
  const { env, result } = await setupWithServing(t);

  await env.services.attendance.confirmPresence({
    guildId: env.guildId,
    userId: PLAYER,
    channelId: env.attChannelId,
  });

  const closed = await env.services.attendance.finish({
    guildId: env.guildId,
    attendanceId: result.attendance.id,
    actorId: STAFF,
    actorTag: 'Staff Teste',
  });

  assert.equal(closed.outcome, 'ATENDIMENTO_CONCLUIDO');
  assert.ok(closed.ended_at >= closed.started_at);
  assert.equal(env.services.staff.get(env.guildId, STAFF).status, 'DISPONIVEL');

  const evaluationDm = env.gateway.dms.at(-1);
  assert.equal(evaluationDm.userId, PLAYER);
  assert.match(JSON.stringify(evaluationDm.payload), /Como foi seu atendimento/i);

  const summary = env.services.statistics.summary(env.guildId, 'hoje');
  assert.equal(summary.concluded, 1);
});

test('avaliação é salva e não pode ser duplicada', async (t) => {
  const { env, result } = await setupWithServing(t);
  const closed = await env.services.attendance.finish({
    guildId: env.guildId,
    attendanceId: result.attendance.id,
    actorId: STAFF,
    actorTag: 'Staff Teste',
  });

  const evaluation = await env.services.evaluations.submit({
    guildId: env.guildId,
    userId: PLAYER,
    attendanceId: closed.id,
    rating: 'MUITO_BOM',
  });

  assert.equal(evaluation.rating, 'MUITO_BOM');
  assert.equal(evaluation.staff_id, STAFF);

  await assert.rejects(
    () =>
      env.services.evaluations.submit({
        guildId: env.guildId,
        userId: PLAYER,
        attendanceId: closed.id,
        rating: 'BOM',
      }),
    (error) => /já avaliou/i.test(error.userMessage),
  );

  const ranking = env.services.statistics.summary(env.guildId, 'hoje').ranking;
  assert.equal(ranking[0].staffId, STAFF);
  assert.equal(ranking[0].avgRating, 4);
});

test('devolver à fila recoloca no final e libera o staff', async (t) => {
  const { env, result } = await setupWithServing(t);
  addMember(env.gateway, '900000000000001002');
  await env.services.queue.join({
    guildId: env.guildId,
    userId: '900000000000001002',
    displayName: 'Segundo Jogador',
  });

  const returned = await env.services.queue.returnToQueue({
    guildId: env.guildId,
    attendanceId: result.attendance.id,
    actorId: STAFF,
    actorTag: 'Staff Teste',
    reason: 'Instabilidade no servidor',
  });

  assert.equal(returned.attendance.status, 'waiting');
  assert.equal(returned.position, 2);
  assert.equal(env.services.staff.get(env.guildId, STAFF).status, 'DISPONIVEL');

  const state = env.services.engine.getState(env.guildId);
  assert.equal(state.waiting[1].user_id, PLAYER);
});

test('pular com política hold mantém o jogador pendente; com end vai para o final', async (t) => {
  const env = await createTestEnv({ settings: { skip_policy: 'hold' } });
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER);
  addMember(env.gateway, '900000000000001003');

  const first = await env.services.queue.join({ guildId: env.guildId, userId: PLAYER, displayName: 'A' });
  await env.services.queue.join({
    guildId: env.guildId,
    userId: '900000000000001003',
    displayName: 'B',
  });

  const skipped = await env.services.queue.skip({
    guildId: env.guildId,
    attendanceId: first.attendance.id,
    actorId: '1',
    actorTag: 'Admin',
    reason: 'Aguardando documentação',
  });
  assert.equal(skipped.mode, 'hold');

  const state = env.services.engine.getState(env.guildId);
  assert.equal(state.hold.length, 1);
  assert.equal(state.waiting.length, 1);

  const reactivated = await env.services.queue.reactivate({
    guildId: env.guildId,
    attendanceId: first.attendance.id,
    actorId: '1',
    actorTag: 'Admin',
  });
  assert.equal(reactivated.status, 'waiting');

  await env.services.settings.set('skip_policy', 'end');
  const second = env.services.engine.getState(env.guildId);
  const target = second.waiting[0];
  const result = await env.services.queue.skip({
    guildId: env.guildId,
    attendanceId: target.id,
    actorId: '1',
    actorTag: 'Admin',
    reason: 'Sem resposta',
  });
  assert.equal(result.mode, 'end');
  const after = env.services.engine.getState(env.guildId);
  assert.equal(after.waiting.at(-1).id, target.id);
});

test('pular e remover exigem motivo', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER);
  const joined = await env.services.queue.join({
    guildId: env.guildId,
    userId: PLAYER,
    displayName: 'A',
  });

  await assert.rejects(
    () =>
      env.services.queue.skip({
        guildId: env.guildId,
        attendanceId: joined.attendance.id,
        actorId: '1',
        actorTag: 'Admin',
        reason: '',
      }),
    (error) => error.code === 'MOTIVO_OBRIGATORIO',
  );

  await assert.rejects(
    () =>
      env.services.queue.remove({
        guildId: env.guildId,
        attendanceId: joined.attendance.id,
        actorId: '1',
        actorTag: 'Admin',
        reason: '   ',
      }),
    (error) => error.code === 'MOTIVO_OBRIGATORIO',
  );
});

test('não compareceu: encerra o protocolo e devolve à fila conforme política', async (t) => {
  const { env, result } = await setupWithServing(t, {
    settings: { presence_timeout_minutes: 1, no_show_policy: 'requeue' },
  });

  await env.services.engine._handlePresenceTimeout(env.guildId, result.attendance.id);

  const record = env.services.repositories.attendance.findByIdSync(env.guildId, result.attendance.id);
  assert.equal(record.outcome, 'JOGADOR_NAO_COMPARECEU');
  assert.equal(env.services.staff.get(env.guildId, STAFF).status, 'DISPONIVEL');

  const state = env.services.engine.getState(env.guildId);
  assert.equal(state.waiting.length, 1);
  assert.equal(state.waiting[0].user_id, PLAYER);
  assert.notEqual(state.waiting[0].protocol, record.protocol);
});

test('staff que sai do servidor tem o atendimento encerrado e o jogador devolvido', async (t) => {
  const { env, result } = await setupWithServing(t);

  await env.services.attendance.handleStaffLeave({
    guildId: env.guildId,
    userId: STAFF,
    displayName: 'Staff Teste',
  });

  const record = env.services.repositories.attendance.findByIdSync(env.guildId, result.attendance.id);
  assert.equal(record.outcome, 'STAFF_DESCONECTOU');
  assert.equal(env.services.staff.get(env.guildId, STAFF).status, 'INDISPONIVEL');

  const state = env.services.engine.getState(env.guildId);
  assert.equal(state.waiting.length, 1);
  assert.equal(state.waiting[0].user_id, PLAYER);
});

test('limpar fila encerra todos os registros ativos', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER);
  addMember(env.gateway, '900000000000001004');

  await env.services.queue.join({ guildId: env.guildId, userId: PLAYER, displayName: 'A' });
  await env.services.queue.join({
    guildId: env.guildId,
    userId: '900000000000001004',
    displayName: 'B',
  });

  const count = await env.services.queue.clear({
    guildId: env.guildId,
    actorId: '1',
    actorTag: 'Admin',
    reason: 'Fechamento',
  });

  assert.equal(count, 2);
  const state = env.services.engine.getState(env.guildId);
  assert.equal(state.waiting.length, 0);
  assert.equal(state.hold.length, 0);
});
