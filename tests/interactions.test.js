'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember, addStaffInVoice, panelButtonIds } = require('./helpers');
const { handleInteraction } = require('../src/interactions/router');

const STAFF_ROLE = '500000000000000001';
const PLAYER = '900000000000006001';
const STAFF = '910000000000006001';

function baseInteraction(overrides = {}) {
  return {
    guildId: overrides.guildId,
    user: { id: overrides.userId, username: 'usuario' },
    member: {
      id: overrides.userId,
      displayName: overrides.displayName ?? 'Membro',
      roles: { cache: new Map((overrides.roles ?? []).map((role) => [role, { id: role }])) },
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
    async showModal(modal) {
      this.modal = modal;
    },
    // `kind` pode ser ajustado depois do spread nos testes
    isChatInputCommand() { return this.kind === 'command'; },
    isAutocomplete() { return this.kind === 'autocomplete'; },
    isButton() { return (this.kind ?? 'button') === 'button'; },
    isStringSelectMenu() { return this.kind === 'select'; },
    isModalSubmit() { return this.kind === 'modal'; },
  };
}

function context(env) {
  return { services: env.services, client: { commands: new Map() }, env: {}, runtime: {} };
}

test('botão ENTRAR NA FILA coloca o jogador na fila e responde em privado ao clique', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER, { voiceChannelId: env.waitChannelId });

  const interaction = { ...baseInteraction({ userId: PLAYER, guildId: env.guildId }), customId: 'pub:join' };
  await handleInteraction(interaction, context(env));

  assert.equal(env.services.engine.getState(env.guildId).waiting.length, 1);
  assert.equal(interaction.responses.length, 1);
  assert.match(JSON.stringify(interaction.responses[0]), /0001/);
});

test('jogador sem permissão não consegue usar o botão da staff', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER);

  const interaction = { ...baseInteraction({ userId: PLAYER, guildId: env.guildId }), customId: 'staff:call_next' };
  await handleInteraction(interaction, context(env));

  assert.match(JSON.stringify(interaction.responses[0]), /não faz parte da equipe/i);
});

test('botão CHAMAR PRÓXIMO da staff chama o primeiro da fila', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER, { voiceChannelId: env.waitChannelId });
  addStaffInVoice(env.gateway, STAFF);
  await env.services.queue.join({ guildId: env.guildId, userId: PLAYER, displayName: 'Cliente' });

  const interaction = {
    ...baseInteraction({ userId: STAFF, guildId: env.guildId, roles: [STAFF_ROLE], displayName: 'Staff' }),
    customId: 'staff:call_next',
  };
  await handleInteraction(interaction, context(env));

  const state = env.services.engine.getState(env.guildId);
  assert.equal(state.serving.length, 1);
  assert.match(JSON.stringify(interaction.responses[0]), /Jogador chamado/);
});

test('botão de seleção abre menu com os jogadores da fila', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER);
  await env.services.queue.join({ guildId: env.guildId, userId: PLAYER, displayName: 'Menu' });

  const interaction = {
    ...baseInteraction({ userId: STAFF, guildId: env.guildId, roles: [STAFF_ROLE] }),
    customId: 'staff:call_specific',
  };
  await handleInteraction(interaction, context(env));

  const payload = interaction.responses[0];
  const menu = payload.components[0].components[0];
  assert.equal(menu.custom_id, 'staff:select:call');
  assert.equal(menu.options.length, 1);
});

test('modal de remoção exige motivo e registra a ação', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER);
  const joined = await env.services.queue.join({
    guildId: env.guildId,
    userId: PLAYER,
    displayName: 'Removido',
  });

  const interaction = {
    ...baseInteraction({ userId: STAFF, guildId: env.guildId, roles: [STAFF_ROLE] }),
    customId: `staff:modal:remove:${joined.attendance.id}`,
    kind: 'modal',
    fields: { getTextInputValue: () => 'Conduta inadequada' },
  };
  await handleInteraction(interaction, context(env));

  const record = env.services.repositories.attendance.findByIdSync(env.guildId, joined.attendance.id);
  assert.equal(record.outcome, 'JOGADOR_REMOVIDO');
  assert.ok(env.services.audit.recent(env.guildId).some((event) => event.type === 'QUEUE_REMOVE'));
});

test('botões de avaliação registram a nota', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  addMember(env.gateway, PLAYER);
  addStaffInVoice(env.gateway, STAFF);
  await env.services.queue.join({ guildId: env.guildId, userId: PLAYER, displayName: 'Avaliado' });
  const call = await env.services.attendance.callNext({
    guildId: env.guildId,
    staffId: STAFF,
    staffTag: 'Staff',
  });
  await env.services.attendance.finish({
    guildId: env.guildId,
    attendanceId: call.attendance.id,
    actorId: STAFF,
    actorTag: 'Staff',
  });

  const interaction = {
    ...baseInteraction({ userId: PLAYER, guildId: env.guildId }),
    customId: `eval:${call.attendance.id}:BOM`,
  };
  await handleInteraction(interaction, context(env));

  const evaluations = env.services.evaluations.summary(env.guildId, 'hoje');
  assert.equal(evaluations.total, 1);
  assert.equal(evaluations.byRating.BOM, 1);
});

test('painéis publicados usam IDs persistentes reconhecidos pelo router', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  const { payload } = env.services.panels.buildPayload(env.guildId, 'public');
  assert.deepEqual(panelButtonIds(payload), ['pub:join', 'pub:status', 'pub:leave']);
});
