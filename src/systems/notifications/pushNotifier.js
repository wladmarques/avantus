'use strict';

/**
 * Notificação no celular do dono quando alguém entra na fila.
 *
 * Canal: **ntfy** (push nativo, grátis). O bot publica um JSON no servidor
 * ntfy (`https://ntfy.sh` por padrão) e o app assinado no celular recebe o
 * aviso na hora, mesmo com a tela apagada.
 *
 * Regras:
 * - uma mensagem por pessoa que entra na fila (sem agrupamento);
 * - falha de push NUNCA quebra a fila: vira WARN no log e o último resultado
 *   fica visível no painel (`push_last_status`);
 * - o token de acesso e o tópico são segredos: o painel só mostra o token
 *   mascarado e o tópico nunca aparece em log;
 * - a URL/tópico/segredo ficam no banco (editáveis pelo painel, sem redeploy).
 */

const { createLogger } = require('../../utils/logger');
const { formatDateTime } = require('../../utils/time');

const logger = createLogger('push');

const DEFAULT_ENDPOINT = 'https://ntfy.sh';
const DEFAULT_TTL_SECONDS = 1800; // 30 min: um aviso atrasado ainda vale
const REQUEST_TIMEOUT_MS = 8000;

/** Tópicos do ntfy: letras, números, `-` e `_` (3 a 64 caracteres). */
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

/** "0007" / 7 → "007"? Mantém 4 dígitos como o resto do painel. */
function formatProtocol(protocol) {
  return String(protocol ?? '').padStart(4, '0');
}

