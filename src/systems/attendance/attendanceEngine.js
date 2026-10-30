'use strict';

/**
 * Núcleo do atendimento: fila, chamadas, atendimentos simultâneos,
 * timeouts, recuperação e consistência de estado.
 *
 * Toda transição crítica acontece dentro de `db.transaction`, que é
 * serializado por um mutex — dois membros da staff não conseguem reservar
 * o mesmo jogador, e um staff não assume dois atendimentos (salvo
 * configuração explícita).
 */

const { AppError, ERRORS } = require('../../services/errors');
const {
  ATTENDANCE_STATUS,
  OUTCOMES,
  OUTCOME_LABELS,
  STAFF_STATUS,
  COLORS,
} = require('../../config/theme');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('attendance');

const ALLOWED_TRANSITIONS = {
  [ATTENDANCE_STATUS.WAITING]: [ATTENDANCE_STATUS.SERVING, ATTENDANCE_STATUS.HOLD, ATTENDANCE_STATUS.FINISHED],
  [ATTENDANCE_STATUS.HOLD]: [ATTENDANCE_STATUS.WAITING, ATTENDANCE_STATUS.FINISHED],
  [ATTENDANCE_STATUS.SERVING]: [ATTENDANCE_STATUS.WAITING, ATTENDANCE_STATUS.FINISHED],
  [ATTENDANCE_STATUS.FINISHED]: [],
};

class AttendanceEngine {
  constructor({
    db,
    repositories,
    settings,
    gateway,
    staffService,
    notifications,
    audit,
    panels,
    schedule,
    cooldowns = null,
  }) {
    this.db = db;
    this.repos = repositories;
    this.settings = settings;
    this.gateway = gateway;
    this.staff = staffService;
    this.notifications = notifications;
    this.audit = audit;
    this.panels = panels;
    this.schedule = schedule;
    this.cooldowns = cooldowns;
    this.timers = new Map();
    this.positionCooldowns = new Map();
  }

  /* ==================================================================== */
  /* Leitura de estado                                                    */
  /* ==================================================================== */

  getState(guildId) {
    const now = Date.now();
    const waiting = this.repos.attendance.listWaitingSync(guildId);
    const hold = this.repos.attendance.listHoldSync(guildId);
    const serving = this.repos.attendance.listServingSync(guildId);
    const windowMs = (this.settings.get('average_wait_window_minutes') || 120) * 60000;
    const avgWait = this.repos.attendance.averageWaitSync(guildId, now - windowMs);

    return {
      waiting: waiting.map((row, index) => ({
        ...row,
        position: index + 1,
        waitingSeconds: Math.max(0, Math.floor((now - row.joined_at) / 1000)),
      })),
      hold: hold.map((row) => ({
        ...row,
        waitingSeconds: Math.max(0, Math.floor((now - row.joined_at) / 1000)),
      })),
      serving: serving.map((row) => ({
        ...row,
        servingSeconds: Math.max(0, Math.floor((now - (row.started_at ?? now)) / 1000)),
      })),
      staffCounts: this.staff.counts(guildId),
      staffList: this.staff.list(guildId),
      avgWaitSeconds: Math.round(avgWait.average || 0),
      avgWaitSamples: avgWait.total || 0,
    };
  }

  /** Previsão simples de espera: média recente por atendimento x posição. */
  estimateWaitSeconds(state) {
    const available = Math.max(1, state.staffCounts[STAFF_STATUS.DISPONIVEL] || 0);
    const baseWait = state.avgWaitSamples > 0 ? state.avgWaitSeconds : 300;
    const nextPosition = state.waiting.length + 1;
    return Math.max(0, Math.round((baseWait / available) * nextPosition));
  }

  /* ==================================================================== */
  /* Entrada e saída da fila                                              */
  /* ==================================================================== */

  async joinQueue({ guildId, userId, displayName = null, source = 'painel' }) {
    // Quem saiu da fila antes de ser chamado precisa aguardar o bloqueio.
    this.cooldowns?.assertAllowed(guildId, userId);

    const open = this.schedule.isOpen(guildId);
    if (!open.open) {
      throw new AppError(
        ERRORS.CENTRAL_FECHADA,
        'A central de atendimento está fechada no momento. Confira os horários de funcionamento no painel.',
        { schedule: this.schedule.getSchedule(guildId), nextOpen: open.nextOpen },
      );
    }

    const member = await this.gateway.getMember(guildId, userId);
    if (!member || !member.inGuild) {
      throw new AppError(ERRORS.JOGADOR_NAO_ENCONTRADO, 'Não encontrei seu cadastro no servidor da VANTUS.');
    }

    const settings = this.settings.getAll();
    const waitingBefore = this.repos.attendance.countByStatusSync(guildId, ATTENDANCE_STATUS.WAITING);
    if (settings.max_queue_size > 0 && waitingBefore >= settings.max_queue_size) {
      throw new AppError(ERRORS.FILA_CHEIA, 'A fila está cheia no momento. Tente novamente em alguns minutos.');
    }

    const active = this.repos.attendance.findActiveByUserSync(guildId, userId);
    if (active) {
      if (active.status === ATTENDANCE_STATUS.SERVING) {
        throw new AppError(ERRORS.JA_EM_ATENDIMENTO, 'Você já possui um atendimento em andamento.', {
          protocol: active.protocol,
        });
      }
      const state = this.getState(guildId);
      const index = state.waiting.findIndex((row) => row.id === active.id);
      throw new AppError(
        ERRORS.JA_NA_FILA,
        index >= 0
          ? `Você já está na fila na posição ${index + 1}º (protocolo #${this.formatProtocol(active.protocol)}).`
          : 'Você já possui um registro de atendimento em aberto.',
        { protocol: active.protocol, position: index >= 0 ? index + 1 : null },
      );
    }

    const created = await this.db.transaction(() => {
      const protocol = this.repos.counter.nextSync(`protocol:${guildId}`);
      const queueSeq = this.repos.counter.nextSync(`queue:${guildId}`);
      const row = this.repos.attendance.createSync({
        guildId,
        protocol,
        userId,
        username: displayName || member.displayName || `Usuário ${userId}`,
        status: ATTENDANCE_STATUS.WAITING,
        queueSeq,
        waitChannelId: settings.wait_channel_id,
      });
      const waiting = this.repos.attendance.listWaitingSync(guildId);
      const position = waiting.findIndex((item) => item.id === row.id) + 1;
      // posição inicial registrada: só avisamos quando ela realmente melhorar
      const withPosition = this.repos.attendance.updateSync(guildId, row.id, {
        last_position_notified: position,
      });
      return { attendance: withPosition, protocol, position, queueSize: waiting.length };
    });

    await this._effect('mover para a espera', async () => {
      const moved = await this.gateway.moveToVoiceChannel(guildId, userId, settings.wait_channel_id);
      return moved;
    });
    const memberVoice = await this._effect('consultar voz', () =>
      this.gateway.getMember(guildId, userId),
    );
    const inWaitVoice =
      memberVoice?.voiceChannelId && memberVoice.voiceChannelId === settings.wait_channel_id;

    await this._effect('confirmar entrada', () =>
      this.notifications.joinConfirmation({
        guildId,
        userId,
        protocol: created.protocol,
        position: created.position,
        note:
          inWaitVoice || !settings.wait_channel_id
            ? null
            : 'Entre no canal de voz **AGUARDANDO ATENDIMENTO** para ser atendido pela equipe.',
      }),
    );

    await this.audit.log({
      guildId,
      type: 'QUEUE_JOIN',
      actorId: userId,
      actorTag: created.attendance.username,
      targetId: userId,
      protocol: created.protocol,
      message: `**${created.attendance.username}** entrou na fila (posição ${created.position}º) via ${source}.`,
      color: COLORS.ORANGE,
      metadata: { position: created.position, queueSize: created.queueSize },
    });

    await this._notifyPositionChanges(guildId, { excludeUserId: userId });
    await this.panels.refresh(guildId);
    return created;
  }

