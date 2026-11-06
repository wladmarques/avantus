'use strict';

/**
 * Painel web: bloquear o staff de entrar em serviço e removê-lo da equipe.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addStaffInVoice, panelText } = require('./helpers');
const { createWebServer } = require('../src/web/server');

const PASSWORD = 'senha-de-teste';
const STAFF = '960000000000002001';
const OTHER = '960000000000002002';

async function startPanel(env) {
  const { server } = createWebServer({
    services: env.services,
    env: { timezone: 'America/Sao_Paulo', guildId: env.guildId },
    password: PASSWORD,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const login = async () => {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    return { cookie: String(response.headers.get('set-cookie') || '').split(';')[0] };
  };

  const call = async (pathname, { method = 'GET', body, cookie } = {}) => {
    const response = await fetch(`${base}${pathname}`, {
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
    return { status: response.status, json };
  };

  return { call, login, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Staff disponível, com sessão do banco de horas aberta e na call de atendimento. */
async function staffOnDuty(env, userId = STAFF) {
  await addStaffInVoice(env, userId);
  env.gateway.members.set(userId, {
    inGuild: true,
    voiceChannelId: env.attendanceChannelId ?? env.gateway.attendanceChannelId ?? null,
    displayName: `Staff ${userId}`,
    staffRoles: [],
  });
  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId,
    status: 'DISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });
  await env.services.hourBank.syncStatus({ guildId: env.guildId, userId, status: 'DISPONIVEL' });
  return env.services.staff.get(env.guildId, userId);
}

test('bloquear: staff sai de serviço e não consegue voltar pelo /status', async (t) => {
  const env = await createTestEnv({ staff: false });
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  await staffOnDuty(env);
  assert.ok(env.services.hourBank.activeSession(env.guildId, STAFF), 'sessão aberta antes');

  const { cookie } = await panel.login();
  const blocked = await panel.call(`/api/staff/${STAFF}/block`, {
    method: 'PUT',
    cookie,
    body: { blocked: true, reason: 'conduta' },
  });

  assert.equal(blocked.status, 200);
  assert.equal(blocked.json.blocked, true);
  assert.ok(blocked.json.endedSession, 'sessão encerrada');

  const staff = env.services.staff.get(env.guildId, STAFF);
  assert.equal(staff.blocked, true);
  assert.equal(staff.status, 'INDISPONIVEL', 'saiu de serviço');
  assert.equal(staff.blockedReason, 'conduta');
  assert.equal(env.services.hourBank.activeSession(env.guildId, STAFF), null, 'sessão fechada');

  // O próprio staff não consegue mais ficar disponível.
  await assert.rejects(
    () =>
      env.services.staff.setStatus({
        guildId: env.guildId,
        userId: STAFF,
        status: 'DISPONIVEL',
        updatedBy: STAFF,
        manual: true,
      }),
    (error) => {
      assert.equal(error.code, 'STAFF_BLOQUEADO');
      assert.match(error.userMessage, /bloqueado/i);
      return true;
    },
  );
  assert.equal(env.services.staff.get(env.guildId, STAFF).status, 'INDISPONIVEL');

  // Também não é liberado automaticamente ao finalizar atendimento.
  await env.services.staff.markBusy(env.guildId, STAFF);
  await env.services.staff.release(env.guildId, STAFF);
  assert.equal(env.services.staff.get(env.guildId, STAFF).status, 'INDISPONIVEL', 'release respeita o bloqueio');

  // Aviso ao staff por DM.
  const dm = env.gateway.dms.filter((entry) => entry.userId === STAFF).at(-1);
  assert.ok(dm, 'staff avisado por DM');
  assert.match(JSON.stringify(dm.payload), /bloqueado/i);
});

test('bloqueado não entra em serviço ao entrar no canal de atendimento', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  await staffOnDuty(env);
  await env.services.staff.setBlocked(env.guildId, STAFF, { blocked: true, by: 'teste' });
  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'INDISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });

  const channelId = env.services.settings.get('attendance_channel_ids')[0];
  await env.services.attendance.handleStaffVoiceUpdate({
    guildId: env.guildId,
    userId: STAFF,
    channelId,
    attendanceChannelIds: [channelId],
  });

  assert.equal(
    env.services.staff.get(env.guildId, STAFF).status,
    'INDISPONIVEL',
    'continua indisponível mesmo na call de atendimento',
  );
});

