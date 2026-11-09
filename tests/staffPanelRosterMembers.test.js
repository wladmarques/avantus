'use strict';

/**
 * EQUIPE do painel deve listar **todo mundo que tem o cargo de atendimento**,
 * mesmo quem nunca entrou em serviço.
 *
 * Antes, a lista vinha só de `staff_status` (quem já ficou DISPONÍVEL alguma
 * vez). Quem recebeu o cargo depois, ou nunca abriu o próprio status, sumia do
 * painel — e o painel mostrava uma equipe menor do que a real.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv } = require('./helpers');
const { buildStaffPanel } = require('../src/dashboard/panels/staffPanel');

const ROLE = '1566903220968624188';
const REGISTRADO = '900000000000003001';
const SO_CARGO_1 = '900000000000003002';
const SO_CARGO_2 = '900000000000003003';
const SEM_CARGO = '900000000000003004';

const OVERVIEW = { avgDurationSeconds: 0, concluded: 0, evaluations: false, avgRating: 0 };

function addMember(env, userId, roles) {
  env.gateway.members.set(userId, {
    inGuild: true,
    voiceChannelId: null,
    displayName: `Staff ${userId}`,
    staffRoles: roles,
  });
}

function render(env) {
  const state = env.services.engine.getState(env.guildId);
  const payload = buildStaffPanel({
    state,
    overview: OVERVIEW,
    schedule: { open: false },
    todayWindow: { text: '12:00 às 00:00' },
    now: new Date(),
  });
  const description = payload.embeds[0].description;
  return { state, description, team: description.split('**EQUIPE**')[1] ?? '' };
}

async function envComCargo(t, { roleFilter = [ROLE] } = {}) {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  // Só um staff tem linha em `staff_status` (já entrou em serviço alguma vez).
  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: REGISTRADO,
    status: 'INDISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });

  addMember(env, REGISTRADO, [ROLE]);
  addMember(env, SO_CARGO_1, [ROLE]); // tem o cargo, nunca entrou em serviço
  addMember(env, SO_CARGO_2, ['123456789012345678', ROLE]);
  addMember(env, SEM_CARGO, ['123456789012345678']);

  if (roleFilter.length) await env.services.settings.set('staff_panel_role_ids', roleFilter);
  await env.services.staff.refreshRoleCache(env.guildId, { force: true });
  return env;
}

test('quem tem o cargo e nunca entrou em serviço aparece na EQUIPE', async (t) => {
  const env = await envComCargo(t);
  const { state } = render(env);

  const ids = state.staffList.map((row) => row.userId);
  assert.ok(ids.includes(REGISTRADO));
  assert.ok(ids.includes(SO_CARGO_1), 'tem o cargo, sem status registrado');
  assert.ok(ids.includes(SO_CARGO_2), 'tem o cargo + outro cargo');
  assert.ok(!ids.includes(SEM_CARGO), 'sem o cargo continua fora');
});

test('quem só tem o cargo entra em FORA DE SERVIÇO, com "sem escala"', async (t) => {
  const env = await envComCargo(t);
  const { team } = render(env);

  const marca = '**FORA DE SERVIÇO';
  const deServico = team.slice(0, team.indexOf(marca));
  const fora = team.slice(team.indexOf(marca));

  assert.ok(fora.includes(`<@${SO_CARGO_1}>`), 'listado em FORA DE SERVIÇO');
  assert.ok(fora.includes(`<@${SO_CARGO_2}>`));
  assert.ok(deServico.includes('**DE SERVIÇO (0)**'), 'ninguém de serviço');
  assert.ok(!deServico.includes(`<@${SO_CARGO_1}>`), 'não aparece em DE SERVIÇO');

  const linhas = fora.split('\n').filter((linha) => linha.includes('<@'));
  assert.equal(linhas.length, 3, 'três nomes em FORA DE SERVIÇO');
  for (const linha of linhas) {
    assert.ok(linha.includes('sem escala'), `linha sem escala: ${linha}`);
  }
});

test('a contagem do grupo inclui quem veio pelo cargo', async (t) => {
  const env = await envComCargo(t);
  const { team } = render(env);
  assert.ok(team.includes('**FORA DE SERVIÇO (3)**'), 'três staff no grupo');
});

test('quem vem pelo cargo é marcado como não registrado', async (t) => {
  const env = await envComCargo(t);
  const { state } = render(env);

  const porId = new Map(state.staffList.map((row) => [row.userId, row]));
  assert.equal(porId.get(REGISTRADO).registered, true);
  assert.equal(porId.get(SO_CARGO_1).registered, false);
  assert.equal(porId.get(SO_CARGO_1).status, 'INDISPONIVEL');
  assert.equal(porId.get(SO_CARGO_1).blocked, false);
});

test('sem cargo configurado nada muda: lista só quem já entrou em serviço', async (t) => {
  const env = await envComCargo(t, { roleFilter: [] });
  const { state } = render(env);

  const ids = state.staffList.map((row) => row.userId);
  assert.deepEqual(ids, [REGISTRADO]);
});

test('quem perdeu o cargo sai da EQUIPE', async (t) => {
  const env = await envComCargo(t);
  assert.equal(env.services.staff.rosterIds(env.guildId).has(SO_CARGO_2), true);

  env.gateway.members.set(SO_CARGO_2, {
    inGuild: true,
    voiceChannelId: null,
    displayName: 'Staff',
    staffRoles: ['123456789012345678'],
  });
  await env.services.staff.refreshRoleCache(env.guildId, { force: true });

  const { state } = render(env);
  const ids = state.staffList.map((row) => row.userId);
  assert.ok(!ids.includes(SO_CARGO_2), 'sem o cargo, não aparece');
  assert.ok(ids.includes(SO_CARGO_1));
});

test('quem veio pelo cargo não conta como disponível (fila continua fechada)', async (t) => {
  const env = await envComCargo(t);
  await env.services.settings.set('central_open', true);
  const state = env.services.engine.getState(env.guildId);

  assert.equal(state.staffCounts.DISPONIVEL, 0, 'ninguém está em serviço');
  assert.equal(state.staffCounts.INDISPONIVEL, 3);
  assert.equal(env.services.engine.availability(env.guildId).reason, 'sem_staff');
});

test('o painel web também passa a enxergar quem tem o cargo', async (t) => {
  const env = await envComCargo(t);
  const overview = env.services.hourBank.overview(env.guildId);
  const porId = new Map(overview.staff.map((row) => [row.userId, row]));

  // O overview do painel web usa o status salvo; quem nunca entrou em serviço
  // continua aparecendo como ESCALA (tem o cargo) quando consultado.
  assert.equal(porId.get(REGISTRADO).group, 'ESCALA');
  assert.equal(env.services.staff.rosterIds(env.guildId).has(SO_CARGO_1), true);
});
