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
 *   GET  /api/schedule         → horário de funcionamento + status atual
 *   PUT  /api/schedule         → salva o horário (e o estado manual) da central
 *   PUT  /api/central          → abre/fecha a central na hora ou volta ao horário
 *   GET  /api/evaluations      → avaliações do período (notas, média, ranking)
 *   PUT  /api/evaluations/channel → define o canal do Discord que recebe as avaliações
 *   POST /api/staff/:id/off-service → tira o staff de serviço (encerra a sessão)
 *   PUT  /api/staff/:id/block      → bloqueia/desbloqueia o staff de entrar em serviço
 *   DELETE /api/staff/:id          → remove o staff da equipe
 *   PUT  /api/staff/:id/shifts → salva a escala semanal
 *   DELETE /api/staff/:id/shifts
 *   POST /api/staff/:id/reset-hours → zera as horas de um staff
 *   POST /api/hours/reset         → zera as horas de toda a equipe
 *   GET  /api/health
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLogger } = require('../utils/logger');
const {
  getWebhookUrl,
  setWebhookUrl,
  sendWeeklySchedule,
} = require('../systems/hourbank/scheduleBroadcast');
const { takeStaffOffService, StaffServingError } = require('../systems/staff/offService');
const { blockStaff, unblockStaff, removeStaff } = require('../systems/staff/staffAdmin');
const { RATING_META } = require('../config/theme');
const { isValidSchedule, isValidHHMM } = require('../utils/validators');
const { DAY_KEYS, DAY_LABELS, evaluateSchedule } = require('../utils/time');
const { COLORS } = require('../config/theme');
const { formatDateTime, startOfDay } = require('../utils/time');
const { parseDayStart } = require('../systems/hourbank/hourBankService');

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

/** Versão dos assets (muda a cada carregamento do processo) — invalida o cache do navegador. */
const ASSET_VERSION = (() => {
  try {
    const hash = crypto.createHash('sha1');
    for (const file of ['index.html', 'styles.css', 'app.js']) {
      hash.update(fs.readFileSync(path.join(PUBLIC_DIR, file)));
    }
    return hash.digest('hex').slice(0, 8);
  } catch {
    return String(Date.now());
  }
})();
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

/**
 * Intervalo do período vindo da query (`from`/`to` em AAAA-MM-DD, fuso do bot).
 * Sem `from`: últimos 7 dias. Sem `to`: agora.
 */
function periodRange(url, { timeZone = undefined, now = Date.now() } = {}) {
  const fromTs = parseDayStart(url.searchParams.get('from'), timeZone);
  const toTs = parseDayStart(url.searchParams.get('to'), timeZone);
  const from = fromTs ?? startOfDay(new Date(now - 6 * 24 * 3600000), timeZone);
  const to = toTs ? toTs + 24 * 3600000 - 1 : now;
  return { from, to };
}

/**
 * Estado do horário de funcionamento para o painel.
 * `schedule` sempre traz as 7 chaves (dias fechados = lista vazia).
 */
function schedulePayload(services, guildId) {
  const stored = services.settings.get('schedule') || {};
  const schedule = {};
  for (const key of DAY_KEYS) {
    const windows = Array.isArray(stored[key]) ? stored[key] : [];
    schedule[key] = windows.map((window) => ({ open: window.open, close: window.close }));
  }

  const status = services.schedule.isOpen(guildId);
  const today = services.schedule.todayWindow(guildId);
  // O que a agenda sozinha diz (ignorando o estado manual).
  const scheduledOpen = evaluateSchedule(schedule, new Date()).open;
  const manual = services.settings.get('central_manual');

  return {
    schedule,
    days: DAY_KEYS.map((key) => ({
      key,
      label: DAY_LABELS[key] ?? key,
      windows: schedule[key],
    })),
    centralManual: manual,
    status: {
      open: status.open,
      manual: status.manual,
      label: status.open ? 'ABERTA' : 'FECHADA',
      // true = aberta pelo horário mas fechada manualmente (ou o contrário)
      scheduledOpen,
      overridden: status.open !== scheduledOpen,
      nextOpen: status.nextOpen ?? null,
      today: today.text,
    },
    timezone: services.hourBank?.timeZone ?? null,
  };
}