test('desbloquear devolve o direito de entrar em serviço', async (t) => {
  const env = await createTestEnv({ staff: false });
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  await staffOnDuty(env);
  await env.services.staff.setBlocked(env.guildId, STAFF, { blocked: true, by: 'teste' });
  const { cookie } = await panel.login();

  const unblocked = await panel.call(`/api/staff/${STAFF}/block`, {
    method: 'PUT',
    cookie,
    body: { blocked: false },
  });

  assert.equal(unblocked.status, 200);
  assert.equal(unblocked.json.blocked, false);
  assert.equal(env.services.staff.isBlocked(env.guildId, STAFF), false);

  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'DISPONIVEL',
    updatedBy: STAFF,
    manual: true,
  });
  assert.equal(env.services.staff.get(env.guildId, STAFF).status, 'DISPONIVEL');
});

test('o overview do painel mostra o bloqueio e o motivo', async (t) => {
  const env = await createTestEnv({ staff: false });
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  await staffOnDuty(env);
  const { cookie } = await panel.login();
  await panel.call(`/api/staff/${STAFF}/block`, {
    method: 'PUT',
    cookie,
    body: { blocked: true, reason: 'advertência' },
  });

  const overview = await panel.call('/api/overview', { cookie });
  const row = overview.json.staff.find((item) => item.userId === STAFF);
  assert.ok(row, 'staff continua na equipe');
  assert.equal(row.blocked, true);
  assert.equal(row.blockedReason, 'advertência');
});

test('remover: apaga cadastro, nome e escala e mantém o histórico', async (t) => {
  const env = await createTestEnv({ staff: false });
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  await staffOnDuty(env);
  await env.services.hourBank.setDisplayName({
    guildId: env.guildId,
    userId: STAFF,
    staffName: 'conde',
  });
  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF,
    staffName: 'conde',
    shifts: [{ weekday: 1, start: '12:00', end: '18:00' }],
  });
  const sessionsBefore = env.services.db.all(
    'SELECT * FROM staff_sessions WHERE guild_id = ? AND user_id = ?',
    [env.guildId, STAFF],
  );

  const { cookie } = await panel.login();
  const removed = await panel.call(`/api/staff/${STAFF}`, { method: 'DELETE', cookie });

  assert.equal(removed.status, 200);
  assert.equal(removed.json.ok, true);
  assert.equal(removed.json.staffName, 'conde');

  assert.equal(env.services.staff.get(env.guildId, STAFF).status, 'INDISPONIVEL', 'sem cadastro');
  assert.equal(
    env.services.staff.list(env.guildId).some((row) => row.userId === STAFF),
    false,
    'saiu da lista do painel',
  );
  assert.equal(env.services.hourBank.listShifts(env.guildId, STAFF).length, 0, 'escala removida');
  assert.equal(env.services.hourBank.names(env.guildId).has(STAFF), false, 'nome removido');

  const overview = await panel.call('/api/overview', { cookie });
  assert.equal(
    overview.json.staff.some((item) => item.userId === STAFF),
    false,
    'não aparece mais na equipe',
  );

  // Histórico preservado.
  const sessionsAfter = env.services.db.all(
    'SELECT * FROM staff_sessions WHERE guild_id = ? AND user_id = ?',
    [env.guildId, STAFF],
  );
  assert.equal(sessionsAfter.length, sessionsBefore.length, 'sessões mantidas para o relatório');

  // Auditoria.
  const logs = env.gateway.channelMessages.filter(
    (item) => item.channelId === env.services.settings.get('log_channel_id'),
  );
  assert.ok(logs.some((item) => /removeu .* da equipe/i.test(item.payload.embeds[0].description)));
});

