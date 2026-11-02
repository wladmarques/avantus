'use strict';

/**
 * Cliente mínimo da API da SquareCloud (v2).
 *
 * Só os endpoints que o deploy usa:
 *   POST   /v2/apps/{app_id}/commit    envia um .zip (escopo apps:deploy)
 *   POST   /v2/apps/{app_id}/restart   aplica os arquivos (escopo apps:control)
 *   DELETE /v2/apps/{app_id}/files     remove um arquivo, ex.: data/vantus.sqlite (files:write)
 *
 * Documentação: https://docs.squarecloud.app/pt-br/api-reference
 * O token da API fica em squarecloud.app → Conta → Segurança.
 */

const DEFAULT_BASE_URL = 'https://api.squarecloud.app';

class SquareCloudError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'SquareCloudError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

class SquareCloudClient {
  constructor({ token, baseUrl = DEFAULT_BASE_URL, fetchImpl } = {}) {
    if (!token) throw new SquareCloudError('SQUARECLOUD_TOKEN não configurado.');
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl ?? globalThis.fetch;
    if (typeof this.fetch !== 'function') {
      throw new SquareCloudError('fetch indisponível: use Node.js 20+.');
    }
  }

  async _request(method, path, { body, headers = {}, apiKey } = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: apiKey ?? this.token, ...headers },
      body,
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }

    if (!response.ok || payload?.status === 'error') {
      const code = payload?.code ?? payload?.error?.code ?? null;
      const detail = payload?.message ?? payload?.error?.message ?? text.slice(0, 300);
      throw new SquareCloudError(
        `SquareCloud ${method} ${path} falhou (HTTP ${response.status}${code ? `, ${code}` : ''}): ${detail}`,
        { status: response.status, code, body: payload },
      );
    }
    return payload;
  }

  /** Envia um .zip para a aplicação (não reinicia). */
  async commit(appId, zipBuffer, { fileName = 'app.zip', path } = {}) {
    const form = new FormData();
    form.append('file', new Blob([zipBuffer], { type: 'application/zip' }), fileName);
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return this._request('POST', `/v2/apps/${encodeURIComponent(appId)}/commit${query}`, { body: form });
  }

  /** Reinicia (para e inicia) a aplicação. */
  async restart(appId) {
    return this._request('POST', `/v2/apps/${encodeURIComponent(appId)}/restart`);
  }

  /** Status atual (usado para confirmar que a aplicação voltou). */
  async status(appId) {
    return this._request('GET', `/v2/apps/${encodeURIComponent(appId)}/status`);
  }

  /** Exclui um arquivo dentro da aplicação. */
  async deleteFile(appId, filePath) {
    return this._request('DELETE', `/v2/apps/${encodeURIComponent(appId)}/files`, {
      body: JSON.stringify({ path: filePath }),
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

module.exports = { SquareCloudClient, SquareCloudError, DEFAULT_BASE_URL };
