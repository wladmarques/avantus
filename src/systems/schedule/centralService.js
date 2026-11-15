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
      // true = aberta automaticamente porque um staff entrou em serviço
      autoStaff: Boolean(this.settings.get('central_auto_staff')),
      scheduleText: this.schedule.describe(guildId),
      today: this.schedule.todayWindow(guildId),
    };
  }

  async open({ guildId, actorId, actorTag, manual = true }) {
    // Abertura manual (painel/comando) passa a mandar: a marca de "aberta pela
    // equipe" cai, senão o próximo staff saindo fecharia a central sem querer.
    await this.settings.setMany({
      central_manual: manual ? 'open' : 'auto',
      central_auto_staff: false,
    });
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
    await this.settings.setMany({
      central_manual: manual ? 'closed' : 'auto',
      central_auto_staff: false,
    });
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

  /* ==================================================================== */
  /* Abertura automática pela equipe                                      */
  /* ==================================================================== */

  /**
   * Staff **em serviço**: disponível ou atendendo. Quem está em atendimento
   * continua segurando a central aberta — fechar no meio de um atendimento
   * seria pior do que ficar aberta sem ninguém na fila.
   */
  onDutyStaff(guildId) {
    const repo = this.engine?.repos?.staff;
    if (!repo || typeof repo.countByStatusSync !== 'function') return 0;
    const available = repo.countByStatusSync(guildId, STAFF_STATUS.DISPONIVEL) || 0;
    const serving = repo.countByStatusSync(guildId, STAFF_STATUS.EM_ATENDIMENTO) || 0;
    return available + serving;
  }

  /**
   * Chamado a cada mudança de status da equipe (StaffService).
   *
   * Regra:
   * - alguém entrou em serviço e a central estava **seguindo o horário** (e o
   *   horário diz fechada) → abre na hora, marcando `central_auto_staff`;
   * - o último staff saiu de serviço → volta para o **horário programado**.
   *
   * Fechamento manual do administrador **nunca** é desfeito por aqui.
   */
  async syncStaffAvailability(guildId) {
    if (!this.settings.get('central_auto_open_on_staff')) return { changed: false, reason: 'desligado' };

    const onDuty = this.onDutyStaff(guildId);
    const manual = this.settings.get('central_manual');
    const openedByStaff = Boolean(this.settings.get('central_auto_staff'));

    if (onDuty > 0 && !openedByStaff) {
      // Já aberta pelo horário ou fechada pelo administrador: nada a fazer.
      if (manual !== 'auto') return { changed: false, reason: 'estado manual' };
      if (this.schedule.isOpen(guildId).open) return { changed: false, reason: 'já aberta pelo horário' };
      return this.openForStaff({ guildId, onDuty });
    }

    if (onDuty === 0 && openedByStaff) {
      return this.backToSchedule({ guildId });
    }

    return { changed: false, reason: null };
  }

  /** Abre a central porque alguém entrou em serviço (fora do horário). */
  async openForStaff({ guildId, onDuty = null }) {
    await this.settings.setMany({ central_manual: 'open', central_auto_staff: true });
    const total = onDuty ?? this.onDutyStaff(guildId);
    await this.audit.log({
      guildId,
      type: 'CENTRAL_OPEN_STAFF',
      actorId: 'sistema',
      actorTag: 'Equipe',
      message:
        '🟢 A central abriu automaticamente porque a equipe entrou em serviço ' +
        `(${total === 1 ? '1 staff' : `${total} staff`}) às ${formatTime()}.`,
      color: COLORS.SUCCESS,
    });
    await this.panels.refresh(guildId, { immediate: true }).catch(() => null);
    return { changed: true, reason: 'staff disponível', status: this.status(guildId) };
  }

  /** Ninguém mais em serviço: a central volta a seguir o horário programado. */
  async backToSchedule({ guildId }) {
    await this.settings.setMany({ central_manual: 'auto', central_auto_staff: false });
    const status = this.status(guildId);
    const scheduleText = this.schedule.describe(guildId);

    if (!status.open) {
      // Fechou de fato: avisa quem estava esperando (a fila é mantida).
      const state = this.engine.getState(guildId);
      for (const entry of state.waiting) {
        await this.notifications
          ?.centralClosed({
            guildId,
            userId: entry.user_id,
            schedule: this.settings.get('schedule'),
            nextOpen: status.nextOpen,
          })
          .catch(() => null);
      }
    }

    await this.audit.log({
      guildId,
      type: 'CENTRAL_BACK_TO_SCHEDULE',
      actorId: 'sistema',
      actorTag: 'Equipe',
      message:
        '🔒 Nenhum staff está em serviço: a central voltou a seguir o horário de funcionamento ' +
        `(${scheduleText}) às ${formatTime()}. O estado agora é ${status.open ? 'ABERTA' : 'FECHADA'}.`,
      color: COLORS.MUTED,
    });
    await this.panels.refresh(guildId, { immediate: true }).catch(() => null);
    return { changed: true, reason: 'sem staff em serviço', status };
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
