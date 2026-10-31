'use strict';

const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) return null;
  return value.trim();
}

function bool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'sim', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const env = {
  token: required('DISCORD_TOKEN'),
  guildId: required('GUILD_ID'),
  dbPath: required('DB_PATH') || path.resolve(process.cwd(), 'data', 'vantus.sqlite'),
  logLevel: (required('LOG_LEVEL') || 'info').toLowerCase(),
  timezone: required('TIMEZONE') || 'America/Sao_Paulo',
  autoRegisterCommands: bool('AUTO_REGISTER_COMMANDS', true),
  devGuildId: required('DEV_GUILD_ID'),
  panelRefreshSeconds: int('PANEL_REFRESH_SECONDS', 30),
  backupRetention: int('BACKUP_RETENTION', 10),
  isProduction: (required('NODE_ENV') || 'production') === 'production',
  // Painel web do banco de horas
  webPanelPassword: required('WEB_PANEL_PASSWORD'),
  webPanelPort: int('WEB_PANEL_PORT', 8080),
  webPanelHost: required('WEB_PANEL_HOST') || '0.0.0.0',
};

/** Valida as variáveis obrigatórias e devolve a lista de erros. */
function validateEnv({ requireToken = true } = {}) {
  const errors = [];
  if (requireToken && !env.token) {
    errors.push('DISCORD_TOKEN não configurado (obrigatório para iniciar o bot).');
  }
  if (requireToken && !env.guildId) {
    errors.push('GUILD_ID não configurado (ID do servidor da VANTUS).');
  }
  return errors;
}

module.exports = { env, validateEnv };
