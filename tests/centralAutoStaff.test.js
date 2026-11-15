'use strict';

/**
 * A central segue a equipe.
 *
 * - staff fica **DISPONÍVEL** com a central fora do horário → abre na hora;
 * - o **último** staff sai de serviço → volta a seguir o horário programado;
 * - fechamento manual do administrador nunca é desfeito pela equipe;
 * - quem está **em atendimento** também segura a central aberta.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember, countDms } = require('./helpers');
const { createWebServer } = require('../src/web/server');

const STAFF = '930000000000001001';
const STAFF_B = '930000000000001002';
const PLAYER = '930000000000002001';
const PASSWORD = 'vantus';

/** Nenhum turno em nenhum dia: a agenda manda fechar. */
const CLOSED_SCHEDULE = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
/** Aberto o dia inteiro: a agenda manda abrir. */
const OPEN_SCHEDULE = {
  mon: [{ open: '00:00', close: '23:59' }],
  tue: [{ open: '00:00', close: '23:59' }],
  wed: [{ open: '00:00', close: '23:59' }],
  thu: [{ open: '00:00', close: '23:59' }],
  fri: [{ open: '00:00', close: '23:59' }],
  sat: [{ open: '00:00', close: '23:59' }],
  sun: [{ open: '00:00', close: '23:59' }],
};

async function makeEnv(t, settings = {}) {
  const env = await createTestEnv({
    staff: false,
    settings: { central_manual: 'auto', schedule: CLOSED_SCHEDULE, ...settings },
  });
  t.after(() => env.cleanup());
  return env;
}

const setStaff = (env, userId, status) =>
  env.services.staff.setStatus({
    guildId: env.guildId,
    userId,
    status,
    updatedBy: userId,
    manual: true,
  });

const isOpen = (env) => env.services.schedule.isOpen(env.guildId).open;
const events = (env) => env.services.audit.recent(env.guildId);

/* ------------------------------------------------------------------ */
/* Abrir e voltar ao horário                                           */
/* ------------------------------------------------------------------ */

test('staff fica disponível fora do horário e a central abre na hora', async (t) => {
  const env = await makeEnv(t);
  assert.equal(isOpen(env), false, 'começa fechada pelo horário');

  await setStaff(env, STAFF, 'DISPONIVEL');

  assert.equal(isOpen(env), true, 'a central abriu com o staff em serviço');
  assert.equal(env.services.settings.get('central_manual'), 'open');
  assert.equal(env.services.settings.get('central_auto_staff'), true, 'marcada como aberta pela equipe');
  assert.ok(events(env).some((event) => event.type === 'CENTRAL_OPEN_STAFF'));
  // e a fila passa a aceitar jogador
  assert.equal(env.services.engine.availability(env.guildId).available, true);
});

test('quando o último staff sai de serviço a central volta ao horário', async (t) => {
  const env = await makeEnv(t);
  await setStaff(env, STAFF, 'DISPONIVEL');
  assert.equal(isOpen(env), true);

  await setStaff(env, STAFF, 'INDISPONIVEL');

  assert.equal(isOpen(env), false, 'voltou a seguir a agenda (fechada)');
  assert.equal(env.services.settings.get('central_manual'), 'auto');
  assert.equal(env.services.settings.get('central_auto_staff'), false);
  assert.ok(events(env).some((event) => event.type === 'CENTRAL_BACK_TO_SCHEDULE'));
  assert.equal(env.services.engine.availability(env.guildId).reason, 'fechada');
});

test('com dois staff a central só fecha quando o último sai', async (t) => {
  const env = await makeEnv(t);
  await setStaff(env, STAFF, 'DISPONIVEL');
  await setStaff(env, STAFF_B, 'DISPONIVEL');

  await setStaff(env, STAFF, 'INDISPONIVEL');
  assert.equal(isOpen(env), true, 'ainda tem gente em serviço');
  assert.equal(env.services.settings.get('central_auto_staff'), true);

  await setStaff(env, STAFF_B, 'AUSENTE');
  assert.equal(isOpen(env), false);
  assert.equal(env.services.settings.get('central_manual'), 'auto');
});

test('staff em atendimento também segura a central aberta', async (t) => {
  const env = await makeEnv(t);
  await setStaff(env, STAFF, 'DISPONIVEL');
  await env.services.staff.markBusy(env.guildId, STAFF);
  assert.equal(isOpen(env), true);

  // O único staff está EM_ATENDIMENTO: nada de fechar no meio do atendimento.
  assert.equal(env.services.settings.get('central_manual'), 'open');
  assert.equal(env.services.central.onDutyStaff(env.guildId), 1);

  await env.services.staff.release(env.guildId, STAFF);
  assert.equal(isOpen(env), true, 'voltou a DISPONÍVEL, segue aberta');

  await setStaff(env, STAFF, 'INDISPONIVEL');
  assert.equal(isOpen(env), false);
});

test('voltar ao horário com a agenda aberta mantém a central aberta', async (t) => {
  const env = await makeEnv(t, { schedule: OPEN_SCHEDULE });
  // Fora do horário a central já estaria aberta: assume fechada manualmente e
  // devolve ao automático pela equipe.
  await env.services.settings.set('central_manual', 'closed');
  await setStaff(env, STAFF, 'DISPONIVEL');
  assert.equal(isOpen(env), false, 'fechamento manual não é desfeito pela equipe');

  await env.services.central.syncStaffAvailability(env.guildId);
  assert.equal(env.services.settings.get('central_manual'), 'closed');
});

