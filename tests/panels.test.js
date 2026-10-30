'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember, panelText, panelButtonIds, panelCards } = require('./helpers');

test('painel público moderno (Components V2) expõe indicadores e é atualizado na fila', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, '900000000000003001');
  env.gateway.iconUrl = 'https://cdn.discordapp.com/icons/1/abc.png';

  const channelId = env.services.settings.get('public_channel_id');
  const published = await env.services.panels.publish(env.guildId, 'public', channelId);
  assert.equal(published.format, 'v2');

  const message = env.gateway.channelMessages.at(-1);
  assert.equal(message.payload.flags, 32768, 'usa MessageFlags.IsComponentsV2');
  assert.equal(message.payload.embeds, undefined, 'V2 não mistura embeds');
  assert.ok(panelCards(message.payload).length >= 6, 'cards da central');

  const text = panelText(message.payload);
  assert.match(text, /ATENDIMENTO \| VANTUS/);
  assert.match(text, /STATUS DA CENTRAL/);
  assert.match(text, /FILA ABERTA/);
  assert.match(text, /NA FILA/);
  assert.match(text, /STAFFS DISPONÍVEIS/);
  assert.match(text, /EM ATENDIMENTO/);
  assert.match(text, /ESPERA MÉDIA/);
  assert.match(text, /HORÁRIO DE ATENDIMENTO/);
  assert.match(text, /Seg–Sex/);
  assert.match(text, /12:00 às 02:00/);
  assert.match(text, /Sáb–Dom/);
  assert.match(text, /12:00 às 00:00/);
  assert.match(text, /Fila por canal de voz/);

  assert.deepEqual(panelButtonIds(message.payload), ['pub:join', 'pub:leave', 'pub:status']);

  // thumbnail com o ícone do servidor no cabeçalho
  const section = message.payload.components[0].components[0];
  assert.equal(section.type, 9);
  assert.equal(section.accessory.type, 11);
  assert.equal(section.accessory.media.url, env.gateway.iconUrl);

  await env.services.queue.join({ guildId: env.guildId, userId: '900000000000003001', displayName: 'Teste' });
  await env.services.panels.refresh(env.guildId);

  const updated = env.gateway.channelMessages.find((item) => item.id === message.id);
  assert.match(panelText(updated.payload), /NA FILA\*\*\n## 1/);
});

test('estilo clássico continua disponível em embed', async (t) => {
  const env = await createTestEnv({ settings: { panel_style: 'classic' } });
  t.after(env.cleanup);

  const published = await env.services.panels.publish(env.guildId, 'public', env.services.settings.get('public_channel_id'));
  assert.equal(published.format, 'embed');

  const message = env.gateway.channelMessages.at(-1);
  assert.ok(message.payload.embeds?.length, 'payload em embed');
  assert.match(panelText(message.payload), /ATENDIMENTO \| VANTUS/);
  assert.deepEqual(panelButtonIds(message.payload), ['pub:join', 'pub:leave', 'pub:status']);
});

test('trocar o estilo recria a mensagem sem duplicar o painel', async (t) => {
  const env = await createTestEnv({ settings: { panel_style: 'classic' } });
  t.after(env.cleanup);
  const channelId = env.services.settings.get('public_channel_id');

  const first = await env.services.panels.publish(env.guildId, 'public', channelId);
  assert.equal(first.format, 'embed');

  await env.services.settings.set('panel_style', 'modern');
  const second = await env.services.panels.publish(env.guildId, 'public', channelId);

  assert.equal(second.format, 'v2');
  assert.equal(env.gateway.deletedMessages.length, 1, 'mensagem antiga removida');
  const publicMessages = env.gateway.channelMessages.filter((item) => item.channelId === channelId);
  assert.equal(publicMessages.length, 2, 'uma antiga (apagada) + uma nova');
});

test('fallback: se o Discord recusar Components V2, publica o painel clássico', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  const channelId = env.services.settings.get('public_channel_id');

  const original = env.gateway.sendChannelMessage.bind(env.gateway);
  let attempts = 0;
  env.gateway.sendChannelMessage = async (guildId, channel, payload) => {
    attempts += 1;
    if (payload.flags === 32768) {
      const error = new Error('Invalid Form Body (components)');
      error.code = 50035;
      throw error;
    }
    return original(guildId, channel, payload);
  };

  const result = await env.services.panels.publish(env.guildId, 'public', channelId);
  assert.equal(result.format, 'embed');
  assert.equal(attempts, 2);
  assert.ok(env.gateway.channelMessages.at(-1).payload.embeds?.length);
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
  const text = panelText(payload);
  assert.match(text, /CENTRAL FECHADA/);
  assert.match(text, /HORÁRIO DE ATENDIMENTO/);
  assert.match(text, /📕|🔴/);
});
