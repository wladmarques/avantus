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
  assert.match(first.location.hash, /auth=/, 'token persistido no hash (fallback sem storage)');

  // "Reload": mesmo hash, storage ainda bloqueado.
  const second = harness.load({ hash: first.location.hash });
  await wait(250);
  assert.equal(second.doc.getElementById('app').hidden, false, 'continua logado após recarregar');
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
