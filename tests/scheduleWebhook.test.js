'use strict';

/**
 * Escala da semana publicada por webhook: montagem da mensagem
 * (minimalista, sem emojis, paleta VANTUS) e envio HTTP.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { createTestEnv } = require('./helpers');
const {
  SETTING_KEY,
  isValidWebhookUrl,
  getWebhookUrl,
  setWebhookUrl,
  weekWindow,
  buildWeeklySchedule,
  postWebhook,
  sendWeeklySchedule,
} = require('../src/systems/hourbank/scheduleBroadcast');
const { PALETTE } = require('../src/config/theme');

const STAFF_A = '970000000000001001';
const STAFF_B = '970000000000001002';
// Emoji/dingbat: a mensagem da escala não deve ter nenhum.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u;

async function withSchedule(env) {
  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF_A,
    staffName: 'pedrosa17',
    shifts: [
      { weekday: 1, start: '12:00', end: '18:00' },
      { weekday: 3, start: '22:00', end: '02:00' },
      { weekday: 0, start: '09:00', end: '13:00' },
    ],
  });
  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF_B,
    staffName: 'gabriel_tt',
    shifts: [{ weekday: 1, start: '08:00', end: '12:00' }],
  });
}

test('webhook: validação do endereço do Discord', async (t) => {
  assert.equal(isValidWebhookUrl('https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789'), true);
  assert.equal(isValidWebhookUrl('https://discordapp.com/api/webhooks/1234567890/abcdefghijklmnopqrstuvwxyz'), true);
  assert.equal(isValidWebhookUrl('https://canary.discord.com/api/v10/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz'), true);
  assert.equal(isValidWebhookUrl('http://discord.com/api/webhooks/1/abc'), false, 'exige https');
  assert.equal(isValidWebhookUrl('https://exemplo.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(isValidWebhookUrl('https://discord.com/api/webhooks/123/curto'), false);
  assert.equal(isValidWebhookUrl(''), false);
  assert.equal(isValidWebhookUrl(null), false);

  const env = await createTestEnv();
  t.after(env.cleanup);

  await assert.rejects(
    () => setWebhookUrl(env.services.settings, 'https://exemplo.com/hook'),
    /Webhook inválido/,
  );
  const saved = await setWebhookUrl(
    env.services.settings,
    '  https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789  ',
  );
  assert.equal(saved.startsWith('https://discord.com/api/webhooks/'), true, 'grava sem espaços');
  assert.equal(getWebhookUrl(env.services.settings), saved);
  await setWebhookUrl(env.services.settings, '');
  assert.equal(getWebhookUrl(env.services.settings), '', 'string vazia desliga o webhook');
});

test('escala da semana: segunda a domingo, sem emojis e nas cores da VANTUS', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  await withSchedule(env);

  // Quinta-feira 15/01/2026 10:00 (fuso do bot = America/Sao_Paulo).
  const now = Date.UTC(2026, 0, 15, 13, 0, 0);
  const built = buildWeeklySchedule({
    hourBank: env.services.hourBank,
    guildId: env.guildId,
    timeZone: 'America/Sao_Paulo',
    now,
  });

  assert.equal(built.week.startKey, '2026-01-12', 'semana começa na segunda');
  assert.equal(built.week.endKey, '2026-01-18', 'e termina no domingo');
  assert.equal(built.staffCount, 2);
  assert.equal(built.shiftCount, 4);

  const [embed] = built.payload.embeds;
  assert.equal(embed.title, 'ESCALA DA SEMANA');
  assert.equal(embed.color, PALETTE.RED, 'destaque vermelho #ff2200');
  assert.match(embed.description, /12\/01 a 18\/01/);
  assert.equal(embed.footer.text, 'VANTUS • Banco de horas');
  assert.equal(built.payload.allowed_mentions.parse.length, 0, 'sem pingar ninguém');

  // Sete dias, na ordem da semana.
  assert.equal(embed.fields.length, 7);
  assert.deepEqual(
    embed.fields.map((field) => field.name.split(' · ')[0]),
    ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'],
  );
  assert.equal(embed.fields[0].name, 'Segunda · 12/01');
  assert.equal(embed.fields[6].name, 'Domingo · 18/01');

  // Ordenado por horário de início, nome — e sem emoji em lugar nenhum.
  assert.equal(embed.fields[0].value, 'gabriel_tt — 08:00–12:00\npedrosa17 — 12:00–18:00');
  assert.equal(embed.fields[1].value, '—', 'dia sem escala');
  assert.equal(embed.fields[2].value, 'pedrosa17 — 22:00–02:00 (+1 dia)', 'turno que vira o dia');
  assert.equal(embed.fields[6].value, 'pedrosa17 — 09:00–13:00');
  assert.equal(EMOJI.test(JSON.stringify(embed)), false, 'mensagem sem emojis');
});

test('escala da semana usa o nome definido no painel e a menção quando não há nome', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF_A,
    shifts: [{ weekday: 2, start: '10:00', end: '14:00' }],
  });
  await env.services.hourBank.setDisplayName({
    guildId: env.guildId,
    userId: STAFF_A,
    staffName: 'mika',
  });

  const built = buildWeeklySchedule({
    hourBank: env.services.hourBank,
    guildId: env.guildId,
    timeZone: 'America/Sao_Paulo',
    now: Date.UTC(2026, 0, 15, 13, 0, 0),
  });
  const tuesday = built.payload.embeds[0].fields[1];
  assert.equal(tuesday.value, 'mika — 10:00–14:00');

  await env.services.hourBank.setDisplayName({ guildId: env.guildId, userId: STAFF_A, staffName: '' });
  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF_A,
    shifts: [{ weekday: 2, start: '10:00', end: '14:00' }],
  });
  const withoutName = buildWeeklySchedule({
    hourBank: env.services.hourBank,
    guildId: env.guildId,
    timeZone: 'America/Sao_Paulo',
    now: Date.UTC(2026, 0, 15, 13, 0, 0),
  });
  assert.match(
    withoutName.payload.embeds[0].fields[1].value,
    new RegExp(`^<@${STAFF_A}> — 10:00–14:00$`),
    'sem nome, menciona o usuário (sem pingar)',
  );
});

test('weekWindow sempre devolve segunda → domingo', async () => {
  const monday = weekWindow(Date.UTC(2026, 0, 12, 15, 0, 0), 'America/Sao_Paulo');
  assert.equal(monday.days[0].key, '2026-01-12');
  const sunday = weekWindow(Date.UTC(2026, 0, 18, 15, 0, 0), 'America/Sao_Paulo');
  assert.equal(sunday.days[0].key, '2026-01-12', 'domingo ainda pertence à semana que começou na segunda');
  assert.equal(sunday.days[6].key, '2026-01-18');
});

test('envio: sem webhook ou com endereço inválido explica o problema', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await assert.rejects(
    () => sendWeeklySchedule({ settings: env.services.settings, hourBank: env.services.hourBank, guildId: env.guildId }),
    /Nenhum webhook cadastrado/,
  );

  await env.services.settings.set(SETTING_KEY, 'nao-e-url');
  await assert.rejects(
    () => sendWeeklySchedule({ settings: env.services.settings, hourBank: env.services.hourBank, guildId: env.guildId }),
    /não é uma URL válida/,
  );
});

test('envio: publica o embed no webhook e trata a recusa do Discord', async (t) => {
  const env = await createTestEnv();
  await withSchedule(env);

  const received = [];
  let status = 204;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ url: req.url, method: req.method, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(status);
      res.end(status === 204 ? '' : '{"message":"Invalid Webhook Token"}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/webhooks/1/token`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await env.cleanup();
  });

  await env.services.settings.set(SETTING_KEY, url);
  const result = await sendWeeklySchedule({
    settings: env.services.settings,
    hourBank: env.services.hourBank,
    guildId: env.guildId,
    timeZone: 'America/Sao_Paulo',
    now: Date.UTC(2026, 0, 15, 13, 0, 0),
  });

  assert.equal(result.ok, true);
  assert.equal(result.staffCount, 2);
  assert.equal(result.shiftCount, 4);
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'POST');
  assert.match(received[0].headers['content-type'], /application\/json/);
  assert.equal(received[0].body.embeds[0].title, 'ESCALA DA SEMANA');
  assert.equal(received[0].body.embeds[0].color, PALETTE.RED);

  // Discord recusando (token inválido, canal apagado etc.).
  status = 400;
  await assert.rejects(
    () => sendWeeklySchedule({ settings: env.services.settings, hourBank: env.services.hourBank, guildId: env.guildId }),
    /HTTP 400/,
  );
});

test('postWebhook respeita o timeout', async (t) => {
  const server = http.createServer(() => {
    /* nunca responde */
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  await assert.rejects(
    () => postWebhook(`http://127.0.0.1:${server.address().port}/x`, {}, { timeoutMs: 150 }),
    /não respondeu a tempo/,
  );
  await delay(10);
});

