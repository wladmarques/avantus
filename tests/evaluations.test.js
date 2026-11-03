'use strict';

/**
 * Avaliações: envio ao jogador, canal de avaliações e dados do painel web.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv, addMember, addStaffInVoice } = require('./helpers');

const PLAYER = '900000000000001001';
const STAFF = '900000000000000900';
const EVAL_CHANNEL = '1560793933750210582';

/** Chama o jogador, finaliza o atendimento e devolve o atendimento encerrado. */
async function finishedAttendance(env, { player = PLAYER, staff = STAFF } = {}) {
  addMember(env.gateway, player, { voiceChannelId: env.waitChannelId, displayName: 'Jogador Teste' });
  addStaffInVoice(env.gateway, staff);
  await env.services.queue.join({ guildId: env.guildId, userId: player, displayName: 'Jogador Teste' });
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

test('ao finalizar, o jogador recebe a DM com os 4 botões de nota', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const attendance = await finishedAttendance(env);
  const dm = env.gateway.dms.filter((entry) => entry.userId === PLAYER).at(-1);

  assert.ok(dm, 'DM enviada ao jogador');
  const embed = dm.payload.embeds[0];
  assert.match(embed.title, /Como foi seu atendimento/);
  assert.match(embed.description, new RegExp(`#${String(attendance.protocol).padStart(4, '0')}`));

  const buttons = dm.payload.components[0].components;
  assert.equal(buttons.length, 4);
  assert.deepEqual(
    buttons.map((button) => button.custom_id),
    [
      `eval:${attendance.id}:MUITO_BOM`,
      `eval:${attendance.id}:BOM`,
      `eval:${attendance.id}:REGULAR`,
      `eval:${attendance.id}:RUIM`,
    ],
  );
});

test('clique na nota grava a avaliação e publica no canal configurado', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const attendance = await finishedAttendance(env);
  await env.services.settings.set('evaluation_channel_id', EVAL_CHANNEL);

  const saved = await env.services.evaluations.submit({
    guildId: env.guildId,
    userId: PLAYER,
    attendanceId: attendance.id,
    rating: 'BOM',
  });

  assert.equal(saved.rating, 'BOM');
  assert.equal(saved.staff_id, STAFF);

  const published = env.gateway.channelMessages.filter((item) => item.channelId === EVAL_CHANNEL);
  assert.equal(published.length, 1, 'uma mensagem no canal de avaliações');
  const description = published[0].payload.embeds[0].description;
  assert.match(description, /Nota:\*\* Bom · 3\/4/);
  assert.match(description, new RegExp(`#${String(attendance.protocol).padStart(4, '0')}`));
  assert.match(description, new RegExp(`<@${PLAYER}>`));
  assert.match(description, new RegExp(`<@${STAFF}>`));

  // O log administrativo continua separado (canal de logs, não o de avaliações).
  const logs = env.gateway.channelMessages.filter((item) => item.channelId === env.gateway.settings.get('log_channel_id'));
  assert.ok(logs.some((item) => /avaliou o atendimento/.test(item.payload.embeds[0].description)));
});

test('sem canal configurado a avaliação é salva sem publicar', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const attendance = await finishedAttendance(env);
  await env.services.evaluations.submit({
    guildId: env.guildId,
    userId: PLAYER,
    attendanceId: attendance.id,
    rating: 'RUIM',
  });

  assert.equal(env.gateway.channelMessages.filter((item) => item.channelId === EVAL_CHANNEL).length, 0);
  assert.equal(env.services.evaluations.list(env.guildId, { from: 0, to: Date.now() + 1 }).length, 1);
});

test('canal de avaliações inválido é recusado', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await assert.rejects(() => env.services.evaluations.setChannelId('abc'), /ID de canal inválido/);
  assert.equal(await env.services.evaluations.setChannelId(EVAL_CHANNEL), EVAL_CHANNEL);
  assert.equal(env.services.evaluations.channelId, EVAL_CHANNEL);
  assert.equal(await env.services.evaluations.setChannelId(''), null);
  assert.equal(env.services.evaluations.channelId, null);
});

