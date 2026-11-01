'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, makeCommandInteraction, panelText } = require('./helpers');
const { executeCommand, loadCommands } = require('../src/handlers/commandHandler');
const { handleInteraction } = require('../src/interactions/router');

const ADMIN_ROLE = '500000000000000002';

/** Client falso com o mínimo que os comandos usam. */
function fakeClient(commands) {
  return {
    commands,
    guilds: { cache: new Map() },
  };
}

test('executeCommand repassa client, services, env e runtime ao comando', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  let received = null;
  const stub = {
    category: 'admin',
    data: { name: 'teste' },
    async execute(context) {
      received = context;
    },
  };
  const client = fakeClient(new Map([['teste', stub]]));
  const interaction = makeCommandInteraction({ commandName: 'teste', roles: [ADMIN_ROLE], client });

  const context = { client, services: env.services, env: { autoRegisterCommands: true }, runtime: { ok: true } };
  await executeCommand(interaction, context);

  assert.ok(received, 'comando executado');
  assert.equal(received.client, client, 'client repassado');
  assert.equal(received.services, env.services);
  assert.equal(received.env, context.env, 'env repassado');
  assert.equal(received.runtime, context.runtime, 'runtime repassado');
  assert.equal(received.interaction, interaction);
});

test('/setup executa sem erro de client e configura canais + publica painéis', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const commands = loadCommands();
  const client = fakeClient(commands);
  client.guilds.cache.set(env.guildId, {
    id: env.guildId,
    channels: { cache: new Map() },
    roles: { cache: new Map() },
  });

  const interaction = makeCommandInteraction({
    commandName: 'setup',
    roles: [ADMIN_ROLE],
    options: { criar_cargos: false },
    client,
  });

  await handleInteraction(interaction, { client, services: env.services, env: {}, runtime: {} });

  const responses = JSON.stringify(interaction.responses);
  assert.ok(!/Erro inesperado/.test(responses), `erro inesperado: ${responses.slice(0, 300)}`);
  assert.match(responses, /Estrutura preparada/);

  const settings = env.services.settings.getAll();
  assert.ok(settings.category_id, 'categoria configurada');
  assert.ok(settings.wait_channel_id, 'canal de espera configurado');
  assert.equal(settings.attendance_channel_ids.length, 3, 'três canais de atendimento');
  assert.ok(settings.public_channel_id && settings.staff_channel_id && settings.log_channel_id);

  const panels = env.services.repositories.panels;
  assert.ok(panels.getSync(env.guildId, 'public')?.message_id, 'painel público publicado');
  assert.ok(panels.getSync(env.guildId, 'staff')?.message_id, 'painel staff publicado');
});

test('/diagnostico executa sem erro de client e aponta configuração', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const commands = loadCommands();
  const client = fakeClient(commands);
  client.guilds.cache.set(env.guildId, {
    id: env.guildId,
    members: { me: null },
  });

  const interaction = makeCommandInteraction({
    commandName: 'diagnostico',
    roles: [ADMIN_ROLE],
    client,
  });

  await handleInteraction(interaction, { client, services: env.services, env: {}, runtime: {} });

  const text = panelText(interaction.responses.at(-1));
  assert.match(text, /Diagnóstico do sistema/);
  assert.match(text, /Servidor configurado/);
  assert.match(text, /Canais de atendimento/);
  assert.match(text, /não configurado|válidos/);
});

test('/setup cria os canais com os nomes novos e emoji da VANTUS', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const client = fakeClient(loadCommands());
  client.guilds.cache.set(env.guildId, {
    id: env.guildId,
    channels: { cache: new Map() },
    roles: { cache: new Map() },
  });

  const interaction = makeCommandInteraction({
    commandName: 'setup',
    roles: [ADMIN_ROLE],
    options: { criar_cargos: false },
    client,
  });
  await handleInteraction(interaction, { client, services: env.services, env: {}, runtime: {} });

  const channels = [...env.gateway.channelStore.values()];
  const names = channels.map((channel) => channel.name);
  assert.deepEqual(
    names.filter((name) => name.includes('・')),
    [
      '🎧・central de atendimento',
      '⏳・aguardando-atendimento',
      '🔉・suporte¹',
      '🔉・suporte²',
      '🔉・suporte³',
    ],
  );

  // Categoria e canais configurados apontam para os nomes novos.
  const settings = env.services.settings.getAll();
  const byId = (id) => channels.find((channel) => channel.id === id);
  assert.equal(byId(settings.category_id).name, '🎧・central de atendimento');
  assert.equal(byId(settings.wait_channel_id).name, '⏳・aguardando-atendimento');
  assert.deepEqual(settings.attendance_channel_ids.map((id) => byId(id).name), [
    '🔉・suporte¹',
    '🔉・suporte²',
    '🔉・suporte³',
  ]);

  const text = JSON.stringify(interaction.responses);
  assert.match(text, /central de atendimento/);
  assert.match(text, /aguardando-atendimento/);
  assert.match(text, /suporte¹/);
});