/**
 * Aplica o estado manual da central pelo fluxo oficial (fila, avisos e
 * auditoria), não apenas gravando a configuração.
 * @param {'auto'|'open'|'closed'} state
 */
async function applyCentralState(services, guildId, state, { actorTag = 'painel web', reason = null } = {}) {
  if (state === 'open') {
    return services.central.open({ guildId, actorId: actorTag, actorTag, manual: true });
  }
  if (state === 'closed') {
    return services.central.close({ guildId, actorId: actorTag, actorTag, manual: true, reason });
  }
  // automático: a agenda volta a mandar
  await services.settings.set('central_manual', 'auto');
  await services.audit.log({
    guildId,
    type: 'CENTRAL_AUTO',
    actorId: actorTag,
    actorTag,
    message: '⚙️ O **painel web** devolveu a central ao **horário de funcionamento** (automático).',
    color: COLORS.MUTED,
  });
  await services.panels.refresh(guildId, { immediate: true }).catch(() => null);
  return services.central.status(guildId);
}

/** Aceita { mon: [{open, close}] } (ou um único objeto por dia). */
function normalizeSchedule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Formato de horário inválido.');
  }
  const result = {};
  for (const key of DAY_KEYS) {
    const value = input[key];
    if (value === undefined || value === null) {
      result[key] = [];
      continue;
    }
    const windows = Array.isArray(value) ? value : [value];
    result[key] = windows
      .map((window) => ({
        open: String(window?.open ?? '').trim(),
        close: String(window?.close ?? '').trim(),
      }))
      .filter((window) => window.open || window.close);

    for (const window of result[key]) {
      if (!isValidHHMM(window.open) || !isValidHHMM(window.close)) {
        throw new Error(`Horário inválido em ${key}: use HH:MM (ex.: 12:00).`);
      }
      if (window.open === window.close) {
        throw new Error(`Em ${key} a abertura e o fechamento não podem ser iguais (${window.open}).`);
      }
    }
  }

  const unknown = Object.keys(input).filter((key) => !DAY_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`Dia desconhecido: ${unknown.join(', ')}.`);
  return result;
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
  // Espaços nas pontas (senha colada do gerenciador/terminal) não devem invalidar o acesso.
  const secret = String(password || env.webPanelPassword || '').trim() || null;
  const secretHash = secret ? sha256(secret) : null;
  // Chave de assinatura derivada da senha: os tokens continuam válidos mesmo se o
  // processo reiniciar (o preview e a SquareCloud reiniciam com frequência).
  const signingKey = secretHash ? crypto.createHmac('sha256', secretHash).update('vantus-web-panel').digest() : null;
  const revoked = new Set();

  const resolveGuildId = () => guildId ?? services.settings.get('guild_id') ?? env.guildId ?? null;

  function sign(payload) {
    return crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
  }

  /** Token assinado (stateless): `base64url({exp,iat}).assinatura`. */
  function createSession() {
    const payload = Buffer.from(
      JSON.stringify({ iat: Date.now(), exp: Date.now() + SESSION_TTL_MS, jti: crypto.randomUUID() }),
    ).toString('base64url');
    const token = `${payload}.${sign(payload)}`;
    sessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
  }

  /** @returns {{ok: boolean, reason: string|null}} */
  function verifyToken(token) {
    if (!token) return { ok: false, reason: 'sem_token' };
    if (revoked.has(token)) return { ok: false, reason: 'token_desconhecido' };

    const [payload, signature] = String(token).split('.');
    if (!payload || !signature) return { ok: false, reason: 'token_desconhecido' };

    const expected = sign(payload);
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      return { ok: false, reason: 'token_desconhecido' };
    }

    let data = null;
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, reason: 'token_desconhecido' };
    }
    if (!data?.exp || data.exp < Date.now()) return { ok: false, reason: 'expirado' };
    return { ok: true, reason: null };
  }

  /**
   * Token da sessão, na ordem: Authorization: Bearer (iframe/terceiros) →
   * query `auth` (proxies que removem headers) → cookie (navegador normal).
   */
  function tokenFrom(req, url = null) {
    const header = String(req.headers.authorization || '');
    if (header.toLowerCase().startsWith('bearer ')) {
      const value = header.slice(7).trim();
      if (value) return value;
    }
    const queryToken = url?.searchParams?.get('auth');
    if (queryToken) return queryToken;
    return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
  }

  /** @returns {{ok: boolean, reason: string|null}} */
  function checkSession(req, url = null) {
    return verifyToken(tokenFrom(req, url));
  }

  function isAuthed(req, url = null) {
    return checkSession(req, url).ok;
  }

  /**
   * Cookie da sessão.
   * Em contextos de terceiros (iframe do painel de preview, proxy https) o
   * navegador só aceita `SameSite=None; Secure` — por isso o atributo é
   * decidido pela origem da requisição, e o token também é devolvido no corpo
   * do login (o cliente pode usar Authorization: Bearer).
   */
  function sessionCookie(req, token, maxAgeSeconds) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
    const host = String(req.headers.host || '');
    const isHttps = forwardedProto.includes('https') || /:(443)$/.test(host);
    const sameSite = isHttps ? 'None; Secure' : 'Lax';
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAgeSeconds}`;
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

    // Nunca servir cache antigo: durante o desenvolvimento/atualizações o
    // navegador mantinha o JS velho e o login parecia "expirado".
    const headers = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'no-store, no-cache, must-revalidate',
      'pragma': 'no-cache',
      'x-content-type-options': 'nosniff',
      // O painel também é exibido dentro de iframes (preview/proxy): sem
      // X-Frame-Options e com frame-ancestors liberado, senão a tela fica em branco.
      'content-security-policy': "frame-ancestors *",
    };

    if (ext === '.html') {
      // Injeta a versão dos assets para furar qualquer cache intermediário.
      const html = fs.readFileSync(filePath, 'utf8');
      const body = html
        .replace(/href="styles\.css(\?[^"]*)?"/, `href="styles.css?v=${ASSET_VERSION}"`)
        .replace(/src="app\.js(\?[^"]*)?"/, `src="app.js?v=${ASSET_VERSION}"`);
      res.writeHead(200, { ...headers, 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  }

  // Nomes exibidos: o painel mostra "Usuário <id>" quando não há nome cadastrado.
  // Aqui completamos com o nome do membro no Discord (cache curto + persistência),
  // sem nunca sobrescrever um nome definido manualmente no painel.
  const nameCache = new Map();
  const NAME_TTL_MS = 10 * 60 * 1000;
  const NAME_RETRY_MS = 60 * 1000;

  /** Nome exibido do staff (painel → Discord → id). Usado nos logs de auditoria. */
  function displayNameFor(guildId, userId) {
    const known = services.hourBank?.nameOf?.(guildId, userId);
    return known || `Usuário ${userId}`;
  }

  async function fillStaffNames(guildId, rows) {
    const gateway = services.gateway;
    if (!gateway || typeof gateway.getMember !== 'function' || !guildId) return;
    const pending = rows.filter((row) => row && row.userId && !row.staffName).slice(0, 40);
    if (!pending.length) return;

    await Promise.all(
      pending.map(async (row) => {
        const key = `${guildId}:${row.userId}`;
        const cached = nameCache.get(key);
        const ttl = cached?.name ? NAME_TTL_MS : NAME_RETRY_MS;
        if (cached && Date.now() - cached.at < ttl) {
          if (cached.name) row.staffName = cached.name;
          return;
        }
        let name = null;
        try {
          const info = await gateway.getMember(guildId, row.userId);
          if (info && info.inGuild !== false) name = info.displayName || info.username || null;
        } catch (error) {
          logger.debug(`Não foi possível resolver o nome de ${row.userId}: ${error.message}`);
        }
        nameCache.set(key, { name, at: Date.now() });
        if (!name) return;
        row.staffName = name;
        try {
          services.hourBank.rememberDiscordName(guildId, row.userId, name);
        } catch (error) {
          logger.debug(`Falha ao guardar o nome de ${row.userId}: ${error.message}`);
        }
      }),
    );
  }

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    res.on('finish', () => {
      const line = `${req.method} ${pathname} → ${res.statusCode} (${Date.now() - startedAt}ms)`;
      if (res.statusCode >= 500) logger.error(line);
      else if (res.statusCode >= 400) logger.warn(line);
      else logger.debug(line);
    });

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
        if (!body.password || !safeEqual(sha256(String(body.password).trim()), secretHash)) {
          return sendJson(res, 401, { error: 'Senha incorreta.' });
        }
        const token = createSession();
        return sendJson(
          res,
          200,
          { ok: true, token, expiresIn: SESSION_TTL_MS / 1000 },
          { 'set-cookie': sessionCookie(req, token, SESSION_TTL_MS / 1000) },
        );
      }

      if (pathname === '/api/logout' && req.method === 'POST') {
        const token = tokenFrom(req, url);
        if (token) {
          sessions.delete(token);
          revoked.add(token);
        }
        return sendJson(res, 200, { ok: true }, {
          'set-cookie': sessionCookie(req, '', 0),
        });
      }

      // A partir daqui tudo exige sessão.
      if (pathname.startsWith('/api/')) {
        const check = checkSession(req, url);
        if (!check.ok) {
          logger.warn(
            `Acesso negado em ${pathname} (${check.reason}) • cookie: ${
              req.headers.cookie ? 'sim' : 'não'
            } • bearer: ${req.headers.authorization ? 'sim' : 'não'} • query: ${
              url.searchParams.get('auth') ? 'sim' : 'não'
            }`,
          );
          return sendJson(res, 401, {
            error: check.reason === 'expirado' ? 'Sessão expirada. Entre novamente.' : 'Sessão inválida. Entre novamente.',
            reason: check.reason,
          });
        }
        prune();
      }

      const currentGuildId = resolveGuildId();
      if (pathname.startsWith('/api/') && !currentGuildId) {
        return sendJson(res, 409, { error: 'Nenhum servidor configurado (GUILD_ID).' });
      }

      if (pathname === '/api/overview' && req.method === 'GET') {
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const overview = services.hourBank.overview(currentGuildId, { from, to });
        await fillStaffNames(currentGuildId, overview.staff);
        return sendJson(res, 200, {
          guildId: currentGuildId,
          timezone: env.timezone ?? null,
          reminderMinutes: services.hourBank.reminderMinutes,
          enabled: services.hourBank.enabled,
          ...overview,
        });
      }

      if (pathname === '/api/report' && req.method === 'GET') {
        const report = services.hourBank.report(currentGuildId, {
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
        });
        await fillStaffNames(currentGuildId, report.staff);
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

      if (pathname === '/api/schedule' && req.method === 'GET') {
        return sendJson(res, 200, schedulePayload(services, currentGuildId));
      }

      if (pathname === '/api/central' && req.method === 'PUT') {
        const body = await readBody(req);
        const state = String(body.state ?? '').trim();
        if (!['auto', 'open', 'closed'].includes(state)) {
          return sendJson(res, 400, {
            error: 'Estado inválido: use "open", "closed" ou "auto".',
          });
        }
        const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : null;

        await applyCentralState(services, currentGuildId, state, { reason: reason || null });

        const payload = schedulePayload(services, currentGuildId);
        const labels = { open: 'aberta', closed: 'fechada', auto: 'no automático' };
        return sendJson(res, 200, {
          ok: true,
          message: `Central ${labels[state]}.`,
          queueCleared: state === 'closed' && services.settings.get('queue_policy_on_close') === 'clear',
          ...payload,
        });
      }

      if (pathname === '/api/schedule' && req.method === 'PUT') {
        const body = await readBody(req);
        const incoming = body.schedule;
        const manual = body.centralManual ?? null;

        if (manual !== null && !['auto', 'open', 'closed'].includes(manual)) {
          return sendJson(res, 400, { error: 'Estado da central inválido (auto/open/closed).' });
        }

        let schedule = null;
        if (incoming !== undefined) {
          try {
            schedule = normalizeSchedule(incoming);
          } catch (error) {
            return sendJson(res, 400, { error: error.message });
          }
          if (!isValidSchedule(schedule)) {
            return sendJson(res, 400, { error: 'Horário inválido: use HH:MM em todos os turnos.' });
          }
        }

        const before = services.settings.get('schedule');
        if (schedule) await services.settings.set('schedule', schedule);
        // O estado manual passa pelo fluxo oficial (fila, avisos e auditoria).
        if (manual !== null) await applyCentralState(services, currentGuildId, manual);

        if (schedule || manual !== null) {
          const changes = [];
          if (schedule) changes.push('horário de funcionamento');
          if (manual !== null) changes.push(`estado manual (${manual})`);
          await services.audit
            .log({
              guildId: currentGuildId,
              type: 'SCHEDULE_UPDATE',
              actorId: 'painel web',
              message: `⚙️ O **painel web** atualizou ${changes.join(' e ')} da central.\n` +
                `**Agora:** ${services.schedule.describe(currentGuildId)}`,
              color: RATING_META.MUITO_BOM.color,
              metadata: { before, schedule, manual },
            })
            .catch(() => null);
          await services.panels.refresh(currentGuildId).catch(() => null);
          logger.info(
            `Horário da central atualizado pelo painel web (${services.schedule.statusLabel(currentGuildId)}).`,
          );
        }

        return sendJson(res, 200, { ok: true, ...schedulePayload(services, currentGuildId) });
      }

      if (pathname === '/api/evaluations' && req.method === 'GET') {
        const range = periodRange(url, { timeZone: env.timezone });
        const staffFilter = (url.searchParams.get('staffId') || '').trim() || null;
        if (staffFilter && !/^\d{5,25}$/.test(staffFilter)) {
          return sendJson(res, 400, { error: 'staffId inválido.' });
        }
        const stats = services.evaluations.stats(currentGuildId, { ...range, staffId: staffFilter });
        const entries = services.evaluations.list(currentGuildId, {
          ...range,
          limit: 500,
          staffId: staffFilter,
        });

        const names = services.hourBank.names(currentGuildId);
        const rows = [];
        for (const entry of entries) {
          const attendance = services.repositories.attendance.findByIdSync(currentGuildId, entry.attendance_id);
          rows.push({
            attendanceId: entry.attendance_id,
            protocol: entry.protocol,
            protocolLabel: `#${String(entry.protocol).padStart(4, '0')}`,
            userId: entry.user_id,
            userName: attendance?.username ?? null,
            staffId: entry.staff_id,
            staffName: names.get(entry.staff_id) ?? entry.staff_tag ?? null,
            rating: entry.rating,
            ratingLabel: RATING_META[entry.rating]?.label ?? entry.rating,
            score: RATING_META[entry.rating]?.score ?? null,
            durationSeconds: Number(attendance?.duration_seconds) || 0,
            createdAt: entry.created_at,
            dateLabel: formatDateTime(new Date(entry.created_at)),
          });
        }

        // Opções do filtro por atendente: quem tem avaliação no período + os
        // nomes cadastrados no painel (para filtrar quem ainda não foi avaliado).
        const staffOptions = new Map();
        for (const item of stats.byStaff) {
          staffOptions.set(item.staffId, item.staffName || names.get(item.staffId) || item.staffId);
        }
        for (const [userId, name] of names.entries()) {
          if (!staffOptions.has(userId)) staffOptions.set(userId, name);
        }

        return sendJson(res, 200, {
          guildId: currentGuildId,
          period: range,
          channelId: services.evaluations.channelId,
          staffFilter,
          alertMinAverage: Number(services.settings.get('evaluations_alert_min_average')) || 0,
          staffOptions: [...staffOptions.entries()].map(([userId, name]) => ({ userId, name })),
          ...stats,
          entries: rows,
        });
      }

      if (pathname === '/api/evaluations/alert' && req.method === 'PUT') {
        const body = await readBody(req);
        const value = Number(String(body.minAverage ?? '').replace(',', '.'));
        if (!Number.isFinite(value) || value < 0 || value > 4) {
          return sendJson(res, 400, { error: 'Informe um valor entre 0 e 4 (0 desliga o aviso).' });
        }
        const rounded = Math.round(value * 100) / 100;
        await services.settings.set('evaluations_alert_min_average', rounded);
        logger.info(
          rounded > 0
            ? `Aviso de média das avaliações ativado (abaixo de ${rounded.toFixed(2)}/4).`
            : 'Aviso de média das avaliações desligado.',
        );
        return sendJson(res, 200, { ok: true, alertMinAverage: rounded });
      }

      if (pathname === '/api/evaluations/channel' && req.method === 'PUT') {
        const body = await readBody(req);
        try {
          const channelId = await services.evaluations.setChannelId(body.channelId ?? null);
          logger.info(
            channelId
              ? `Canal de avaliações definido pelo painel: ${channelId}`
              : 'Canal de avaliações removido pelo painel.',
          );
          return sendJson(res, 200, { ok: true, channelId });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (pathname === '/api/schedule/webhook' && req.method === 'GET') {
        return sendJson(res, 200, services.scheduleBroadcast.getConfig());
      }

      if (pathname === '/api/schedule/webhook' && req.method === 'PUT') {
        const body = await readBody(req);
        try {
          let url = null;
          if (body.url !== undefined) {
            url = await setWebhookUrl(services.settings, body.url);
            logger.info(
              url
                ? `Webhook da escala salvo pelo painel (${url.replace(/\/[\w-]{20,}$/, '/•••')}).`
                : 'Webhook da escala removido pelo painel.',
            );
          }
          // Sem webhook não há como enviar: o envio automático é desligado junto.
          const config = await services.scheduleBroadcast.updateConfig({
            auto: url === '' ? false : body.auto,
            day: body.day,
            time: body.time,
          });
          logger.info(
            config.auto
              ? `Envio automático da escala ativado (${config.dayLabel} às ${config.time}).`
              : 'Envio automático da escala desligado.',
          );
          return sendJson(res, 200, { ok: true, ...config });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (pathname === '/api/schedule/send' && req.method === 'POST') {
        try {
          const result = await sendWeeklySchedule({
            settings: services.settings,
            hourBank: services.hourBank,
            guildId: currentGuildId,
            timeZone: env.timezone,
          });
          return sendJson(res, 200, result);
        } catch (error) {
          logger.warn(`Falha ao enviar a escala pelo webhook: ${error.message}`);
          return sendJson(res, 400, { error: error.message });
        }
      }

      const offMatch = /^\/api\/staff\/(\d{5,25})\/off-service$/.exec(pathname);
      if (offMatch && req.method === 'POST') {
        const userId = offMatch[1];
        const body = await readBody(req).catch(() => ({}));
        try {
          const result = await takeStaffOffService({
            services,
            guildId: currentGuildId,
            userId,
            source: 'painel web',
            disconnectVoice: body.disconnectVoice !== false,
            notify: body.notify !== false,
          });
          nameCache.delete(`${currentGuildId}:${userId}`);
          logger.info(`Staff ${userId} retirado de serviço pelo painel web.`);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          if (error instanceof StaffServingError) {
            return sendJson(res, 409, {
              error: error.message,
              code: error.code,
              protocol: error.protocol,
            });
          }
          return sendJson(res, 400, { error: error.message });
        }
      }

      const blockMatch = /^\/api\/staff\/(\d{5,25})\/block$/.exec(pathname);
      if (blockMatch && req.method === 'PUT') {
        const userId = blockMatch[1];
        const body = await readBody(req).catch(() => ({}));
        const blocked = body.blocked !== false; // padrão: bloquear
        const reason =
          typeof body.reason === 'string' && body.reason.trim()
            ? body.reason.trim().slice(0, 200)
            : null;
        try {
          const result = blocked
            ? await blockStaff({ services, guildId: currentGuildId, userId, reason })
            : await unblockStaff({ services, guildId: currentGuildId, userId });
          return sendJson(res, 200, {
            ok: true,
            blocked: result.blocked?.blocked ?? blocked,
            alreadyBlocked: Boolean(result.alreadyBlocked),
            alreadyUnblocked: Boolean(result.alreadyUnblocked),
            endedSession: result.endedSession ?? null,
            message: blocked ? 'Staff bloqueado.' : 'Bloqueio removido.',
          });
        } catch (error) {
          if (error instanceof StaffServingError) {
            return sendJson(res, 409, {
              error: error.message,
              code: error.code,
              protocol: error.protocol,
            });
          }
          return sendJson(res, 400, { error: error.message });
        }
      }

      const removeMatch = /^\/api\/staff\/(\d{5,25})$/.exec(pathname);
      if (removeMatch && req.method === 'DELETE') {
        const userId = removeMatch[1];
        try {
          const result = await removeStaff({ services, guildId: currentGuildId, userId });
          nameCache.delete(`${currentGuildId}:${userId}`);
          return sendJson(res, 200, { ok: true, ...result, message: 'Staff removido da equipe.' });
        } catch (error) {
          if (error instanceof StaffServingError) {
            return sendJson(res, 409, {
              error: error.message,
              code: error.code,
              protocol: error.protocol,
            });
          }
          return sendJson(res, 400, { error: error.message });
        }
      }

      const resetMatch = /^\/api\/staff\/(\d{5,25})\/reset-hours$/.exec(pathname);
      if (resetMatch && req.method === 'POST') {
        const userId = resetMatch[1];
        try {
          const result = await services.hourBank.resetHours({ guildId: currentGuildId, userId });
          const staffName = displayNameFor(currentGuildId, userId);
          await services.audit.log({
            guildId: currentGuildId,
            type: 'HOURS_RESET',
            actorId: 'painel web',
            targetId: userId,
            message:
              `🧹 O **painel web** zerou o banco de horas de **${staffName}**: ` +
              `${result.sessions} sessão(ões) apagada(s), ${result.restarted} sessão(ões) em andamento reiniciada(s).`,
            color: COLORS.MUTED,
            metadata: { userId, ...result },
          });
          logger.info(`Horas de ${userId} zeradas pelo painel web.`);
          return sendJson(res, 200, {
            ok: true,
            message: `Horas de ${staffName} zeradas.`,
            staffName,
            ...result,
          });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (pathname === '/api/hours/reset' && req.method === 'POST') {
        try {
          const result = await services.hourBank.resetHours({ guildId: currentGuildId });
          await services.audit.log({
            guildId: currentGuildId,
            type: 'HOURS_RESET',
            actorId: 'painel web',
            message:
              '🧹 O **painel web** zerou o banco de horas de **toda a equipe**: ' +
              `${result.sessions} sessão(ões) apagada(s), ${result.restarted} sessão(ões) em andamento reiniciada(s).`,
            color: COLORS.MUTED,
            metadata: { ...result, all: true },
          });
          logger.info('Horas de toda a equipe zeradas pelo painel web.');
          return sendJson(res, 200, {
            ok: true,
            message: 'Horas de toda a equipe zeradas.',
            ...result,
          });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      const nameMatch = /^\/api\/staff\/(\d{5,25})\/name$/.exec(pathname);
      if (nameMatch && req.method === 'PUT') {
        const userId = nameMatch[1];
        const body = await readBody(req);
        try {
          const staffName = await services.hourBank.setDisplayName({
            guildId: currentGuildId,
            userId,
            staffName: typeof body.staffName === 'string' ? body.staffName : null,
          });
          nameCache.delete(`${currentGuildId}:${userId}`);
          logger.info(
            staffName
              ? `Nome do staff ${userId} definido pelo painel: ${staffName}`
              : `Nome manual do staff ${userId} removido (volta ao nome do Discord).`,
          );
          return sendJson(res, 200, { ok: true, staffName });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
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

module.exports = { createWebServer, startWebServer, PUBLIC_DIR, SESSION_COOKIE, SESSION_TTL_MS, ASSET_VERSION };