test('jogador não avalia duas vezes nem o atendimento de outra pessoa', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const attendance = await finishedAttendance(env);
  await env.services.evaluations.submit({
    guildId: env.guildId,
    userId: PLAYER,
    attendanceId: attendance.id,
    rating: 'MUITO_BOM',
  });

  await assert.rejects(
    () =>
      env.services.evaluations.submit({
        guildId: env.guildId,
        userId: PLAYER,
        attendanceId: attendance.id,
        rating: 'RUIM',
      }),
    /já avaliou este atendimento/,
  );

  await assert.rejects(
    () =>
      env.services.evaluations.submit({
        guildId: env.guildId,
        userId: '999999999999999999',
        attendanceId: attendance.id,
        rating: 'RUIM',
      }),
    /não pertence a você/,
  );
});

test('/avaliar funciona pelo protocolo (fallback quando a DM está fechada)', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const attendance = await finishedAttendance(env);
  await env.services.settings.set('evaluation_channel_id', EVAL_CHANNEL);

  const command = require('../src/commands/player/avaliar');
  const replies = [];
  const interaction = {
    guildId: env.guildId,
    user: { id: PLAYER },
    replied: false,
    deferred: false,
    reply: async (payload) => replies.push(payload),
    options: {
      getInteger: (name) => (name === 'protocolo' ? attendance.protocol : null),
      getString: (name) => (name === 'nota' ? 'REGULAR' : null),
    },
  };

  await command.execute({ interaction, services: env.services });

  assert.equal(replies.length, 1, 'respondeu ao jogador');
  assert.equal(replies[0].flags, 64, 'resposta efêmera');
  assert.match(replies[0].embeds[0].description, /Regular/);

  const entries = env.services.evaluations.list(env.guildId, { from: 0, to: Date.now() + 1 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].rating, 'REGULAR');
  assert.equal(
    env.gateway.channelMessages.filter((item) => item.channelId === EVAL_CHANNEL).length,
    1,
    'também publica no canal de avaliações',
  );
});

test('protocolo de outro jogador é recusado', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const attendance = await finishedAttendance(env);
  await assert.rejects(
    () =>
      env.services.evaluations.submitByProtocol({
        guildId: env.guildId,
        userId: '999999999999999999',
        protocol: attendance.protocol,
        rating: 'BOM',
      }),
    /não pertence a você/,
  );
});

test('stats do painel: média, distribuição, positivas e ranking por staff', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const first = await finishedAttendance(env, { player: PLAYER });
  await env.services.evaluations.submit({
    guildId: env.guildId,
    userId: PLAYER,
    attendanceId: first.id,
    rating: 'MUITO_BOM',
  });

  const second = await finishedAttendance(env, { player: '900000000000001002' });
  await env.services.evaluations.submit({
    guildId: env.guildId,
    userId: '900000000000001002',
    attendanceId: second.id,
    rating: 'RUIM',
  });

  const stats = env.services.evaluations.stats(env.guildId, { from: 0, to: Date.now() + 1000 });
  assert.equal(stats.total, 2);
  assert.equal(stats.average, 2.5, '(4 + 1) / 2');
  assert.equal(stats.positiveRate, 50);
  assert.deepEqual(stats.byRating, { MUITO_BOM: 1, BOM: 0, REGULAR: 0, RUIM: 1 });
  assert.equal(stats.byStaff.length, 1);
  assert.equal(stats.byStaff[0].average, 2.5);
  assert.equal(stats.byStaff[0].total, 2);
});

/* ------------------------------------------------------------------ */
/* Filtro por atendente                                                */
/* ------------------------------------------------------------------ */