  /** Jogador desiste / staff remove enquanto na fila. */
  async leaveQueue({ guildId, userId, actorId = null, reason = null, outcome = OUTCOMES.DESISTIU, silent = false }) {
    const closed = await this.db.transaction(() => {
      const active = this.repos.attendance.findActiveByUserSync(guildId, userId);
      if (!active) {
        throw new AppError(ERRORS.NAO_NA_FILA, 'Você não está na fila de atendimento.');
      }
      return this._finalizeSync(guildId, active, {
        outcome,
        note: reason,
        closedBy: actorId || userId,
      });
    });

    this._clearTimer(closed.id);

    // Desistiu antes de ser chamado? Aplica o bloqueio de reentrada.
    let cooldown = null;
    if (outcome === OUTCOMES.DESISTIU && closed.started_at === null) {
      cooldown = await this.cooldowns?.apply({
        guildId,
        userId,
        reason: reason || 'Saiu da fila antes de ser chamado',
      });
    }

    await this._effect('remover acesso de voz', () =>
      this.gateway.revokeVoiceAccess(guildId, closed.voice_channel_id, userId),
    );
    await this._effect('desconectar da espera', () =>
      this.gateway.disconnectFromVoice(guildId, userId),
    );

    if (!silent) {
      await this._effect('avisar saída', () =>
        this.notifications.removed({
          guildId,
          userId,
          protocol: closed.protocol,
          reason: reason || (outcome === OUTCOMES.DESISTIU ? 'Você desistiu do atendimento.' : null),
          cooldownMinutes: cooldown?.minutes ?? 0,
        }),
      );
    }

    await this.audit.log({
      guildId,
      type: 'QUEUE_LEAVE',
      actorId: actorId || userId,
      targetId: userId,
      protocol: closed.protocol,
      message: actorId && actorId !== userId
        ? `**${closed.username}** foi removido da fila por <@${actorId}>. Motivo: ${reason ?? 'não informado'}.`
        : `**${closed.username}** saiu da fila.`,
      color: COLORS.DANGER,
      metadata: { outcome, reason },
    });

    await this._notifyPositionChanges(guildId);
    await this.panels.refresh(guildId);
    return closed;
  }

  /* ==================================================================== */
  /* Chamada de jogadores                                                 */
  /* ==================================================================== */

  async callNext({ guildId, staffId, staffTag, reason = null }) {
    return this._call({ guildId, staffId, staffTag, attendanceId: null, reason });
  }

  async callSpecific({ guildId, staffId, staffTag, attendanceId, reason }) {
    if (!reason || !String(reason).trim()) {
      throw new AppError(ERRORS.MOTIVO_OBRIGATORIO, 'Informe o motivo para chamar um jogador específico.');
    }
    return this._call({ guildId, staffId, staffTag, attendanceId: Number(attendanceId), reason });
  }

  async _call({ guildId, staffId, staffTag, attendanceId, reason }) {
    const settings = this.settings.getAll();

    const voice = await this.gateway.getStaffVoiceState(guildId, staffId);
    if (!voice || !voice.connected || !voice.isAttendanceChannel) {
      throw new AppError(
        ERRORS.STAFF_SEM_VOZ,
        'Você precisa estar conectado a um canal de voz de atendimento para chamar um jogador.',
      );
    }

    if (!settings.allow_staff_multi) {
      const busy = this.repos.attendance.findServingByStaffSync(guildId, staffId);
      if (busy) {
        throw new AppError(
          ERRORS.STAFF_OCUPADO,
          `Você já está atendendo o protocolo #${this.formatProtocol(busy.protocol)}. Finalize antes de chamar outro jogador.`,
          { protocol: busy.protocol },
        );
      }
    }

    let result = null;
    let lastError = null;

    // Reserva com nova tentativa: se outro staff pegou o jogador primeiro,
    // buscamos o próximo da fila em vez de falhar.
    for (let attempt = 0; attempt < 12 && !result; attempt += 1) {
      const target = await this._resolveCallTarget({ guildId, attendanceId });
      try {
        result = await this.db.transaction(() => {
          const fresh = this.repos.attendance.findByIdSync(guildId, target.id);
          if (!fresh || fresh.status !== ATTENDANCE_STATUS.WAITING) {
            throw new AppError(ERRORS.ATENDIMENTO_NAO_ENCONTRADO, 'Este jogador não está mais aguardando na fila.');
          }
          if (!settings.allow_staff_multi && this.repos.attendance.findServingByStaffSync(guildId, staffId)) {
            throw new AppError(ERRORS.STAFF_OCUPADO, 'Você já está em atendimento.');
          }

          const now = Date.now();
          const updated = this.repos.attendance.updateSync(guildId, fresh.id, {
            status: ATTENDANCE_STATUS.SERVING,
            staff_id: staffId,
            staff_tag: staffTag ?? null,
            started_at: now,
            presence_confirmed: 0,
            voice_channel_id: voice.channelId,
            order_override: attendanceId ? 1 : 0,
            order_reason: reason ?? null,
          });

          const waiting = this.repos.attendance.listWaitingSync(guildId);
          return { attendance: updated, remaining: waiting.length };
        });
      } catch (error) {
        if (attendanceId || error.code !== ERRORS.ATENDIMENTO_NAO_ENCONTRADO) throw error;
        lastError = error;
      }
    }

    if (!result) throw lastError ?? new AppError(ERRORS.FILA_VAZIA, 'Não há jogadores disponíveis na fila.');

    await this._effect('marcar staff ocupado', () =>
      this.staff.markBusy(guildId, staffId),
    );
    await this._effect('liberar acesso ao canal', () =>
      this.gateway.grantVoiceAccess(guildId, voice.channelId, result.attendance.user_id),
    );
    await this._effect('mover jogador', () =>
      this.gateway.moveToVoiceChannel(guildId, result.attendance.user_id, voice.channelId, {
        force: true,
      }),
    );
    await this._effect('avisar jogador', () =>
      this.notifications.called({
        guildId,
        userId: result.attendance.user_id,
        protocol: result.attendance.protocol,
        channelName: voice.channelName,
        staffName: `<@${staffId}>`,
      }),
    );

    await this.audit.log({
      guildId,
      type: attendanceId ? 'QUEUE_CALL_OVERRIDE' : 'QUEUE_CALL',
      actorId: staffId,
      actorTag: staffTag,
      targetId: result.attendance.user_id,
      protocol: result.attendance.protocol,
      message: attendanceId
        ? `**${staffTag ?? staffId}** chamou **${result.attendance.username}** fora da ordem da fila. Motivo: **${reason}**.`
        : `**${staffTag ?? staffId}** chamou **${result.attendance.username}** (protocolo #${this.formatProtocol(result.attendance.protocol)}).`,
      color: COLORS.SUCCESS,
      metadata: {
        channelId: voice.channelId,
        orderOverride: Boolean(attendanceId),
        reason: reason ?? null,
        remaining: result.remaining,
      },
    });

    this._schedulePresenceTimeout(guildId, result.attendance.id);
    await this._notifyPositionChanges(guildId);
    await this.panels.refresh(guildId);
    return { ...result, staffVoice: voice };
  }

