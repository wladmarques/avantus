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
const { CooldownRepository } = require('../database/repositories/cooldownRepository');
const { HourBankRepository } = require('../database/repositories/hourBankRepository');

const { NotificationService } = require('../systems/notifications/notificationService');
const { AuditService } = require('../systems/logs/auditService');
const { StaffService } = require('../systems/staff/staffService');
const { ScheduleService } = require('../systems/schedule/scheduleService');
const { CentralService } = require('../systems/schedule/centralService');
const { AttendanceEngine } = require('../systems/attendance/attendanceEngine');
const { AttendanceService } = require('../systems/attendance/attendanceService');
const { QueueService } = require('../systems/queue/queueService');
const { CooldownService } = require('../systems/queue/cooldownService');
const { PanelService } = require('../systems/panels/panelService');
const { StatisticsService } = require('../systems/statistics/statisticsService');
const { EvaluationService } = require('../systems/evaluations/evaluationService');
const { RecoveryService } = require('../systems/recovery/recoveryService');
const { HourBankService } = require('../systems/hourbank/hourBankService');
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
    cooldowns: new CooldownRepository(db),
    hourBank: new HourBankRepository(db),
  };

  await db.transaction(async () => {
    repositories.settings.ensureDefaults();
  });
  const settings = repositories.settings;
  settings.load();
  // o gateway consulta configurações (canais/cargos) em tempo de execução
  if (gateway && 'settings' in gateway) gateway.settings = settings;

  const cooldownService = new CooldownService({
    db,
    repo: repositories.cooldowns,
    settings,
  });

  const notificationService = new NotificationService({ gateway, settings });
  const auditService = new AuditService({
    db,
    repo: repositories.audit,
    settings,
    gateway,
    notifications: notificationService,
  });

  const scheduleService = new ScheduleService({ settings, logger });

  // Banco de horas: conta o tempo em serviço, controla escala e avisos de turno.
  const hourBankService = new HourBankService({
    db,
    repo: repositories.hourBank,
    settings,
    gateway,
    notifications: notificationService,
  });

  const staffService = new StaffService({
    db,
    repo: repositories.staff,
    gateway,
    hourBank: hourBankService,
  });
  // o painel web precisa do status atual de cada staff
  hourBankService.staff = staffService;

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
    cooldowns: cooldownService,
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
    cooldowns: cooldownService,
    hourBank: hourBankService,
    attendance: attendanceService,
    statistics: statisticsService,
    evaluations: evaluationService,
    recovery: recoveryService,
    logger,
  };
}

module.exports = { createServices };
