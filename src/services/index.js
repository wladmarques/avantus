'use strict';

/**
 * Container de dependências: monta repositórios, serviços e o motor de
 * atendimento. Um único lugar para injetar o banco e o gateway do Discord
 * (nos testes, o gateway em memória).
 */
const { SettingsRepository } = require('../database/repositories/settingsRepository');
const { AttendanceRepository } = require('../database/repositories/attendanceRepository');
const { StaffRepository } = require('../database/repositories/staffRepository');
const { CounterRepository } = require('../database/repositories/counterRepository');
const { EvaluationRepository } = require('../database/repositories/evaluationRepository');
const { AuditRepository } = require('../database/repositories/auditRepository');
const { PanelRepository } = require('../database/repositories/panelRepository');

const { NotificationService } = require('../systems/notifications/notificationService');
const { AuditService } = require('../systems/logs/auditService');
const { StaffService } = require('../systems/staff/staffService');
const { ScheduleService } = require('../systems/schedule/scheduleService');
const { CentralService } = require('../systems/schedule/centralService');
const { AttendanceEngine } = require('../systems/attendance/attendanceEngine');
const { AttendanceService } = require('../systems/attendance/attendanceService');
const { QueueService } = require('../systems/queue/queueService');
const { PanelService } = require('../systems/panels/panelService');
const { StatisticsService } = require('../systems/statistics/statisticsService');
const { EvaluationService } = require('../systems/evaluations/evaluationService');
const { RecoveryService } = require('../systems/recovery/recoveryService');
const { createLogger } = require('../utils/logger');

const logger = createLogger('container');

async function createServices({ db, gateway }) {
  const repositories = {
    settings: new SettingsRepository(db),
    attendance: new AttendanceRepository(db),
    staff: new StaffRepository(db),
    counter: new CounterRepository(db),
    evaluations: new EvaluationRepository(db),
    audit: new AuditRepository(db),
    panels: new PanelRepository(db),
  };

  await db.transaction(async () => {
    repositories.settings.ensureDefaults();
  });
  const settings = repositories.settings;
  settings.load();
  // o gateway consulta configurações (canais/cargos) em tempo de execução
  if (gateway && 'settings' in gateway) gateway.settings = settings;

  const notificationService = new NotificationService({ gateway, settings });
  const auditService = new AuditService({
    db,
    repo: repositories.audit,
    settings,
    gateway,
    notifications: notificationService,
  });

  const scheduleService = new ScheduleService({ settings, logger });
  const staffService = new StaffService({ db, repo: repositories.staff, gateway });

  let panelService = null;
  const panelFacade = {
    refresh: (guildId, options) => panelService.refreshOrRequest(guildId, options),
  };

  const attendanceEngine = new AttendanceEngine({
    db,
    repositories,
    settings,
    gateway,
    staffService,
    notifications: notificationService,
    audit: auditService,
    panels: panelFacade,
    schedule: scheduleService,
  });

  const statisticsService = new StatisticsService({ db, repos: repositories, settings });
  panelService = new PanelService({
    db,
    repo: repositories.panels,
    gateway,
    settings,
    engine: attendanceEngine,
    statistics: statisticsService,
    schedule: scheduleService,
  });

  const centralService = new CentralService({
    db,
    settings,
    schedule: scheduleService,
    engine: attendanceEngine,
    panels: panelFacade,
    audit: auditService,
    notifications: notificationService,
  });

  const queueService = new QueueService({ engine: attendanceEngine });
  const attendanceService = new AttendanceService({
    engine: attendanceEngine,
    repos: repositories,
  });
  const evaluationService = new EvaluationService({
    db,
    repos: repositories,
    settings,
    audit: auditService,
  });

  const recoveryService = new RecoveryService({
    engine: attendanceEngine,
    panels: panelService,
    repositories,
    settings,
    schedule: scheduleService,
    gateway,
    statistics: statisticsService,
  });

  return {
    db,
    gateway,
    settings,
    repositories,
    notifications: notificationService,
    audit: auditService,
    schedule: scheduleService,
    staff: staffService,
    engine: attendanceEngine,
    panels: panelService,
    panelsFacade: panelFacade,
    central: centralService,
    queue: queueService,
    attendance: attendanceService,
    statistics: statisticsService,
    evaluations: evaluationService,
    recovery: recoveryService,
    logger,
  };
}

module.exports = { createServices };
