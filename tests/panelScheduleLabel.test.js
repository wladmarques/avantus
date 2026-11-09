'use strict';

/**
 * `describeSchedule` — resumo curto da escala usado no bloco EQUIPE do painel.
 *
 * O painel deixou de mostrar DISPONÍVEL/INDISPONÍVEL na linha do staff: no
 * lugar entrou o horário do turno. Aqui testamos a resolução do texto:
 * turno em andamento, turnos de hoje, próximo turno e "sem escala".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  describeSchedule,
  scheduleSummary,
  toShift,
  weekParity,
} = require('../src/systems/hourbank/shiftSchedule');
const { tzParts } = require('../src/utils/time');

// Sexta-feira, 12:00 em America/Sao_Paulo (fuso padrão do ambiente de teste).
const NOW = new Date('2026-10-30T15:00:00Z');
const FRIDAY = tzParts(NOW).weekday;
const TZ = 'America/Sao_Paulo';

function shift(weekday, start, end, { parity = null, id = 1 } = {}) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return toShift({
    id,
    user_id: '900000000000000001',
    weekday,
    start_minutes: sh * 60 + sm,
    end_minutes: eh * 60 + em,
    parity,
  });
}

const weekdayLabel = (offset) => ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][(FRIDAY + offset) % 7];

test('sem turno cadastrado → "sem escala"', () => {
  assert.equal(describeSchedule([], NOW, { timeZone: TZ }), 'sem escala');
  assert.equal(describeSchedule(null, NOW, { timeZone: TZ }), 'sem escala');
});

test('turno de hoje → "hoje HH:MM às HH:MM"', () => {
  assert.equal(describeSchedule([shift(FRIDAY, '14:00', '22:00')], NOW, { timeZone: TZ }), 'hoje 14:00 às 22:00');
});

test('turno de hoje que vira o dia mantém a janela', () => {
  assert.equal(
    describeSchedule([shift(FRIDAY, '22:00', '02:00')], NOW, { timeZone: TZ }),
    'hoje 22:00 às 02:00',
  );
});

test('dois turnos hoje aparecem na mesma linha, em ordem de horário', () => {
  const shifts = [shift(FRIDAY, '18:00', '22:00', { id: 2 }), shift(FRIDAY, '08:00', '12:00', { id: 1 })];
  assert.equal(describeSchedule(shifts, NOW, { timeZone: TZ }), 'hoje 08:00 às 12:00 / 18:00 às 22:00');
});

test('turno em andamento → "em turno até HH:MM"', () => {
  assert.equal(describeSchedule([shift(FRIDAY, '08:00', '20:00')], NOW, { timeZone: TZ }), 'em turno até 20:00');
});

test('turno de ontem que atravessa a madrugada conta como "em turno até"', () => {
  const yesterday = (FRIDAY + 6) % 7;
  assert.equal(
    describeSchedule([shift(yesterday, '22:00', '14:00')], NOW, { timeZone: TZ }),
    'em turno até 14:00',
  );
});

test('sem turno hoje, mostra o próximo dia: amanhã', () => {
  const tomorrow = (FRIDAY + 1) % 7;
  assert.equal(
    describeSchedule([shift(tomorrow, '14:00', '22:00')], NOW, { timeZone: TZ }),
    'amanhã 14:00 às 22:00',
  );
});

test('sem turno hoje nem amanhã, mostra o dia da semana', () => {
  const inThreeDays = (FRIDAY + 3) % 7;
  assert.equal(
    describeSchedule([shift(inThreeDays, '14:00', '22:00')], NOW, { timeZone: TZ }),
    `${weekdayLabel(3)} 14:00 às 22:00`,
  );
});

test('turno só da semana oposta (revezamento) não conta como hoje', () => {
  // parity contrária à semana atual: o turno de hoje não vale nesta semana.
  const other = weekParity(NOW, TZ) === 'A' ? 'B' : 'A';
  const onlyOther = [shift(FRIDAY, '14:00', '22:00', { parity: other })];
  assert.equal(describeSchedule(onlyOther, NOW, { timeZone: TZ }), 'sem escala');
});

test('turno do revezamento da semana atual aparece normalmente', () => {
  const current = weekParity(NOW, TZ);
  const sameWeek = [shift(FRIDAY, '14:00', '22:00', { parity: current })];
  assert.equal(describeSchedule(sameWeek, NOW, { timeZone: TZ }), 'hoje 14:00 às 22:00');
});

test('turno do revezamento oposto aparece com o dia da semana (vale na próxima)', () => {
  const other = weekParity(NOW, TZ) === 'A' ? 'B' : 'A';
  assert.equal(
    describeSchedule([shift(FRIDAY, '06:00', '08:00', { parity: other })], NOW, { timeZone: TZ }),
    'Sex 06:00 às 08:00',
  );
});

test('janela do próximo turno é limitada: semana inteira sem turno → "sem escala"', () => {
  // Turno apenas no dia atual, com parity da semana que vem e já encerrado
  // nesta semana: fora do horizonte de 7 dias não há o que mostrar.
  const other = weekParity(NOW, TZ) === 'A' ? 'B' : 'A';
  const horizon = { timeZone: TZ, horizonDays: 1 };
  assert.equal(
    describeSchedule([shift((FRIDAY + 2) % 7, '06:00', '08:00', { parity: other })], NOW, horizon),
    'sem escala',
  );
});

test('scheduleSummary devolve a chave de ordenação: início do turno mostrado', () => {
  const summary = scheduleSummary([shift(FRIDAY, '14:00', '22:00')], NOW, { timeZone: TZ });
  assert.equal(summary.label, 'hoje 14:00 às 22:00');
  assert.equal(summary.hasShift, true);
  const inicio = new Date(summary.sortKey);
  assert.equal(tzParts(inicio, TZ).hour, 14);
  assert.equal(tzParts(inicio, TZ).weekday, FRIDAY);
});

test('dois turnos no dia: a chave de ordenação é o mais cedo', () => {
  const shifts = [shift(FRIDAY, '18:00', '22:00', { id: 2 }), shift(FRIDAY, '08:00', '12:00', { id: 1 })];
  const summary = scheduleSummary(shifts, NOW, { timeZone: TZ });
  assert.equal(tzParts(new Date(summary.sortKey), TZ).hour, 8);
});

test('sem escala: chave infinita (vai para o fim da lista)', () => {
  const summary = scheduleSummary([], NOW, { timeZone: TZ });
  assert.equal(summary.label, 'sem escala');
  assert.equal(summary.sortKey, Number.POSITIVE_INFINITY);
  assert.equal(summary.hasShift, false);
});

test('turno de amanhã ordena depois de qualquer turno de hoje', () => {
  const hoje = scheduleSummary([shift(FRIDAY, '22:00', '23:00')], NOW, { timeZone: TZ });
  const amanha = scheduleSummary([shift((FRIDAY + 1) % 7, '08:00', '12:00')], NOW, { timeZone: TZ });
  assert.ok(amanha.sortKey > hoje.sortKey);
  assert.equal(amanha.label, 'amanhã 08:00 às 12:00');
});
