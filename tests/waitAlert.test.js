'use strict';

/**
 * Aviso de espera longa: jogador parado na sala de aguardando além de
 * `wait_alert_minutes` (padrão 3) dispara uma DM para cada staff disponível.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember, DEFAULT_STAFF } = require('./helpers');

const PLAYER = '900000000000009701';
const PLAYER_2 = '900000000000009702';
const STAFF_2 = '910000000000009702';
const STAFF_OFF = '910000000000009703';

/** Entra na fila e "envelhece" o registro (simula minutos de espera). */
async function joinWaiting(env, userId, minutesAgo = 0) {
  addMember(env.gateway, userId, { voiceChannelId: env.waitChannelId, displayName: `Jogador ${userId}` });
  const joined = await env.services.queue.join({
    guildId: env.guildId,
    userId,
    displayName: `Jogador ${userId}`,
  });
  const attendanceId = joined.attendance.id;
  if (minutesAgo > 0) {
    env.db.run('UPDATE attendance SET joined_at = ? WHERE id = ?', [
      Date.now() - minutesAgo * 60000,
      attendanceId,
    ]);
  }
  return joined.attendance;
}

const dmsTo = (env, userId) => env.gateway.dms.filter((dm) => dm.userId === userId);
/** DMs enviadas à equipe (o jogador também recebe DM de confirmação da fila). */
const staffDms = (env) =>
  env.gateway.dms.filter((dm) => [DEFAULT_STAFF, STAFF_2, STAFF_OFF].includes(dm.userId));

test('ninguém esperando: nenhuma DM', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const result = await env.services.attendance.checkWaitAlerts(env.guildId);
  assert.deepEqual(result.alerted, []);
  assert.equal(staffDms(env).length, 0);
});

test('espera abaixo de 3 minutos não avisa', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await joinWaiting(env, PLAYER, 2);
  const result = await env.services.attendance.checkWaitAlerts(env.guildId);
  assert.equal(result.alerted.length, 0);
  assert.equal(staffDms(env).length, 0);
});

test('depois de 3 minutos o staff disponível recebe DM com protocolo e tempo', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const joined = await joinWaiting(env, PLAYER, 4);
  const result = await env.services.attendance.checkWaitAlerts(env.guildId);

  assert.equal(result.notified, 1);
  assert.deepEqual(result.alerted, [joined.protocol]);

  const dms = dmsTo(env, DEFAULT_STAFF);
  assert.equal(dms.length, 1, 'uma DM para o staff em serviço');
  const embed = dms[0].payload.embeds[0];
  assert.match(embed.description, /sala de aguardando/i);
  assert.match(embed.description, /3 minuto/);
  assert.ok(embed.description.includes(`#${String(joined.protocol).padStart(4, '0')}`));
  assert.match(embed.description, /Jogador/);
});

test('não repete a DM a cada verificação (marca o aviso no registro)', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await joinWaiting(env, PLAYER, 5);
  await env.services.attendance.checkWaitAlerts(env.guildId);
  assert.equal(staffDms(env).length, 1);

  await env.services.attendance.checkWaitAlerts(env.guildId);
  await env.services.attendance.checkWaitAlerts(env.guildId);
  assert.equal(staffDms(env).length, 1, 'DM única por jogador');

  const row = env.services.repositories.attendance.listWaitingSync(env.guildId)[0];
  assert.ok(row.wait_alert_at > 0, 'aviso registrado no banco (sobrevive a reinício)');
});

test('staff fora de serviço, ausente ou bloqueado não recebe DM', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await joinWaiting(env, PLAYER, 10);

  // Depois da entrada na fila, a equipe sai de serviço.
  for (const [userId, status] of [
    [DEFAULT_STAFF, 'EM_ATENDIMENTO'],
    [STAFF_2, 'AUSENTE'],
    [STAFF_OFF, 'INDISPONIVEL'],
  ]) {
    await env.services.staff.setStatus({
      guildId: env.guildId,
      userId,
      status,
      updatedBy: 'teste',
      manual: true,
    });
  }
  await env.services.staff.setBlocked(env.guildId, STAFF_OFF, { blocked: true, reason: 'teste' });

  const result = await env.services.attendance.checkWaitAlerts(env.guildId);
  assert.equal(result.notified, 0);
  assert.equal(staffDms(env).length, 0);
});

test('staff bloqueado não é avisado mesmo se ficar disponível depois', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: DEFAULT_STAFF,
    status: 'DISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });
  await joinWaiting(env, PLAYER, 10);
  await env.services.staff.setBlocked(env.guildId, DEFAULT_STAFF, { blocked: true, reason: 'teste' });

  const result = await env.services.attendance.checkWaitAlerts(env.guildId);
  assert.equal(result.notified, 0);
  assert.equal(staffDms(env).length, 0);
});

test('uma DM por staff, com todos os jogadores atrasados juntos', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId: STAFF_2,
    status: 'DISPONIVEL',
    updatedBy: 'teste',
    manual: true,
  });

  await joinWaiting(env, PLAYER, 6);
  await joinWaiting(env, PLAYER_2, 4);

  const result = await env.services.attendance.checkWaitAlerts(env.guildId);
  assert.equal(result.alerted.length, 2);
  assert.equal(result.notified, 2, 'dois staffs em serviço');

  for (const staffId of [DEFAULT_STAFF, STAFF_2]) {
    const dms = dmsTo(env, staffId);
    assert.equal(dms.length, 1, `uma DM só para ${staffId}`);
    const text = dms[0].payload.embeds[0].description;
    assert.equal((text.match(/#00\d\d/g) || []).length, 2, 'os dois protocolos na mesma DM');
  }
});

test('wait_alert_minutes = 0 desliga o aviso', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await env.services.settings.set('wait_alert_minutes', 0);
  await joinWaiting(env, PLAYER, 30);

  const result = await env.services.attendance.checkWaitAlerts(env.guildId);
  assert.deepEqual(result.alerted, []);
  assert.equal(staffDms(env).length, 0);
});

test('o limite é configurável (5 minutos não avisa com 4)', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await env.services.settings.set('wait_alert_minutes', 5);
  await joinWaiting(env, PLAYER, 4);
  assert.equal(staffDms(env).length, 0);

  env.db.run('UPDATE attendance SET joined_at = ? WHERE id = ?', [
    Date.now() - 6 * 60000,
    env.services.repositories.attendance.listWaitingSync(env.guildId)[0].id,
  ]);
  const result = await env.services.attendance.checkWaitAlerts(env.guildId);
  assert.equal(result.notified, 1);
});

test('o aviso também fica registrado no canal de logs', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await joinWaiting(env, PLAYER, 5);
  await env.services.attendance.checkWaitAlerts(env.guildId);

  const logs = env.services.repositories.audit.listRecentSync(env.guildId, { limit: 20 });
  const alert = logs.find((row) => row.type === 'WAIT_ALERT');
  assert.ok(alert, 'auditoria WAIT_ALERT gravada');
});
