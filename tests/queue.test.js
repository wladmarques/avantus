'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember, addStaffInVoice, removeMemberFromGuild } = require('./helpers');

test('entrada na fila gera protocolo, posição e mensagem privada', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, '900000000000000001', { voiceChannelId: env.waitChannelId });

  const result = await env.services.queue.join({
    guildId: env.guildId,
    userId: '900000000000000001',
    displayName: 'Marcos',
  });

  assert.equal(result.protocol, 1);
  assert.equal(result.position, 1);
  assert.equal(result.attendance.status, 'waiting');
  assert.equal(env.services.queue.state(env.guildId).waiting.length, 1);

  const dm = env.gateway.dms.at(-1);
  assert.equal(dm.userId, '900000000000000001');
  assert.match(JSON.stringify(dm.payload), /0001/);
});

test('não permite duas posições simultâneas para o mesmo jogador', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, '900000000000000002');

  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000000002', displayName: 'Ana' });

  await assert.rejects(
    () => env.services.queue.join({ guildId: env.guildId, userId: '900000000000000002', displayName: 'Ana' }),
    (error) => error.code === 'JA_NA_FILA',
  );

  assert.equal(env.services.queue.state(env.guildId).waiting.length, 1);
});

test('entrada bloqueada quando a central está fechada', async (t) => {
  const env = await createTestEnv({ settings: { central_manual: 'closed' } });
  t.after(env.cleanup);
  addMember(env.gateway, '900000000000000003');

  await assert.rejects(
    () => env.services.queue.join({ guildId: env.guildId, userId: '900000000000000003', displayName: 'Bia' }),
    (error) => error.code === 'CENTRAL_FECHADA',
  );
});

test('saída da fila registra desistência e libera a vaga', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, '900000000000000004');

  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000000004', displayName: 'Caio' });
  const closed = await env.services.queue.leave({
    guildId: env.guildId,
    userId: '900000000000000004',
  });

  assert.equal(closed.outcome, 'JOGADOR_DESISTIU');
  assert.equal(env.services.queue.state(env.guildId).waiting.length, 0);

  const history = env.services.audit.recent(env.guildId);
  assert.ok(history.some((event) => event.type === 'QUEUE_LEAVE'));
});

test('jogador que sai do servidor é removido da fila automaticamente', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, '900000000000000005');

  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000000005', displayName: 'Davi' });
  removeMemberFromGuild(env.gateway, '900000000000000005');

  await env.services.attendance.handleMemberLeave({
    guildId: env.guildId,
    userId: '900000000000000005',
    displayName: 'Davi',
  });

  assert.equal(env.services.queue.state(env.guildId).waiting.length, 0);
  const record = env.services.repositories.attendance.listByUserSync(env.guildId, '900000000000000005')[0];
  assert.equal(record.status, 'finished');
});

test('chamada sem estar em canal de voz de atendimento é bloqueada', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, '900000000000000006');
  env.gateway.members.set('910000000000000001', { inGuild: true, voiceChannelId: null });

  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000000006', displayName: 'Eva' });

  await assert.rejects(
    () =>
      env.services.attendance.callNext({
        guildId: env.guildId,
        staffId: '910000000000000001',
        staffTag: 'staff#0001',
      }),
    (error) => error.code === 'STAFF_SEM_VOZ',
  );
});

test('dois staffs chamando ao mesmo tempo reservam jogadores diferentes', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  addMember(env.gateway, '900000000000000010');
  addMember(env.gateway, '900000000000000011');
  addStaffInVoice(env.gateway, '910000000000000010');
  addStaffInVoice(env.gateway, '910000000000000011', { channelName: 'ATENDIMENTO 02' });

  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000000010', displayName: 'F1' });
  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000000011', displayName: 'F2' });

  const [first, second] = await Promise.all([
    env.services.attendance.callNext({ guildId: env.guildId, staffId: '910000000000000010', staffTag: 'Staff A' }),
    env.services.attendance.callNext({ guildId: env.guildId, staffId: '910000000000000011', staffTag: 'Staff B' }),
  ]);

  const users = [first.attendance.user_id, second.attendance.user_id].sort();
  assert.deepEqual(users, ['900000000000000010', '900000000000000011']);
  assert.equal(new Set([first.attendance.protocol, second.attendance.protocol]).size, 2);
  assert.equal(env.services.queue.state(env.guildId).serving.length, 2);
});

test('staff não pode atender dois jogadores ao mesmo tempo', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, '900000000000000020');
  addMember(env.gateway, '900000000000000021');
  addStaffInVoice(env.gateway, '910000000000000020');

  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000000020', displayName: 'G1' });
  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000000021', displayName: 'G2' });

  await env.services.attendance.callNext({
    guildId: env.guildId,
    staffId: '910000000000000020',
    staffTag: 'Staff',
  });

  await assert.rejects(
    () =>
      env.services.attendance.callNext({
        guildId: env.guildId,
        staffId: '910000000000000020',
        staffTag: 'Staff',
      }),
    (error) => error.code === 'STAFF_OCUPADO',
  );

  // com autorização administrativa é permitido
  await env.services.settings.set('allow_staff_multi', true);
  const second = await env.services.attendance.callNext({
    guildId: env.guildId,
    staffId: '910000000000000020',
    staffTag: 'Staff',
  });
  assert.equal(second.attendance.status, 'serving');
});

test('fila vazia devolve erro claro', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addStaffInVoice(env.gateway, '910000000000000030');

  await assert.rejects(
    () =>
      env.services.attendance.callNext({
        guildId: env.guildId,
        staffId: '910000000000000030',
        staffTag: 'Staff',
      }),
    (error) => error.code === 'FILA_VAZIA',
  );
});
