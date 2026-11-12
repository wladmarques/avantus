'use strict';

/**
 * Filtro por staff na seção **Presença** do painel web.
 *
 * Roda o JS real (`src/web/public/app.js`) em um DOM simulado, com um servidor
 * de verdade e um registro de falta no banco. O filtro precisa:
 *
 * - listar a equipe + quem só aparece nas ausências;
 * - filtrar a tabela **e** os cartões (números do staff selecionado);
 * - mostrar o resumo completo do staff (status, turno, sessão, horas, atrasos);
 * - sobreviver ao refresh automático de 30s (a seleção não volta para "Todos").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestEnv } = require('./helpers');
const { createWebServer } = require('../src/web/server');
const { tzParts } = require('../src/utils/time');

const PASSWORD = 'vantus';
const APP_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'app.js');
const STAFF = '970000000000001001';
const MINUTE = 60 * 1000;

/* ------------------------------------------------------------------ */
/* DOM mínimo (mesmo modelo do webPanelBrowser.test.js)                */
/* ------------------------------------------------------------------ */

function createElement(tag = 'div') {
  return {
    tagName: tag,
    children: [],
    dataset: {},
    style: {},
    listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    remove() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    showModal() {},
    close() {},
    set innerHTML(value) {
      this._html = value;
      this.children = [];
    },
    get innerHTML() {
      return this._html || '';
    },
    get textContent() {
      const parts = [this._text || '', ...this.children.map((child) => child.textContent || '')];
      return parts.filter(Boolean).join(' ');
    },
    set textContent(value) {
      // Como no navegador: escrever textContent descarta os filhos.
      this._text = value == null ? '' : String(value);
      this.children = [];
    },
    value: '',
    hidden: false,
  };
}

function createDocument() {
  const registry = new Map();
  return {
    registry,
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, createElement());
      return registry.get(id);
    },
    createElement: (tag) => createElement(tag),
    querySelectorAll: () => [],
  };
}

const blockedStorage = {
  getItem() {
    throw new Error('storage bloqueado');
  },
  setItem() {
    throw new Error('storage bloqueado');
  },
  removeItem() {
    throw new Error('storage bloqueado');
  },
};

const wait = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera uma condição virar verdadeira (o painel carrega em várias etapas). */
async function until(check, { timeout = 4000, step = 40 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (check()) return true;
    await wait(step);
  }
  return false;
}

/** "HH:MM" de `minutesAgo` minutos atrás, no fuso do bot. */
function shiftStartedAgo(minutesAgo, duration) {
  const p = tzParts(new Date());
  let start = p.hour * 60 + p.minute - minutesAgo;
  if (start < 0) start += 24 * 60;
  const hhmm = (value) =>
    `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  return { weekday: p.weekday, start: hhmm(start), end: hhmm(start + duration) };
}

/* ------------------------------------------------------------------ */
/* Ambiente                                                            */
/* ------------------------------------------------------------------ */

async function createHarness(t) {
  const env = await createTestEnv({ staff: false });

  // Um staff escalado que não entrou em serviço (vira "faltou" no período).
  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF,
    staffName: 'pedrosa17',
    shifts: [shiftStartedAgo(120, 60)],
  });
  await env.services.hourBank.checkAbsences(env.guildId);

  const { server } = createWebServer({
    services: env.services,
    env: { guildId: env.guildId },
    password: PASSWORD,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // fetch do "navegador": manda o token pelo query/authorization (sem cookies).
  const browserFetch = async (url, options = {}) => {
    const absolute = url.startsWith('http') ? url : `${base}${url.startsWith('/') ? '' : '/'}${url}`;
    const response = await fetch(absolute, { ...options, headers: { ...(options.headers || {}) } });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      headers: { get: (name) => response.headers.get(name) },
      json: async () => json,
      text: async () => text,
    };
  };

  const source = fs.readFileSync(APP_PATH, 'utf8');
  const load = ({ hash = '' } = {}) => {
    const doc = createDocument();
    const location = { href: `https://preview.exemplo/panel/${hash}`, hash };
    const win = {
      location,
      history: {
        replaceState(_state, _title, url) {
          const parsed = new URL(url);
          location.href = parsed.toString();
          location.hash = parsed.hash;
        },
      },
      addEventListener() {},
    };
    const run = new Function(
      'document',
      'window',
      'sessionStorage',
      'fetch',
      'URL',
      'Blob',
      'setTimeout',
      'setInterval',
      'clearInterval',
      'clearTimeout',
      'console',
      source,
    );
    run(
      doc,
      win,
      blockedStorage,
      browserFetch,
      URL,
      function Blob() {},
      setTimeout,
      () => 0,
      () => {},
      () => {},
      { log() {}, warn() {}, error() {} },
    );
    return { doc, location };
  };

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await env.cleanup();
  });

  return { env, load };
}

/** Abre o painel já autenticado (fluxo de login real do app). */
async function openPanel(harness) {
  const page = harness.load();
  await wait(120);
  page.doc.getElementById('password').value = PASSWORD;
  await page.doc.getElementById('login-form').listeners.submit[0]({ preventDefault() {} });
  // A tela preenche em etapas (overview → avaliações → agenda): espera a
  // seção Presença existir de fato antes de asseverar.
  await until(() => page.doc.getElementById('absence-staff').children.length > 1);
  return page;
}