/** Endereço válido http(s) e sem barra no fim. */
function normalizeEndpoint(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return DEFAULT_ENDPOINT;
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** Mostra só os últimos 4 caracteres de um segredo (`tk_••••••••1a2b`). */
function maskSecret(secret) {
  const value = String(secret ?? '');
  if (!value) return '';
  const tail = value.slice(-4);
  const prefix = value.startsWith('tk_') ? 'tk_' : '';
  return `${prefix}${'•'.repeat(8)}${tail}`;
}

/** Título do push (curto: aparece no bloqueio de tela). */
function joinTitle(item) {
  return item.userName ? `${item.userName} entrou na fila` : 'Alguém entrou na fila';
}

/**
 * Mensagem de entrada na fila — texto curto, sem emoji, com o que a equipe
 * precisa para abrir o atendimento sem olhar o Discord.
 */
function buildJoinMessage(item, { timeZone = undefined } = {}) {
  const position = Number(item.position) > 0 ? `${item.position}º` : null;
  const queueSize = Number(item.queueSize) > 0 ? String(item.queueSize) : null;
  const place = position
    ? queueSize
      ? `Posição ${position} de ${queueSize}`
      : `Posição ${position}`
    : null;
  const protocol =
    item.protocol !== undefined && item.protocol !== null
      ? `Protocolo #${formatProtocol(item.protocol)}`
      : null;
  return {
    title: joinTitle(item),
    message: [
      `${item.userName || 'Alguém'} entrou na fila`,
      [place, protocol].filter(Boolean).join(' · '),
      `Entrou às ${formatDateTime(item.at || new Date(), timeZone)}`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/** Mensagem do caso "entrou na call, mas não pôde entrar na fila". */
function buildBlockedMessage(item, { timeZone = undefined } = {}) {
  return {
    title: item.userName ? `${item.userName} não entrou na fila` : 'Tentativa de entrada na fila',
    message: [
      `${item.userName || 'Alguém'} tentou entrar na fila`,
      item.reason || 'Central fechada no momento',
      `Tentou às ${formatDateTime(item.at || new Date(), timeZone)}`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

class PushNotifier {
  constructor({ settings, logger: customLogger = logger, fetchImpl = fetch, timeZone = undefined }) {
    this.settings = settings;
    this.logger = customLogger;
    this.fetchImpl = fetchImpl;
    this.timeZone = timeZone;
  }

  /* ------------------------------------------------------------------ */
  /* Configuração                                                        */
  /* ------------------------------------------------------------------ */

  get endpoint() {
    return normalizeEndpoint(this.settings.get('push_endpoint') || DEFAULT_ENDPOINT);
  }

  get topic() {
    const value = String(this.settings.get('push_topic') || '').trim();
    return TOPIC_PATTERN.test(value) ? value : null;
  }

  get token() {
    return String(this.settings.get('push_token') || '').trim() || null;
  }

  /** Ligado só quando o admin ligou **e** existe um destino válido. */
  get enabled() {
    return Boolean(this.settings.get('push_enabled')) && Boolean(this.endpoint) && Boolean(this.topic);
  }

  /** Por que está desligado (texto pronto para o painel). */
  get disabledReason() {
    if (!this.settings.get('push_enabled')) return 'Notificações desligadas no painel.';
    if (!this.endpoint) return 'O endereço do ntfy não é uma URL http(s) válida.';
    if (!this.topic) return 'Informe um tópico válido (3 a 64 letras, números, - ou _).';
    return null;
  }

  get events() {
    return {
      queueJoin: Boolean(this.settings.get('push_on_queue_join')),
      queueBlocked: Boolean(this.settings.get('push_on_queue_blocked')),
    };
  }

  /** Configuração segura para o painel (nunca devolve o token inteiro). */
  config() {
    return {
      enabled: Boolean(this.settings.get('push_enabled')),
      endpoint: String(this.settings.get('push_endpoint') || DEFAULT_ENDPOINT),
      topic: String(this.settings.get('push_topic') || ''),
      hasToken: Boolean(this.token),
      tokenMask: this.token ? maskSecret(this.token) : '',
      events: this.events,
      ready: this.enabled,
      disabledReason: this.disabledReason,
      lastStatus: this.settings.get('push_last_status') || null,
      lastAt: this.settings.get('push_last_at') || null,
      lastError: this.settings.get('push_last_error') || null,
      // tempo entre o bot publicar e o ntfy responder (não inclui a entrega
      // no celular): serve para separar problema do bot de problema do app
      lastLatencyMs: Number(this.settings.get('push_last_latency_ms')) || 0,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Eventos                                                             */
  /* ------------------------------------------------------------------ */

  /** Alguém entrou na fila (botão, `/entrar` ou automaticamente pela call). */
  async queueJoined(item) {
    if (!this.events.queueJoin) return { skipped: 'evento desligado' };
    return this._send(buildJoinMessage(item, { timeZone: this.timeZone }), {
      kind: 'queue_join',
      // Sempre **high**: no Android isso vira uma mensagem FCM de prioridade
      // alta, entregue mesmo com o celular em modo de espera (doze). Com
      // prioridade normal o Firebase pode segurar a entrega por minutos.
      priority: 'high',
    });
  }

  /** Alguém entrou na call, mas a central estava fechada / sem staff. */
  async queueBlocked(item) {
    if (!this.events.queueBlocked) return { skipped: 'evento desligado' };
    return this._send(buildBlockedMessage(item, { timeZone: this.timeZone }), {
      kind: 'queue_blocked',
      priority: 'default',
    });
  }

  /** Mensagem de exemplo disparada pelo botão "Enviar teste" do painel. */
  async sendTest() {
    // O teste funciona mesmo com o aviso desligado: serve para validar o destino.
    if (!this.endpoint) throw new Error('O endereço do ntfy não é uma URL http(s) válida.');
    if (!this.topic) throw new Error('Informe um tópico válido (3 a 64 letras, números, "-" ou "_") antes de testar.');
    const result = await this._publish({
      title: 'Teste da VANTUS',
      message: [
        'Se você está lendo isto no celular, as notificações estão funcionando.',
        `Enviado às ${formatDateTime(new Date(), this.timeZone)}`,
      ].join('\n'),
      kind: 'test',
      priority: 'default',
    });
    if (!result.ok) throw new Error(result.error);
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* Envio                                                               */
  /* ------------------------------------------------------------------ */

  async _send(built, { kind, priority = 'default' }) {
    if (!this.enabled) return { skipped: this.disabledReason || 'desligado' };
    return this._publish({ ...built, kind, priority });
  }

  /**
   * Publica no ntfy. Nunca lança: devolve `{ ok, status?, error? }` e grava o
   * resultado em `push_last_status` / `push_last_error` para o painel.
   */
  async _publish({ title, message, kind, priority = 'default' }) {
    const body = JSON.stringify({
      topic: this.topic,
      title,
      message,
      priority,
      tags: ['bell'],
      // O aviso vale enquanto a fila está quente: 30 min de cache no servidor.
      cache: 'yes',
      ttl: DEFAULT_TTL_SECONDS,
    });

    const headers = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const error =
          response.status === 401 || response.status === 403
            ? 'O servidor recusou o acesso (401/403). Confira o token de acesso do ntfy.'
            : `O ntfy recusou o envio (HTTP ${response.status})${detail ? `: ${detail.slice(0, 140)}` : ''}.`;
        await this._remember(false, response.status, error, kind, Date.now() - startedAt);
        return { ok: false, status: response.status, error };
      }
      const latencyMs = Date.now() - startedAt;
      await this._remember(true, response.status, null, kind, latencyMs);
      return { ok: true, status: response.status, latencyMs };
    } catch (error) {
      const messageText =
        error.name === 'AbortError'
          ? 'O ntfy não respondeu a tempo (8s).'
          : `Não foi possível falar com o ntfy: ${error.message}`;
      await this._remember(false, null, messageText, kind, Date.now() - startedAt);
      return { ok: false, error: messageText };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Guarda o último resultado sem nunca derrubar quem chamou. */
  async _remember(ok, status, error, kind, latencyMs = null) {
    const stamp = Date.now();
    const took = Number.isFinite(latencyMs) ? ` em ${latencyMs} ms` : '';
    const summary = ok ? `ok ${status}${took}` : `falhou: ${error}`;
    try {
      await this.settings.setMany({
        push_last_status: summary,
        push_last_at: stamp,
        push_last_error: error || '',
        push_last_latency_ms: Number.isFinite(latencyMs) ? latencyMs : 0,
      });
    } catch (settingsError) {
      this.logger.debug(`[push] não foi possível gravar o último status: ${settingsError.message}`);
    }
    if (ok) this.logger.info(`[push] aviso publicado (${kind}, HTTP ${status}${took}).`);
    else this.logger.warn(`[push] falha ao enviar ${kind}: ${error}`);
  }
}

module.exports = {
  PushNotifier,
  DEFAULT_ENDPOINT,
  TOPIC_PATTERN,
  normalizeEndpoint,
  maskSecret,
  formatProtocol,
  buildJoinMessage,
  buildBlockedMessage,
};
