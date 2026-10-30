'use strict';

/**
 * Regra de disponibilidade: só é possível entrar na fila com a central aberta
 * **e** com pelo menos um staff DISPONÍVEL.
 *
 * - botão "Entrar na Fila" do painel fica desabilitado quando indisponível;
 * - `/entrar`, clique no botão e entrada pelo canal de voz são recusados;
 * - assim que um staff fica disponível, tudo volta a funcionar.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember, countDms, panelButtonIds } = require('./helpers');
const voiceEvent = require('../src/events/voice/voiceStateUpdate');

const PLAYER = '940000000000001001';
const STAFF = '940000000000002001';

function fakeMember(userId, displayName = 'Jogador') {
  return {
    id: userId,
    displayName,
    user: { id: userId, username: displayName, bot: false },
    roles: { cache: new Map() },
    permissions: { has: () => false },
    guild: { ownerId: 'owner' },
  };
}

async function joinButton(env) {
  const { payload } = env.services.panels.buildPayload(env.guildId, 'public');
  const container = payload.components[0];
  const section = container.components.find((item) => item.type === 9 && item.accessory?.type === 2);
  return section?.accessory ?? null;
}

test('sem staff disponível a central fica indisponível e o botão desabilitado', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  const availability = env.services.engine.availability(env.guildId);
  assert.equal(availability.available, false);
  assert.equal(availability.reason, 'sem_staff');

  const join = await joinButton(env);
  assert.equal(join.custom_id, 'pub:join');
  assert.equal(join.disabled, true, 'botão Entrar na Fila desabilitado');
});

test('fora do horário o botão também fica desabilitado', async (t) => {
  const env = await createTestEnv({ settings: { central_manual: 'closed' } });
  t.after(env.cleanup);

  const availability = env.services.engine.availability(env.guildId);
  assert.equal(availability.available, false);
  assert.equal(availability.reason, 'fechada');

  const join = await joinButton(env);
  assert.equal(join.disabled, true);
});

test('com staff disponível dentro do horário o botão é liberado', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const availability = env.services.engine.availability(env.guildId);
  assert.equal(availability.available, true);

  const join = await joinButton(env);
  assert.equal(join.disabled, false);
});

test('entrar na fila sem staff é recusado com mensagem clara', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER);

  await assert.rejects(
    () => env.services.queue.join({ guildId: env.guildId, userId: PLAYER, displayName: 'Sem staff' }),
    (error) => {
      assert.equal(error.code, 'SEM_STAFF');
      assert.match(error.userMessage, /staff.*em serviço/i);
      return true;
    },
  );

  assert.equal(env.services.queue.state(env.guildId).waiting.length, 0);
});

test('staff ocupado (em atendimento) não libera a entrada de novos jogadores', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER);

  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'EM_ATENDIMENTO',
    updatedBy: 'sistema',
    manual: false,
  });

  assert.equal(env.services.engine.availability(env.guildId).reason, 'sem_staff');
  await assert.rejects(
    () => env.services.queue.join({ guildId: env.guildId, userId: PLAYER, displayName: 'Ocupado' }),
    (error) => error.code === 'SEM_STAFF',
  );
});

test('quando o staff fica disponível a entrada é liberada', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER, { voiceChannelId: env.waitChannelId });

  await assert.rejects(
    () => env.services.queue.join({ guildId: env.guildId, userId: PLAYER, displayName: 'Antes' }),
    (error) => error.code === 'SEM_STAFF',
  );

  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'DISPONIVEL',
    updatedBy: 'sistema',
    manual: false,
  });

  const result = await env.services.queue.join({
    guildId: env.guildId,
    userId: PLAYER,
    displayName: 'Depois',
  });
  assert.equal(result.position, 1);
  assert.equal(env.services.queue.state(env.guildId).waiting.length, 1);
});

test('entrar pelo canal de voz sem staff não coloca o jogador na fila e avisa', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER, { voiceChannelId: env.waitChannelId });

  const member = fakeMember(PLAYER);
  await voiceEvent.execute(
    { guild: { id: env.guildId }, id: PLAYER, member, channelId: null },
    { guild: { id: env.guildId }, id: PLAYER, member, channelId: env.waitChannelId },
    { services: env.services },
  );

  assert.equal(env.services.queue.state(env.guildId).waiting.length, 0);
  assert.ok(countDms(env.gateway, PLAYER) > 0, 'jogador é avisado que não entrou');
});

test('painel clássico também desabilita o botão de entrada', async (t) => {
  const env = await createTestEnv({ staff: false, settings: { panel_style: 'classic' } });
  t.after(env.cleanup);

  const { payload } = env.services.panels.buildPayload(env.guildId, 'public');
  assert.equal(payload.embeds[0].color, 0xff2200, 'cor da marca mantida');
  const joinButtonPayload = payload.components[0].components.find((item) => item.custom_id === 'pub:join');
  assert.ok(joinButtonPayload, 'botão presente no payload');
  assert.equal(joinButtonPayload.disabled, true);
  assert.deepEqual(panelButtonIds(payload).length, 3, 'layout clássico mantém os três botões');
});
