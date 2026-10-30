'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember } = require('./helpers');

test('painel público exibe indicadores e atualiza ao entrar alguém na fila', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, '900000000000003001');

  const channelId = env.services.settings.get('public_channel_id');
  await env.services.panels.publish(env.guildId, 'public', channelId);
  const message = env.gateway.channelMessages.at(-1);
  const embed = message.payload.embeds[0];
  const fields = embed.fields.map((field) => field.name).join(' | ');

  assert.match(embed.title, /ATENDIMENTO \| VANTUS/);
  assert.match(fields, /STATUS DA CENTRAL/);
  assert.match(fields, /NA FILA/);
  assert.match(fields, /STAFFS DISPONÍVEIS/);
  assert.match(fields, /EM ATENDIMENTO/);
  assert.match(fields, /ESPERA MÉDIA/);
  assert.match(fields, /HORÁRIO/);
  assert.ok(message.payload.components.length > 0, 'painel tem botões');

  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000003001', displayName: 'Teste' });
  await env.services.panels.refresh(env.guildId);

  const updated = env.gateway.channelMessages.find((item) => item.id === message.id);
  const queueField = updated.payload.embeds[0].fields.find((field) => field.name.includes('NA FILA'));
  assert.match(queueField.value, /\*\*1\*\*/);
});

test('painel da staff lista a fila com protocolo, entrada e espera', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, '900000000000003002');
  addMember(env.gateway, '900000000000003003');

  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000003002', displayName: 'Primeiro' });
  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000003003', displayName: 'Segundo' });

  const channelId = env.services.settings.get('staff_channel_id');
  await env.services.panels.publish(env.guildId, 'staff', channelId);
  const embed = env.gateway.channelMessages.at(-1).payload.embeds[0];

  assert.match(embed.title, /PAINEL DA EQUIPE/);
  assert.match(embed.description, /#01 — Primeiro/);
  assert.match(embed.description, /#02 — Segundo/);
  assert.match(embed.description, /Protocolo: `#0001`/);
  assert.match(embed.description, /Espera:/);
});

test('reconstruir painel apaga a mensagem antiga e publica uma nova', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  const channelId = env.services.settings.get('public_channel_id');

  const first = await env.services.panels.publish(env.guildId, 'public', channelId);
  const rebuilt = await env.services.panels.rebuild(env.guildId, 'public', channelId);

  assert.equal(env.gateway.deletedMessages.length, 1);
  assert.equal(env.gateway.channelMessages.length, 2);
  assert.notEqual(first.message_id, rebuilt.message_id);
});

test('painel indica central fechada fora do horário', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  await env.services.central.close({ guildId: env.guildId, actorId: '1', actorTag: 'Admin' });

  const { payload } = env.services.panels.buildPayload(env.guildId, 'public');
  assert.match(JSON.stringify(payload), /FECHADA/);
  assert.match(JSON.stringify(payload), /Central fechada/);
});