/* ------------------------------------------------------------------ */
/* Envio automático                                                    */
/* ------------------------------------------------------------------ */

const {
  ScheduleBroadcastService,
  AUTO_KEY,
  DAY_KEY,
  TIME_KEY,
  LAST_WEEK_KEY,
} = require('../src/systems/hourbank/scheduleAutoSend');

// Segunda-feira 12/01/2026 no horário de Brasília (UTC-3).
const mondayAt = (hour, minute = 0) => Date.UTC(2026, 0, 12, hour + 3, minute, 0);
const sundayAt = (hour, minute = 0) => Date.UTC(2026, 0, 18, hour + 3, minute, 0);

async function startReceiver(t, initialStatus = 204) {
  const received = [];
  const state = { status: initialStatus };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(state.status);
      res.end(state.status === 204 ? '' : 'nope');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    received,
    state,
    url: `http://127.0.0.1:${server.address().port}/webhooks/1/token`,
  };
}

async function autoEnv(t, status = 204) {
  const env = await createTestEnv();
  t.after(env.cleanup);
  await withSchedule(env);
  const receiver = await startReceiver(t, status);
  await env.services.settings.set(SETTING_KEY, receiver.url);
  await env.services.settings.set(AUTO_KEY, true);
  await env.services.settings.set(DAY_KEY, 1); // segunda
  await env.services.settings.set(TIME_KEY, '09:00');
  return { env, receiver, broadcast: env.services.scheduleBroadcast };
}

