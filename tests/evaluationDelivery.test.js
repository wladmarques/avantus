'use strict';

/**
 * Entrega da avaliação ao jogador: DM com botões válidos, fallback no canal
 * do painel quando a DM está fechada e o botão "Avaliar atendimento".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember, addStaffInVoice, makeCommandInteraction } = require('./helpers');
const { handleInteraction } = require('../src/interactions/router');
const { executeCommand } = require('../src/handlers/commandHandler');
const avaliarCommand = require('../src/commands/player/avaliar');

const PLAYER = '900000000000007001';
const STAFF = '900000000000007900';

/** Valida o formato que o Discord exige (o `type` faltante derrubava o envio). */
function assertDiscordComponents(payload) {
  for (const row of payload.components ?? []) {
    assert.equal(row.type, 1, 'linha de componentes é ActionRow (type 1)');
    assert.ok(row.components.length >= 1 && row.components.length <= 5, 'até 5 botões por linha');
    for (const component of row.components) {
      assert.equal(component.type, 2, 'botão precisa de type: 2 (senão o Discord recusa)');
      assert.equal(typeof component.custom_id, 'string');
      assert.ok(component.custom_id.length > 0);
      assert.ok([1, 2, 3, 4, 5].includes(component.style), 'style válido');
      assert.equal(typeof component.label, 'string');
      assert.ok(component.label.length > 0 && component.label.length <= 80);
    }
  }
}

function baseInteraction({ userId, guildId, roles = [] }) {
  return {
    guildId,
    user: { id: userId, username: 'jogador' },
    member: {
      id: userId,
      displayName: 'Jogador',
      roles: { cache: new Map(roles.map((role) => [role, { id: role }])) },
      permissions: { has: () => false },
    },
    deferred: false,
    replied: false,
    responses: [],
    async deferReply(options) {
      this.deferred = true;
      this.deferOptions = options;
    },
    async reply(payload) {
      this.replied = true;
      this.responses.push(payload);
      return payload;
    },
    async editReply(payload) {
      this.responses.push(payload);
      return payload;
    },
    async followUp(payload) {
      this.responses.push(payload);
      return payload;
    },
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
  };
}

function context(env) {
  return { services: env.services, client: { commands: new Map() }, env: {}, runtime: {} };
}

/** Contexto com o comando /avaliar registrado no client falso. */
function commandContext(env) {
  const client = { commands: new Map([['avaliar', avaliarCommand]]), guilds: { cache: new Map() } };
  return { client, services: env.services, env: {}, runtime: {} };
}

async function finishedAttendance(env, { player = PLAYER, staff = STAFF } = {}) {
  addMember(env.gateway, player, { voiceChannelId: env.waitChannelId, displayName: 'Jogador' });
  addStaffInVoice(env.gateway, staff);
  await env.services.queue.join({ guildId: env.guildId, userId: player, displayName: 'Jogador' });
  const called = await env.services.attendance.callNext({
    guildId: env.guildId,
    staffId: staff,
    staffTag: 'Staff Teste',
  });
  await env.services.attendance.finish({
    guildId: env.guildId,
    attendanceId: called.attendance.id,
    actorId: staff,
    actorTag: 'Staff Teste',
  });
  return called.attendance;
}

test('a DM de avaliação tem payload válido para o Discord', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const attendance = await finishedAttendance(env);
  const dm = env.gateway.dms.filter((entry) => entry.userId === PLAYER).at(-1);

  assert.ok(dm, 'DM enviada');
  assert.doesNotThrow(() => assertDiscordComponents(dm.payload));
  assert.equal(dm.payload.components[0].components.length, 4, 'quatro notas');
  assert.deepEqual(
    dm.payload.components[0].components.map((item) => item.custom_id),
    ['MUITO_BOM', 'BOM', 'REGULAR', 'RUIM'].map((rating) => `eval:${attendance.id}:${rating}`),
  );
});