/* ------------------------------------------------------------------ */
/* Limites da automação                                                */
/* ------------------------------------------------------------------ */

test('fechamento manual pelo administrador não é desfeito por staff disponível', async (t) => {
  const env = await makeEnv(t);
  await env.services.central.close({
    guildId: env.guildId,
    actorId: 'admin',
    actorTag: 'Administrador',
  });
  assert.equal(env.services.settings.get('central_manual'), 'closed');

  await setStaff(env, STAFF, 'DISPONIVEL');

  assert.equal(isOpen(env), false);
  assert.equal(env.services.settings.get('central_manual'), 'closed');
  assert.equal(env.services.settings.get('central_auto_staff'), false);
});

test('abertura manual do administrador também não é desfeita quando a equipe sai', async (t) => {
  const env = await makeEnv(t);
  await env.services.central.open({ guildId: env.guildId, actorId: 'admin', actorTag: 'Administrador' });
  await setStaff(env, STAFF, 'DISPONIVEL');
  assert.equal(env.services.settings.get('central_auto_staff'), false, 'aberta pelo admin, não pela equipe');

  await setStaff(env, STAFF, 'INDISPONIVEL');
  assert.equal(isOpen(env), true, 'o admin abriu: continua aberta');
  assert.equal(env.services.settings.get('central_manual'), 'open');
});

test('dentro do horário nada muda ao staff ficar disponível', async (t) => {
  const env = await makeEnv(t, { schedule: OPEN_SCHEDULE });
  assert.equal(isOpen(env), true);

  await setStaff(env, STAFF, 'DISPONIVEL');

  assert.equal(env.services.settings.get('central_manual'), 'auto', 'segue no automático');
  assert.equal(env.services.settings.get('central_auto_staff'), false);
  assert.equal(events(env).some((event) => event.type === 'CENTRAL_OPEN_STAFF'), false, 'sem log desnecessário');
});

test('a automação pode ser desligada nas configurações', async (t) => {
  const env = await makeEnv(t, { central_auto_open_on_staff: false });
  await setStaff(env, STAFF, 'DISPONIVEL');

  assert.equal(isOpen(env), false);
  assert.equal(env.services.settings.get('central_manual'), 'auto');
});

test('quem sai da fila esperando é avisado quando a central fecha', async (t) => {
  const env = await makeEnv(t);
  await setStaff(env, STAFF, 'DISPONIVEL');
  addMember(env.gateway, PLAYER, { voiceChannelId: env.waitChannelId, displayName: 'Jogador' });
  await env.services.queue.join({
    guildId: env.guildId,
    userId: PLAYER,
    displayName: 'Jogador',
    source: 'painel',
  });
  const before = countDms(env.gateway, PLAYER);

  await setStaff(env, STAFF, 'INDISPONIVEL');

  assert.equal(isOpen(env), false);
  assert.ok(countDms(env.gateway, PLAYER) > before, 'jogador recebeu o aviso de central fechada');
});

/* ------------------------------------------------------------------ */
/* Painel web                                                          */
/* ------------------------------------------------------------------ */

test('o painel web mostra que a central foi aberta pela equipe e devolve ao horário', async (t) => {
  const env = await makeEnv(t);
  const { server } = createWebServer({
    services: env.services,
    env: { guildId: env.guildId },
    password: PASSWORD,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const { token } = await login.json();
  const call = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };

  await setStaff(env, STAFF, 'DISPONIVEL');

  const overview = await call('/api/schedule');
  assert.equal(overview.status, 200);
  assert.equal(overview.data.centralManual, 'open');
  assert.equal(overview.data.centralAutoStaff, true);
  assert.equal(overview.data.status.open, true);
  assert.equal(overview.data.status.scheduledOpen, false);

  // "Seguir o horário" no painel devolve ao automático e limpa a marca.
  const back = await call('/api/central', { method: 'PUT', body: JSON.stringify({ state: 'auto' }) });
  assert.equal(back.status, 200);
  assert.equal(back.data.centralManual, 'auto');
  assert.equal(back.data.centralAutoStaff, false);
  assert.equal(env.services.settings.get('central_auto_staff'), false);
  assert.equal(isOpen(env), false);
});

/* ------------------------------------------------------------------ */
/* Reinício do bot                                                     */
/* ------------------------------------------------------------------ */

test('no boot a central é alinhada com quem está em serviço', async (t) => {
  const env = await makeEnv(t);
  const { startGuild } = require('../src/handlers/guildStart');

  // Cenário de reinício: banco diz "aberta pela equipe", mas ninguém está em serviço.
  await env.services.settings.setMany({ central_manual: 'open', central_auto_staff: true });
  const guild = {
    id: env.guildId,
    name: 'servidor de teste',
    channels: { fetch: async () => null },
  };
  const client = {
    user: { id: '123' },
    guilds: { cache: new Map([[env.guildId, guild]]) },
    commands: new Map(),
  };
  const context = { services: env.services, env: { autoRegisterCommands: false }, runtime: {} };
  t.after(() => {
    clearInterval(context.runtime.panelTimer);
    clearInterval(context.runtime.expireTimer);
    context.runtime.stopHourBankWatcher?.();
    context.runtime.stopScheduleBroadcastWatcher?.();
    context.runtime.stopScheduleWatcher?.();
  });

  await startGuild({ client, context, guildId: env.guildId });

  assert.equal(env.services.settings.get('central_manual'), 'auto', 'voltou a seguir o horário');
  assert.equal(env.services.settings.get('central_auto_staff'), false);
  assert.equal(isOpen(env), false);
});
