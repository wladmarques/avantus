'use strict';

/**
 * Boot: servidor certo x servidor errado.
 *
 * Cenário real: o bot conecta (token válido) mas ainda não foi convidado para o
 * servidor do GUILD_ID. Antes o boot tentava registrar comandos e estourava
 * "Missing Access (50001)" e não subia nada. Agora avisa com o link de convite
 * e sobe a central sozinho quando o bot entra.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv } = require('./helpers');
const { inviteUrl } = require('../src/utils/invite');

const APP_ID = '1200967871480737912';

function fakeClient({ guildIds = [] } = {}) {
  const guilds = new Map();
  for (const id of guildIds) {
    guilds.set(id, { id, name: `servidor ${id}`, channels: { fetch: async () => null } });
  }
  return {
    user: { id: APP_ID, tag: 'VANTUS ATENDIMENTO#8206' },
    application: { id: APP_ID },
    guilds: { cache: guilds },
    commands: new Map(),
  };
}

const cleanRuntime = (runtime) => {
  clearInterval(runtime.panelTimer);
  clearInterval(runtime.expireTimer);
  runtime.stopHourBankWatcher?.();
  runtime.stopScheduleBroadcastWatcher?.();
  runtime.stopScheduleWatcher?.();
};

test('bot fora do servidor: não tenta registrar comandos e mostra o link de convite', async (t) => {
  const env = await createTestEnv();
  t.after(() => env.db.close());

  const client = fakeClient({ guildIds: ['999999999999999999'] });
  const context = { services: env.services, env: { autoRegisterCommands: true, clientId: APP_ID }, runtime: {} };
  const ready = require('../src/events/client/clientReady');

  await ready.execute(client, context);

  assert.equal(context.runtime.awaitingGuild, env.guildId, 'marca que está esperando o servidor');
  assert.equal(context.runtime.panelTimer, undefined, 'nada de painel rodando sem servidor');

  // O link mostrado no log usa a aplicação do token (não o CLIENT_ID errado).
  assert.match(inviteUrl(APP_ID), /client_id=1200967871480737912/);
});

test('registerCommands recusa servidor onde o bot não está (evita 50001)', async () => {
  const { registerCommands } = require('../src/handlers/registerCommands');
  const client = fakeClient({ guildIds: [] });
  client.commands = new Map();

  await assert.rejects(
    () => registerCommands({ client, token: 'x', guildId: '440265886302076928', commands: new Map() }),
    /não está no servidor 440265886302076928.*oauth2\/authorize\?client_id=1200967871480737912/,
  );
});

test('guildCreate sobe a central quando o bot entra no servidor configurado', async (t) => {
  const env = await createTestEnv();
  t.after(() => env.db.close());

  const client = fakeClient();
  const context = { services: env.services, env: { autoRegisterCommands: false }, runtime: {} };
  const guildCreate = require('../src/events/client/guildCreate');

  // Outro servidor: ignora.
  await guildCreate.execute({ id: '999999999999999999', name: 'outro', client }, context);
  assert.equal(context.runtime.startedGuildId, undefined);

  // Servidor configurado: sobe (e só uma vez).
  const guild = { id: env.guildId, name: 'VANTUS', client };
  client.guilds.cache.set(env.guildId, guild);
  t.after(() => cleanRuntime(context.runtime));

  await guildCreate.execute(guild, context);
  assert.equal(context.runtime.startedGuildId, env.guildId);
  assert.ok(context.runtime.panelTimer, 'painéis ligados');
  assert.ok(context.runtime.expireTimer, 'expiração ligada');

  const { startGuild } = require('../src/handlers/guildStart');
  assert.equal(await startGuild({ client, context, guildId: env.guildId }), false, 'idempotente');
});

test('audit não tenta enviar para servidor fora do cache', async (t) => {
  const env = await createTestEnv();
  t.after(() => env.db.close());

  env.gateway.isGuildAvailable = () => false;
  await env.services.audit.log({ guildId: env.guildId, type: 'TESTE', message: 'sem servidor' });

  assert.equal(env.gateway.channelMessages.length, 0, 'nada enviado ao canal de logs');
  const rows = env.services.audit.recent(env.guildId, { limit: 5 });
  assert.equal(rows.length >= 1, true, 'continua gravando no banco');
});
