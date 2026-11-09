'use strict';

/**
 * Rodapé dos painéis.
 *
 * Antes o rodapé da staff dizia
 * `VANTUS • Central de Atendimento • Painel restrito à equipe • Atualização automática`
 * e, logo depois, o Discord colava o timestamp (`Hoje às 11:07`) — quatro
 * informações para dizer duas coisas. Agora o rodapé só carrega o que ele
 * precisa carregar: quem pode ver o painel e de quanto em quanto tempo ele se
 * atualiza (a hora vem do `timestamp` do embed, e a marca já está no título).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStaffPanel } = require('../src/dashboard/panels/staffPanel');
const { buildPublicPanelClassic } = require('../src/dashboard/panels/publicPanel');
const { createTestEnv } = require('./helpers');

const NOW = new Date('2026-10-30T14:07:00Z');
const OVERVIEW = { avgDurationSeconds: 0, concluded: 0, evaluations: 0, avgRating: 0, lastEndedAt: null };
const STATE = {
  waiting: [],
  serving: [],
  hold: [],
  staffList: [],
  staffCounts: { DISPONIVEL: 0, EM_ATENDIMENTO: 0 },
  avgWaitSeconds: 0,
  avgWaitSamples: 0,
};

function staffFooter(options = {}) {
  return buildStaffPanel({
    state: STATE,
    overview: OVERVIEW,
    schedule: { open: true },
    todayWindow: { text: '12:00 às 00:00' },
    now: NOW,
    ...options,
  }).embeds[0].footer.text;
}

function classicFooter(options = {}) {
  const built = buildPublicPanelClassic({
    settings: { message_panel_title: 'ATENDIMENTO | VANTUS' },
    state: STATE,
    schedule: { open: true },
    todayWindow: { text: '12:00 às 00:00' },
    now: NOW,
    ...options,
  });
  return built.payload.embeds[0].footer.text;
}

test('rodapé da staff: curto, com o intervalo de atualização', () => {
  const footer = staffFooter();
  assert.equal(footer, 'Painel restrito à equipe • atualiza a cada 30s');
});

test('rodapé da staff não repete a marca nem a hora', () => {
  const footer = staffFooter();
  assert.ok(!footer.includes('VANTUS'), 'a marca já está no título');
  assert.ok(!footer.includes('Central de Atendimento'), 'o título do painel já diz o que é');
  assert.ok(!footer.includes('Atualização automática'), 'a hora vem do timestamp do embed');
  assert.ok(!/\d{2}:\d{2}/.test(footer), 'nenhum horário escrito no texto do rodapé');
});

test('o rodapé acompanha o intervalo configurado', () => {
  assert.match(staffFooter({ refreshSeconds: 45 }), /atualiza a cada 45s/);
  assert.match(staffFooter({ refreshSeconds: 15 }), /atualiza a cada 15s/);
});

test('o rodapé continua curto (cabe com folga no limite do Discord)', () => {
  const footer = staffFooter({ refreshSeconds: 600 });
  assert.ok(footer.length <= 60, `rodapé com ${footer.length} caracteres`);
});

test('timestamp do embed continua presente (é ele que mostra a hora)', () => {
  const embed = buildStaffPanel({
    state: STATE,
    overview: OVERVIEW,
    schedule: { open: true },
    todayWindow: { text: '12:00 às 00:00' },
    now: NOW,
  }).embeds[0];
  assert.equal(embed.timestamp, NOW.toISOString());
});

test('rodapé do painel público clássico também perde a hora duplicada', () => {
  const footer = classicFooter();
  assert.equal(footer, 'Central de Atendimento • atualiza a cada 30s');
  assert.ok(!/Atualizado \d{2}:\d{2}/.test(footer), 'a hora já aparece no timestamp');
  assert.ok(!footer.includes('VANTUS'), 'a marca está no título');
});

test('o painel usa o intervalo configurado em panel_refresh_seconds', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await env.services.settings.set('panel_refresh_seconds', 45);
  const staff = env.services.panels.buildPayload(env.guildId, 'staff');
  assert.match(staff.payload.embeds[0].footer.text, /atualiza a cada 45s/);
  assert.equal(env.services.panels.refreshSeconds, 45);
});

test('valor inválido de intervalo cai no padrão de 30s', async (t) => {
  const env = await createTestEnv();
  t.after(env.cleanup);

  await env.services.settings.set('panel_refresh_seconds', null);
  assert.equal(env.services.panels.refreshSeconds, 30);
  const staff = env.services.panels.buildPayload(env.guildId, 'staff');
  assert.match(staff.payload.embeds[0].footer.text, /atualiza a cada 30s/);
});