  /** Encontra o próximo jogador válido, limpando quem saiu do servidor. */
  async _resolveCallTarget({ guildId, attendanceId }) {
    const maxAttempts = 25;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const row = attendanceId
        ? this.repos.attendance.findByIdSync(guildId, attendanceId)
        : this.repos.attendance.peekNextSync(guildId);

      if (!row) {
        throw new AppError(ERRORS.FILA_VAZIA, 'Não há jogadores aguardando na fila neste momento.');
      }

      const member = await this.gateway.getMember(guildId, row.user_id);
      if (!member || !member.inGuild) {
        const closed = await this.db.transaction(() =>
          this._finalizeSync(guildId, row, {
            outcome: OUTCOMES.DESISTIU,
            note: 'Saiu do servidor enquanto aguardava',
            closedBy: 'sistema',
          }),
        );
        await this.audit.log({
          guildId,
          type: 'QUEUE_GHOST_REMOVED',
          actorId: null,
          targetId: row.user_id,
          protocol: closed.protocol,
          message: `**${row.username}** foi removido da fila automaticamente (saiu do servidor).`,
          color: COLORS.MUTED,
        });
        if (attendanceId) {
          throw new AppError(
            ERRORS.JOGADOR_NAO_ENCONTRADO,
            'Este jogador não está mais no servidor e foi removido da fila.',
          );
        }
        continue;
      }

      if (row.status === ATTENDANCE_STATUS.HOLD) {
        throw new AppError(
          ERRORS.ATENDIMENTO_NAO_ENCONTRADO,
          'Este jogador está pendente. Reative-o na fila antes de chamar.',
        );
      }

      return row;
    }

