'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember } = require('./helpers');
const { handleInteraction } = require('../src/interactions/router');
const { makeCommandInteraction } = require('./helpers');

const PLAYER = '900000000000007001';

/** Coloca o jogador na fila e o remove como desistente (ação do próprio jogador). */
async function joinAndLeave(env, userId = PLAYER) {
  addMember(env.gateway, userId, { voiceChannelId: env.waitChannelId });
  await env.services.queue.join({ guildId: env.guildId, userId, displayName: 'Player' });
  return env.services.queue.leave({ guildId: env.guildId, userId });
}

test('quem desiste antes de ser chamado fica 10 minutos bloqueado', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  await joinAndLeave(env);

  const info = env.services.cooldowns.check(env.guildId, PLAYER);
  assert.equal(info.active, true);
  assert.ok(info.remainingSeconds > 590 && info.remainingSeconds <= 600, `restante: ${info.remainingSeconds}`);

  await assert.rejects(
    () => env.services.queue.join({ guildId: env.guildId, userId: PLAYER, displayName: 'Player' }),
    (error) => {
      assert.equal(error.code, 'EM_COOLDOWN');
      assert.match(error.userMessage, /Aguarde/);
      return true;
    },
  );
  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 0);
});

test('a mensagem privada de saída informa o tempo de bloqueio', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  await joinAndLeave(env);

  const dm = JSON.stringify(env.gateway.dms.at(-1).payload);
  assert.match(dm, /10 minutos/);
});

test('entrar no canal de espera durante o bloqueio remove o jogador e avisa', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  await joinAndLeave(env);
  const before = env.gateway.disconnects.length;

  const result = await env.services.attendance.handlePlayerVoiceUpdate({
    guildId: env.guildId,
    userId: PLAYER,
    oldChannelId: null,
    channelId: env.waitChannelId,
    attendanceChannelIds: [env.attChannelId],
    displayName: 'Teimoso',
  });

  assert.equal(result.cooldownBlocked, true);
  assert.ok(env.gateway.disconnects.length > before, 'removido do canal');
  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 0);
  assert.match(JSON.stringify(env.gateway.dms.at(-1).payload), /Aguarde|Tempo restante/);

  const events = env.services.audit.recent(env.guildId);
  assert.ok(events.some((event) => event.type === 'COOLDOWN_BLOCKED'));
});

test('após o tempo de bloqueio o jogador pode entrar novamente', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  await joinAndLeave(env);

  // simula a passagem do tempo
  await env.db.transaction(async () =>
    env.services.repositories.cooldowns.setSync(env.guildId, PLAYER, {
      until: Date.now() - 1000,
      reason: 'expirado',
    }),
  );

  const info = env.services.cooldowns.check(env.guildId, PLAYER);
  assert.equal(info.active, false);

  addMember(env.gateway, PLAYER);
  const joined = await env.services.queue.join({
    guildId: env.guildId,
    userId: PLAYER,
    displayName: 'Voltou',
  });
  assert.equal(joined.position, 1);
});

test('staff removendo o jogador NÃO gera bloqueio', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER);
  const joined = await env.services.queue.join({
    guildId: env.guildId,
    userId: PLAYER,
    displayName: 'Removido por staff',
  });

  await env.services.queue.remove({
    guildId: env.guildId,
    attendanceId: joined.attendance.id,
    actorId: '910000000000000099',
    actorTag: 'Admin',
    reason: 'Conduta inadequada',
  });

  assert.equal(env.services.cooldowns.check(env.guildId, PLAYER).active, false);
});

test('bloqueio desativado (0 minutos) permite reentrada imediata', async (t) => {
  const env = await createTestEnv({ settings: { rejoin_cooldown_minutes: 0 } });
  t.after(env.cleanup);
  await joinAndLeave(env);

  assert.equal(env.services.cooldowns.check(env.guildId, PLAYER).active, false);
  addMember(env.gateway, PLAYER);
  const joined = await env.services.queue.join({ guildId: env.guildId, userId: PLAYER, displayName: 'Já voltou' });
  assert.equal(joined.position, 1);
});

test('cliente configurável: 3 minutos', async (t) => {
  const env = await createTestEnv({ settings: { rejoin_cooldown_minutes: 3 } });
  t.after(env.cleanup);
  await joinAndLeave(env);

  const info = env.services.cooldowns.check(env.guildId, PLAYER);
  assert.ok(info.remainingSeconds > 170 && info.remainingSeconds <= 180);
});

test('botão do painel mostra o bloqueio em vez de erro genérico', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  await joinAndLeave(env);

  const interaction = makeCommandInteraction({ commandName: 'x', userId: PLAYER, guildId: env.guildId });
  interaction.customId = 'pub:join';
  interaction.isChatInputCommand = () => false;
  interaction.isButton = () => true;

  await handleInteraction(interaction, { services: env.services, client: { commands: new Map() } });

  const payload = interaction.responses.at(-1);
  assert.match(JSON.stringify(payload), /Aguarde|bloque/i);
  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 0);
});

test('/fila liberar remove o bloqueio', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  await joinAndLeave(env);

  const admin = makeCommandInteraction({
    commandName: 'fila',
    guildId: env.guildId,
    roles: ['500000000000000002'],
    options: { subcommand: 'liberar', jogador: { id: PLAYER } },
  });

  const commands = require('../src/handlers/commandHandler').loadCommands();
  admin.client = { commands, guilds: { cache: new Map() } };
  await handleInteraction(admin, { services: env.services, client: admin.client, env: {}, runtime: {} });

  assert.equal(env.services.cooldowns.check(env.guildId, PLAYER).active, false);
  assert.match(JSON.stringify(admin.responses.at(-1)), /Bloqueio removido/);
});
