'use strict';

/**
 * Seção **Notificações** do painel web: o que está salvo continua na tela
 * depois de recarregar a página.
 *
 * Regressão: no reload (sessão já existente) o app não chamava `/api/push`, e
 * a seção ficava em "Carregando…" com os campos vazios — parecia que a
 * configuração tinha se perdido, mesmo estando gravada no banco.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestEnv } = require('./helpers');
const { createWebServer } = require('../src/web/server');

const PASSWORD = 'vantus';
const APP_PATH = path.join(__dirname, '..', 'src', 'web', 'public', 'app.js');
const TOPIC = 'vantus-fila-abc123';

/* ------------------------------------------------------------------ */
/* DOM mínimo (mesmo modelo dos outros testes de painel)               */
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
      this._text = value == null ? '' : String(value);
      this.children = [];
    },
    value: '',
    checked: false,
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

const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, { timeout = 4000, step = 40 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (check()) return true;
    await wait(step);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Ambiente                                                            */
/* ------------------------------------------------------------------ */

async function createHarness(t, settings) {
  const env = await createTestEnv({ staff: false, settings });
  const { server } = createWebServer({
    services: env.services,
    env: { guildId: env.guildId },
    password: PASSWORD,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browserFetch = async (url, options = {}) => {
    const absolute = url.startsWith('http') ? url : `${base}${url.startsWith('/') ? '' : '/'}${url}`;
    const response = await fetch(absolute, options);
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

  return { env, load, base, browserFetch };
}

/** Token de sessão válido, como o navegador guardaria no hash. */
async function newToken(harness) {
  const login = await harness.browserFetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const data = await login.json();
  return data.token;
}

/* ------------------------------------------------------------------ */
/* Testes                                                              */
/* ------------------------------------------------------------------ */

test('ao recarregar a página a seção Notificações mostra o que está salvo', async (t) => {
  const harness = await createHarness(t, {
    push_enabled: true,
    push_endpoint: 'https://ntfy.sh',
    push_topic: TOPIC,
    push_on_queue_blocked: false,
  });
  const token = await newToken(harness);

  // "F5": carrega o app com a sessão no hash da URL.
  const page = harness.load({ hash: `#auth=${encodeURIComponent(token)}` });

  assert.equal(await until(() => page.doc.getElementById('push-topic').value === TOPIC), true);
  assert.equal(page.doc.getElementById('push-enabled').checked, true);
  assert.equal(page.doc.getElementById('push-endpoint').value, 'https://ntfy.sh');
  assert.equal(page.doc.getElementById('push-on-join').checked, true);
  assert.equal(page.doc.getElementById('push-on-blocked').checked, false);
  assert.doesNotMatch(page.doc.getElementById('push-status').textContent, /Carregando/);
  assert.match(page.doc.getElementById('push-status').textContent, /Ligado/);
});

test('sem configuração salva a seção sai de "Carregando…" e explica o que falta', async (t) => {
  const harness = await createHarness(t);
  const token = await newToken(harness);
  const page = harness.load({ hash: `#auth=${encodeURIComponent(token)}` });

  // O DOM do teste começa vazio (não traz o HTML): espera o carregamento real.
  assert.equal(await until(() => page.doc.getElementById('push-endpoint').value === 'https://ntfy.sh'), true);
  assert.doesNotMatch(page.doc.getElementById('push-status').textContent, /Carregando/);
  assert.equal(page.doc.getElementById('push-topic').value, '');
  assert.equal(page.doc.getElementById('push-endpoint').value, 'https://ntfy.sh');
  assert.equal(page.doc.getElementById('push-enabled').checked, false);
  assert.match(page.doc.getElementById('push-status').textContent, /Desligado/);
});

test('o token salvo aparece mascarado, nunca no campo visível', async (t) => {
  const harness = await createHarness(t, {
    push_enabled: true,
    push_endpoint: 'https://ntfy.sh',
    push_topic: TOPIC,
    push_token: 'tk_segredo1234',
  });
  const token = await newToken(harness);
  const page = harness.load({ hash: `#auth=${encodeURIComponent(token)}` });

  assert.equal(await until(() => page.doc.getElementById('push-topic').value === TOPIC), true);
  const field = page.doc.getElementById('push-token');
  assert.equal(field.value, '');
  assert.match(field.placeholder, /Token salvo/);
  assert.match(field.placeholder, /1234/);
  assert.equal(JSON.stringify(field.placeholder).includes('tk_segredo1234'), false);
});

test('salvar pelo painel e recarregar mantém os valores', async (t) => {
  const harness = await createHarness(t);
  const token = await newToken(harness);
  const hash = `#auth=${encodeURIComponent(token)}`;

  const first = harness.load({ hash });
  assert.equal(await until(() => page_ready(first)), true);
  first.doc.getElementById('push-enabled').checked = true;
  first.doc.getElementById('push-topic').value = TOPIC;
  await first.doc.getElementById('push-save').listeners.click[0]();
  assert.equal(await until(() => harness.env.services.settings.get('push_topic') === TOPIC), true);

  const reloaded = harness.load({ hash });
  assert.equal(await until(() => reloaded.doc.getElementById('push-topic').value === TOPIC), true);
  assert.equal(reloaded.doc.getElementById('push-enabled').checked, true);

  function page_ready(page) {
    return page.doc.getElementById('push-endpoint').value === 'https://ntfy.sh';
  }
});