    throw new AppError(ERRORS.FILA_VAZIA, 'Não há jogadores disponíveis na fila.');
  }

  /* ==================================================================== */
  /* Ações da staff sobre a fila                                          */
  /* ==================================================================== */

  async skipPlayer({ guildId, attendanceId, actorId, actorTag, reason }) {
    if (!reason || !String(reason).trim()) {
      throw new AppError(ERRORS.MOTIVO_OBRIGATORIO, 'O motivo é obrigatório para pular um jogador.');
    }
    const policy = this.settings.get('skip_policy');

    const result = await this.db.transaction(() => {
      const row = this.repos.attendance.findByIdSync(guildId, attendanceId);
      if (!row) throw new AppError(ERRORS.ATENDIMENTO_NAO_ENCONTRADO, 'Atendimento não encontrado.');
      if (row.status === ATTENDANCE_STATUS.HOLD) {
        throw new AppError(ERRORS.ATENDIMENTO_NAO_ENCONTRADO, 'Este jogador já está pendente.');
      }
      if (row.status !== ATTENDANCE_STATUS.WAITING) {
        throw new AppError(ERRORS.ATENDIMENTO_NAO_ENCONTRADO, 'Este jogador não está aguardando na fila.');
      }

      if (policy === 'hold') {
        const updated = this.repos.attendance.updateSync(guildId, row.id, {
          status: ATTENDANCE_STATUS.HOLD,
          hold_reason: reason,
        });
        return { attendance: updated, mode: 'hold' };
      }

      const newSeq = this.repos.counter.nextSync(`queue:${guildId}`);
      const updated = this.repos.attendance.updateSync(guildId, row.id, {
        queue_seq: newSeq,
        hold_reason: reason,
      });
      return { attendance: updated, mode: 'end' };
    });

    await this.audit.log({
      guildId,
      type: 'QUEUE_SKIP',
      actorId,
      actorTag,
      targetId: result.attendance.user_id,
      protocol: result.attendance.protocol,
      message:
        result.mode === 'hold'
          ? `**${result.attendance.username}** foi pausado na fila por **${actorTag ?? actorId}**. Motivo: **${reason}**.`
          : `**${result.attendance.username}** foi movido para o final da fila por **${actorTag ?? actorId}**. Motivo: **${reason}**.`,
      color: COLORS.WARNING,
      metadata: { policy: result.mode, reason },
    });

    await this._notifyPositionChanges(guildId);
    await this.panels.refresh(guildId);
    return result;
  }

  async reactivateHold({ guildId, attendanceId, actorId, actorTag }) {
    const result = await this.db.transaction(() => {
      const row = this.repos.attendance.findByIdSync(guildId, attendanceId);
      if (!row || row.status !== ATTENDANCE_STATUS.HOLD) {
        throw new AppError(ERRORS.ATENDIMENTO_NAO_ENCONTRADO, 'Este jogador não está pendente.');
      }
      const newSeq = this.repos.counter.nextSync(`queue:${guildId}`);
      return this.repos.attendance.updateSync(guildId, row.id, {
        status: ATTENDANCE_STATUS.WAITING,
        queue_seq: newSeq,
      });
    });

    await this.audit.log({
      guildId,
      type: 'QUEUE_REACTIVATE',
      actorId,
      actorTag,
      targetId: result.user_id,
      protocol: result.protocol,
      message: `**${result.username}** voltou para a fila (reativado por **${actorTag ?? actorId}**).`,
      color: COLORS.INFO,
    });

    await this._notifyPositionChanges(guildId);
    await this.panels.refresh(guildId);
    return result;
  }

  /** Devolve o jogador ao final da fila (mesmo protocolo). */
  async returnToQueue({ guildId, attendanceId, actorId, actorTag, reason }) {
    const result = await this.db.transaction(() => {
      const row = this.repos.attendance.findByIdSync(guildId, attendanceId);
      if (!row) throw new AppError(ERRORS.ATENDIMENTO_NAO_ENCONTRADO, 'Atendimento não encontrado.');
      if (row.status !== ATTENDANCE_STATUS.SERVING) {
        throw new AppError(
          ERRORS.ATENDIMENTO_NAO_EM_ANDAMENTO,
          'Só é possível devolver à fila um atendimento em andamento.',
        );
      }
      const newSeq = this.repos.counter.nextSync(`queue:${guildId}`);
      return this.repos.attendance.updateSync(guildId, row.id, {
        status: ATTENDANCE_STATUS.WAITING,
        staff_id: null,
        staff_tag: null,
        started_at: null,
        presence_confirmed: 0,
        queue_seq: newSeq,
        order_reason: reason ?? row.order_reason,
      });
    });

    this._clearTimer(result.id);
    await this._effect('liberar staff', () =>
      this.staff.release(guildId, actorId, {
        autoAvailable: this.settings.get('staff_auto_available'),
      }),
    );
    await this._effect('remover acesso', () =>
      this.gateway.revokeVoiceAccess(guildId, result.voice_channel_id, result.user_id),
    );
    await this._effect('mover para espera', () =>
      this.gateway.moveToVoiceChannel(guildId, result.user_id, this.settings.get('wait_channel_id'), {
        force: true,
      }),
    );

    const state = this.getState(guildId);
    const position = state.waiting.findIndex((item) => item.id === result.id) + 1;
    await this._effect('avisar retorno', () =>
      this.notifications.requeued({
        guildId,
        userId: result.user_id,
        protocol: result.protocol,
        position,
        reason,
      }),
    );

    await this.audit.log({
      guildId,
      type: 'QUEUE_RETURN',
      actorId,
      actorTag,
      targetId: result.user_id,
      protocol: result.protocol,
      message: `**${result.username}** foi devolvido ao final da fila por **${actorTag ?? actorId}**${reason ? `. Motivo: **${reason}**` : ''}.`,
      color: COLORS.WARNING,
      metadata: { reason, position },
    });

    await this._notifyPositionChanges(guildId);
    await this.panels.refresh(guildId);
    return { attendance: result, position };
  }

  /** Remoção com justificativa obrigatória. */
  async removePlayer({ guildId, attendanceId, actorId, actorTag, reason }) {
    if (!reason || !String(reason).trim()) {
      throw new AppError(ERRORS.MOTIVO_OBRIGATORIO, 'A justificativa é obrigatória para remover um jogador.');
    }

    const closed = await this.db.transaction(() => {
      const row = this.repos.attendance.findByIdSync(guildId, attendanceId);
      if (!row) throw new AppError(ERRORS.ATENDIMENTO_NAO_ENCONTRADO, 'Atendimento não encontrado.');
      if (row.status === ATTENDANCE_STATUS.FINISHED) {
        throw new AppError(ERRORS.ATENDIMENTO_NAO_ENCONTRADO, 'Este atendimento já foi encerrado.');
      }
      const outcome = row.status === ATTENDANCE_STATUS.SERVING ? OUTCOMES.CANCELADO : OUTCOMES.REMOVIDO;
      return this._finalizeSync(guildId, row, { outcome, note: reason, closedBy: actorId });
    });

    this._clearTimer(closed.id);
    if (closed.staff_id && closed.status === ATTENDANCE_STATUS.FINISHED) {
      await this._effect('liberar staff', () => this.staff.release(guildId, closed.staff_id));
    }
    await this._effect('remover acesso', () =>
      this.gateway.revokeVoiceAccess(guildId, closed.voice_channel_id, closed.user_id),
    );
    await this._effect('desconectar', () => this.gateway.disconnectFromVoice(guildId, closed.user_id));
    await this._effect('avisar jogador', () =>
      this.notifications.removed({ guildId, userId: closed.user_id, protocol: closed.protocol, reason }),
    );

    await this.audit.log({
      guildId,
      type: 'QUEUE_REMOVE',
      actorId,
      actorTag,
      targetId: closed.user_id,
      protocol: closed.protocol,
      message: `**${closed.username}** foi removido do atendimento por **${actorTag ?? actorId}**. Justificativa: **${reason}**.`,
      color: COLORS.DANGER,
      metadata: { outcome: closed.outcome },
    });

    await this._notifyPositionChanges(guildId);
    await this.panels.refresh(guildId);
    return closed;
  }

  /* ==================================================================== */
  /* Finalização e avaliação                                              */
  /* ==================================================================== */

  async finish({ guildId, attendanceId, actorId, actorTag, note = null, outcome = OUTCOMES.CONCLUIDO }) {
    const closed = await this.db.transaction(() => {
      const row = this.repos.attendance.findByIdSync(guildId, attendanceId);
      if (!row) throw new AppError(ERRORS.ATENDIMENTO_NAO_ENCONTRADO, 'Atendimento não encontrado.');
      if (row.status !== ATTENDANCE_STATUS.SERVING) {
        throw new AppError(
          ERRORS.ATENDIMENTO_NAO_EM_ANDAMENTO,
          'Este atendimento não está em andamento.',
        );
      }
      return this._finalizeSync(guildId, row, { outcome, note, closedBy: actorId });
    });

    this._clearTimer(closed.id);
    await this._effect('liberar staff', () =>
      this.staff.release(guildId, closed.staff_id, {
        autoAvailable: this.settings.get('staff_auto_available'),
      }),
    );
    await this._effect('remover acesso', () =>
      this.gateway.revokeVoiceAccess(guildId, closed.voice_channel_id, closed.user_id),
    );
    await this._effect('desconectar do canal de atendimento', () =>
      this.gateway.disconnectFromVoice(guildId, closed.user_id),
    );

    if (this.settings.get('evaluations_enabled')) {
      await this._effect('enviar avaliação', () =>
        this.notifications.evaluationRequest({
          guildId,
          userId: closed.user_id,
          protocol: closed.protocol,
          staffName: closed.staff_tag ? `<@${closed.staff_id}>` : null,
          attendanceId: closed.id,
        }),
      );
    }

    await this.audit.log({
      guildId,
      type: 'ATTENDANCE_FINISH',
      actorId,
      actorTag,
      targetId: closed.user_id,
      protocol: closed.protocol,
      message: [
        `${OUTCOME_LABELS[closed.outcome] ?? closed.outcome}`,
        `**Protocolo:** #${this.formatProtocol(closed.protocol)}`,
        `**Jogador:** ${closed.username}`,
        `**Staff:** ${closed.staff_tag ? `<@${closed.staff_id}>` : 'não registrado'}`,
        `**Espera:** ${this.formatSeconds(closed.wait_seconds)} • **Duração:** ${this.formatSeconds(closed.duration_seconds)}`,
        note ? `**Observação:** ${note}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      color: COLORS.SUCCESS,
      metadata: {
        outcome: closed.outcome,
        waitSeconds: closed.wait_seconds,
        durationSeconds: closed.duration_seconds,
      },
    });

    await this.panels.refresh(guildId);
    return closed;
  }

  /** Finaliza o atendimento ativo de um staff (sem precisar do ID). */
  async finishByStaff({ guildId, staffId, staffTag, note = null }) {
    const active = this.repos.attendance.findServingByStaffSync(guildId, staffId);
    if (!active) {
      throw new AppError(ERRORS.ATENDIMENTO_NAO_ENCONTRADO, 'Você não possui atendimento em andamento.');
    }
    return this.finish({
      guildId,
      attendanceId: active.id,
      actorId: staffId,
      actorTag: staffTag,
      note,
    });
  }

  /* ==================================================================== */
  /* Timeouts / eventos do Discord                                        */
  /* ==================================================================== */

  _schedulePresenceTimeout(guildId, attendanceId) {
    this._clearTimer(attendanceId);
    const minutes = this.settings.get('presence_timeout_minutes') || 5;
    const timer = setTimeout(() => {
      this._handlePresenceTimeout(guildId, attendanceId).catch((error) =>
        logger.error('Falha no timeout de presença', error),
      );
    }, minutes * 60000);
    timer.unref?.();
    this.timers.set(attendanceId, timer);
  }

  async _handlePresenceTimeout(guildId, attendanceId) {
    const row = this.repos.attendance.findByIdSync(guildId, attendanceId);
    if (!row || row.status !== ATTENDANCE_STATUS.SERVING || row.presence_confirmed === 1) return;

    const policy = this.settings.get('no_show_policy');
    const closed = await this.db.transaction(() =>
      this._finalizeSync(guildId, row, {
        outcome: OUTCOMES.NAO_COMPARECEU,
        note: 'Jogador não compareceu ao canal de voz no tempo limite',
        closedBy: 'sistema',
      }),
    );

    await this._effect('liberar staff', () => this.staff.release(guildId, closed.staff_id));
    await this._effect('remover acesso', () =>
      this.gateway.revokeVoiceAccess(guildId, closed.voice_channel_id, closed.user_id),
    );
    await this._effect('avisar no-show', () =>
      this.notifications.noShow({ guildId, userId: closed.user_id, protocol: closed.protocol }),
    );

    await this.audit.log({
      guildId,
      type: 'ATTENDANCE_NO_SHOW',
      actorId: null,
      targetId: closed.user_id,
      protocol: closed.protocol,
      message: `⌛ **${closed.username}** não compareceu ao atendimento #${this.formatProtocol(closed.protocol)} no tempo limite.`,
      color: COLORS.WARNING,
    });

    if (policy === 'requeue') {
      await this._effect('devolver à fila', () =>
        this.enqueueExistingPlayer({
          guildId,
          userId: closed.user_id,
          displayName: closed.username,
          source: 'no-show',
        }),
      );
    }

    await this.panels.refresh(guildId);
  }

  /** Coloca um jogador na fila sem passar pelas validações de entrada. */
  async enqueueExistingPlayer({ guildId, userId, displayName, source = 'sistema' }) {
    const created = await this.db.transaction(() => {
      const active = this.repos.attendance.findActiveByUserSync(guildId, userId);
      if (active) return { attendance: active, position: null, protocol: active.protocol };
      const protocol = this.repos.counter.nextSync(`protocol:${guildId}`);
      const queueSeq = this.repos.counter.nextSync(`queue:${guildId}`);
      const row = this.repos.attendance.createSync({
        guildId,
        protocol,
        userId,
        username: displayName,
        status: ATTENDANCE_STATUS.WAITING,
        queueSeq,
        waitChannelId: this.settings.get('wait_channel_id'),
      });
      const waiting = this.repos.attendance.listWaitingSync(guildId);
      const position = waiting.findIndex((item) => item.id === row.id) + 1;
      const withPosition = this.repos.attendance.updateSync(guildId, row.id, {
        last_position_notified: position,
      });
      return { attendance: withPosition, protocol, position };
    });

    await this._effect('mover para espera', () =>
      this.gateway.moveToVoiceChannel(guildId, userId, this.settings.get('wait_channel_id'), {
        force: true,
      }),
    );
    await this.audit.log({
      guildId,
      type: 'QUEUE_REQUEUE',
      actorId: null,
      targetId: userId,
      protocol: created.protocol,
      message: `**${displayName}** retornou à fila (${source}).`,
      color: COLORS.INFO,
    });
    await this._notifyPositionChanges(guildId);
    await this.panels.refresh(guildId);
    return created;
  }

  /** Confirma presença do jogador no canal de atendimento. */
  async confirmPresence({ guildId, userId, channelId }) {
    const active = this.repos.attendance.findActiveByUserSync(guildId, userId);
    if (!active || active.status !== ATTENDANCE_STATUS.SERVING) return null;
    if (active.presence_confirmed === 1) return active;

    const updated = await this.db.transaction(() =>
      this.repos.attendance.updateSync(guildId, active.id, {
        presence_confirmed: 1,
        voice_channel_id: channelId,
      }),
    );
    this._clearTimer(active.id);

    await this.audit.log({
      guildId,
      type: 'ATTENDANCE_PRESENCE',
      actorId: userId,
      targetId: userId,
      protocol: active.protocol,
      message: `**${active.username}** compareceu ao atendimento #${this.formatProtocol(active.protocol)}.`,
      color: COLORS.INFO,
    });
    await this.panels.refresh(guildId);
    return updated;
  }

  /** Jogador saiu do servidor. */
  async handleMemberLeave({ guildId, userId, displayName }) {
    const active = this.repos.attendance.findActiveByUserSync(guildId, userId);
    if (!active) return null;

    const closed = await this.db.transaction(() =>
      this._finalizeSync(guildId, active, {
        outcome: active.status === ATTENDANCE_STATUS.SERVING ? OUTCOMES.DESCONECTOU : OUTCOMES.DESISTIU,
        note: 'Jogador saiu do servidor',
        closedBy: 'sistema',
      }),
    );

    this._clearTimer(closed.id);
    if (closed.staff_id) {
      await this._effect('liberar staff', () => this.staff.release(guildId, closed.staff_id));
    }

    await this.audit.log({
      guildId,
      type: 'PLAYER_LEFT_GUILD',
      actorId: null,
      targetId: userId,
      protocol: closed.protocol,
      message: `**${displayName ?? closed.username}** saiu do servidor durante o atendimento #${this.formatProtocol(closed.protocol)}. Registro encerrado automaticamente.`,
      color: COLORS.DANGER,
      metadata: { outcome: closed.outcome },
    });

    await this._notifyPositionChanges(guildId);
    await this.panels.refresh(guildId);
    return closed;
  }

  /** Staff saiu do servidor: libera atendimentos pendentes. */
  async handleStaffLeave({ guildId, userId, displayName }) {
    const active = this.repos.attendance.findServingByStaffSync(guildId, userId);
    await this.db.transaction(async () =>
      this.repos.staff.upsertSync(guildId, userId, {
        status: STAFF_STATUS.INDISPONIVEL,
        manual: 1,
        updatedBy: 'sistema',
      }),
    );

    if (active) {
      const closed = await this.db.transaction(() =>
        this._finalizeSync(guildId, active, {
          outcome: OUTCOMES.STAFF_DESCONECTOU,
          note: 'Staff saiu do servidor durante o atendimento',
          closedBy: 'sistema',
        }),
      );
      this._clearTimer(closed.id);
      await this._effect('remover acesso', () =>
        this.gateway.revokeVoiceAccess(guildId, closed.voice_channel_id, closed.user_id),
      );
      await this.audit.log({
        guildId,
        type: 'STAFF_LEFT_GUILD',
        actorId: userId,
        targetId: closed.user_id,
        protocol: closed.protocol,
        message: `🛡️ O staff **${displayName ?? userId}** saiu do servidor e o atendimento #${this.formatProtocol(closed.protocol)} foi encerrado. Jogador devolvido à fila.`,
        color: COLORS.DANGER,
      });
      await this._effect('devolver jogador à fila', () =>
        this.enqueueExistingPlayer({
          guildId,
          userId: closed.user_id,
          displayName: closed.username,
          source: 'staff saiu do servidor',
        }),
      );
    } else {
      await this.audit.log({
        guildId,
        type: 'STAFF_LEFT_GUILD',
        actorId: userId,
        message: `🛡️ **${displayName ?? userId}** saiu do servidor. Status marcado como INDISPONÍVEL.`,
        color: COLORS.MUTED,
      });
    }

    await this.panels.refresh(guildId);
    return active;
  }

  /** Atualização de voz de um jogador. */
  /**
   * Sincroniza fila e canais de voz.
   *
   * - Entrou no canal de espera → entra na fila automaticamente.
   * - Saiu do canal de espera → sai da fila (configurável).
   * - Entrou no canal de atendimento → presença confirmada.
   * - Saiu do canal de atendimento → tolerância e encerramento.
   */
  async handlePlayerVoiceUpdate({
    guildId,
    userId,
    channelId,
    oldChannelId = null,
    attendanceChannelIds = [],
    isStaff = false,
    displayName = null,
  }) {
    const waitChannelId = this.settings.get('wait_channel_id');
    const active = this.repos.attendance.findActiveByUserSync(guildId, userId);

    // 0) Tentou voltar ao canal de espera durante o bloqueio → remove do canal
    if (!isStaff && !active && channelId && waitChannelId && channelId === waitChannelId) {
      const cooldown = this.cooldowns?.check(guildId, userId);
      if (cooldown?.active) {
        await this._effect('remover do canal de espera', () =>
          this.gateway.disconnectFromVoice(guildId, userId),
        );
        await this._effect('avisar bloqueio', () =>
          this.notifications.cooldownBlocked({
            guildId,
            userId,
            remainingSeconds: cooldown.remainingSeconds,
            minutes: this.cooldowns.minutes,
          }),
        );
        await this.audit.log({
          guildId,
          type: 'COOLDOWN_BLOCKED',
          actorId: userId,
          targetId: userId,
          message: `⏳ **${displayName ?? `<@${userId}>`}** tentou voltar ao canal de espera durante o bloqueio (${this.cooldowns.message(cooldown)}).`,
          color: COLORS.MUTED,
          metadata: { remainingSeconds: cooldown.remainingSeconds },
        });
        return { cooldownBlocked: true, remainingSeconds: cooldown.remainingSeconds };
      }
    }

    // 1) Entrou no canal de espera sem estar na fila → entra automaticamente
    if (
      !isStaff &&
      !active &&
      channelId &&
      waitChannelId &&
      channelId === waitChannelId &&
      this.settings.get('auto_queue_on_voice_join')
    ) {
      try {
        const created = await this.joinQueue({
          guildId,
          userId,
          displayName,
          source: 'canal de voz de espera',
        });
        await this.audit.log({
          guildId,
          type: 'QUEUE_JOIN_VOICE',
          actorId: userId,
          targetId: userId,
          protocol: created.protocol,
          message: `**${created.attendance.username}** entrou na fila automaticamente ao entrar no canal de espera (posição ${created.position}º).`,
          color: COLORS.ORANGE,
        });
        return { autoJoined: true, position: created.position };
      } catch (error) {
        // Já na fila / em atendimento: nada a fazer.
        if (error.code === ERRORS.JA_NA_FILA || error.code === ERRORS.JA_EM_ATENDIMENTO) return null;
        if (error.code === ERRORS.CENTRAL_FECHADA) {
          await this._effect('avisar central fechada', () =>
            this.notifications.centralClosed({
              guildId,
              userId,
              schedule: this.schedule.getSchedule(guildId),
              nextOpen: this.schedule.isOpen(guildId).nextOpen,
            }),
          );
          return null;
        }
        throw error;
      }
    }

    if (!active) return null;

    // 2) Fora da fila de espera enquanto aguardava → desistência
    if (active.status === ATTENDANCE_STATUS.WAITING) {
      const wasWaitingInVoice = oldChannelId && oldChannelId === waitChannelId;
      const leftWaitChannel = wasWaitingInVoice && channelId !== waitChannelId;

      if (leftWaitChannel && this.settings.get('leave_queue_on_wait_exit')) {
        const closed = await this.leaveQueue({
          guildId,
          userId,
          actorId: userId,
          reason: 'Saiu do canal de espera antes de ser chamado',
          outcome: OUTCOMES.DESISTIU,
        });
        await this.audit.log({
          guildId,
          type: 'QUEUE_LEFT_WAIT_VOICE',
          actorId: userId,
          targetId: userId,
          protocol: closed.protocol,
          message: `**${closed.username}** saiu do canal de espera e foi removido da fila automaticamente.`,
          color: COLORS.MUTED,
        });
        return { leftQueue: true };
      }

      if (leftWaitChannel) {
        await this.audit.log({
          guildId,
          type: 'PLAYER_LEFT_WAIT_VOICE',
          actorId: userId,
          targetId: userId,
          protocol: active.protocol,
          message: `**${active.username}** saiu do canal de espera (permanece na fila).`,
          color: COLORS.MUTED,
        });
      }
      return null;
    }

    if (active.status === ATTENDANCE_STATUS.SERVING) {
      const isAttendanceChannel = channelId && attendanceChannelIds.includes(channelId);
      if (isAttendanceChannel) {
        this._clearVoiceTimer(active.id);
        return this.confirmPresence({ guildId, userId, channelId });
      }
      if (!channelId) {
        this._scheduleVoiceDisconnect(guildId, active.id);
      }
      return null;
    }

    return null;
  }

  _scheduleVoiceDisconnect(guildId, attendanceId) {
    this._clearVoiceTimer(attendanceId);
    const graceSeconds = this.settings.get('voice_disconnect_grace_seconds') || 120;
    const timer = setTimeout(() => {
      this._handleVoiceDisconnectTimeout(guildId, attendanceId).catch((error) =>
        logger.error('Falha no timeout de desconexão', error),
      );
    }, graceSeconds * 1000);
    timer.unref?.();
    this.timers.set(`voice:${attendanceId}`, timer);
  }

  _clearVoiceTimer(attendanceId) {
    const key = `voice:${attendanceId}`;
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  async _handleVoiceDisconnectTimeout(guildId, attendanceId) {
    const row = this.repos.attendance.findByIdSync(guildId, attendanceId);
    if (!row || row.status !== ATTENDANCE_STATUS.SERVING) return;

    const member = await this.gateway.getMember(guildId, row.user_id);
    if (!member?.inGuild) return this.handleMemberLeave({ guildId, userId: row.user_id });

    const channelId = member.voiceChannelId;
    const allowed = this.settings.get('attendance_channel_ids') || [];
    if (channelId && allowed.includes(channelId)) return;

    const closed = await this.db.transaction(() =>
      this._finalizeSync(guildId, row, {
        outcome: OUTCOMES.DESCONECTOU,
        note: 'Jogador desconectou do canal de atendimento',
        closedBy: 'sistema',
      }),
    );

    await this._effect('liberar staff', () => this.staff.release(guildId, closed.staff_id));
    await this._effect('remover acesso', () =>
      this.gateway.revokeVoiceAccess(guildId, closed.voice_channel_id, closed.user_id),
    );
    await this.audit.log({
      guildId,
      type: 'ATTENDANCE_DISCONNECT',
      actorId: null,
      targetId: closed.user_id,
      protocol: closed.protocol,
      message: `🔌 **${closed.username}** desconectou do canal de atendimento #${this.formatProtocol(closed.protocol)}. Atendimento encerrado.`,
      color: COLORS.WARNING,
    });
    await this.panels.refresh(guildId);
    return closed;
  }

  /** Atualização de voz de um membro da staff. */
  async handleStaffVoiceUpdate({ guildId, userId, channelId, attendanceChannelIds, memberInGuild = true }) {
    const serving = this.repos.attendance.findServingByStaffSync(guildId, userId);

    if (!channelId) {
      if (serving) {
        await this._effect('marcar indisponível', () =>
          this.staff.markUnavailableFromVoice(guildId, userId),
        );
        await this.audit.log({
          guildId,
          type: 'STAFF_VOICE_DISCONNECT',
          actorId: userId,
          protocol: serving.protocol,
          message: `🛡️ <@${userId}> desconectou do canal de voz durante o atendimento #${this.formatProtocol(serving.protocol)}.`,
          color: COLORS.WARNING,
        });
        this._scheduleStaffReturnTimeout(guildId, userId, serving.id);
      } else {
        await this._effect('marcar indisponível', () =>
          this.staff.markUnavailableFromVoice(guildId, userId),
        );
      }
      await this.panels.refresh(guildId);
      return;
    }

    const isAttendanceChannel = attendanceChannelIds.includes(channelId);
    const current = this.staff.get(guildId, userId);

    if (memberInGuild && isAttendanceChannel && current.status === STAFF_STATUS.INDISPONIVEL) {
      await this._effect('marcar disponível', () =>
        this.staff.setStatus({
          guildId,
          userId,
          status: STAFF_STATUS.DISPONIVEL,
          updatedBy: 'sistema',
          manual: false,
        }),
      );
    }

    this._clearStaffTimer(userId);
    await this.panels.refresh(guildId);
  }

  _scheduleStaffReturnTimeout(guildId, staffId, attendanceId) {
    this._clearStaffTimer(staffId);
    const graceSeconds = this.settings.get('voice_disconnect_grace_seconds') || 120;
    const timer = setTimeout(() => {
      this._handleStaffReturnTimeout(guildId, staffId, attendanceId).catch((error) =>
        logger.error('Falha no timeout de retorno do staff', error),
      );
    }, graceSeconds * 1000);
    timer.unref?.();
    this.timers.set(`staff:${staffId}`, timer);
  }

  _clearStaffTimer(staffId) {
    const key = `staff:${staffId}`;
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  async _handleStaffReturnTimeout(guildId, staffId, attendanceId) {
    const row = this.repos.attendance.findByIdSync(guildId, attendanceId);
    if (!row || row.status !== ATTENDANCE_STATUS.SERVING) return;

    const voice = await this.gateway.getStaffVoiceState(guildId, staffId);
    if (voice?.connected && voice.isAttendanceChannel) return;

    const closed = await this.db.transaction(() =>
      this._finalizeSync(guildId, row, {
        outcome: OUTCOMES.STAFF_DESCONECTOU,
        note: 'Staff não retornou ao canal de voz',
        closedBy: 'sistema',
      }),
    );

    await this._effect('remover acesso', () =>
      this.gateway.revokeVoiceAccess(guildId, closed.voice_channel_id, closed.user_id),
    );
    await this.audit.log({
      guildId,
      type: 'ATTENDANCE_STAFF_ABANDON',
      actorId: staffId,
      targetId: closed.user_id,
      protocol: closed.protocol,
      message: `🛡️ <@${staffId}> não retornou ao canal de voz. Atendimento #${this.formatProtocol(closed.protocol)} encerrado e jogador devolvido à fila.`,
      color: COLORS.DANGER,
    });
    await this._effect('devolver jogador à fila', () =>
      this.enqueueExistingPlayer({
        guildId,
        userId: closed.user_id,
        displayName: closed.username,
        source: 'staff desconectou',
      }),
    );
    await this.panels.refresh(guildId);
    return closed;
  }

  /* ==================================================================== */
  /* Manutenção periódica / recuperação                                   */
  /* ==================================================================== */

  /** Expira jogadores que excederam o tempo máximo de espera. */
  async expireWaitingPlayers(guildId) {
    const limitMinutes = this.settings.get('max_wait_minutes') || 0;
    if (limitMinutes <= 0) return [];

    const limitMs = limitMinutes * 60000;
    const now = Date.now();
    const expired = this.repos.attendance
      .listWaitingSync(guildId)
      .filter((row) => now - row.joined_at >= limitMs);

    const results = [];
    for (const row of expired) {
      const closed = await this.db.transaction(() =>
        this._finalizeSync(guildId, row, {
          outcome: OUTCOMES.REMOVIDO,
          note: `Tempo máximo de espera excedido (${limitMinutes} min)`,
          closedBy: 'sistema',
        }),
      );
      results.push(closed);
      await this._effect('avisar expiração', () =>
        this.notifications.removed({
          guildId,
          userId: row.user_id,
          protocol: row.protocol,
          reason: `Tempo máximo de espera excedido (${limitMinutes} minutos).`,
        }),
      );
      await this._effect('desconectar', () => this.gateway.disconnectFromVoice(guildId, row.user_id));
    }

    if (results.length > 0) {
      await this.audit.log({
        guildId,
        type: 'QUEUE_EXPIRED',
        actorId: null,
        message: `${results.length} jogador(es) removido(s) da fila por exceder o tempo máximo de espera.`,
        color: COLORS.MUTED,
        metadata: { protocols: results.map((r) => r.protocol) },
      });
      await this.panels.refresh(guildId);
    }
    return results;
  }

  /** Chamado na inicialização: valida fila, atendimentos e presenças. */
  async recover(guildId) {
    const active = this.repos.attendance.listActiveSync(guildId);
    const report = { recovered: 0, closed: 0, requeued: 0, details: [] };

    for (const row of active) {
      const member = await this.gateway.getMember(guildId, row.user_id);
      if (!member?.inGuild) {
        const closed = await this.db.transaction(() =>
          this._finalizeSync(guildId, row, {
            outcome: OUTCOMES.DESISTIU,
            note: 'Recuperação: jogador não está mais no servidor',
            closedBy: 'sistema',
          }),
        );
        report.closed += 1;
        report.details.push(`Protocolo #${closed.protocol}: jogador ausente do servidor — encerrado.`);
        continue;
      }

      if (row.status === ATTENDANCE_STATUS.SERVING) {
        const staff = await this.gateway.getMember(guildId, row.staff_id);
        if (!staff?.inGuild) {
          const closed = await this.db.transaction(() =>
            this._finalizeSync(guildId, row, {
              outcome: OUTCOMES.STAFF_DESCONECTOU,
              note: 'Recuperação: staff ausente do servidor',
              closedBy: 'sistema',
            }),
          );
          this._clearTimer(closed.id);
          await this._effect('devolver jogador à fila', () =>
            this.enqueueExistingPlayer({
              guildId,
              userId: closed.user_id,
              displayName: closed.username,
              source: 'recuperação',
            }),
          );
          report.closed += 1;
          report.requeued += 1;
          report.details.push(
            `Protocolo #${closed.protocol}: staff ausente — jogador devolvido à fila.`,
          );
          continue;
        }

        if (row.presence_confirmed === 0) {
          this._schedulePresenceTimeout(guildId, row.id);
        }
        report.recovered += 1;
        report.details.push(`Protocolo #${row.protocol}: atendimento retomado.`);
      } else {
        report.recovered += 1;
      }
    }

    // Staff que ficou preso em EM_ATENDIMENTO sem atendimento ativo
    for (const entry of this.repos.staff.listSync(guildId)) {
      if (entry.status !== STAFF_STATUS.EM_ATENDIMENTO) continue;
      const serving = this.repos.attendance.findServingByStaffSync(guildId, entry.user_id);
      if (!serving) {
        await this.db.transaction(async () =>
          this.repos.staff.upsertSync(guildId, entry.user_id, {
            status: STAFF_STATUS.DISPONIVEL,
            manual: 0,
            updatedBy: 'recuperação',
          }),
        );
        report.details.push(`Staff <@${entry.user_id}> liberado (estava EM ATENDIMENTO sem protocolo ativo).`);
      }
    }

    for (const row of this.repos.attendance.listWaitingSync(guildId)) {
      await this._effect('reposicionar na espera', () =>
        this.gateway.moveToVoiceChannel(guildId, row.user_id, this.settings.get('wait_channel_id')).catch(
          () => null,
        ),
      );
    }

    await this.panels.refresh(guildId, { immediate: true });
    logger.info(`Recuperação concluída para ${guildId}`, report);
    return report;
  }

  /** Encerra a fila restante (política de fechamento). */
  async clearQueue({ guildId, actorId, actorTag, reason }) {
    const waiting = this.repos.attendance.listWaitingSync(guildId);
    const hold = this.repos.attendance.listHoldSync(guildId);
    const all = [...waiting, ...hold];
    for (const row of all) {
      const closed = await this.db.transaction(() =>
        this._finalizeSync(guildId, row, {
          outcome: OUTCOMES.CANCELADO,
          note: reason || 'Central encerrada',
          closedBy: actorId,
        }),
      );
      await this._effect('avisar jogador', () =>
        this.notifications.removed({
          guildId,
          userId: closed.user_id,
          protocol: closed.protocol,
          reason: reason || 'A central de atendimento foi encerrada.',
        }),
      );
      await this._effect('desconectar', () => this.gateway.disconnectFromVoice(guildId, closed.user_id));
    }

    if (all.length > 0) {
      await this.audit.log({
        guildId,
        type: 'QUEUE_CLEARED',
        actorId,
        actorTag,
        message: `A fila foi encerrada por **${actorTag ?? actorId}** (${all.length} jogador(es)).`,
        color: COLORS.DANGER,
        metadata: { protocols: all.map((row) => row.protocol) },
      });
    }
    await this.panels.refresh(guildId);
    return all.length;
  }

  /* ==================================================================== */
  /* Internos                                                             */
  /* ==================================================================== */

  _finalizeSync(guildId, row, { outcome, note = null, closedBy = null }) {
    const now = Date.now();
    const startedAt = row.started_at ?? null;
    const waitSeconds = Math.max(
      0,
      Math.round(((startedAt ?? now) - row.joined_at) / 1000),
    );
    const durationSeconds = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;

    return this.repos.attendance.updateSync(guildId, row.id, {
      status: ATTENDANCE_STATUS.FINISHED,
      outcome,
      ended_at: now,
      wait_seconds: waitSeconds,
      duration_seconds: durationSeconds,
      note: note ?? row.note ?? null,
      closed_by: closedBy,
      presence_confirmed: row.presence_confirmed,
    });
  }

  async _notifyPositionChanges(guildId, { excludeUserId = null } = {}) {
    if (!this.settings.get('notifications_position_change')) return;
    const cooldownMs = (this.settings.get('position_notify_cooldown_minutes') || 10) * 60000;
    const waiting = this.repos.attendance.listWaitingSync(guildId);
    const now = Date.now();

    for (let index = 0; index < waiting.length; index += 1) {
      const row = waiting[index];
      if (row.user_id === excludeUserId) continue;
      const position = index + 1;
      const last = row.last_position_notified;
      if (last !== null && last !== undefined && last <= position) continue;

      const lastAt = this.positionCooldowns.get(row.user_id) || 0;
      if (now - lastAt < cooldownMs) continue;

      this.positionCooldowns.set(row.user_id, now);
      await this._effect('avisar posição', () =>
        this.notifications.positionUpdate({
          guildId,
          userId: row.user_id,
          protocol: row.protocol,
          position,
        }),
      );
      await this.db.transaction(async () =>
        this.repos.attendance.updateSync(guildId, row.id, { last_position_notified: position }),
      );
      // primeiro aviso já registra a posição atual
    }
  }

  async _effect(label, fn) {
    try {
      return await fn();
    } catch (error) {
      logger.error(`Efeito "${label}" falhou: ${error.message}`);
      return null;
    }
  }

  _clearTimer(attendanceId) {
    const timer = this.timers.get(attendanceId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(attendanceId);
    }
    this._clearVoiceTimer(attendanceId);
  }

  formatProtocol(protocol) {
    return String(protocol).padStart(4, '0');
  }

  formatSeconds(seconds) {
    const { formatDuration } = require('../../utils/time');
    return formatDuration(seconds || 0);
  }
}

module.exports = { AttendanceEngine, ALLOWED_TRANSITIONS };
