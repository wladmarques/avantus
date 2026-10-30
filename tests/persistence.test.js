'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember, addStaffInVoice } = require('./helpers');
const { openDatabase } = require('../src/database/connection');
const { runMigrations } = require('../src/database/migrations');
const { createServices } = require('../src/services');
const { MemoryGateway } = require('../src/services/discordGateway');

test('fila, protocolos e staff sobrevivem à reinicialização do bot', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  addMember(env.gateway, '900000000000002001');
  addMember(env.gateway, '900000000000002002');
  addStaffInVoice(env.gateway, '910000000000002001');

  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000002001', displayName: 'Um' });
  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000002002', displayName: 'Dois' });
  await env.services.attendance.callNext({
    guildId: env.guildId,
    staffId: '910000000000002001',
    staffTag: 'Staff',
  });

  await env.db.close();

  // ===== "restart" =====
  const db = await openDatabase({ filePath: env.filePath });
  await runMigrations(db);
  const gateway = new MemoryGateway({});
  const services = await createServices({ db, gateway });
  gateway.settings = services.settings;

  const state = services.engine.getState(env.guildId);
  assert.equal(state.waiting.length, 1, 'fila mantida após reinício');
  assert.equal(state.serving.length, 1, 'atendimento ativo mantido após reinício');
  assert.equal(state.serving[0].staff_id, '910000000000002001');

  addMember(gateway, '900000000000002003');
  const joined = await services.queue.join({
    guildId: env.guildId,
    userId: '900000000000002003',
    displayName: 'Três',
  });
  assert.equal(joined.protocol, 3, 'contador de protocolo persistido');

  await db.close();
});

test('recuperação encerra registros de quem saiu do servidor e libera staff preso', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  addMember(env.gateway, '900000000000002010');
  addMember(env.gateway, '900000000000002011');
  addStaffInVoice(env.gateway, '910000000000002010');

  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000002010', displayName: 'Saiu' });
  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000002011', displayName: 'Ficou' });
  await env.services.attendance.callNext({
    guildId: env.guildId,
    staffId: '910000000000002010',
    staffTag: 'Staff',
  });

  await env.db.close();

  const db = await openDatabase({ filePath: env.filePath });
  await runMigrations(db);
  const gateway = new MemoryGateway({});
  // Jogador "Saiu" não existe mais no servidor
  addMember(gateway, '900000000000002011');
  const services = await createServices({ db, gateway });
  gateway.settings = services.settings;

  const report = await services.recovery.run(env.guildId);

  assert.ok(report.attendance.closed >= 1);
  const state = services.engine.getState(env.guildId);
  assert.equal(state.waiting.length, 1);
  assert.equal(state.waiting[0].user_id, '900000000000002011');

  // staff que perdeu o atendimento volta a ficar disponível
  const staff = services.staff.get(env.guildId, '910000000000002010');
  assert.notEqual(staff.status, 'EM_ATENDIMENTO');

  await db.close();
});

test('painéis não são duplicados e continuam funcionando após reinício', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const first = await env.services.panels.publish(env.guildId, 'public', env.services.settings.get('public_channel_id'));
  const second = await env.services.panels.publish(env.guildId, 'public', env.services.settings.get('public_channel_id'));

  assert.equal(first.id ?? first.message_id, second.id ?? second.message_id);
  assert.equal(env.gateway.channelMessages.length, 1, 'apenas uma mensagem de painel');

  await env.db.close();

  const db = await openDatabase({ filePath: env.filePath });
  await runMigrations(db);
  const gateway = new MemoryGateway({});
  const services = await createServices({ db, gateway });
  gateway.settings = services.settings;
  gateway.channelMessages.push({ id: 'msg-1', channelId: services.settings.get('public_channel_id'), payload: {} });

  const report = await services.recovery.run(env.guildId);
  assert.ok(report.panels.some((entry) => entry.startsWith('public')));
  assert.equal(gateway.channelMessages.length, 1, 'continuou editando a mesma mensagem');

  await db.close();
});
