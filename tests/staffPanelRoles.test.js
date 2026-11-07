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

async function envWithStaff(t, { roleFilter = [ROLE], disponivel = false } = {}) {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  addMemberWithRoles(env, WITH_ROLE, [ROLE], { name: 'conde' });
  addMemberWithRoles(env, WITH_ROLE_2, ['123456789012345678', ROLE], { name: 'kezu' });
  addMemberWithRoles(env, WITHOUT_ROLE, ['123456789012345678'], { name: 'forasteiro' });

  for (const userId of [WITH_ROLE, WITH_ROLE_2, WITHOUT_ROLE]) {
    await env.services.staff.setStatus({
      guildId: env.guildId,
      userId,
      status: disponivel ? 'DISPONIVEL' : 'INDISPONIVEL',
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
  await env.services.staff.refreshRoleCache(env.guildId, { force: true });

  const ids = env.services.engine.getState(env.guildId).staffList.map((row) => row.userId);
  assert.deepEqual(ids, [WITH_ROLE]);
});

test('membro que saiu do servidor não aparece mais', async (t) => {
  const env = await envWithStaff(t);
  env.gateway.members.set(WITH_ROLE, { inGuild: false, staffRoles: [ROLE] });
  await env.services.staff.refreshRoleCache(env.guildId, { force: true });

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

/* ------------------------------------------------------------------ */
/* Resiliência do cache de cargos                                      */
/* ------------------------------------------------------------------ */

/**
 * Sintoma relatado: "a central some com todos os staff da equipe e fica
 * fechada, depois volta ao normal sozinha".
 *
 * Causa: uma falha de API (rate limit / queda do gateway) devolvia lista vazia
 * e esse vazio ia para o cache — a EQUIPE ficava sem ninguém, os "Disponíveis"
 * caíam para 0 e o botão Entrar na Fila era desabilitado até a próxima
 * sincronização (5 min). Agora falha/vazio preservam a última lista boa.
 */
test('falha na sincronização mantém a equipe no painel (não fecha a central)', async (t) => {
  const env = await envWithStaff(t, { disponivel: true });
  const before = env.services.engine.getState(env.guildId);
  assert.equal(before.staffList.length, 2);

  // O gateway real devolve `null` quando o fetch dos membros falha.
  const original = env.gateway.listMemberRoles.bind(env.gateway);
  env.gateway.listMemberRoles = async () => null;
  const result = await env.services.staff.refreshRoleCache(env.guildId, { force: true });

  assert.equal(result?.size, 2, 'cache anterior preservado');
  const state = env.services.engine.getState(env.guildId);
  assert.deepEqual(state.staffList.map((row) => row.userId).sort(), [WITH_ROLE, WITH_ROLE_2].sort());
  assert.equal(state.staffCounts.DISPONIVEL, 2, 'continua com staff disponível');
  assert.ok(env.services.engine.availability(env.guildId).available, 'entrada na fila segue liberada');

  env.gateway.listMemberRoles = original;
  await env.services.staff.refreshRoleCache(env.guildId, { force: true });
  assert.equal(env.services.engine.getState(env.guildId).staffList.length, 2);
});

test('sincronização vazia não apaga a equipe já conhecida', async (t) => {
  const env = await envWithStaff(t, { disponivel: true });
  const original = env.gateway.listMemberRoles.bind(env.gateway);
  env.gateway.listMemberRoles = async () => new Map();

  await env.services.staff.refreshRoleCache(env.guildId, { force: true });
  assert.equal(env.services.engine.getState(env.guildId).staffList.length, 2);

  env.gateway.listMemberRoles = original;
});

test('cache vazio (cold start ruim) não esconde a equipe inteira', async (t) => {
  const env = await envWithStaff(t, { disponivel: true });
  env.services.staff.roleCache.set(env.guildId, new Map());

  // Sem cache confiável, o painel volta a listar todos os staff registrados
  // (comportamento de cold start) em vez de esconder a equipe inteira.
  const state = env.services.engine.getState(env.guildId);
  assert.equal(state.staffList.length, 3);
  assert.equal(state.staffCounts.DISPONIVEL, 3);
});

test('painel público segue disponível quando a sincronização falha', async (t) => {
  const env = await envWithStaff(t, { disponivel: true });
  env.gateway.listMemberRoles = async () => null;
  await env.services.staff.refreshRoleCache(env.guildId, { force: true });

  const { buildPublicPanel } = require('../src/dashboard/panels/publicPanel');
  const state = env.services.engine.getState(env.guildId);
  const built = buildPublicPanel({
    style: 'classic',
    settings: env.services.settings.getAll(),
    state,
    schedule: { open: true, nextOpen: null },
    todayWindow: { text: '12:00 às 00:00' },
  });

  const fields = built.payload.embeds[0].fields ?? [];
  const statusField = fields.find((field) => field.name === 'STATUS DA CENTRAL');
  assert.ok(!/INDISPONÍVEL/.test(statusField.value), 'central não pode aparecer fechada');
  const staffField = fields.find((field) => field.name === 'STAFFS DISPONÍVEIS');
  assert.equal(staffField.value, '**2**');
});

test('sincronizações seguidas usam o cache (evita rajada de consultas)', async (t) => {
  const env = await envWithStaff(t);
  const original = env.gateway.listMemberRoles.bind(env.gateway);
  let calls = 0;
  env.gateway.listMemberRoles = async (...args) => {
    calls += 1;
    return original(...args);
  };

  await env.services.staff.refreshRoleCache(env.guildId);
  await env.services.staff.refreshRoleCache(env.guildId);
  await env.services.staff.refreshRoleCache(env.guildId);
  assert.equal(calls, 0, 'sem throttle interno, tudo veio do cache recente');

  await env.services.staff.refreshRoleCache(env.guildId, { force: true });
  assert.equal(calls, 1);

  env.gateway.listMemberRoles = original;
});

test('sem filtro de cargo configurado a API não é consultada', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  let calls = 0;
  env.gateway.listMemberRoles = async () => {
    calls += 1;
    return new Map();
  };

  const result = await env.services.staff.refreshRoleCache(env.guildId, { force: true });
  assert.equal(result, null);
  assert.equal(calls, 0);
  assert.equal(env.services.engine.getState(env.guildId).staffList.length, 1);
});

test('roleCacheInfo alimenta o /diagnostico', async (t) => {
  const env = await envWithStaff(t);
  const info = env.services.staff.roleCacheInfo(env.guildId);
  assert.equal(info.synced, true);
  assert.equal(info.members, 2, 'só os membros com o cargo são carregados');
  assert.deepEqual(info.roleIds, [ROLE]);
  assert.equal(info.error, null);

  env.gateway.listMemberRoles = async () => null;
  await env.services.staff.refreshRoleCache(env.guildId, { force: true });
  const after = env.services.staff.roleCacheInfo(env.guildId);
  assert.ok(after.error, 'erro registrado para o diagnóstico');
});