test('/setup renomeia os canais antigos em vez de duplicar', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  // Servidor já configurado com os nomes antigos.
  const legacy = [
    { id: 'old-cat', name: 'CENTRAL DE ATENDIMENTO', type: 4 },
    { id: 'old-wait', name: 'AGUARDANDO ATENDIMENTO', type: 2 },
    { id: 'old-att1', name: 'ATENDIMENTO 01', type: 2 },
    { id: 'old-att2', name: 'ATENDIMENTO 02', type: 2 },
    { id: 'old-att3', name: 'ATENDIMENTO 03', type: 2 },
    { id: 'old-text', name: 'central-atendimento', type: 0 },
  ];
  for (const channel of legacy) env.gateway.channelStore.set(channel.id, { ...channel });

  const client = fakeClient(loadCommands());
  client.guilds.cache.set(env.guildId, {
    id: env.guildId,
    channels: { cache: new Map() },
    roles: { cache: new Map() },
  });

  const interaction = makeCommandInteraction({
    commandName: 'setup',
    roles: [ADMIN_ROLE],
    options: { criar_cargos: false },
    client,
  });
  await handleInteraction(interaction, { client, services: env.services, env: {}, runtime: {} });

  const channels = [...env.gateway.channelStore.values()];
  // Nada duplicado: os 6 antigos (renomeados) + os 2 de texto que faltavam.
  assert.equal(channels.length, legacy.length + 2, 'não criou canais extras');
  const renamed = Object.fromEntries(channels.map((channel) => [channel.id, channel.name]));
  assert.equal(renamed['old-cat'], '🎧・central de atendimento');
  assert.equal(renamed['old-wait'], '⏳・aguardando-atendimento');
  assert.equal(renamed['old-att1'], '🔉・suporte¹');
  assert.equal(renamed['old-att2'], '🔉・suporte²');
  assert.equal(renamed['old-att3'], '🔉・suporte³');
  assert.equal(renamed['old-text'], 'central-atendimento', 'texto já estava no padrão');

  // A configuração continua apontando para os mesmos canais (só o nome mudou).
  const settings = env.services.settings.getAll();
  assert.equal(settings.wait_channel_id, 'old-wait');
  assert.deepEqual(settings.attendance_channel_ids, ['old-att1', 'old-att2', 'old-att3']);
  assert.match(JSON.stringify(interaction.responses), /Canais atualizados para o padrão novo/);
});

test('nomes de canal são comparados sem caixa, acento e separador', async (t) => {
  const { normalizeChannelName } = require('../src/services/discordGateway');
  assert.equal(normalizeChannelName('🎧・Central de Atendimento'), 'central de atendimento');
  assert.equal(normalizeChannelName('CENTRAL DE ATENDIMENTO'), 'central de atendimento');
  assert.equal(normalizeChannelName('⏳・aguardando-atendimento'), 'aguardando atendimento');
  assert.equal(normalizeChannelName('AGUARDANDO ATENDIMENTO'), 'aguardando atendimento');
  assert.equal(normalizeChannelName('🔉・suporte¹'), 'suporte¹');
  assert.equal(normalizeChannelName('   '), '');

  const env = await createTestEnv();
  t.after(env.cleanup);
  const created = await env.gateway.ensureVoiceChannel(env.guildId, '🔉・Suporte 1');
  const found = await env.gateway.findChannelByName(env.guildId, 'suporte 1', 2);
  assert.equal(found?.id, created.id);
  assert.equal(await env.gateway.findChannelByName(env.guildId, 'inexistente', 2), null);

  const renamed = await env.gateway.renameChannel(env.guildId, created.id, '🔉・suporte¹');
  assert.equal(renamed.name, '🔉・suporte¹');
  assert.equal(await env.gateway.renameChannel(env.guildId, 'nao-existe', 'x'), null);
});
