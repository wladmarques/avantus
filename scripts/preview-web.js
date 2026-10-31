'use strict';

/**
 * Pré-visualização local do painel web do banco de horas.
 *   npm run preview:web
 *
 * Sobe o painel com um banco temporário e dados de exemplo (staff, escalas e
 * sessões dos últimos dias) — nenhum dado do seu servidor é usado.
 * Senha padrão: vantus (defina PREVIEW_PASSWORD para trocar).
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../src/database/connection');
const { runMigrations } = require('../src/database/migrations');
const { createServices } = require('../src/services');
const { MemoryGateway } = require('../src/services/discordGateway');
const { startWebServer } = require('../src/web/server');
const { createLogger, setLevel } = require('../src/utils/logger');
const { startOfDay } = require('../src/utils/time');

setLevel('warn');
const logger = createLogger('preview-web');

const root = path.join(__dirname, '..');
const dbFile = path.join(root, 'data', 'preview-web.sqlite');
const PORT = Number(process.env.WEB_PANEL_PORT) || 8080;
const PASSWORD = process.env.PREVIEW_PASSWORD || 'vantus';
const GUILD = '100000000000000001';
const MINUTE = 60000;

const STAFF = [
  { id: '900000000000000001', name: 'pedrosa17', status: 'DISPONIVEL' },
  { id: '900000000000000002', name: 'gabriel_tt', status: 'EM_ATENDIMENTO' },
  { id: '900000000000000003', name: 'lucas.v', status: 'AUSENTE' },
  { id: '900000000000000004', name: 'mika', status: 'INDISPONIVEL' },
];

function hhmm(minutes) {
  const value = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

async function main() {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  for (const suffix of ['', '.bak', '.tmp']) fs.rmSync(`${dbFile}${suffix}`, { force: true });

  const db = await openDatabase({ filePath: dbFile });
  await runMigrations(db);
  const gateway = new MemoryGateway({ settings: null });
  const services = await createServices({ db, gateway });
  gateway.settings = services.settings;

  await services.settings.setMany({
    guild_id: GUILD,
    central_manual: 'open',
    wait_channel_id: '200000000000000001',
  });

  // Escala de exemplo para todos os dias (o turno da madrugada vira o dia).
  const schedules = [
    { start: '12:00', end: '02:00' },
    { start: '12:00', end: '02:00' },
    { start: '20:00', end: '02:00' },
    { start: '12:00', end: '02:00' },
  ];

  for (const [index, staff] of STAFF.entries()) {
    await services.hourBank.setSchedule({
      guildId: GUILD,
      userId: staff.id,
      staffName: staff.name,
      shifts: Array.from({ length: 7 }, (_, weekday) => ({ weekday, ...schedules[index] })),
    });

    // Sessões dos últimos dias (entrada alguns minutos após o turno → atraso).
    for (const day of [3, 2, 1]) {
      const dayTs = startOfDay(new Date(Date.now() - day * 24 * 60 * MINUTE));
      const started = dayTs + (12 * 60 + 5 + index * 4) * MINUTE;
      await services.hourBank.startSession({
        guildId: GUILD,
        userId: staff.id,
        staffName: staff.name,
        at: started,
      });
      await services.hourBank.endSession({
        guildId: GUILD,
        userId: staff.id,
        at: started + (240 - index * 35) * MINUTE,
      });
    }
  }

  // Status depois das sessões históricas: pedrosa17 fica em serviço agora.
  for (const staff of STAFF) {
    await services.staff.setStatus({
      guildId: GUILD,
      userId: staff.id,
      status: staff.status,
      updatedBy: 'preview',
      manual: true,
    });
  }

  const active = services.hourBank.activeSession(GUILD, STAFF[0].id);
  if (active) {
    db.run('UPDATE staff_sessions SET started_at = ?, late_minutes = ? WHERE id = ?', [
      Date.now() - 95 * MINUTE,
      12,
      active.id,
    ]);
  }

  const web = await startWebServer({
    services,
    env: { webPanelPassword: PASSWORD, webPanelPort: PORT, timezone: 'America/Sao_Paulo', guildId: GUILD },
    logger: {
      info: (message) => console.log(`✔ ${message}`),
      warn: (message) => console.log(`⚠ ${message}`),
      error: (message) => console.log(`✖ ${message}`),
    },
  });

  if (!web) {
    console.error('Não foi possível iniciar o painel.');
    process.exit(1);
  }

  console.log('');
  console.log(`   Painel: http://localhost:${web.port}`);
  console.log(`   Senha:  ${PASSWORD}`);
  console.log(`   Banco:  ${path.relative(root, dbFile)} (apague para resetar)`);
  console.log('');
}

main().catch((error) => {
  logger.error('Falha na pré-visualização', error);
  process.exit(1);
});
