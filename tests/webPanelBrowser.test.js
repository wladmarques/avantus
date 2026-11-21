'use strict';

/**
 * Executa o JS REAL do painel (`src/web/public/app.js`) em um DOM simulado,
 * reproduzindo o cenário que quebrava o login no preview:
 *
 *   - iframe de terceiros → `sessionStorage` lança erro e cookies são recusados;
 *   - a página é recarregada depois do login.
 *
 * Sem o fallback por hash o painel voltava para a tela de senha com
 * "Sessão expirada" logo após autenticar.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestEnv } = require('./helpers');
const { createWebServer } = require('../src/web/server');

const PASSWORD = 'vantus';
const APP_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'app.js');

/* ------------------------------------------------------------------ */
/* DOM mínimo                                                          */
/* ------------------------------------------------------------------ */

function createElement(tag = 'div') {
  // classList de verdade: o painel alterna classes (grupo recolhido, sidebar).
  const classes = new Set();
  return {
    tagName: tag,
    children: [],
    dataset: {},
    style: {},
    listeners: {},
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    getAttribute(name) {
      return this.attributes[name];
    },
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    get className() {
      return [...classes].join(' ');
    },
    set className(value) {
      classes.clear();
      for (const item of String(value || '').split(/\s+/).filter(Boolean)) classes.add(item);
    },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
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
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
    click() {},
    set innerHTML(value) {
      this._html = value;
      this.children = [];
    },
    get innerHTML() {
      return this._html || '';
    },
    textContent: '',
    value: '',
    hidden: false,
  };
}

