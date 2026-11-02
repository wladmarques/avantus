'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember, addStaffInVoice } = require('./helpers');

test('relatórios contabilizam conclusões, desistências e desempenho por staff', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const staffA = '910000000000004001';
  const staffB = '910000000000004002';
  addStaffInVoice(env.gateway, staffA);
  addStaffInVoice(env.gateway, staffB, { channelName: 'ATENDIMENTO 02' });

  // três jogadores: dois atendidos (por staffs diferentes), um desiste
  for (const id of ['900000000000004001', '900000000000004002', '900000000000004003']) {
    addMember(env.gateway, id, { voiceChannelId: env.waitChannelId });
    await env.services.queue.join({ guildId: env.guildId, userId: id, displayName: id });
  }

  const callA = await env.services.attendance.callNext({
    guildId: env.guildId,
    staffId: staffA,
    staffTag: 'Staff A',
  });
  await env.services.attendance.finish({
    guildId: env.guildId,
    attendanceId: callA.attendance.id,
    actorId: staffA,
    actorTag: 'Staff A',
  });

  const callB = await env.services.attendance.callNext({
    guildId: env.guildId,
    staffId: staffB,
    staffTag: 'Staff B',
  });
  await env.services.attendance.finish({
    guildId: env.guildId,
    attendanceId: callB.attendance.id,
    actorId: staffB,
    actorTag: 'Staff B',
  });

  await env.services.queue.leave({ guildId: env.guildId, userId: '900000000000004003' });

  const summary = env.services.statistics.summary(env.guildId, 'hoje');
  assert.equal(summary.total, 3);
  assert.equal(summary.concluded, 2);
  assert.equal(summary.desistencias, 1);
  assert.equal(summary.byHour.length, 24);
  assert.ok(summary.byDay.length >= 1);
  assert.ok(summary.ranking.length >= 2);
  assert.equal(summary.ranking.length, 2);

  const formatted = env.services.statistics.formatSummary(summary);
  assert.ok(formatted.outcomes.includes('atendimento concluido'));
  assert.ok(formatted.avgWait.length > 0);

  const overview = env.services.statistics.todayOverview(env.guildId);
  assert.equal(overview.concluded, 2);
});

test('histórico registra eventos administrativos com responsável', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, '900000000000004010');

  const joined = await env.services.queue.join({
    guildId: env.guildId,
    userId: '900000000000004010',
    displayName: 'Histórico',
  });

  await env.services.queue.remove({
    guildId: env.guildId,
    attendanceId: joined.attendance.id,
    actorId: '777777777777777777',
    actorTag: 'Admin Teste',
    reason: 'Teste de auditoria',
  });

  const events = env.services.audit.history(env.guildId, joined.protocol);
  const types = events.map((event) => event.type);
  assert.ok(types.includes('QUEUE_JOIN'));
  assert.ok(types.includes('QUEUE_REMOVE'));
  const remove = events.find((event) => event.type === 'QUEUE_REMOVE');
  assert.equal(remove.actor_id, '777777777777777777');
  assert.ok(remove.message.includes('Teste de auditoria'));

  // logs também foram enviados ao canal configurado
  assert.ok(
    env.gateway.channelMessages.some(
      (message) => message.channelId === env.services.settings.get('log_channel_id'),
    ),
  );
});
