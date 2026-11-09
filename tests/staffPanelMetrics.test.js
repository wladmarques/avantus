'use strict';

/**
 * Métricas do painel da equipe em **três cartões** (AGORA / TEMPOS / HOJE)
 * no lugar das nove caixinhas soltas, + estado vazio inteligente.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStaffPanel } = require('../src/dashboard/panels/staffPanel');

const NOW = new Date('2026-10-30T15:00:00Z');

function staff(userId, status, extra = {}) {
  return { userId, status, blocked: false, meta: { label: status }, ...extra };
}

function render({
  waiting = [],
  serving = [],
  hold = [],
  staffList = [],
  staffCounts = { DISPONIVEL: 0, EM_ATENDIMENTO: 0 },
  avgWaitSeconds = 0,
  avgWaitSamples = 0,
  overview = {},
  open = true,
} = {}) {
  const payload = buildStaffPanel({
    state: { waiting, serving, hold, staffList, staffCounts, avgWaitSeconds, avgWaitSamples },
    overview: { avgDurationSeconds: 0, concluded: 0, evaluations: 0, avgRating: 0, lastEndedAt: null, ...overview },
    schedule: { open },
    todayWindow: { text: '12:00 às 00:00' },
    now: NOW,
    escalas: null,
  });
  const fields = payload.embeds[0].fields;
  const byName = Object.fromEntries(fields.map((field) => [field.name, field]));
  return { fields, byName, payload };
}

const WAITING = [
  { id: 1, position: 1, username: 'jogador', protocol: 1, joined_at: NOW.getTime(), waitingSeconds: 120 },
];
const SERVING = [
  {
    id: 2,
    username: 'outro',
    protocol: 2,
    staff_id: '900000000000000002',
    started_at: NOW.getTime(),
    servingSeconds: 300,
    presence_confirmed: true,
  },
];

test('três cartões no lugar de nove campos', () => {
  const { fields } = render({
    waiting: WAITING,
    serving: SERVING,
    staffList: [staff('900000000000000001', 'DISPONIVEL')],
    staffCounts: { DISPONIVEL: 1, EM_ATENDIMENTO: 1 },
    overview: { concluded: 4, avgDurationSeconds: 480, evaluations: 3, avgRating: 3.4 },
  });

  assert.equal(fields.length, 3, 'AGORA, TEMPOS e HOJE');
  assert.deepEqual(fields.map((field) => field.name), ['AGORA', 'TEMPOS', 'HOJE']);
  assert.ok(fields.every((field) => field.inline === true), 'os três ficam na mesma linha');
});

test('AGORA mostra fila, atendendo e livres', () => {
  const { byName } = render({
    waiting: WAITING,
    serving: SERVING,
    staffCounts: { DISPONIVEL: 2, EM_ATENDIMENTO: 1 },
    overview: { concluded: 1 },
  });
  assert.equal(byName.AGORA.value, '**1** na fila · **1** atendendo · **2** livres');
});

test('TEMPOS usa — quando não há amostra', () => {
  const { byName } = render({ staffCounts: { DISPONIVEL: 1, EM_ATENDIMENTO: 0 }, overview: {} });
  assert.equal(byName.TEMPOS.value, '**—** de espera · **—** de duração');
});

test('TEMPOS mostra espera e duração quando existem', () => {
  const { byName } = render({
    waiting: WAITING,
    avgWaitSeconds: 132,
    avgWaitSamples: 5,
    overview: { concluded: 4, avgDurationSeconds: 480 },
  });
  assert.match(byName.TEMPOS.value, /de espera/);
  assert.match(byName.TEMPOS.value, /de duração/);
  assert.ok(!byName.TEMPOS.value.includes('—'), 'sem traço quando há dado');
});

test('HOJE conta concluídos e pendentes, com a nota só quando há avaliação', () => {
  const semNota = render({ hold: [{ id: 9, username: 'mika', protocol: 9 }], overview: { concluded: 4 } });
  assert.equal(semNota.byName.HOJE.value, '**4** concluídos · **1** pendente');

  const comNota = render({ overview: { concluded: 4, evaluations: 3, avgRating: 3.4 } });
  assert.equal(comNota.byName.HOJE.value, '**4** concluídos · **3.40** de 4 · **0** pendentes');
});

test('singular e plural do cartão HOJE', () => {
  const um = render({ overview: { concluded: 1 } });
  assert.match(um.byName.HOJE.value, /\*\*1\*\* concluído ·/);
});

test('estado vazio: um campo só quando não há nada acontecendo', () => {
  const { fields, byName } = render({ open: false, overview: {} });

  assert.equal(fields.length, 1, 'apenas o campo de estado vazio');
  assert.equal(fields[0].name, 'SEM MOVIMENTO');
  assert.equal(fields[0].inline, false);
  assert.match(fields[0].value, /Central fechada/);
  assert.match(fields[0].value, /sem fila nem atendimento/);
  assert.match(fields[0].value, /nenhuma atividade registrada ainda/);
  assert.equal(byName.AGORA, undefined);
});

test('estado vazio mostra a última atividade como timestamp relativo', () => {
  const lastEndedAt = Date.now() - 2 * 3600 * 1000;
  const { fields } = render({ open: false, overview: { lastEndedAt } });

  assert.equal(fields.length, 1);
  assert.match(fields[0].value, /última atividade <t:\d+:R>/);
  assert.ok(!fields[0].value.includes('nenhuma atividade'), 'tem atividade anterior');
});

test('não esconde os cartões quando existe staff livre', () => {
  const { fields, byName } = render({
    staffCounts: { DISPONIVEL: 2, EM_ATENDIMENTO: 0 },
    overview: { concluded: 0 },
    open: true,
  });
  assert.equal(fields.length, 3, 'alguém livre já é "movimento" e precisa aparecer');
  assert.equal(byName.AGORA.value, '**0** na fila · **0** atendendo · **2** livres');
});

test('não esconde os cartões quando há pendente na fila', () => {
  const { fields } = render({ hold: [{ id: 9, username: 'mika', protocol: 9 }], overview: {} });
  assert.equal(fields.length, 3);
});

test('os cartões não repetem o mesmo número em campos diferentes', () => {
  const { fields } = render({
    waiting: WAITING,
    serving: SERVING,
    staffCounts: { DISPONIVEL: 1, EM_ATENDIMENTO: 1 },
    overview: { concluded: 2, avgWaitSeconds: 60, avgDurationSeconds: 300, evaluations: 1, avgRating: 4 },
  });
  const valores = fields.map((field) => field.value).join(' ');
  assert.ok(!/Ocupados/.test(valores), 'campo "Ocupados" foi absorvido por AGORA');
  assert.ok(!/Aguardando/.test(valores), 'campo "Aguardando" foi absorvido por AGORA');
});
