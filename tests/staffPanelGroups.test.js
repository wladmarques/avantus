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

const DISPONIVEL_1 = '900000000000001101';
const DISPONIVEL_2 = '900000000000001102';
const ATENDENDO = '900000000000001103';
const AUSENTE = '900000000000001104';
const INDISPONIVEL = '900000000000001105';
const BLOQUEADO = '900000000000001106';

const OVERVIEW = { avgDurationSeconds: 0, concluded: 0, evaluations: false, avgRating: 0 };

function render(env) {
  const state = env.services.engine.getState(env.guildId);
  const payload = buildStaffPanel({
    state,
    overview: OVERVIEW,
    schedule: { open: true },
    todayWindow: { text: '14:00 às 00:00' },
    now: new Date(),
  });
  const description = payload.embeds[0].description;
  return { state, payload, description, team: description.split('**EQUIPE**')[1] ?? '' };
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

test('status de cada staff continua visível dentro do grupo', async (t) => {
  const env = await envComEquipe(t);
  const { team } = render(env);

  assert.ok(team.includes(`<@${DISPONIVEL_1}> — **DISPONÍVEL**`));
  assert.ok(team.includes(`<@${ATENDENDO}> — **EM ATENDIMENTO**`));
  assert.ok(team.includes(`<@${AUSENTE}> — **AUSENTE**`));
  assert.ok(team.includes(`<@${INDISPONIVEL}> — **INDISPONÍVEL**`));
  assert.ok(team.includes(`<@${BLOQUEADO}> — **BLOQUEADO**`));
});

test('disponível aparece antes de em atendimento dentro de DE SERVIÇO', async (t) => {
  const env = await envComEquipe(t);
  const { team } = render(env);

  const deServico = team.split('**FORA DE SERVIÇO')[0];
  assert.ok(
    deServico.indexOf(`<@${DISPONIVEL_1}>`) < deServico.indexOf(`<@${ATENDENDO}>`),
    'disponíveis vêm primeiro',
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