test('envio automático: só no dia e horário configurados', async (t) => {
  const { env, receiver, broadcast } = await autoEnv(t);

  const early = await broadcast.tick(env.guildId, mondayAt(8, 59));
  assert.deepEqual([early.sent, early.reason], [false, 'antes do horário']);

  const otherDay = await broadcast.tick(env.guildId, sundayAt(10, 0));
  assert.deepEqual([otherDay.sent, otherDay.reason], [false, 'outro dia']);

  const ok = await broadcast.tick(env.guildId, mondayAt(9, 0));
  assert.equal(ok.sent, true);
  assert.equal(receiver.received.length, 1);
  assert.equal(receiver.received[0].embeds[0].title, 'ESCALA DA SEMANA');
  assert.equal(env.services.settings.get(LAST_WEEK_KEY), '2026-01-12');

  // Uma vez por semana: os próximos ticks não repetem a mensagem.
  const repeated = await broadcast.tick(env.guildId, mondayAt(9, 1));
  assert.deepEqual([repeated.sent, repeated.reason], [false, 'já enviado nesta semana']);
  assert.equal(receiver.received.length, 1);
});

test('envio automático: recupera o horário perdido e sobrevive a reinício', async (t) => {
  const { env, receiver, broadcast } = await autoEnv(t);

  // Bot estava desligado às 09:00 e voltou 14:30 da mesma segunda.
  const late = await broadcast.tick(env.guildId, mondayAt(14, 30));
  assert.equal(late.sent, true);
  assert.equal(receiver.received.length, 1);

  // "Reinício": um serviço novo lendo as mesmas configurações não reenvia.
  const restarted = new ScheduleBroadcastService({
    settings: env.services.settings,
    hourBank: env.services.hourBank,
  });
  const afterRestart = await restarted.tick(env.guildId, mondayAt(15, 0));
  assert.deepEqual([afterRestart.sent, afterRestart.reason], [false, 'já enviado nesta semana']);
  assert.equal(receiver.received.length, 1);

  // Na semana seguinte volta a enviar.
  const nextMonday = Date.UTC(2026, 0, 19, 12, 5, 0);
  const nextWeek = await restarted.tick(env.guildId, nextMonday);
  assert.equal(nextWeek.sent, true);
  assert.equal(env.services.settings.get(LAST_WEEK_KEY), '2026-01-19');
});

