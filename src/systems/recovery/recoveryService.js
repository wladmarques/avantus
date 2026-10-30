'use strict';

const { createLogger } = require('../../utils/logger');

const logger = createLogger('recovery');

/**
 * Recuperação no start do bot:
 * - valida fila, atendimentos e staffs contra o estado real do servidor;
 * - garante que os painéis existam e estejam atualizados;
 * - limpa presenças/timers perdidos durante o downtime.
 */
class RecoveryService {
  constructor({ engine, panels, repositories, settings, schedule, gateway, statistics }) {
    this.engine = engine;
    this.panels = panels;
    this.repos = repositories;
    this.settings = settings;
    this.schedule = schedule;
    this.gateway = gateway;
    this.statistics = statistics;
  }

  async run(guildId) {
    const report = { guildId, attendance: null, panels: [], errors: [] };

    try {
      report.attendance = await this.engine.recover(guildId);
    } catch (error) {
      logger.error('Falha na recuperação de atendimentos', error);
      report.errors.push(`atendimentos: ${error.message}`);
    }

    for (const key of ['public', 'staff']) {
      const panel = this.repos.panels.getSync(guildId, key);
      if (!panel?.message_id) {
        report.panels.push(`${key}: não publicado`);
        continue;
      }
      try {
        const { payload } = this.panels.buildPayload(guildId, key);
        await this.gateway.editMessage(guildId, panel.channel_id, panel.message_id, payload);
        report.panels.push(`${key}: atualizado`);
      } catch (error) {
        logger.warn(`Painel ${key} precisa ser republicado: ${error.message}`);
        report.panels.push(`${key}: precisa reconstruir (${error.message})`);
      }
    }

    logger.info('Recuperação finalizada', report);
    return report;
  }

  /** Resumo para o comando /diagnostico. */
  diagnostics(guildId) {
    const state = this.engine.getState(guildId);
    const settings = this.settings.getAll();
    const panels = {
      public: this.repos.panels.getSync(guildId, 'public'),
      staff: this.repos.panels.getSync(guildId, 'staff'),
    };
    return {
      state,
      settings,
      panels,
      schedule: this.schedule.statusLabel(guildId),
      today: this.statistics.todayOverview(guildId),
    };
  }
}

module.exports = { RecoveryService };
