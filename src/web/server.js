'use strict';

/**
 * Painel web do banco de horas.
 *
 * Servidor HTTP nativo (sem dependências): autenticação por senha
 * (`WEB_PANEL_PASSWORD`), sessão em cookie HttpOnly e API JSON consumida pela
 * interface em `src/web/public`.
 *
 * Rotas:
 *   GET  /                     → interface
 *   POST /api/login            → cria a sessão
 *   POST /api/logout
 *   GET  /api/overview         → staff + escala + horas do período
 *   GET  /api/report           → relatório agregado
 *   GET  /api/sessions         → sessões detalhadas (entrada/saída/atrasos)
 *   PUT  /api/staff/:id/shifts → salva a escala semanal
 *   DELETE /api/staff/:id/shifts
 *   GET  /api/health
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLogger } = require('../utils/logger');

const logger = createLogger('web');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const SESSION_COOKIE = 'vantus_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Corpo da requisição muito grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Cria o servidor HTTP do painel.
 * @param {{services: object, env: object, password?: string, guildId?: string}} options
 */
function createWebServer({ services, env = {}, password = null, guildId = null }) {
  const sessions = new Map();
  const attempts = new Map();
  const secret = password || env.webPanelPassword || null;
  const secretHash = secret ? sha256(secret) : null;

  const resolveGuildId = () => guildId ?? services.settings.get('guild_id') ?? env.guildId ?? null;

  function createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
  }

  function isAuthed(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return false;
    const session = sessions.get(token);
    if (!session) return false;
    if (session.expiresAt < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function prune() {
    const now = Date.now();
    for (const [token, session] of sessions) if (session.expiresAt < now) sessions.delete(token);
    for (const [ip, entry] of attempts) if (now - entry.first > LOGIN_WINDOW_MS) attempts.delete(ip);
  }

  function registerAttempt(ip) {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
      attempts.set(ip, { first: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= LOGIN_MAX_ATTEMPTS;
  }

  function serveStatic(res, urlPath) {
    const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = path.join(PUBLIC_DIR, relative);
    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Não encontrado');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
    });
    fs.createReadStream(filePath).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      if (pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, at: Date.now() });
      }

      if (pathname === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress || 'unknown';
        if (!registerAttempt(ip)) {
          return sendJson(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos.' });
        }
        if (!secretHash) {
          return sendJson(res, 503, { error: 'Painel desativado: configure WEB_PANEL_PASSWORD.' });
        }
        const body = await readBody(req);
        if (!body.password || !safeEqual(sha256(body.password), secretHash)) {
          return sendJson(res, 401, { error: 'Senha incorreta.' });
        }
        const token = createSession();
        const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
        return sendJson(
          res,
          200,
          { ok: true },
          {
            'set-cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${
              SESSION_TTL_MS / 1000
            }${secure}`,
          },
        );
      }

      if (pathname === '/api/logout' && req.method === 'POST') {
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (token) sessions.delete(token);
        return sendJson(res, 200, { ok: true }, {
          'set-cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
        });
      }

      // A partir daqui tudo exige sessão.
      if (pathname.startsWith('/api/')) {
        if (!isAuthed(req)) return sendJson(res, 401, { error: 'Sessão expirada. Entre novamente.' });
        prune();
      }

      const currentGuildId = resolveGuildId();
      if (pathname.startsWith('/api/') && !currentGuildId) {
        return sendJson(res, 409, { error: 'Nenhum servidor configurado (GUILD_ID).' });
      }

      if (pathname === '/api/overview' && req.method === 'GET') {
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        return sendJson(res, 200, {
          guildId: currentGuildId,
          timezone: env.timezone ?? null,
          reminderMinutes: services.hourBank.reminderMinutes,
          enabled: services.hourBank.enabled,
          ...services.hourBank.overview(currentGuildId, { from, to }),
        });
      }

      if (pathname === '/api/report' && req.method === 'GET') {
        const report = services.hourBank.report(currentGuildId, {
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
        });
        return sendJson(res, 200, report);
      }

      if (pathname === '/api/sessions' && req.method === 'GET') {
        const sessionsList = services.hourBank.sessions(currentGuildId, {
          userId: url.searchParams.get('userId'),
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
        });
        return sendJson(res, 200, { sessions: sessionsList });
      }

      const shiftsMatch = /^\/api\/staff\/(\d{5,25})\/shifts$/.exec(pathname);
      if (shiftsMatch) {
        const userId = shiftsMatch[1];
        if (req.method === 'PUT') {
          const body = await readBody(req);
          const shifts = Array.isArray(body.shifts) ? body.shifts : [];
          try {
            const saved = await services.hourBank.setSchedule({
              guildId: currentGuildId,
              userId,
              staffName: body.staffName || null,
              shifts,
            });
            logger.info(`Escala de ${userId} atualizada pelo painel (${saved.length} turno(s)).`);
            return sendJson(res, 200, { ok: true, shifts: saved });
          } catch (error) {
            return sendJson(res, 400, { error: error.message });
          }
        }
        if (req.method === 'DELETE') {
          await services.hourBank.clearSchedule({ guildId: currentGuildId, userId });
          return sendJson(res, 200, { ok: true });
        }
      }

      if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Rota não encontrada.' });

      // Interface (só faz sentido quando existe senha configurada).
      if (!secretHash) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Painel desativado: configure WEB_PANEL_PASSWORD no .env.');
        return;
      }
      return serveStatic(res, pathname);
    } catch (error) {
      logger.error(`Erro no painel web (${pathname})`, error);
      if (!res.headersSent) sendJson(res, 500, { error: error.message || 'Erro interno.' });
      else res.end();
    }
  });

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return { server, sessions, secretHash };
}

/**
 * Sobe o painel web (0.0.0.0 para funcionar em container/SquareCloud).
 * @returns {Promise<{close: Function, port: number}|null>}
 */
function startWebServer({ services, env = {}, logger: customLogger = logger }) {
  const password = env.webPanelPassword || null;
  const port = Number(env.webPanelPort) || 8080;
  const host = env.webPanelHost || '0.0.0.0';

  if (!password) {
    customLogger.warn(
      'Painel web desativado: defina WEB_PANEL_PASSWORD no .env para habilitar o banco de horas pela web.',
    );
    return Promise.resolve(null);
  }

  const { server } = createWebServer({ services, env });
  return new Promise((resolve) => {
    server.once('error', (error) => {
      customLogger.error(`Falha ao iniciar o painel web na porta ${port}: ${error.message}`);
      resolve(null);
    });
    server.listen(port, host, () => {
      customLogger.info(`Painel web do banco de horas em http://${host}:${port}`);
      resolve({
        server,
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            // encerra conexões keep-alive para o processo não travar
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
          }),
      });
    });
  });
}

module.exports = { createWebServer, startWebServer, PUBLIC_DIR, SESSION_COOKIE, SESSION_TTL_MS };
