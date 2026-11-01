'use strict';

const { COLORS, STAFF_STATUS } = require('../../config/theme');
const { formatTime } = require('../../utils/time');

/**
 * Abertura e fechamento manual da central, além da verificação de status.
 */
class CentralService {
  constructor({ db, settings, schedule, engine, panels, audit, notifications }) {
    this.db = db;
    this.settings = settings;
    this.schedule = schedule;
    this.engine = engine;
    this.panels = panels;
    this.audit = audit;
    this.notifications = notifications;
  }

  status(guildId) {
    const info = this.schedule.isOpen(guildId);
    return {
      ...info,
      label: info.open ? 'ABERTA' : 'FECHADA',
      manual: this.settings.get('central_manual'),
      scheduleText: this.schedule.describe(guildId),
      today: this.schedule.todayWindow(guildId),
    };
  }

  async open({ guildId, actorId, actorTag, manual = true }) {
    await this.settings.set('central_manual', manual ? 'open' : 'auto');
    await this.audit.log({
      guildId,
      type: 'CENTRAL_OPEN',
      actorId,
      actorTag,
      message: `🟢 A central de atendimento foi **aberta** por **${actorTag ?? actorId}**.`,
      color: COLORS.SUCCESS,
    });
    await this.panels.refresh(guildId, { immediate: true });
    return this.status(guildId);
  }

  async close({ guildId, actorId, actorTag, manual = true, clearQueue = false, reason = null }) {
    await this.settings.set('central_manual', manual ? 'closed' : 'auto');
    const policy = this.settings.get('queue_policy_on_close');
    const shouldClear = clearQueue || policy === 'clear';

    if (shouldClear) {
      await this.engine.clearQueue({
        guildId,
        actorId,
        actorTag,
        reason: reason || 'A central de atendimento foi encerrada.',
      });
    }

    if (!shouldClear) {
      // A fila é mantida: avisamos quem está esperando e segue aberto o status.
      const state = this.engine.getState(guildId);
      for (const entry of state.waiting) {
        await this.notifications
          .centralClosed({
            guildId,
            userId: entry.user_id,
            schedule: this.settings.get('schedule'),
            nextOpen: this.status(guildId).nextOpen,
          })
          .catch(() => null);
      }
    }

    await this.audit.log({
      guildId,
      type: 'CENTRAL_CLOSE',
      actorId,
      actorTag,
      message: [
        `🔒 A central de atendimento foi **fechada** por **${actorTag ?? actorId}** às ${formatTime()}.`,
        shouldClear ? 'A fila restante foi encerrada.' : 'A fila existente foi mantida.',
        reason ? `Motivo: **${reason}**` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      color: COLORS.DANGER,
    });

    await this.panels.refresh(guildId, { immediate: true });
    return this.status(guildId);
  }

  /** Chamado pelo watcher de horário. */
  async handleScheduleTransition({ guildId, open, previousOpen }) {
    if (open === previousOpen) return;
    const policy = this.settings.get('queue_policy_on_close');

    if (!open) {
      if (policy === 'clear') {
        await this.engine.clearQueue({
          guildId,
          actorId: 'sistema',
          actorTag: 'Horário de funcionamento',
          reason: 'A central fechou no horário configurado.',
        });
      }
      await this.audit.log({
        guildId,
        type: 'CENTRAL_AUTO_CLOSE',
        actorId: 'sistema',
        actorTag: 'Horário de funcionamento',
        message: `🔒 A central fechou automaticamente no horário configurado (${formatTime()}). ${
          policy === 'clear' ? 'A fila foi encerrada.' : 'A fila foi mantida.'
        }`,
        color: COLORS.MUTED,
      });
    } else {
      await this.audit.log({
        guildId,
        type: 'CENTRAL_AUTO_OPEN',
        actorId: 'sistema',
        actorTag: 'Horário de funcionamento',
        message: `🟢 A central abriu automaticamente no horário configurado (${formatTime()}).`,
        color: COLORS.SUCCESS,
      });
    }

    await this.panels.refresh(guildId, { immediate: true });
  }

  /** Alterna status manual — usado pelo /central alternar. */
  async toggle({ guildId, actorId, actorTag }) {
    const status = this.status(guildId);
    if (status.open) return this.close({ guildId, actorId, actorTag });
    return this.open({ guildId, actorId, actorTag });
  }

  availableStaff(guildId) {
    return this.status(guildId).open ? STAFF_STATUS.DISPONIVEL : STAFF_STATUS.AUSENTE;
  }
}

module.exports = { CentralService };