test('envio automático: falha do webhook não marca a semana e é repetida', async (t) => {
  const { env, receiver, broadcast } = await autoEnv(t, 400);

  await assert.rejects(() => broadcast.tick(env.guildId, mondayAt(9, 5)), /HTTP 400/);
  assert.equal(env.services.settings.get(LAST_WEEK_KEY), null, 'sem envio, semana não é marcada');

  receiver.state.status = 204;
  const retry = await broadcast.tick(env.guildId, mondayAt(9, 6));
  assert.equal(retry.sent, true, 'tenta de novo no minuto seguinte');
  assert.equal(env.services.settings.get(LAST_WEEK_KEY), '2026-01-12');
});

test('envio automático desligado ou sem webhook não envia', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);
  const broadcast = env.services.scheduleBroadcast;

  assert.deepEqual(
    [(await broadcast.tick(env.guildId, mondayAt(9, 30))).sent, (await broadcast.tick(env.guildId, mondayAt(9, 30))).reason],
    [false, 'desligado'],
  );

  await env.services.settings.set(AUTO_KEY, true);
  const withoutUrl = await broadcast.tick(env.guildId, mondayAt(9, 30));
  assert.deepEqual([withoutUrl.sent, withoutUrl.reason], [false, 'sem webhook']);
});

test('envio manual marca a semana (o automático não duplica)', async (t) => {
  const { env, receiver, broadcast } = await autoEnv(t);

  await sendWeeklySchedule({
    settings: env.services.settings,
    hourBank: env.services.hourBank,
    guildId: env.guildId,
    timeZone: 'America/Sao_Paulo',
    now: mondayAt(8, 0),
  });
  assert.equal(receiver.received.length, 1);

  const auto = await broadcast.tick(env.guildId, mondayAt(9, 0));
  assert.deepEqual([auto.sent, auto.reason], [false, 'já enviado nesta semana']);
  assert.equal(receiver.received.length, 1);
});

test('configuração do envio automático é validada e devolvida ao painel', async (t) => {
  const { env, receiver, broadcast } = await autoEnv(t);

  const config = broadcast.getConfig();
  assert.equal(config.auto, true);
  assert.equal(config.day, 1);
  assert.equal(config.dayLabel, 'Segunda');
  assert.equal(config.time, '09:00');
  assert.equal(config.url, receiver.url);

  await assert.rejects(() => broadcast.updateConfig({ day: 9 }), /Dia da semana inválido/);
  await assert.rejects(() => broadcast.updateConfig({ time: '25:00' }), /Horário inválido/);
  await assert.rejects(() => broadcast.updateConfig({ auto: 'sim' }), /Valor inválido/);

  const updated = await broadcast.updateConfig({ day: 0, time: '20:30' });
  assert.equal(updated.day, 0);
  assert.equal(updated.dayLabel, 'Domingo');
  assert.equal(updated.time, '20:30');

  // Ativar sem webhook cadastrado é bloqueado.
  await setWebhookUrl(env.services.settings, '');
  await assert.rejects(() => broadcast.updateConfig({ auto: true }), /Cadastre a URL do webhook/);
});

test('startWatcher envia no tick e stopWatcher para de rodar', async (t) => {
  const { env, receiver, broadcast } = await autoEnv(t);
  const stop = broadcast.startWatcher(env.guildId, { intervalMs: 60000 });
  await delay(120);
  stop();
  broadcast.stopWatcher();

  // O relógio real não é segunda 09:00 — nada é enviado, mas o watcher rodou sem erro.
  assert.equal(receiver.received.length, 0);
  assert.equal(broadcast.timer, null, 'timer encerrado');
});
