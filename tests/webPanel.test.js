'use strict';

/**
 * Painel web do banco de horas: autenticação, API e edição de escala.
 * Sobe um servidor HTTP real em porta efêmera (127.0.0.1).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createTestEnv } = require('./helpers');
const { createWebServer, PUBLIC_DIR, ASSET_VERSION } = require('../src/web/server');

const PASSWORD = 'senha-de-teste';
const STAFF = '960000000000001001';

async function startPanel(env, { password = PASSWORD } = {}) {
  const { server } = createWebServer({
    services: env.services,
    env: { timezone: 'America/Sao_Paulo', guildId: env.guildId },
    password,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const call = async (path, { method = 'GET', body, cookie, token, headers: extra = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text, headers: response.headers };
  };

  const login = async () => {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const cookie = String(response.headers.get('set-cookie') || '').split(';')[0];
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, cookie, token: payload.token, setCookie: response.headers.get('set-cookie') };
  };

  return {
    base,
    call,
    login,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('API exige login (401 sem sessão)', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const response = await panel.call('/api/overview');
  assert.equal(response.status, 401);
  assert.match(response.json.error, /Sessão inválida/);
  assert.equal(response.json.reason, 'sem_token');
});

test('senha errada e senha correta', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const wrong = await panel.call('/api/login', { method: 'POST', body: { password: 'errada' } });
  assert.equal(wrong.status, 401);

  const { status, cookie } = await panel.login();
  assert.equal(status, 200);
  assert.match(cookie, /vantus_session=/);

  const overview = await panel.call('/api/overview', { cookie });
  assert.equal(overview.status, 200);
  assert.equal(overview.json.guildId, env.guildId);
  assert.ok(Array.isArray(overview.json.staff));
});

test('senha com espaços nas pontas é aceita', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  // Senha colada de gerenciador/terminal costuma vir com espaço ou quebra de linha.
  const ok = await panel.call('/api/login', { method: 'POST', body: { password: `  ${PASSWORD}  ` } });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.token);
});

test('painel desativado sem senha configurada', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env, { password: null });
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const login = await panel.call('/api/login', { method: 'POST', body: { password: 'x' } });
  assert.equal(login.status, 503);
  const page = await panel.call('/');
  assert.equal(page.status, 503);
});

test('salvar escala pelo painel e refletir na API', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();

  const saved = await panel.call(`/api/staff/${STAFF}/shifts`, {
    method: 'PUT',
    cookie,
    body: {
      staffName: 'pedrosa17',
      shifts: [
        { weekday: 1, start: '12:00', end: '18:00' },
        { weekday: 6, start: '20:00', end: '23:30' },
      ],
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.shifts.length, 2);

  const overview = await panel.call('/api/overview', { cookie });
  const row = overview.json.staff.find((item) => item.userId === STAFF);
  assert.ok(row, 'staff aparece no painel após cadastrar a escala');
  assert.equal(row.staffName, 'pedrosa17');
  assert.equal(row.weekly.length, 7);
  const monday = row.weekly.find((day) => day.weekday === 1);
  assert.deepEqual(monday.shifts, [{ start: '12:00', end: '18:00' }]);

  const invalid = await panel.call(`/api/staff/${STAFF}/shifts`, {
    method: 'PUT',
    cookie,
    body: { shifts: [{ weekday: 9, start: '10:00', end: '12:00' }] },
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /Dia da semana inválido/);

  const removed = await panel.call(`/api/staff/${STAFF}/shifts`, { method: 'DELETE', cookie });
  assert.equal(removed.status, 200);
  const after = await panel.call(`/api/sessions?userId=${STAFF}`, { cookie });
  assert.equal(after.status, 200);
});

test('relatório e sessões exigem sessão válida e trazem os dados', async (t) => {
  const env = await createTestEnv({ staff: false });
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();
  const now = Date.now();
  await env.services.hourBank.startSession({ guildId: env.guildId, userId: STAFF, staffName: 'ana', at: now - 90 * 60000 });
  await env.services.hourBank.endSession({ guildId: env.guildId, userId: STAFF, at: now - 30 * 60000 });

  const report = await panel.call('/api/report', { cookie });
  assert.equal(report.status, 200);
  const item = report.json.staff.find((row) => row.userId === STAFF);
  assert.equal(item.sessions, 1);
  assert.equal(item.totalMinutes, 60);

  const sessions = await panel.call(`/api/sessions?userId=${STAFF}`, { cookie });
  assert.equal(sessions.status, 200);
  assert.equal(sessions.json.sessions.length, 1);
  assert.equal(sessions.json.sessions[0].open, false);
  assert.ok(sessions.json.sessions[0].entry);
  assert.ok(sessions.json.sessions[0].exit);
});

test('logout invalida a sessão', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { cookie } = await panel.login();
  const logout = await panel.call('/api/logout', { method: 'POST', cookie });
  assert.equal(logout.status, 200);

  // O cookie antigo continua sendo enviado pelo cliente, mas o token foi removido.
  const after = await panel.call('/api/overview', { cookie });
  assert.equal(after.status, 401);
});

test('interface e assets são servidos para usuários autenticados', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const page = await panel.call('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /Banco de horas/);

  const css = await panel.call('/styles.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const js = await panel.call('/app.js');
  assert.equal(js.status, 200);
  assert.match(js.text, /api\/overview/);

  const health = await panel.call('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
});

test('cookie e token funcionam em proxy https (iframe de preview)', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  // Login vindo de um proxy https (como o preview do Arena) → SameSite=None; Secure
  const response = await fetch(`${panel.base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', host: 'abc-8080.exemplo.app' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const payload = await response.json();
  const setCookie = String(response.headers.get('set-cookie') || '');

  assert.equal(response.status, 200);
  assert.ok(payload.token, 'token devolvido no corpo para uso em Bearer');
  assert.match(setCookie, /SameSite=None/, 'cookie compatível com contexto de terceiros');
  assert.match(setCookie, /Secure/);

  // Autenticação por Authorization (navegador pode bloquear o cookie no iframe)
  const overview = await panel.call('/api/overview', { token: payload.token });
  assert.equal(overview.status, 200);
  assert.ok(Array.isArray(overview.json.staff));

  const logout = await panel.call('/api/logout', { method: 'POST', token: payload.token });
  assert.equal(logout.status, 200);
  const after = await panel.call('/api/overview', { token: payload.token });
  assert.equal(after.status, 401, 'token invalidado no logout');
});

test('painel pode ser embutido em iframe (sem X-Frame-Options)', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const page = await panel.call('/');
  assert.equal(page.headers.get('x-frame-options'), null, 'X-Frame-Options removido');
  assert.match(String(page.headers.get('content-security-policy')), /frame-ancestors/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
});

test('token sobrevive ao reinício do servidor (sessão assinada)', async (t) => {
  const env = await createTestEnv();
  const first = await startPanel(env);
  const { token } = await first.login();
  assert.ok(token);
  await first.close();

  // Novo processo/servidor: sessões em memória são perdidas, a assinatura não.
  const second = await startPanel(env);
  t.after(async () => {
    await second.close();
    await env.cleanup();
  });

  const overview = await second.call('/api/overview', { token });
  assert.equal(overview.status, 200, 'token continua válido após reiniciar');
});

test('token aceito pela query (?auth=) para proxies que removem headers', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { token } = await panel.login();
  const response = await panel.call(`/api/overview?auth=${encodeURIComponent(token)}`);
  assert.equal(response.status, 200);
});

test('token adulterado é recusado', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { token } = await panel.login();
  const [payload] = token.split('.');
  const forged = `${payload}.assinaturafalsa`;
  const response = await panel.call('/api/overview', { token: forged });
  assert.equal(response.status, 401);

  // Senha diferente ⇒ nova chave de assinatura ⇒ token antigo inválido.
  const other = await startPanel(env, { password: 'outra-senha' });
  t.after(() => other.close());
  const wrongKey = await other.call('/api/overview', { token });
  assert.equal(wrongKey.status, 401);
});

test('HTML serve os assets com versão e sem cache', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const page = await panel.call('/');
  assert.match(page.text, /app\.js\?v=/, 'script com versão (fura cache antigo)');
  assert.match(page.text, /styles\.css\?v=/);
  assert.match(String(page.headers.get('cache-control')), /no-store/);
});

test('CSS respeita o atributo hidden (a tela de login desaparece ao entrar)', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const css = await panel.call('/styles.css');

  // Regressão: ".login { display: grid }" vencia o [hidden] do navegador, então a
  // tela de senha continuava visível depois do login, por cima do painel.
  assert.match(
    css.text,
    /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s,
    'regra global [hidden] precisa vencer os display das classes',
  );
  assert.match(css.text, /\.login\s*\{[^}]*display:\s*grid/s, 'layout do login preservado');

  // A versão dos assets deve cobrir também o CSS: mudar só o estilo invalida o cache.
  const hash = crypto.createHash('sha1');
  for (const file of ['index.html', 'styles.css', 'app.js']) {
    hash.update(fs.readFileSync(path.join(PUBLIC_DIR, file)));
  }
  assert.equal(ASSET_VERSION, hash.digest('hex').slice(0, 8));

  const page = await panel.call('/');
  assert.match(page.text, /styles\.css\?v=/);
  assert.match(page.text, /id="login-submit"/, 'botão de entrada identificável para o estado "Entrando…"');
});

test('nome do staff: o painel resolve pelo Discord e permite editar', async (t) => {
  const DEFAULT_STAFF_ID = '900000000000000900';
  const env = await createTestEnv({
    members: { [DEFAULT_STAFF_ID]: { inGuild: true, displayName: 'pedrosa17' } },
    settings: {},
  });
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { token } = await panel.login();

  // Sem nome cadastrado, o painel usa o nome do membro no Discord (e guarda).
  const first = await panel.call('/api/overview', { token });
  assert.equal(first.status, 200);
  assert.equal(first.json.staff[0].staffName, 'pedrosa17');

  // Mesmo que o membro saia do cache do bot, o nome já resolvido permanece.
  env.gateway.members.delete(DEFAULT_STAFF_ID);
  const second = await panel.call('/api/overview', { token });
  assert.equal(second.json.staff[0].staffName, 'pedrosa17');

  // Edição manual pelo painel (rota exige sessão).
  const anonymous = await panel.call(`/api/staff/${DEFAULT_STAFF_ID}/name`, {
    method: 'PUT',
    body: { staffName: 'Pedro SA' },
  });
  assert.equal(anonymous.status, 401);

  const renamed = await panel.call(`/api/staff/${DEFAULT_STAFF_ID}/name`, {
    method: 'PUT',
    body: { staffName: '  Pedro   SA  ' },
    token,
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.staffName, 'Pedro SA', 'espaços normalizados');

  const afterRename = await panel.call('/api/overview', { token });
  assert.equal(afterRename.json.staff[0].staffName, 'Pedro SA');
  const report = await panel.call('/api/report', { token });
  assert.equal(report.json.staff.find((item) => item.userId === DEFAULT_STAFF_ID).staffName, 'Pedro SA');

  // Nome manual não é sobrescrito pela resolução automática.
  env.gateway.members.set(DEFAULT_STAFF_ID, { inGuild: true, displayName: 'outro-nome' });
  const again = await panel.call('/api/overview', { token });
  assert.equal(again.json.staff[0].staffName, 'Pedro SA');

  // Limpar ("Usar nome do Discord") remove o nome manual.
  const cleared = await panel.call(`/api/staff/${DEFAULT_STAFF_ID}/name`, {
    method: 'PUT',
    body: { staffName: '' },
    token,
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.staffName, null);
});

test('nome definido pela escala vale sem turnos e aparece no painel', async (t) => {
  const env = await createTestEnv({ staff: false, settings: {} });
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { token } = await panel.login();
  const saved = await panel.call(`/api/staff/${STAFF}/shifts`, {
    method: 'PUT',
    body: { staffName: 'mika', shifts: [] },
    token,
  });
  assert.equal(saved.status, 200);

  const overview = await panel.call('/api/overview', { token });
  assert.equal(overview.json.staff[0].staffName, 'mika', 'nome salvo mesmo sem turno');
});

test('todo id usado pelo app.js existe no HTML (nada quebra ao carregar o painel)', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const page = await panel.call('/');
  const js = await panel.call('/app.js');
  const ids = new Set();
  for (const match of js.text.matchAll(/\$\('([a-z0-9-]+)'\)/gi)) ids.add(match[1]);
  for (const match of js.text.matchAll(/getElementById\('([a-z0-9-]+)'\)/gi)) ids.add(match[1]);
  assert.ok(ids.size > 10, 'o painel usa vários elementos');

  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(page.text));
  assert.deepEqual(missing, [], `ids ausentes no index.html: ${missing.join(', ')}`);
});

test('webhook da escala: salvar, ler e enviar pelo painel', async (t) => {
  const http = require('node:http');
  const { SETTING_KEY } = require('../src/systems/hourbank/scheduleBroadcast');

  const env = await createTestEnv();
  const panel = await startPanel(env);

  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await panel.close();
    await env.cleanup();
  });

  await env.services.hourBank.setSchedule({
    guildId: env.guildId,
    userId: STAFF,
    staffName: 'pedrosa17',
    shifts: [{ weekday: 1, start: '12:00', end: '18:00' }],
  });

  const { token } = await panel.login();

  // Rotas exigem sessão.
  assert.equal((await panel.call('/api/schedule/webhook')).status, 401);
  assert.equal(
    (await panel.call('/api/schedule/webhook', { method: 'PUT', body: { url: 'https://discord.com/api/webhooks/1/x' } })).status,
    401,
  );
  assert.equal((await panel.call('/api/schedule/send', { method: 'POST' })).status, 401);

  // Endereço inválido é recusado com mensagem clara.
  const invalid = await panel.call('/api/schedule/webhook', {
    method: 'PUT',
    body: { url: 'https://exemplo.com/hook' },
    token,
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /Webhook inválido/);

  // Enviar sem webhook configurado.
  const notConfigured = await panel.call('/api/schedule/send', { method: 'POST', token });
  assert.equal(notConfigured.status, 400);
  assert.match(notConfigured.json.error, /Nenhum webhook cadastrado/);

  // Webhook válido é salvo e devolvido.
  const discordUrl = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789';
  const saved = await panel.call('/api/schedule/webhook', { method: 'PUT', body: { url: discordUrl }, token });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.configured, true);
  const current = await panel.call('/api/schedule/webhook', { token });
  assert.equal(current.json.url, discordUrl);

  // Envio real (webhook apontando para o servidor local de teste).
  const localUrl = `http://127.0.0.1:${server.address().port}/webhooks/1/token`;
  await env.services.settings.set(SETTING_KEY, localUrl);
  const sent = await panel.call('/api/schedule/send', { method: 'POST', token });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.ok, true);
  assert.equal(sent.json.staffCount, 1);
  assert.equal(sent.json.shiftCount, 1);
  assert.match(sent.json.week.startKey, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(received.length, 1);
  assert.equal(received[0].embeds[0].title, 'ESCALA DA SEMANA');
  assert.match(received[0].embeds[0].fields[0].value, /pedrosa17/);

  // Falha do Discord vira mensagem no painel (não 500).
  await env.services.settings.set(SETTING_KEY, 'http://127.0.0.1:1/webhooks/1/token');
  const failed = await panel.call('/api/schedule/send', { method: 'POST', token });
  assert.equal(failed.status, 400);
  assert.ok(failed.json.error.length > 0);
});

test('envio automático da escala: configurar, validar e desligar pelo painel', async (t) => {
  const env = await createTestEnv();
  const panel = await startPanel(env);
  t.after(async () => {
    await panel.close();
    await env.cleanup();
  });

  const { token } = await panel.login();

  // Sem webhook salvo não dá para ativar o envio automático.
  const noUrl = await panel.call('/api/schedule/webhook', {
    method: 'PUT',
    body: { auto: true, day: 1, time: '09:00' },
    token,
  });
  assert.equal(noUrl.status, 400);
  assert.match(noUrl.json.error, /Cadastre a URL do webhook/);

  const discordUrl = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789';
  const enabled = await panel.call('/api/schedule/webhook', {
    method: 'PUT',
    body: { url: discordUrl, auto: true, day: 3, time: '18:30' },
    token,
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.json.auto, true);
  assert.equal(enabled.json.day, 3);
  assert.equal(enabled.json.dayLabel, 'Quarta');
  assert.equal(enabled.json.time, '18:30');

  const current = await panel.call('/api/schedule/webhook', { token });
  assert.equal(current.json.auto, true);
  assert.equal(current.json.dayLabel, 'Quarta');
  assert.equal(current.json.lastWeek, null);
  assert.equal(current.json.lastWeekLabel, null);

  // Valores inválidos são recusados sem quebrar a configuração salva.
  const badDay = await panel.call('/api/schedule/webhook', {
    method: 'PUT',
    body: { url: discordUrl, auto: true, day: 9, time: '18:30' },
    token,
  });
  assert.equal(badDay.status, 400);
  assert.match(badDay.json.error, /Dia da semana inválido/);

  const badTime = await panel.call('/api/schedule/webhook', {
    method: 'PUT',
    body: { url: discordUrl, auto: true, day: 3, time: '7h' },
    token,
  });
  assert.equal(badTime.status, 400);
  assert.match(badTime.json.error, /Horário inválido/);

  // Remover o webhook desliga o automático.
  const cleared = await panel.call('/api/schedule/webhook', {
    method: 'PUT',
    body: { url: '', auto: true, day: 3, time: '18:30' },
    token,
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.configured, false);
  assert.equal(cleared.json.auto, false, 'sem webhook o envio automático fica desligado');
});