test('list e stats filtram por atendente sem perder o ranking', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  const OTHER_STAFF = '900000000000000901';
  const first = await finishedAttendance(env, { player: PLAYER });
  await env.services.evaluations.submit({
    guildId: env.guildId,
    userId: PLAYER,
    attendanceId: first.id,
    rating: 'MUITO_BOM',
  });
  const second = await finishedAttendance(env, { player: '900000000000001003', staff: OTHER_STAFF });
  await env.services.evaluations.submit({
    guildId: env.guildId,
    userId: '900000000000001003',
    attendanceId: second.id,
    rating: 'RUIM',
  });

  const range = { from: 0, to: Date.now() + 1000 };
  assert.equal(env.services.evaluations.list(env.guildId, range).length, 2);

  const onlyStaff = env.services.evaluations.list(env.guildId, { ...range, staffId: STAFF });
  assert.equal(onlyStaff.length, 1);
  assert.equal(onlyStaff[0].staff_id, STAFF);

  const stats = env.services.evaluations.stats(env.guildId, { ...range, staffId: STAFF });
  assert.equal(stats.total, 1);
  assert.equal(stats.average, 4);
  assert.equal(stats.byStaff.length, 2, 'ranking continua com os dois atendentes');

  const empty = env.services.evaluations.stats(env.guildId, { ...range, staffId: '999999999999999999' });
  assert.equal(empty.total, 0);
  assert.equal(empty.average, null);
});

/* ------------------------------------------------------------------ */
/* Aviso de média baixa                                               */
/* ------------------------------------------------------------------ */

test('aviso de média baixa é publicado uma vez por semana no canal', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await env.services.settings.set('evaluation_channel_id', EVAL_CHANNEL);
  await env.services.settings.set('evaluations_alert_min_average', 3);
  await env.services.settings.set('evaluations_alert_min_sample', 2);

  const first = await finishedAttendance(env, { player: PLAYER });
  await env.services.evaluations.submit({
    guildId: env.guildId,
    userId: PLAYER,
    attendanceId: first.id,
    rating: 'RUIM',
  });
  // 1 avaliação: abaixo da amostra mínima (2) → nenhum aviso ainda.
  assert.equal(
    env.gateway.channelMessages.filter((item) => /abaixo do esperado/.test(item.payload.embeds[0].title)).length,
    0,
  );

  const second = await finishedAttendance(env, { player: '900000000000001004' });
  await env.services.evaluations.submit({
    guildId: env.guildId,
    userId: '900000000000001004',
    attendanceId: second.id,
    rating: 'REGULAR',
  });

  const alerts = env.gateway.channelMessages.filter((item) =>
    /Média das avaliações abaixo/.test(item.payload.embeds[0].title),
  );
  assert.equal(alerts.length, 1, 'aviso publicado');
  assert.match(alerts[0].payload.embeds[0].description, /1\.50\/4/);
  assert.equal(alerts[0].channelId, EVAL_CHANNEL);

  // Nova avaliação ruim na mesma semana não repete o aviso.
  const third = await finishedAttendance(env, { player: '900000000000001005' });
  await env.services.evaluations.submit({
    guildId: env.guildId,
    userId: '900000000000001005',
    attendanceId: third.id,
    rating: 'RUIM',
  });
  assert.equal(
    env.gateway.channelMessages.filter((item) => /Média das avaliações abaixo/.test(item.payload.embeds[0].title))
      .length,
    1,
    'no máximo um aviso por semana',
  );
});

test('sem limite configurado (ou média boa) nenhum aviso é enviado', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await env.services.settings.set('evaluation_channel_id', EVAL_CHANNEL);
  await env.services.settings.set('evaluations_alert_min_sample', 1);

  const only = await finishedAttendance(env, { player: PLAYER });
  await env.services.evaluations.submit({
    guildId: env.guildId,
    userId: PLAYER,
    attendanceId: only.id,
    rating: 'RUIM',
  });
  assert.equal(
    env.gateway.channelMessages.filter((item) => /Média das avaliações abaixo/.test(item.payload.embeds[0].title))
      .length,
    0,
    'limite 0 = desligado',
  );

  await env.services.settings.set('evaluations_alert_min_average', 2);
  const ok = await finishedAttendance(env, { player: '900000000000001006' });
  await env.services.evaluations.submit({
    guildId: env.guildId,
    userId: '900000000000001006',
    attendanceId: ok.id,
    rating: 'MUITO_BOM',
  });
  // média (1 + 4) / 2 = 2.5 ≥ 2 → sem aviso
  assert.equal(
    env.gateway.channelMessages.filter((item) => /Média das avaliações abaixo/.test(item.payload.embeds[0].title))
      .length,
    0,
  );
});
