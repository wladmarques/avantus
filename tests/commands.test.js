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
