'use strict';

/**
 * Fachada de operações da fila (usada por comandos e botões).
 */
class QueueService {
  constructor({ engine }) {
    this.engine = engine;
  }

  join({ guildId, userId, displayName, source }) {
    return this.engine.joinQueue({ guildId, userId, displayName, source });
  }

  leave({ guildId, userId, actorId, reason, outcome, silent }) {
    return this.engine.leaveQueue({ guildId, userId, actorId, reason, outcome, silent });
  }

  state(guildId) {
    return this.engine.getState(guildId);
  }

  skip({ guildId, attendanceId, actorId, actorTag, reason }) {
    return this.engine.skipPlayer({ guildId, attendanceId, actorId, actorTag, reason });
  }

  reactivate({ guildId, attendanceId, actorId, actorTag }) {
    return this.engine.reactivateHold({ guildId, attendanceId, actorId, actorTag });
  }

  returnToQueue(args) {
    return this.engine.returnToQueue(args);
  }

  remove(args) {
    return this.engine.removePlayer(args);
  }

  clear({ guildId, actorId, actorTag, reason }) {
    return this.engine.clearQueue({ guildId, actorId, actorTag, reason });
  }

  expire(guildId) {
    return this.engine.expireWaitingPlayers(guildId);
  }

  positionOf(guildId, userId) {
    const state = this.engine.getState(guildId);
    const index = state.waiting.findIndex((row) => row.user_id === userId);
    if (index >= 0) return { status: 'waiting', position: index + 1, entry: state.waiting[index] };
    const serving = state.serving.find((row) => row.user_id === userId);
    if (serving) return { status: 'serving', position: null, entry: serving };
    const hold = state.hold.find((row) => row.user_id === userId);
    if (hold) return { status: 'hold', position: null, entry: hold };
    return { status: 'none', position: null, entry: null };
  }
}

module.exports = { QueueService };
