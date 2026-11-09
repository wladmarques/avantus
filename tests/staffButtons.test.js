'use strict';

/**
 * Layout dos botões do painel da equipe.
 *
 * O Discord não permite definir a largura de um botão: ela acompanha o tamanho
 * do rótulo. Como os rótulos antigos iam de 9 a 16 caracteres, cada linha fechava
 * num comprimento diferente e o conjunto parecia torto. A regra agora é:
 *
 * - no máximo 5 botões por linha (limite do Discord);
 * - rótulos entre 5 e 10 caracteres (colunas parecidas);
 * - ordem por fluxo de trabalho, com o destrutivo isolado na ponta.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { staffPanelComponents, IDs } = require('../src/dashboard/components/buttons');

const ALL = { hasQueue: true, hasServing: true, hasHold: true };
const MIN_LABEL = 5;
const MAX_LABEL = 10;
const MAX_PER_ROW = 5;

const rows = (options = ALL) => staffPanelComponents(options);
const labels = (options = ALL) =>
  rows(options).map((row) => row.components.map((component) => component.label));

test('duas linhas: 5 + 4 botões', () => {
  const layout = labels();
  assert.equal(layout.length, 2, 'duas action rows');
  assert.equal(layout[0].length, 5);
  assert.equal(layout[1].length, 4);
});

test('nenhuma linha passa do limite de 5 botões do Discord', () => {
  for (const row of rows()) {
    assert.ok(row.components.length <= MAX_PER_ROW, `${row.components.length} botões numa linha`);
  }
});

test('todos os rótulos têm entre 5 e 10 caracteres', () => {
  for (const label of labels().flat()) {
    assert.ok(
      label.length >= MIN_LABEL && label.length <= MAX_LABEL,
      `"${label}" tem ${label.length} caracteres (esperado ${MIN_LABEL}–${MAX_LABEL})`,
    );
  }
});

test('diferença máxima de tamanho entre os rótulos é de 5 caracteres', () => {
  const tamanhos = labels().flat().map((label) => label.length);
  const variacao = Math.max(...tamanhos) - Math.min(...tamanhos);
  assert.ok(variacao <= 5, `variação de ${variacao} caracteres (máximo 5)`);
});

test('linha 1 é o fluxo do atendimento, na ordem de uso', () => {
  assert.deepEqual(labels()[0], ['CHAMAR', 'ESCOLHER', 'PULAR', 'DEVOLVER', 'FINALIZAR']);
});

test('linha 2 é o que é sobre a pessoa e o administrativo, com REMOVER na ponta', () => {
  assert.deepEqual(labels()[1], ['ATUALIZAR', 'MEU STATUS', 'REATIVAR', 'REMOVER']);
});

test('os IDs não mudaram (botões continuam funcionando após reinício)', () => {
  const ids = rows()
    .flatMap((row) => row.components.map((component) => component.custom_id))
    .sort();
  assert.deepEqual(
    ids,
    [
      IDs.STAFF_CALL_NEXT,
      IDs.STAFF_CALL_SPECIFIC,
      IDs.STAFF_FINISH,
      IDs.STAFF_MY_STATUS,
      IDs.STAFF_REACTIVATE,
      IDs.STAFF_REFRESH,
      IDs.STAFF_REMOVE,
      IDs.STAFF_RETURN,
      IDs.STAFF_SKIP,
    ].sort(),
    'todos os nove botões continuam presentes',
  );
});

test('todos no estilo neutro da paleta (sem cor personalizada e sem emoji)', () => {
  for (const component of rows().flatMap((row) => row.components)) {
    assert.equal(component.style, 2, `${component.label} usa o estilo neutro`);
    assert.equal(component.emoji, undefined, `${component.label} não tem emoji`);
    assert.equal(component.type, 2);
  }
});

test('sem fila: os botões de fila ficam desabilitados e não mudam de tamanho', () => {
  const semFila = rows({ hasQueue: false, hasServing: true, hasHold: false });
  const comFila = rows(ALL);

  assert.deepEqual(
    semFila.map((row) => row.components.map((component) => component.label)),
    comFila.map((row) => row.components.map((component) => component.label)),
    'rótulos idênticos: o botão não muda de largura ao habilitar',
  );

  const porId = new Map(semFila.flatMap((row) => row.components).map((c) => [c.custom_id, c]));
  assert.equal(porId.get(IDs.STAFF_CALL_NEXT).disabled, true);
  assert.equal(porId.get(IDs.STAFF_CALL_SPECIFIC).disabled, true);
  assert.equal(porId.get(IDs.STAFF_SKIP).disabled, true);
  assert.equal(porId.get(IDs.STAFF_FINISH).disabled, false, 'seguir atendendo continua liberado');
  assert.equal(porId.get(IDs.STAFF_REFRESH).disabled, false, 'atualizar nunca fica bloqueado');
  assert.equal(porId.get(IDs.STAFF_MY_STATUS).disabled, false);
});

test('sem pendente o REATIVAR fica desabilitado; sem nada o REMOVER também', () => {
  const vazio = rows({ hasQueue: false, hasServing: false, hasHold: false });
  const porId = new Map(vazio.flatMap((row) => row.components).map((c) => [c.custom_id, c]));

  assert.equal(porId.get(IDs.STAFF_REACTIVATE).disabled, true);
  assert.equal(porId.get(IDs.STAFF_REMOVE).disabled, true);
  assert.equal(porId.get(IDs.STAFF_REACTIVATE).label, 'REATIVAR');
  assert.equal(porId.get(IDs.STAFF_REMOVE).label, 'REMOVER');
});