/** Aplica o filtro como o usuário faria no <select>. */
async function pickStaff(page, userId) {
  const select = page.doc.getElementById('absence-staff');
  select.value = userId;
  select.listeners.change[0]();
  await wait(60);
}

const options = (page) =>
  page.doc.getElementById('absence-staff').options?.map((node) => ({
    value: node.value,
    label: node.textContent,
  })) ?? page.doc.getElementById('absence-staff').children.map((node) => ({
    value: node.value,
    label: node.textContent,
  }));

const rowsOf = (page) => page.doc.getElementById('absence-body').children.length;
const card = (page, id) => page.doc.getElementById(id).textContent;

/* ------------------------------------------------------------------ */
/* Testes                                                              */
/* ------------------------------------------------------------------ */

test('a seção Presença lista o staff e permite filtrar por ele', async (t) => {
  const harness = await createHarness(t);
  const page = await openPanel(harness);

  const list = page.doc.getElementById('absence-staff').children;
  assert.ok(list.length >= 2, 'tem "Todos" + pelo menos um staff');
  assert.equal(list[0].value, '', '"Todos os staff" é a primeira opção');
  const staffOption = list.find((node) => node.value === STAFF);
  assert.ok(staffOption, 'o staff escalado aparece na lista');
  assert.match(staffOption.textContent, /pedrosa17/);
  assert.match(staffOption.textContent, /\(1\)/, 'mostra quantos registros ele tem');

  // "Todos": tabela com o registro.
  assert.equal(rowsOf(page), 1);
  assert.equal(page.doc.getElementById('absence-staff-panel').hidden, true, 'resumo some em "Todos"');
});

test('filtrar por staff filtra a tabela e os cartões', async (t) => {
  const harness = await createHarness(t);
  const page = await openPanel(harness);

  assert.equal(card(page, 'stat-absences-missed'), '1');

  await pickStaff(page, STAFF);

  assert.equal(page.doc.getElementById('absence-staff').value, STAFF, 'seleção fica no filtro');
  assert.equal(rowsOf(page), 1, 'a tabela continua com o registro dele');
  assert.equal(card(page, 'stat-absences-missed'), '1', 'cartões passam a ser do staff');
  assert.match(page.doc.getElementById('absence-filter-note').textContent, /pedrosa17/);
  assert.match(page.doc.getElementById('absence-table-note').textContent, /pedrosa17/);
});

test('o resumo mostra todas as informações do staff filtrado', async (t) => {
  const harness = await createHarness(t);
  const page = await openPanel(harness);

  await pickStaff(page, STAFF);

  const panel = page.doc.getElementById('absence-staff-panel');
  assert.equal(panel.hidden, false, 'o painel de resumo aparece');
  assert.match(page.doc.getElementById('absence-staff-title').textContent, /pedrosa17/);
  assert.match(page.doc.getElementById('absence-staff-subtitle').textContent, /ID 970000000000001001/);

  const summary = page.doc.getElementById('absence-staff-summary').textContent;
  for (const label of [
    'Status',
    'Turno',
    'Sessão atual',
    'Horas no período',
    'Atrasos nas sessões',
    'Faltas',
    'Em atraso agora',
    'Chegou atrasado',
    'Minutos de atraso',
  ]) {
    assert.ok(summary.includes(label), `resumo tem "${label}"`);
  }

  // Escala semanal completa (todos os dias, não só o de hoje).
  const schedule = page.doc.getElementById('absence-staff-schedule').textContent;
  assert.match(schedule, /Escala semanal/);
  for (const day of ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']) {
    assert.ok(schedule.includes(day), `escala mostra ${day}`);
  }
});

test('o filtro continua no staff escolhido depois do refresh automático', async (t) => {
  const harness = await createHarness(t);
  const page = await openPanel(harness);

  await pickStaff(page, STAFF);

  // refresh() do painel: novo /api/overview e nova renderização da seção.
  await page.doc.getElementById('apply').listeners.click[0]();
  await until(() => page.doc.getElementById('absence-staff-panel').hidden === false);

  assert.equal(
    page.doc.getElementById('absence-staff').children.find((node) => node.value === STAFF) !== undefined,
    true,
    'a opção do staff continua na lista',
  );
  assert.match(
    page.doc.getElementById('absence-filter-note').textContent,
    /pedrosa17/,
    'a nota continua dizendo qual staff está filtrado',
  );
  assert.equal(page.doc.getElementById('absence-staff-panel').hidden, false);
});

test('sem registro para o staff o filtro explica o vazio', async (t) => {
  const harness = await createHarness(t);
  const page = await openPanel(harness);

  await pickStaff(page, STAFF);

  // Remove os registros do banco e recarrega.
  await harness.env.services.repositories.hourBank.db.run(
    'DELETE FROM staff_absences WHERE guild_id = ?',
    [harness.env.guildId],
  );
  await page.doc.getElementById('apply').listeners.click[0]();
  await until(() => page.doc.getElementById('stat-absences-missed').textContent === '0');

  assert.match(page.doc.getElementById('absence-body').textContent, /Nenhuma falta ou atraso/);
  assert.equal(card(page, 'stat-absences-missed'), '0');
});