test('não dá para remover nem bloquear quem está atendendo (409)', async (t) => {
  const env = await createTestEnv({ staff: false });
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  await staffOnDuty(env);
  const player = '960000000000002900';
  env.gateway.members.set(player, { inGuild: true, voiceChannelId: env.waitChannelId });
  await env.services.queue.join({ guildId: env.guildId, userId: player, displayName: 'Jogador' });
  await env.services.attendance.callNext({
    guildId: env.guildId,
    staffId: STAFF,
    staffTag: 'Staff Teste',
  });

  const { cookie } = await panel.login();
  const block = await panel.call(`/api/staff/${STAFF}/block`, {
    method: 'PUT',
    cookie,
    body: { blocked: true },
  });
  assert.equal(block.status, 409);
  assert.equal(block.json.code, 'EM_ATENDIMENTO');
  assert.equal(env.services.staff.isBlocked(env.guildId, STAFF), false, 'nada foi bloqueado');

  const remove = await panel.call(`/api/staff/${STAFF}`, { method: 'DELETE', cookie });
  assert.equal(remove.status, 409);
  assert.ok(env.services.staff.list(env.guildId).some((row) => row.userId === STAFF), 'continua na equipe');
});

test('rotas exigem login e validam o staff', async (t) => {
  const env = await createTestEnv({ staff: false });
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  assert.equal(
    (await panel.call(`/api/staff/${STAFF}/block`, { method: 'PUT', body: { blocked: true } })).status,
    401,
  );
  assert.equal((await panel.call(`/api/staff/${STAFF}`, { method: 'DELETE' })).status, 401);

  const { cookie } = await panel.login();
  const unknown = await panel.call(`/api/staff/${OTHER}/block`, {
    method: 'PUT',
    cookie,
    body: { blocked: true },
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /não encontrado/i);
});

test('staff bloqueado aparece como BLOQUEADO no painel do Discord', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  await staffOnDuty(env);
  await env.services.staff.setBlocked(env.guildId, STAFF, { blocked: true, by: 'painel web' });

  const { payload } = env.services.panels.buildPayload(env.guildId, 'staff');
  const text = panelText(payload);
  const team = text.split('**EQUIPE**')[1];
  assert.match(team, new RegExp(`<@${STAFF}>`), 'staff continua listado');
  assert.match(team, /BLOQUEADO/, 'painel indica o bloqueio');
  assert.ok(!/DISPONÍVEL/.test(team), 'não aparece como disponível');
});

test('status em massa e recuperação não promovem staff bloqueado', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  await staffOnDuty(env);
  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: OTHER,
    status: 'INDISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });
  await env.services.staff.setBlocked(env.guildId, STAFF, { blocked: true, by: 'painel web' });
  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF,
    status: 'INDISPONIVEL',
    updatedBy: 'painel web',
    manual: true,
  });
  env.services.db.run(
    "UPDATE staff_status SET status = 'INDISPONIVEL' WHERE guild_id = ? AND user_id = ?",
    [env.guildId, STAFF],
  );

  // "Todos disponíveis" (comando administrativo) não quebra o bloqueio.
  await env.services.staff.setManualStatusForAll(env.guildId, 'DISPONIVEL', 'admin');
  assert.equal(env.services.staff.get(env.guildId, STAFF).blocked, true);
  assert.equal(
    env.services.staff.get(env.guildId, STAFF).status,
    'INDISPONIVEL',
    'bloqueado continua fora de serviço',
  );
  assert.equal(env.services.staff.get(env.guildId, OTHER).status, 'DISPONIVEL', 'demais liberados');

  // Recuperação: staff bloqueado preso em EM_ATENDIMENTO volta para indisponível.
  env.services.db.run('UPDATE staff_status SET status = ? WHERE guild_id = ? AND user_id = ?', [
    'EM_ATENDIMENTO',
    env.guildId,
    STAFF,
  ]);
  await env.services.attendance.recover(env.guildId);
  const after = env.services.staff.get(env.guildId, STAFF);
  assert.equal(after.status, 'INDISPONIVEL');
  assert.equal(after.blocked, true, 'o bloqueio é preservado');
});

test('o painel web tem os controles de bloquear e remover', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { PUBLIC_DIR } = require('../src/web/server');
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');

  for (const id of [
    'block-modal',
    'block-form',
    'block-reason',
    'block-confirm',
    'remove-modal',
    'remove-form',
    'remove-confirm',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `HTML contém #${id}`);
    assert.match(app, new RegExp(`'${id}'`), `app.js usa #${id}`);
  }

  assert.match(app, /\/block`/, 'chama a rota de bloqueio');
  assert.match(app, /method: 'DELETE'/, 'chama a rota de remoção');
  assert.match(app, /Bloquear/, 'botão de bloquear');
  assert.match(app, /Remover/, 'botão de remover');
});
