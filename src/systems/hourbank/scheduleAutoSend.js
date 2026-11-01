'use strict';

/**
 * Envio automático da escala semanal para o webhook.
 *
 * Regras:
 * - o admin escolhe **dia da semana** e **horário** no painel;
 * - o envio acontece uma vez por semana (o controle fica gravado em
 *   `hour_bank_webhook_last_week`, então reiniciar o bot não duplica a mensagem);
 * - se o bot estiver desligado no horário exato, a escala é enviada assim que ele
 *   voltar no mesmo dia (horário já passou e a semana ainda não foi publicada);
 * - qualquer falha é registrada no log e tentada de novo no próximo minuto.
 */

const { createLogger } = require('../../utils/logger');
const { tzParts } = require('../../utils/time');
const {
  getWebhookUrl,
  sendWeeklySchedule,
  weekWindow,
  LAST_WEEK_KEY,
} = require('./scheduleBroadcast');

const logger = createLogger('hourbank');

const AUTO_KEY = 'hour_bank_webhook_auto';
const DAY_KEY = 'hour_bank_webhook_day';
const TIME_KEY = 'hour_bank_webhook_time';

const DEFAULT_DAY = 1; // segunda
const DEFAULT_TIME = '09:00';
const DAY_LABELS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

/** "09:30" → 570 (minutos desde 00:00) ou null se inválido. */
function parseHHMM(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** "YYYY-MM-DD" → "DD/MM" (para exibir no painel). */
function keyToLabel(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  return match ? `${match[3]}/${match[2]}` : null;
}

class ScheduleBroadcastService {
  constructor({ settings, hourBank, timeZone = undefined }) {
    this.settings = settings;
    this.hourBank = hourBank;
    this.timeZone = timeZone;
    this.timer = null;
    this.sending = false;
  }

  get enabled() {
    return Boolean(this.settings.get(AUTO_KEY));
  }

  get day() {
    const value = Number(this.settings.get(DAY_KEY));
    return Number.isInteger(value) && value >= 0 && value <= 6 ? value : DEFAULT_DAY;
  }

  get time() {
    const value = this.settings.get(TIME_KEY);
    return typeof value === 'string' && parseHHMM(value) !== null ? value : DEFAULT_TIME;
  }

  get lastWeek() {
    const value = this.settings.get(LAST_WEEK_KEY);
    return typeof value === 'string' && value ? value : null;
  }

  get minutes() {
    return parseHHMM(this.time);
  }

  /** Configuração atual (usada pelo painel). */
  getConfig() {
    const url = getWebhookUrl(this.settings);
    return {
      url,
      configured: Boolean(url),
      auto: this.enabled,
      day: this.day,
      dayLabel: DAY_LABELS[this.day],
      time: this.time,
      lastWeek: this.lastWeek,
      lastWeekLabel: keyToLabel(this.lastWeek),
    };
  }

  /**
   * Atualiza a configuração do envio automático.
   * Campos ausentes (`undefined`) são mantidos.
   */
  async updateConfig({ auto, day, time } = {}) {
    if (auto !== undefined) {
      if (typeof auto !== 'boolean') throw new Error('Valor inválido para o envio automático.');
      if (auto && !getWebhookUrl(this.settings)) {
        throw new Error('Cadastre a URL do webhook antes de ativar o envio automático.');
      }
      await this.settings.set(AUTO_KEY, auto);
    }

    if (day !== undefined) {
      const parsed = Number(day);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 6) {
        throw new Error('Dia da semana inválido (0 = domingo … 6 = sábado).');
      }
      await this.settings.set(DAY_KEY, parsed);
    }

    if (time !== undefined) {
      if (parseHHMM(time) === null) throw new Error('Horário inválido: use HH:MM.');
      await this.settings.set(TIME_KEY, String(time).trim());
    }

    return this.getConfig();
  }

  /**
   * Verifica se é hora de enviar e, se for, publica a escala.
   * @returns {Promise<{sent: boolean, reason: string, result?: object}>}
   */
  async tick(guildId, now = Date.now()) {
    if (!this.enabled) return { sent: false, reason: 'desligado' };
    if (!getWebhookUrl(this.settings)) return { sent: false, reason: 'sem webhook' };

    const parts = tzParts(new Date(now), this.timeZone);
    if (parts.weekday !== this.day) return { sent: false, reason: 'outro dia' };

    const minutesNow = parts.hour * 60 + parts.minute;
    if (minutesNow < this.minutes) return { sent: false, reason: 'antes do horário' };

    const week = weekWindow(now, this.timeZone);
    const weekKey = week.days[0].key;
    if (this.lastWeek === weekKey) return { sent: false, reason: 'já enviado nesta semana' };
    if (this.sending) return { sent: false, reason: 'envio em andamento' };

    this.sending = true;
    try {
      // A própria publicação registra a semana em LAST_WEEK_KEY (só após o aceite).
      const result = await sendWeeklySchedule({
        settings: this.settings,
        hourBank: this.hourBank,
        guildId,
        timeZone: this.timeZone,
        now,
      });
      logger.info(
        `Envio automático da escala (${DAY_LABELS[this.day]} ${this.time}) concluído — semana de ${keyToLabel(weekKey)}.`,
      );
      return { sent: true, reason: 'enviado', result };
    } finally {
      this.sending = false;
    }
  }

  /** Timer de 1 minuto (unref para não segurar o processo). */
  startWatcher(guildId, { intervalMs = 60000 } = {}) {
    const tick = async () => {
      try {
        const outcome = await this.tick(guildId);
        if (outcome.sent) return;
      } catch (error) {
        logger.warn(`Falha no envio automático da escala: ${error.message}`);
      }
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    this.timer = timer;
    return () => clearInterval(timer);
  }

  stopWatcher() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = {
  ScheduleBroadcastService,
  AUTO_KEY,
  DAY_KEY,
  TIME_KEY,
  LAST_WEEK_KEY,
  DEFAULT_DAY,
  DEFAULT_TIME,
  DAY_LABELS,
  parseHHMM,
  keyToLabel,
};
