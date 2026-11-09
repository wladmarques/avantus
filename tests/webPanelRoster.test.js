'use strict';

/**
 * Painel web: separação entre **escala fixa** (staff com o cargo da escala,
 * ex. `1566903220968624188`) e **apoio** (atendimentos aleatórios).
 *
 * A regra do cargo é a mesma do painel do Discord (`STAFF_PANEL_ROLE_IDS`),
 * mas aqui ela serve para agrupar a tabela do painel web.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv } = require('./helpers');
const { createWebServer } = require('../src/web/server');

const PASSWORD = 'senha-de-teste';
const ROLE = '1566903220968624188';
const ESCALA_1 = '960000000000002001';
const ESCALA_2 = '960000000000002002';
const APOIO = '960000000000002003';
const SEM_CARGO_NA_ESCALA = '960000000000002004';

async function startPanel(env) {
  const { server } = createWebServer({
    services: env.services,
    env: { timezone: 'America/Sao_Paulo', guildId: env.guildId },
    password: PASSWORD,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const call = async (path, { method = 'GET', body, cookie } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  };

  const login = async () => {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = String(response.headers.get('set-cookie') || '').split(';')[0];
    return { cookie };
  };

  return { call, login, close: () => new Promise((resolve) => server.close(resolve)) };
}

function member(env, userId, roles, { name = null } = {}) {
  env.gateway.members.set(userId, {
    inGuild: true,
    voiceChannelId: null,
    displayName: name || `Staff ${userId}`,
    staffRoles: roles,
  });
}

async function envComEquipe(t) {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  for (const userId of [ESCALA_1, ESCALA_2, APOIO, SEM_CARGO_NA_ESCALA]) {
    await env.services.staff.setStatus({
      guildId: env.guildId,
      userId,
      status: 'INDISPONIVEL',
      updatedBy: 'teste',
      manual: true,
    });
  }

  // Dois com o cargo da escala, um sem cargo (apoio) e um sem cargo que, ainda
  // assim, tem turno cadastrado (caso de borda do fallback).
  member(env, ESCALA_1, [ROLE], { name: 'com-cargo-1' });
  member(env, ESCALA_2, ['123456789012345678', ROLE], { name: 'com-cargo-2' });
  member(env, APOIO, ['123456789012345678'], { name: 'apoio' });
  member(env, SEM_CARGO_NA_ESCALA, ['123456789012345678'], { name: 'sem-cargo-com-turno' });

  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: ESCALA_1,
    shifts: [{ weekday: 1, start: '14:00', end: '22:00' }],
  });
  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: SEM_CARGO_NA_ESCALA,
    shifts: [{ weekday: 2, start: '08:00', end: '12:00' }],
  });

  await env.services.settings.set('staff_panel_role_ids', [ROLE]);
  await env.services.staff.refreshRoleCache(env.guildId, { force: true });
  return env;
}

test('overview marca quem tem o cargo da escala como ESCALA e o resto como APOIO', async (t) => {
  const env = await envComEquipe(t);
  const panel = await startPanel(env);
  t.after(() => panel.close());

  const { cookie } = await panel.login();
  const response = await panel.call('/api/overview', { cookie });
  assert.equal(response.status, 200);

  const byUser = new Map(response.json.staff.map((row) => [row.userId, row]));
  assert.equal(byUser.get(ESCALA_1).group, 'ESCALA', 'cargo da escala');
  assert.equal(byUser.get(ESCALA_2).group, 'ESCALA', 'cargo da escala + outro cargo');
  assert.equal(byUser.get(APOIO).group, 'APOIO', 'sem o cargo = apoio');
  assert.equal(
    byUser.get(SEM_CARGO_NA_ESCALA).group,
    'APOIO',
    'sem o cargo continua apoio, mesmo com turno cadastrado',
  );

  assert.equal(byUser.get(ESCALA_1).onRoster, true);
  assert.equal(byUser.get(APOIO).onRoster, false);
  assert.equal(byUser.get(ESCALA_1).hasSchedule, true);
  assert.equal(byUser.get(APOIO).hasSchedule, false);
});

test('/api/overview devolve os cargos usados no agrupamento', async (t) => {
  const env = await envComEquipe(t);
  const panel = await startPanel(env);
  t.after(() => panel.close());

  const { cookie } = await panel.login();
  const response = await panel.call('/api/overview', { cookie });

  assert.deepEqual(response.json.roster.roleIds, [ROLE]);
  assert.equal(response.json.roster.synced, true, 'cache de cargos sincronizado');
});

test('sem cargo configurado, quem tem turno vai para ESCALA (fallback)', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);
  const panel = await startPanel(env);
  t.after(() => panel.close());

  member(env, ESCALA_1, [ROLE]);
  member(env, APOIO, [ROLE]);
  for (const userId of [ESCALA_1, APOIO]) {
    await env.services.staff.setStatus({
      guildId: env.guildId,
      userId,
      status: 'INDISPONIVEL',
      updatedBy: 'teste',
      manual: true,
    });
  }
  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: ESCALA_1,
    shifts: [{ weekday: 1, start: '14:00', end: '22:00' }],
  });
  await env.services.settings.set('staff_panel_role_ids', []);

  const { cookie } = await panel.login();
  const response = await panel.call('/api/overview', { cookie });
  const byUser = new Map(response.json.staff.map((row) => [row.userId, row]));

  assert.deepEqual(response.json.roster.roleIds, []);
  assert.equal(byUser.get(ESCALA_1).group, 'ESCALA', 'tem turno cadastrado');
  assert.equal(byUser.get(APOIO).group, 'APOIO', 'sem turno cadastrado');
  assert.equal(byUser.get(ESCALA_1).onRoster, null, 'sem filtro de cargo não dá para afirmar');
});

test('staff com o cargo e sem turno continua em ESCALA (falta cadastrar horário)', async (t) => {
  const env = await envComEquipe(t);
  const panel = await startPanel(env);
  t.after(() => panel.close());

  const { cookie } = await panel.login();
  const response = await panel.call('/api/overview', { cookie });
  const row = response.json.staff.find((item) => item.userId === ESCALA_2);

  assert.equal(row.group, 'ESCALA');
  assert.equal(row.hasSchedule, false, 'sem turno: o painel mostra "sem escala"');
  assert.equal(row.shifts.length, 0);
});

test('rosterIds devolve null quando o filtro de cargos não existe', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);
  await env.services.settings.set('staff_panel_role_ids', []);
  assert.equal(env.services.staff.rosterIds(env.guildId), null);
});

test('rosterIds lista apenas quem tem o cargo configurado', async (t) => {
  const env = await envComEquipe(t);
  const ids = env.services.staff.rosterIds(env.guildId);
  assert.ok(ids instanceof Set);
  assert.ok(ids.has(ESCALA_1));
  assert.ok(ids.has(ESCALA_2));
  assert.ok(!ids.has(APOIO));
  assert.ok(!ids.has(SEM_CARGO_NA_ESCALA));
});
