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

  const actions = row.children[row.children.length - 1];
  const button = actions.children.find((node) => node.textContent === 'Tirar de serviço');
  assert.ok(button, 'botão "Tirar de serviço" disponível para quem está em serviço');

  button.listeners.click[0]();
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
  const groupTitle = (tr) => tr.children[0]?.children[0]?.children[0]?.textContent;
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
  const contagem = (tr) => tr.children[0]?.children[0]?.children[1]?.textContent;
  assert.equal(contagem(rows.find((tr) => groupTitle(tr) === 'Escala fixa')), '1');
  assert.equal(contagem(rows.find((tr) => groupTitle(tr) === 'Apoio')), '1');
});