function createDocument(registry = new Map()) {
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

/** sessionStorage que sempre falha (iframe sem permissão de armazenamento). */
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

/* ------------------------------------------------------------------ */
/* Ambiente                                                            */
/* ------------------------------------------------------------------ */

async function createHarness(t) {
  const env = await createTestEnv({ staff: false, settings: {} });
  const { server } = createWebServer({
    services: env.services,
    env: { guildId: env.guildId },
    password: PASSWORD,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // fetch do "navegador": cookie de terceiros NUNCA é enviado
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
  const load = ({ hash = '', registry = new Map() } = {}) => {
    const doc = createDocument(registry);
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
      innerWidth: 1400,
      innerHeight: 900,
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

  return { env, base, load, browserFetch };
}

const wait = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Testes                                                              */
/* ------------------------------------------------------------------ */

test('login funciona sem storage e sem cookie (e sobrevive ao reload)', async (t) => {
  const harness = await createHarness(t);

  const first = harness.load();
  await wait(120);
  assert.equal(first.doc.getElementById('app').hidden, true, 'sem sessão: mostra o login');
  assert.equal(first.doc.getElementById('login').hidden, false);

  const password = first.doc.getElementById('password');
  password.value = PASSWORD;
  await first.doc.getElementById('login-form').listeners.submit[0]({ preventDefault() {} });
  await wait(250);

  assert.equal(first.doc.getElementById('app').hidden, false, 'painel aberto após o login');
  assert.equal(first.doc.getElementById('login').hidden, true, 'a tela de login desaparece após entrar');
  assert.equal(first.doc.getElementById('password').value, '', 'senha limpa do formulário');
  assert.equal(first.doc.getElementById('login-error').hidden, true, 'nenhum erro pendente');
  assert.match(first.location.hash, /auth=/, 'token persistido no hash (fallback sem storage)');

  // "Reload": mesmo hash, storage ainda bloqueado.
  const second = harness.load({ hash: first.location.hash });
  await wait(250);
  assert.equal(second.doc.getElementById('app').hidden, false, 'continua logado após recarregar');
  assert.equal(second.doc.getElementById('login').hidden, true, 'login continua oculto após recarregar');
  assert.notEqual(second.doc.getElementById('stat-staff').textContent, '', 'dados carregados');
});

test('sem token o painel pede a senha novamente', async (t) => {
  const harness = await createHarness(t);

  const page = harness.load();
  await wait(150);

  assert.equal(page.doc.getElementById('app').hidden, true);
  assert.equal(page.doc.getElementById('login').hidden, false);
});

test('token inválido no hash não abre o painel', async (t) => {
  const harness = await createHarness(t);

  const page = harness.load({ hash: '#auth=token-falso' });
  await wait(200);

  assert.equal(page.doc.getElementById('app').hidden, true, 'token inválido volta para o login');
  assert.equal(page.doc.getElementById('login').hidden, false);
});

test('senha errada mostra a mensagem do servidor e mantém o login', async (t) => {
  const harness = await createHarness(t);

  const page = harness.load();
  await wait(120);

  page.doc.getElementById('password').value = 'senha-errada';
  await page.doc.getElementById('login-form').listeners.submit[0]({ preventDefault() {} });
  await wait(200);

  const error = page.doc.getElementById('login-error');
  assert.equal(error.hidden, false, 'erro visível');
  assert.match(error.textContent, /Senha incorreta/, 'mensagem do servidor, não "unauthorized"');
  assert.equal(page.doc.getElementById('app').hidden, true, 'painel continua fechado');
  assert.equal(page.doc.getElementById('login').hidden, false, 'login continua visível');
  assert.equal(page.doc.getElementById('login-submit').disabled, false, 'botão reabilitado');

  // Com a senha certa na sequência, entra normalmente.
  page.doc.getElementById('password').value = PASSWORD;
  await page.doc.getElementById('login-form').listeners.submit[0]({ preventDefault() {} });
  await wait(250);
  assert.equal(page.doc.getElementById('app').hidden, false);
  assert.equal(page.doc.getElementById('login').hidden, true);
  assert.equal(error.hidden, true, 'erro anterior limpo');
});

test('botão "Tirar de serviço" encerra a sessão sem sair da tela', async (t) => {
  const harness = await createHarness(t);
  const STAFF_ID = '900000000000000777';

  await harness.env.services.staff.setStatus({
    guildId: harness.env.guildId,
    userId: STAFF_ID,
    status: 'DISPONIVEL',
    updatedBy: 'teste',
    manual: false,
  });
  await harness.env.services.hourBank.setDisplayName({
    guildId: harness.env.guildId,
    userId: STAFF_ID,
    staffName: 'esquecido',
  });

  const login = await harness.browserFetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const { token } = await login.json();
  const page = harness.load({ hash: `#auth=${token}` });
  await wait(250);

  // Encontra a linha do staff e o botão de ação.
  assert.equal(page.doc.getElementById('app').hidden, false, 'painel aberto');
  assert.notEqual(page.doc.getElementById('stat-staff').textContent, '', 'dados carregados');
  const rows = page.doc.getElementById('staff-body').children;
  const nameOf = (tr) => tr.children[0]?.children[0]?.children[0]?.textContent;
  const row = rows.find((tr) => nameOf(tr) === 'esquecido');
  assert.ok(
    row,
    `staff aparece na tabela (linhas: ${rows.map((tr) => nameOf(tr)).join(', ') || 'nenhuma'})`,
  );

  // Uma única ação por linha: o menu de três pontos.
  const actions = row.children[row.children.length - 1];
  assert.equal(actions.children.length, 1, 'a linha tem um único botão de ações');
  const menuButton = actions.children[0];
  assert.ok(menuButton.classList, 'botão do menu de três pontos');
  assert.equal(menuButton.textContent, '', 'o botão não expõe vários rótulos na linha');
  assert.ok(menuButton.listeners.click, 'botão do menu tem handler');

  const menu = page.doc.getElementById('row-menu');
  menuButton.listeners.click[0]({ stopPropagation() {}, target: menuButton });
  assert.equal(menu.hidden, false, 'menu de ações aberto');

  // "Tirar de serviço" está no menu e age na linha aberta.
  const menuClick = menu.listeners.click[0];
  assert.ok(menuClick, 'menu tem handler de ação');
  menuClick({ target: { closest: () => ({ dataset: { action: 'off' } }) } });
  const modal = page.doc.getElementById('off-modal');
  assert.equal(modal.open, true, 'modal de confirmação aberto');
  assert.match(page.doc.getElementById('off-text').textContent, /Sessão aberta desde/);

  await page.doc.getElementById('off-form').listeners.submit[0]({ preventDefault() {} });
  await wait(300);

  assert.equal(modal.open, false, 'modal fecha depois da ação');
  assert.equal(harness.env.services.staff.get(harness.env.guildId, STAFF_ID).status, 'INDISPONIVEL');
  assert.equal(harness.env.services.hourBank.activeSession(harness.env.guildId, STAFF_ID), null);
  assert.match(page.doc.getElementById('toast').textContent, /fora de serviço/);
});

test('tabela do painel separa "Escala fixa" (cargo) de "Apoio"', async (t) => {
  const harness = await createHarness(t);
  const ROLE = '1566903220968624188';
  const COM_CARGO = '900000000000000811';
  const SEM_CARGO = '900000000000000812';

  for (const [userId, roles, name] of [
    [COM_CARGO, [ROLE], 'com-cargo'],
    [SEM_CARGO, ['123456789012345678'], 'apoio-aleatorio'],
  ]) {
    harness.env.gateway.members.set(userId, {
      inGuild: true,
      voiceChannelId: null,
      displayName: name,
      staffRoles: roles,
    });
    await harness.env.services.staff.setStatus({
      guildId: harness.env.guildId,
      userId,
      status: 'INDISPONIVEL',
      updatedBy: 'teste',
      manual: true,
    });
  }
  await harness.env.services.hourBank.setSchedule({
    guildId: harness.env.guildId,
    userId: COM_CARGO,
    shifts: [{ weekday: 1, start: '14:00', end: '22:00' }],
  });
  await harness.env.services.settings.set('staff_panel_role_ids', [ROLE]);

  const login = await harness.browserFetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const { token } = await login.json();
  const page = harness.load({ hash: `#auth=${token}` });
  await wait(300);

  const rows = page.doc.getElementById('staff-body').children;
  // Estrutura: tr.group-row > td > div.group-head > button.group-toggle > [ícone, título, contagem]
  const groupHead = (tr) =>
    tr.children[0]?.children[0]?.children.find((node) => node.className === 'group-toggle');
  const groupTitle = (tr) => groupHead(tr)?.children[1]?.textContent;
  const titles = rows.filter((tr) => tr.className === 'group-row').map(groupTitle);

  assert.deepEqual(titles, ['Escala fixa', 'Apoio'], 'cabeçalhos dos dois grupos, nesta ordem');

  // Cada staff precisa cair no grupo certo.
  const nomeDaLinha = (tr) => tr.children[0]?.children[0]?.children[0]?.textContent;
  const indiceCom = rows.findIndex((tr) => nomeDaLinha(tr) === 'com-cargo');
  const indiceApoio = rows.findIndex((tr) => nomeDaLinha(tr) === 'apoio-aleatorio');
  const indiceApoioHeader = rows.findIndex((tr) => groupTitle(tr) === 'Apoio');

  assert.ok(indiceCom > 0 && indiceCom < indiceApoioHeader, 'staff com cargo fica antes do grupo Apoio');
  assert.ok(indiceApoio > indiceApoioHeader, 'staff sem cargo fica depois do cabeçalho Apoio');

  // O cabeçalho mostra a contagem de cada grupo.
  const contagem = (tr) => groupHead(tr)?.children[2]?.textContent;
  assert.equal(contagem(rows.find((tr) => groupTitle(tr) === 'Escala fixa')), '1');
  assert.equal(contagem(rows.find((tr) => groupTitle(tr) === 'Apoio')), '1');
});

/* ------------------------------------------------------------------ */
/* Redesign: gestão da equipe                                          */
/* ------------------------------------------------------------------ */

/** Abre o painel logado (com dois staff de exemplo) e devolve a página. */
async function openPanel(t) {
  const harness = await createHarness(t);
  for (const [userId, name, status] of [
    ['900000000000000901', 'ana-souza', 'DISPONIVEL'],
    ['900000000000000902', 'bruno-lima', 'INDISPONIVEL'],
  ]) {
    await harness.env.services.staff.setStatus({
      guildId: harness.env.guildId,
      userId,
      status,
      updatedBy: 'teste',
      manual: false,
    });
    await harness.env.services.hourBank.setDisplayName({
      guildId: harness.env.guildId,
      userId,
      staffName: name,
    });
  }
  const login = await harness.browserFetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const { token } = await login.json();
  const page = harness.load({ hash: `#auth=${token}` });
  await wait(300);
  return { harness, page };
}

test('cada linha tem um único menu de ações, com as ações de antes', async (t) => {
  const { page } = await openPanel(t);

  const rows = page.doc.getElementById('staff-body').children.filter(
    (tr) => tr.className !== 'group-row',
  );

  assert.ok(rows.length > 0, 'tabela com staff');
  for (const tr of rows) {
    const actions = tr.children[tr.children.length - 1];
    assert.equal(actions.children.length, 1, 'um único botão de ações por linha');
  }

  // O menu vive no HTML: um único elemento para todas as linhas.
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="row-menu"/, 'existe um menu único compartilhado');
  const actions = [...html.matchAll(/data-action="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(actions, ['name', 'schedule', 'off', 'reset', 'block', 'remove']);
});

test('grupo recolhido esconde as linhas e o cabeçalho continua na tabela', async (t) => {
  const { page } = await openPanel(t);
  const body = page.doc.getElementById('staff-body');

  const before = body.children.length;
  const header = body.children.find((tr) => tr.className === 'group-row');
  assert.ok(header, 'cabeçalho de grupo');
  const toggle = header.children[0].children[0].children[0];
  toggle.listeners.click[0]();

  assert.ok(body.children.length < before, 'linhas do grupo recolhido somem');
  const stillThere = body.children.find((tr) => tr.className.split(' ').includes('group-row'));
  assert.ok(stillThere, 'o cabeçalho permanece na tabela');
  const stillToggle = stillThere.children[0].children[0].children[0];
  assert.equal(stillToggle.title, 'Expandir grupo', 'cabeçalho marcado como recolhido');

  // Expande de novo.
  stillToggle.listeners.click[0]();
  assert.equal(body.children.length, before, 'volta ao estado anterior');
});

test('busca e filtro de status reduzem a tabela sem ir ao servidor', async (t) => {
  const { page } = await openPanel(t);
  const body = page.doc.getElementById('staff-body');
  const total = body.children.length;

  const search = page.doc.getElementById('staff-search');
  search.value = 'zzz-nao-existe';
  search.listeners.input[0]();
  assert.ok(body.children.length < total, 'busca sem resultado encolhe a tabela');
  assert.match(
    body.children.map((tr) => tr.children[0]?.textContent || '').join(' '),
    /Nenhum staff deste grupo combina/,
  );

  search.value = '';
  search.listeners.input[0]();
  assert.equal(body.children.length, total, 'limpar a busca restaura tudo');

  const filters = page.doc.getElementById('staff-filter');
  const blocked = { closest: () => ({ dataset: { filter: 'blocked' } }) };
  filters.listeners.click[0]({ target: blocked });
  const nomes = body.children
    .filter((tr) => !tr.className.includes('group-row'))
    .map((tr) => tr.children[0]?.children[0]?.children[0]?.textContent)
    .filter(Boolean);
  // Nenhum staff bloqueado nos dados de exemplo: a tabela não inventa linhas.
  assert.deepEqual(nomes, [], 'filtro de bloqueados esconde todo mundo');
  assert.match(
    body.children.map((tr) => tr.children[0]?.textContent || '').join(' '),
    /Nenhum staff deste grupo combina/,
  );

  const all = { closest: () => ({ dataset: { filter: 'all' } }) };
  filters.listeners.click[0]({ target: all });
  assert.equal(body.children.length, total, 'voltar para Todos restaura a tabela');
});

test('visão geral lista a equipe com atalho para as sessões', async (t) => {
  const { page } = await openPanel(t);
  const team = page.doc.getElementById('overview-team');
  assert.ok(team.children.length > 0, 'mini lista da equipe preenchida');
  const person = team.children[0];
  assert.equal(person.className, 'overview-person');
  assert.ok(person.listeners.click, 'clicar abre as sessões do staff');

  person.listeners.click[0]();
  assert.equal(page.doc.getElementById('sessions-modal').open, true, 'modal de sessões aberto');
});

test('sidebar recolhível troca o rótulo do botão', async (t) => {
  const { page } = await openPanel(t);
  const toggle = page.doc.getElementById('sidebar-toggle');
  assert.equal(toggle.title, 'Recolher menu');

  toggle.listeners.click[0]();
  assert.equal(toggle.title, 'Expandir menu', 'recolhida');

  toggle.listeners.click[0]();
  assert.equal(toggle.title, 'Recolher menu', 'expandida de novo');
});