test('DM bloqueada: a avaliação é publicada no canal do painel marcando o jogador', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  // Simula "Cannot send messages to this user" (DM fechada).
  env.gateway.sendDirectMessage = async () => ({ ok: false, reason: 'DM fechada' });

  const attendance = await finishedAttendance(env);
  const channelId = env.services.settings.get('public_channel_id');
  const posted = env.gateway.channelMessages.filter((item) => item.channelId === channelId);
  const evaluation = posted.at(-1);

  assert.ok(evaluation, 'avaliação publicada no canal do painel');
  assert.match(evaluation.payload.embeds[0].description, new RegExp(`<@${PLAYER}>`));
  assert.match(evaluation.payload.embeds[0].description, /#0001/);
  assert.doesNotThrow(() => assertDiscordComponents(evaluation.payload));
  assert.equal(
    evaluation.payload.components[0].components[0].custom_id,
    `eval:${attendance.id}:MUITO_BOM`,
  );
});

test('DM entregue não publica nada no canal do painel', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await finishedAttendance(env);
  const channelId = env.services.settings.get('public_channel_id');
  const inChannel = env.gateway.channelMessages.filter(
    (item) => item.channelId === channelId && JSON.stringify(item.payload).includes('Como foi seu atendimento'),
  );
  assert.equal(inChannel.length, 0);
});

test('botão "Avaliar atendimento" mostra as notas após o atendimento', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  const attendance = await finishedAttendance(env);

  // Sem pendências antes do atendimento? Depois do atendimento existe uma.
  const pending = env.services.evaluations.pending(env.guildId, PLAYER);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, attendance.id);

  const interaction = { ...baseInteraction({ userId: PLAYER, guildId: env.guildId }), customId: 'pub:evaluate' };
  await handleInteraction(interaction, context(env));

  const response = interaction.responses.at(-1);
  assert.match(JSON.stringify(response), new RegExp(`eval:${attendance.id}:MUITO_BOM`));
  assert.match(JSON.stringify(response), /#0001/);
  assert.equal(response.components.length, 1, 'uma linha por atendimento pendente');

  // O clique na nota realmente grava.
  const rate = {
    ...baseInteraction({ userId: PLAYER, guildId: env.guildId }),
    customId: `eval:${attendance.id}:BOM`,
  };
  await handleInteraction(rate, context(env));
  assert.equal(env.services.evaluations.summary(env.guildId, 'hoje').total, 1);

  // Depois de avaliar não há mais pendências.
  assert.equal(env.services.evaluations.pending(env.guildId, PLAYER).length, 0);
  const again = { ...baseInteraction({ userId: PLAYER, guildId: env.guildId }), customId: 'pub:evaluate' };
  await handleInteraction(again, context(env));
  assert.match(JSON.stringify(again.responses.at(-1)), /Nenhum atendimento para avaliar/);
});

test('botão "Avaliar atendimento" sem atendimentos responde em privado', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const interaction = { ...baseInteraction({ userId: PLAYER, guildId: env.guildId }), customId: 'pub:evaluate' };
  await handleInteraction(interaction, context(env));

  const response = interaction.responses.at(-1);
  assert.match(JSON.stringify(response), /Nenhum atendimento para avaliar/);
  assert.equal(response.components, undefined, 'sem botões quando não há o que avaliar');
});

test('/avaliar sem protocolo usa o último atendimento pendente', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  const attendance = await finishedAttendance(env);

  const interaction = makeCommandInteraction({
    commandName: 'avaliar',
    userId: PLAYER,
    guildId: env.guildId,
    options: { nota: 'RUIM' },
  });
  const ctx = commandContext(env);
  interaction.client = ctx.client;
  await executeCommand(interaction, ctx);

  const saved = env.services.evaluations.summary(env.guildId, 'hoje');
  assert.equal(saved.total, 1);
  assert.equal(saved.byRating.RUIM, 1);
  assert.equal(saved.recent[0].attendance_id, attendance.id, 'avaliou o atendimento certo');
});

test('/avaliar sem atendimento pendente explica o motivo', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const interaction = makeCommandInteraction({
    commandName: 'avaliar',
    userId: PLAYER,
    guildId: env.guildId,
    options: { nota: 'BOM' },
  });
  const ctx = commandContext(env);
  interaction.client = ctx.client;
  await executeCommand(interaction, ctx);

  assert.match(JSON.stringify(interaction.responses), /não tem atendimentos aguardando avaliação/i);
  assert.equal(env.services.evaluations.summary(env.guildId, 'hoje').total, 0);
});
