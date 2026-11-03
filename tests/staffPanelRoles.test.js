'use strict';

/**
 * EQUIPE do painel da staff filtrada por cargo
 * (setting `staff_panel_role_ids`, ex.: 1566903220968624188).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv } = require('./helpers');
const { buildStaffPanel } = require('../src/dashboard/panels/staffPanel');

const ROLE = '1566903220968624188';
const WITH_ROLE = '900000000000000901';
const WITH_ROLE_2 = '900000000000000902';
const WITHOUT_ROLE = '900000000000000903';

function addMemberWithRoles(env, userId, roles, { name = null } = {}) {
  env.gateway.members.set(userId, {
    inGuild: true,
    voiceChannelId: null,
    displayName: name || `Staff ${userId}`,
    staffRoles: roles,
  });
}

async function envWithStaff(t, { roleFilter = [ROLE] } = {}) {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  addMemberWithRoles(env, WITH_ROLE, [ROLE], { name: 'conde' });
  addMemberWithRoles(env, WITH_ROLE_2, ['123456789012345678', ROLE], { name: 'kezu' });
  addMemberWithRoles(env, WITHOUT_ROLE, ['123456789012345678'], { name: 'forasteiro' });

  for (const userId of [WITH_ROLE, WITH_ROLE_2, WITHOUT_ROLE]) {
    await env.services.staff.setStatus({
      guildId: env.guildId,
      userId,
      status: 'INDISPONIVEL',
      updatedBy: 'teste',
      manual: true,
    });
  }

  if (roleFilter.length) await env.services.settings.set('staff_panel_role_ids', roleFilter);
  await env.services.staff.refreshRoleCache(env.guildId);
  return env;
}

test('sem filtro configurado, EQUIPE lista todos', async (t) => {
  const env = await envWithStaff(t, { roleFilter: [] });
  const state = env.services.engine.getState(env.guildId);

  const ids = state.staffList.map((row) => row.userId);
  assert.equal(ids.length, 3);
  assert.ok(ids.includes(WITHOUT_ROLE));
  assert.deepEqual(env.services.staff.panelRoleIds(), []);
});

test('com filtro, EQUIPE mostra só quem tem o cargo configurado', async (t) => {
  const env = await envWithStaff(t);
  const state = env.services.engine.getState(env.guildId);

  const ids = state.staffList.map((row) => row.userId).sort();
  assert.deepEqual(ids, [WITH_ROLE, WITH_ROLE_2].sort(), 'só os dois com o cargo');
  assert.ok(!ids.includes(WITHOUT_ROLE));

  // Contadores acompanham a lista filtrada (o painel não pode dizer 3 e listar 2).
  assert.equal(state.staffCounts.total, 2);
  assert.equal(state.staffCounts.INDISPONIVEL, 2);
});

test('cargo removido no Discord tira a pessoa do painel após a sincronização', async (t) => {
  const env = await envWithStaff(t);
  assert.equal(env.services.engine.getState(env.guildId).staffList.length, 2);

  // Simula a remoção do cargo e a próxima sincronização (que roda a cada 5 min).
  addMemberWithRoles(env, WITH_ROLE_2, ['123456789012345678'], { name: 'kezu' });
  await env.services.staff.refreshRoleCache(env.guildId);

  const ids = env.services.engine.getState(env.guildId).staffList.map((row) => row.userId);
  assert.deepEqual(ids, [WITH_ROLE]);
});

test('membro que saiu do servidor não aparece mais', async (t) => {
  const env = await envWithStaff(t);
  env.gateway.members.set(WITH_ROLE, { inGuild: false, staffRoles: [ROLE] });
  await env.services.staff.refreshRoleCache(env.guildId);

  const ids = env.services.engine.getState(env.guildId).staffList.map((row) => row.userId);
  assert.deepEqual(ids, [WITH_ROLE_2]);
});

test('sem cache de cargos (cold start) ninguém é escondido', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);
  await env.services.settings.set('staff_panel_role_ids', [ROLE]);
  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: WITH_ROLE,
    status: 'DISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });

  // roleCache vazio: o painel continua funcionando (lista tudo) até sincronizar.
  const state = env.services.engine.getState(env.guildId);
  assert.equal(state.staffList.length, 1);
  assert.equal(state.staffList[0].userId, WITH_ROLE);
});

test('o cargo aparece em EQUIPE no texto do painel e não em outro lugar', async (t) => {
  const env = await envWithStaff(t);
  const state = env.services.engine.getState(env.guildId);

  const payload = buildStaffPanel({
    state,
    overview: { avgDurationSeconds: 0, concluded: 0, evaluations: false, avgRating: 0 },
    schedule: { open: true },
    todayWindow: { text: '12:00 às 02:00' },
    now: new Date(),
  });

  const description = payload.embeds[0].description;
  const teamBlock = description.split('**EQUIPE**')[1];
  assert.ok(teamBlock.includes(`<@${WITH_ROLE}>`), 'staff com cargo aparece');
  assert.ok(teamBlock.includes(`<@${WITH_ROLE_2}>`), 'staff com cargo (2) aparece');
  assert.ok(!teamBlock.includes(`<@${WITHOUT_ROLE}>`), 'quem não tem o cargo fica fora');
});

test('STAFF_PANEL_ROLE_IDS do ambiente é aplicado no boot', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  const client = {
    user: { id: '1200967871480737912', tag: 'VANTUS#0001' },
    application: { id: '1200967871480737912' },
    guilds: { cache: new Map([[env.guildId, { id: env.guildId, name: 'VANTUS', channels: { fetch: async () => null } }]]) },
    commands: new Map(),
  };
  const context = {
    services: env.services,
    env: { autoRegisterCommands: false, staffPanelRoleIds: [ROLE] },
    runtime: {},
  };
  t.after(() => {
    clearInterval(context.runtime.panelTimer);
    clearInterval(context.runtime.expireTimer);
    clearInterval(context.runtime.staffRoleTimer);
    context.runtime.stopHourBankWatcher?.();
    context.runtime.stopScheduleBroadcastWatcher?.();
    context.runtime.stopScheduleWatcher?.();
  });

  await require('../src/handlers/guildStart').startGuild({ client, context, guildId: env.guildId });

  assert.deepEqual(env.services.settings.get('staff_panel_role_ids'), [ROLE]);
  assert.ok(env.services.staff.roleCache.has(env.guildId), 'cache de cargos carregado no boot');
  assert.ok(context.runtime.staffRoleTimer, 'atualização periódica agendada');
});
