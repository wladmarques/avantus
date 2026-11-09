'use strict';

/**
 * Layout do painel público da central (Components V2).
 *
 * O painel virou uma pilha de caixas: uma com o status e o relógio grande à
 * direita, uma por indicador (na fila / staffs / em andamento) e a do rodapé
 * com o botão de entrada. Como a API não permite aninhar containers, cada caixa
 * é um container irmão — o teste garante que essa estrutura não volte a virar
 * uma linha de texto corrida.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  buildPublicPanel,
  buildPublicPanelV2,
  buildPublicPanelClassic,
  statusArt,
  ART,
} = require('../src/dashboard/panels/publicPanel');
const { DEFAULT_SCHEDULE } = require('../src/config/settings');

const settings = { message_panel_title: 'ATENDIMENTO | VANTUS', wait_channel_id: '123' };

const state = (overrides = {}) => ({
  waiting: [],
  serving: [],
  staffCounts: { DISPONIVEL: 0 },
  ...overrides,
});

const OPEN = { open: true, nextOpen: null, schedule: DEFAULT_SCHEDULE };
const CLOSED = { open: false, nextOpen: 'hoje às 14:00', schedule: DEFAULT_SCHEDULE };

const build = (opts = {}) =>
  buildPublicPanelV2({
    settings,
    state: state(),
    schedule: OPEN,
    now: new Date('2026-10-30T14:00:00Z'),
    ...opts,
  }).payload;

/** Todos os containers (type 17) da mensagem. */
const containers = (payload) => payload.components.filter((c) => c.type === 17);

/** Texto de um container, achatado. */
const textOf = (container) =>
  (container.components ?? [])
    .flatMap((c) => (c.components ?? []).flatMap((inner) => (inner.type === 10 ? [inner.content] : [])))
    .concat(container.components.filter((c) => c.type === 10).map((c) => c.content))
    .join('\n');

test('central aberta: status, horário, três indicadores e o rodapé', () => {
  const payload = build({ state: state({ waiting: [1, 2], serving: [1], staffCounts: { DISPONIVEL: 1 } }) });
  const boxes = containers(payload);

  assert.equal(boxes.length, 6, 'status + horário + 3 indicadores + rodapé');
  assert.deepEqual(
    boxes.slice(2, 5).map((box) => textOf(box)),
    ['-# NA FILA\n# 2', '-# STAFFS DISPONÍVEIS\n# 1', '-# EM ANDAMENTO\n# 1'],
  );
});

test('central fechada: sem caixas de indicador (só status, horário e rodapé)', () => {
  const payload = build({ schedule: CLOSED });
  const boxes = containers(payload);

  assert.equal(boxes.length, 3);
  assert.ok(!containers(payload).some((box) => /NA FILA/.test(textOf(box))));
  assert.match(textOf(boxes[0]), /FORA DO HORÁRIO/);
});

test('o status usa o relógio como imagem à direita (section + thumbnail)', () => {
  const [statusBox] = containers(build({ state: state({ staffCounts: { DISPONIVEL: 1 } }) }));
  const section = statusBox.components.find((c) => c.type === 9);

  assert.ok(section, 'a caixa de status tem uma section');
  assert.equal(section.accessory.type, 11, 'acessório é thumbnail');
  assert.equal(section.accessory.media.url, `attachment://${ART.disponivel.file}`);
  assert.ok(section.accessory.description, 'imagem tem texto alternativo');
  assert.ok(section.components.length <= 3, 'a section aceita no máximo 3 text displays');
});

test('a arte acompanha o estado da central', () => {
  assert.equal(statusArt({ open: false, availableStaff: 3 }).file, 'central-fechada.png');
  assert.equal(statusArt({ open: true, availableStaff: 0 }).file, 'central-sem-staff.png');
  assert.equal(statusArt({ open: true, availableStaff: 2 }).file, 'central-disponivel.png');
});

test('a imagem é enviada junto com a mensagem e existe no pacote', () => {
  const payload = build();
  assert.equal(payload.files.length, 1);
  assert.ok(fs.existsSync(payload.files[0]), `arquivo inexistente: ${payload.files[0]}`);
  assert.ok(payload.files[0].endsWith('.png'));

  for (const art of Object.values(ART)) {
    const file = require('node:path').join(__dirname, '..', 'assets', art.file);
    assert.ok(fs.existsSync(file), `arte ausente: ${art.file} (rode npm run art)`);
  }
});

test('o horário tem caixa própria, logo abaixo do status', () => {
  const boxes = containers(build());
  assert.match(textOf(boxes[1]), /HORÁRIO DE ATENDIMENTO/);
  assert.match(textOf(boxes[1]), /Seg–Sex/);
  assert.ok(!/HORÁRIO DE ATENDIMENTO/.test(textOf(boxes[0])), 'o status não repete o horário');
});

test('o rodapé mantém o botão de entrada e a avaliação', () => {
  const payload = build();
  const footer = containers(payload).at(-1);
  const joinSection = footer.components.find((c) => c.type === 9);
  const row = footer.components.find((c) => c.type === 1);

  assert.equal(joinSection.accessory.custom_id, 'pub:join');
  assert.equal(joinSection.accessory.disabled, true, 'sem staff disponível o botão fica desabilitado');
  assert.equal(row.components[0].custom_id, 'pub:evaluate');
});

test('com staff disponível o botão de entrada libera', () => {
  const footer = containers(build({ state: state({ staffCounts: { DISPONIVEL: 1 } }) })).at(-1);
  assert.equal(footer.components.find((c) => c.type === 9).accessory.disabled, false);
});

test('todo container tem barra de destaque ou é a caixa neutra dos indicadores', () => {
  const boxes = containers(build({ state: state({ staffCounts: { DISPONIVEL: 1 } }) }));
  const semAccent = boxes.filter((box) => box.accent_color === undefined);
  assert.equal(semAccent.length, 4, 'horário e os três indicadores são caixas neutras');
});

test('nenhum container é aninhado (a API não permite)', () => {
  const payload = build({ state: state({ staffCounts: { DISPONIVEL: 1 } }) });
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 17) {
      for (const child of node.components ?? []) {
        assert.notEqual(child.type, 17, 'container dentro de container');
      }
    }
    walk(node.components);
  };
  walk(payload.components);
});

test('layout clássico mantém os campos e ganha a mesma arte', () => {
  const built = buildPublicPanel({
    style: 'classic',
    settings,
    state: state({ staffCounts: { DISPONIVEL: 2 } }),
    schedule: { ...OPEN, todayWindow: { text: '12:00 às 00:00' } },
    todayWindow: { text: '12:00 às 00:00' },
  });
  const embed = built.payload.embeds[0];

  assert.ok(embed.fields.some((field) => field.name === 'NA FILA'));
  assert.equal(embed.thumbnail.url, `attachment://${ART.disponivel.file}`);
  assert.equal(built.payload.files.length, 1);
});
