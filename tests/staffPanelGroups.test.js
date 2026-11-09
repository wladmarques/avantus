'use strict';

/**
 * EQUIPE do painel separada em "DE SERVIÇO" e "FORA DE SERVIÇO".
 *
 * Antes era uma lista única: com a equipe grande, quem estava disponível se
 * perdia no meio de uma coluna de INDISPONÍVEL. Agora o bloco mostra primeiro
 * quem está trabalhando (disponível ou em atendimento) e depois o resto
 * (ausente, indisponível e bloqueado).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestEnv } = require('./helpers');
const { buildStaffPanel } = require('../src/dashboard/panels/staffPanel');
const { tzParts } = require('../src/utils/time');

const DISPONIVEL_1 = '900000000000001101';
const DISPONIVEL_2 = '900000000000001102';
const ATENDENDO = '900000000000001103';
const AUSENTE = '900000000000001104';
const INDISPONIVEL = '900000000000001105';
const BLOQUEADO = '900000000000001106';

const OVERVIEW = { avgDurationSeconds: 0, concluded: 0, evaluations: false, avgRating: 0 };

// Sexta-feira, 12:00 em America/Sao_Paulo (fuso padrão do ambiente de teste).
const NOW = new Date('2026-10-30T15:00:00Z');
const FRIDAY = tzParts(NOW).weekday;

function render(env, now = NOW) {
  const state = env.services.engine.getState(env.guildId);
  const payload = buildStaffPanel({
    state,
    overview: OVERVIEW,
    schedule: { open: true },
    todayWindow: { text: '14:00 às 00:00' },
    now,
    escalas: env.services.panels.staffSchedules(env.guildId, now),
  });
  const description = payload.embeds[0].description;
  return { state, payload, description, team: description.split('**EQUIPE**')[1] ?? '' };
}

async function schedule(env, userId, shifts) {
  await env.services.hourBank.setSchedule({ guildId: env.guildId, userId, shifts });
}

async function setStatus(env, userId, status) {
  await env.services.staff.setStatus({
    guildId: env.guildId,
    userId,
    status,
    updatedBy: 'teste',
    manual: true,
  });
}

async function envComEquipe(t) {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  await setStatus(env, DISPONIVEL_1, 'DISPONIVEL');
  await setStatus(env, DISPONIVEL_2, 'DISPONIVEL');
  await setStatus(env, AUSENTE, 'AUSENTE');
  await setStatus(env, INDISPONIVEL, 'INDISPONIVEL');
  await setStatus(env, BLOQUEADO, 'DISPONIVEL');
  await setStatus(env, ATENDENDO, 'DISPONIVEL');

  // EM_ATENDIMENTO é aplicado pelo sistema (não é status manual).
  env.services.db.run(
    "UPDATE staff_status SET status = 'EM_ATENDIMENTO' WHERE guild_id = ? AND user_id = ?",
    [env.guildId, ATENDENDO],
  );
  await env.services.staff.setBlocked(env.guildId, BLOQUEADO, { blocked: true, by: 'teste' });
  return env;
}

test('EQUIPE tem os dois grupos: DE SERVIÇO e FORA DE SERVIÇO', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);
  await setStatus(env, DISPONIVEL_1, 'DISPONIVEL');

  const { team } = render(env);
  assert.ok(team.includes('**DE SERVIÇO (1)**'), 'cabeçalho do grupo de serviço');
  assert.ok(team.includes('**FORA DE SERVIÇO (0)**'), 'cabeçalho do grupo fora de serviço');
  assert.ok(team.includes(`<@${DISPONIVEL_1}>`));
});

test('disponível e em atendimento ficam em DE SERVIÇO; ausente, indisponível e bloqueado em FORA', async (t) => {
  const env = await envComEquipe(t);
  const { team } = render(env);

  const marca = '**FORA DE SERVIÇO';
  const deServico = team.slice(0, team.indexOf(marca));
  const foraDeServico = team.slice(team.indexOf(marca));
  assert.ok(deServico && foraDeServico, 'os dois grupos existem');

  assert.ok(deServico.includes('**DE SERVIÇO (3)**'));
  for (const id of [DISPONIVEL_1, DISPONIVEL_2, ATENDENDO]) {
    assert.ok(deServico.includes(`<@${id}>`), `${id} está de serviço`);
  }
  for (const id of [AUSENTE, INDISPONIVEL, BLOQUEADO]) {
    assert.ok(!deServico.includes(`<@${id}>`), `${id} NÃO está de serviço`);
  }

  assert.ok(foraDeServico.includes('**FORA DE SERVIÇO (3)**'));
  for (const id of [AUSENTE, INDISPONIVEL, BLOQUEADO]) {
    assert.ok(foraDeServico.includes(`<@${id}>`), `${id} está fora de serviço`);
  }
});

test('o status DISPONÍVEL/INDISPONÍVEL saiu da linha: no lugar entra a escala', async (t) => {
  const env = await envComEquipe(t);
  const { team } = render(env);

  for (const rotulo of ['DISPONÍVEL', 'INDISPONÍVEL', 'AUSENTE']) {
    assert.ok(!team.includes(rotulo), `"${rotulo}" não aparece mais no bloco EQUIPE`);
  }
  // Sem escala cadastrada, a linha mostra "sem escala" em vez de um status.
  assert.ok(team.includes(`<@${DISPONIVEL_1}> — sem escala`));
  assert.ok(team.includes(`<@${INDISPONIVEL}> — sem escala`));
});

test('a linha mostra o horário do turno de hoje', async (t) => {
  const env = await envComEquipe(t);
  await schedule(env, DISPONIVEL_1, [{ weekday: FRIDAY, start: '14:00', end: '22:00' }]);
  await schedule(env, AUSENTE, [{ weekday: FRIDAY, start: '22:00', end: '02:00' }]);

  const { team } = render(env);
  assert.ok(team.includes(`<@${DISPONIVEL_1}> — hoje 14:00 às 22:00`), 'turno de hoje');
  assert.ok(team.includes(`<@${AUSENTE}> — hoje 22:00 às 02:00`), 'turno noturno de hoje');
});

test('staff em atendimento mantém o marcador, sem virar status de disponibilidade', async (t) => {
  const env = await envComEquipe(t);
  await schedule(env, ATENDENDO, [{ weekday: FRIDAY, start: '18:00', end: '23:00' }]);

  const { team } = render(env);
  assert.ok(team.includes(`<@${ATENDENDO}> — hoje 18:00 às 23:00 • em atendimento`));
});

test('staff bloqueado mostra a escala e o marcador de bloqueio', async (t) => {
  const env = await envComEquipe(t);
  await schedule(env, BLOQUEADO, [{ weekday: FRIDAY, start: '14:00', end: '22:00' }]);

  const { team } = render(env);
  assert.ok(team.includes(`<@${BLOQUEADO}> — hoje 14:00 às 22:00 • bloqueado`));
});

test('sem turno hoje, a linha mostra o próximo dia da escala', async (t) => {
  const env = await envComEquipe(t);
  const tomorrow = (FRIDAY + 1) % 7;
  await schedule(env, DISPONIVEL_2, [{ weekday: tomorrow, start: '14:00', end: '22:00' }]);

  const { team } = render(env);
  assert.ok(team.includes(`<@${DISPONIVEL_2}> — amanhã 14:00 às 22:00`));
});

test('turno em andamento aparece como "em turno até"', async (t) => {
  const env = await envComEquipe(t);
  await schedule(env, DISPONIVEL_1, [{ weekday: FRIDAY, start: '08:00', end: '20:00' }]);

  const { team } = render(env);
  assert.ok(team.includes(`<@${DISPONIVEL_1}> — em turno até 20:00`));
});

test('empate de horário: status desempata (disponível antes de em atendimento)', async (t) => {
  const env = await envComEquipe(t);
  const { team } = render(env);

  // Nenhum dos dois tem escala: ambos caem no fim, e o status decide.
  const deServico = team.slice(0, team.indexOf('**FORA DE SERVIÇO'));
  assert.ok(
    deServico.indexOf(`<@${DISPONIVEL_1}>`) < deServico.indexOf(`<@${ATENDENDO}>`),
    'disponíveis vêm primeiro',
  );
});

test('EQUIPE é ordenada pelo horário da escala, do mais cedo para o mais tarde', async (t) => {
  const env = await envComEquipe(t);
  // Cadastrados de propósito fora de ordem alfabética e de status.
  await schedule(env, AUSENTE, [{ weekday: FRIDAY, start: '19:12', end: '20:24' }]);
  await schedule(env, DISPONIVEL_2, [{ weekday: FRIDAY, start: '13:12', end: '14:24' }]);
  await schedule(env, INDISPONIVEL, [{ weekday: FRIDAY, start: '16:48', end: '18:00' }]);
  await schedule(env, BLOQUEADO, [{ weekday: FRIDAY, start: '15:36', end: '16:48' }]);
  await schedule(env, DISPONIVEL_1, [{ weekday: FRIDAY, start: '20:24', end: '21:36' }]);
  await schedule(env, ATENDENDO, [{ weekday: FRIDAY, start: '12:00', end: '16:00' }]);

  const { team } = render(env);
  const marcador = '**FORA DE SERVIÇO';
  const deServico = team.slice(0, team.indexOf(marcador));
  const fora = team.slice(team.indexOf(marcador));

  const ordem = (bloco) =>
    bloco
      .split('\n')
      .filter((linha) => linha.includes('<@'))
      .map((linha) => /<@(\d+)>/.exec(linha)[1]);

  assert.deepEqual(ordem(deServico), [ATENDENDO, DISPONIVEL_2, DISPONIVEL_1], '12:00 → 13:12 → 20:24');
  assert.deepEqual(ordem(fora), [BLOQUEADO, INDISPONIVEL, AUSENTE], '15:36 → 16:48 → 19:12');
});

test('quem não tem escala vai para o fim do grupo', async (t) => {
  const env = await envComEquipe(t);
  await schedule(env, DISPONIVEL_2, [{ weekday: FRIDAY, start: '22:00', end: '23:00' }]);

  const { team } = render(env);
  const deServico = team.slice(0, team.indexOf('**FORA DE SERVIÇO'));
  const linhas = deServico.split('\n').filter((l) => l.includes('<@'));
  assert.ok(linhas[0].includes(`<@${DISPONIVEL_2}>`), 'o único com escala hoje vem primeiro');
  assert.ok(linhas.at(-1).includes('sem escala'), 'sem escala fica no fim');
});

test('a ordenação por escala vale também para FORA DE SERVIÇO', async (t) => {
  const env = await envComEquipe(t);
  await schedule(env, AUSENTE, [{ weekday: FRIDAY, start: '21:00', end: '22:00' }]);
  await schedule(env, INDISPONIVEL, [{ weekday: FRIDAY, start: '09:00', end: '10:00' }]);

  const { team } = render(env);
  const fora = team.slice(team.indexOf('**FORA DE SERVIÇO'));
  assert.ok(
    fora.indexOf(`<@${INDISPONIVEL}>`) < fora.indexOf(`<@${AUSENTE}>`),
    '09:00 antes de 21:00',
  );
});

test('equipe vazia mantém o aviso de nenhum staff registrado', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  const { team } = render(env);
  assert.match(team, /Nenhum staff registrado ainda/);
  assert.ok(!team.includes('DE SERVIÇO'), 'sem staff não inventa grupo');
});

test('grupo vazio mostra o texto de apoio em vez de um título solto', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);
  await setStatus(env, INDISPONIVEL, 'INDISPONIVEL');

  const { team } = render(env);
  assert.ok(team.includes('**DE SERVIÇO (0)**\n_Ninguém de serviço agora._'), 'texto de apoio no grupo vazio');
  assert.ok(team.includes('**FORA DE SERVIÇO (1)**'));
});

test('lista longa é cortada para não estourar o limite da descrição', async (t) => {
  const env = await createTestEnv({ staff: false });
  t.after(env.cleanup);

  for (let i = 0; i < 25; i += 1) {
    await setStatus(env, `9000000000000020${String(i).padStart(2, '0')}`, 'INDISPONIVEL');
  }

  const { team, description } = render(env);
  assert.ok(team.includes('**FORA DE SERVIÇO (25)**'));
  assert.ok(team.includes('e mais 5 staff'), 'corta a lista e avisa quantos ficaram de fora');
  assert.ok(description.length < 4096, 'descrição dentro do limite do Discord');
});
