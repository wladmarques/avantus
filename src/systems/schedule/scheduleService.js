'use strict';

const { evaluateSchedule, describeSchedule, formatTime, tzParts, dayLabel } = require('../../utils/time');
const { STAFF_STATUS } = require('../../config/theme');

/**
 * Horário de funcionamento da central.
 * `central_manual` permite que a administração abra/fecha fora do horário.
 */
class ScheduleService {
  constructor({ settings, logger }) {
    this.settings = settings;
    this.logger = logger;
    this._lastOpenState = null;
  }

  getSchedule(guildId) {
    return this.settings.get('schedule');
  }

  /** @returns {{open: boolean, manual: boolean, nextOpen: string|null, current: object|null}} */
  isOpen(guildId, date = new Date()) {
    const manual = this.settings.get('central_manual');
    const schedule = this.getSchedule(guildId);
    const evaluation = evaluateSchedule(schedule, date);

    if (manual === 'open') return { ...evaluation, open: true, manual: true };
    if (manual === 'closed') return { ...evaluation, open: false, manual: true };
    return { ...evaluation, open: evaluation.open, manual: false };
  }

  describe(guildId) {
    return describeSchedule(this.getSchedule(guildId));
  }

  /** Texto curto para o painel (ex.: "12:00 às 02:00"). */
  todayWindow(guildId, date = new Date()) {
    const schedule = this.getSchedule(guildId);
    const key = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][tzParts(date).weekday];
    const windows = schedule?.[key] ?? [];
    if (windows.length === 0) return { text: 'Fechado hoje', weekday: key };
    return {
      text: windows.map((w) => `${w.open} às ${w.close}`).join(' / '),
      weekday: key,
      label: dayLabel(tzParts(date).weekday),
    };
  }

  /**
   * Observa transições de aberto/fechado e dispara callbacks.
   * Usado para fechar a central automaticamente no horário.
   */
  startWatcher(guildId, onChange, intervalMs = 30000) {
    const tick = () => {
      try {
        const state = this.isOpen(guildId);
        const key = `${state.open}:${state.manual}`;
        if (this._lastOpenState !== key) {
          const previous = this._lastOpenState;
          this._lastOpenState = key;
          if (previous !== null) onChange({ ...state, previousOpen: previous.startsWith('true') });
        }
      } catch (error) {
        this.logger.error('Falha ao verificar horário de funcionamento', error);
      }
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  statusLabel(guildId) {
    return this.isOpen(guildId).open ? 'ABERTA' : 'FECHADA';
  }

  nowLabel() {
    return formatTime(new Date());
  }

  staffPresenceHint(status) {
    return status === STAFF_STATUS.EM_ATENDIMENTO ? 'Em atendimento' : status;
  }
}

module.exports = { ScheduleService };
