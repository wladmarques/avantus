'use strict';

/**
 * Fachada das operações de atendimento.
 */
class AttendanceService {
  constructor({ engine, repos }) {
    this.engine = engine;
    this.repos = repos;
  }

  callNext(args) {
    return this.engine.callNext(args);
  }

  callSpecific(args) {
    return this.engine.callSpecific(args);
  }

  finish(args) {
    return this.engine.finish(args);
  }

  finishByStaff(args) {
    return this.engine.finishByStaff(args);
  }

  activeByStaff(guildId, staffId) {
    return this.repos.attendance.findServingByStaffSync(guildId, staffId);
  }

  activeByUser(guildId, userId) {
    return this.repos.attendance.findActiveByUserSync(guildId, userId);
  }

  byProtocol(guildId, protocol) {
    return this.repos.attendance.findByProtocolSync(guildId, protocol);
  }

  history(guildId, userId) {
    return this.repos.attendance.listByUserSync(guildId, userId);
  }

  recent(guildId, limit = 20) {
    return this.repos.attendance.listAllFinishedSync(guildId, { limit });
  }

  recover(guildId) {
    return this.engine.recover(guildId);
  }

  confirmPresence(args) {
    return this.engine.confirmPresence(args);
  }

  handleMemberLeave(args) {
    return this.engine.handleMemberLeave(args);
  }

  handleStaffLeave(args) {
    return this.engine.handleStaffLeave(args);
  }

  handlePlayerVoiceUpdate(args) {
    return this.engine.handlePlayerVoiceUpdate(args);
  }

  handleStaffVoiceUpdate(args) {
    return this.engine.handleStaffVoiceUpdate(args);
  }
}

module.exports = { AttendanceService };
