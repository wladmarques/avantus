'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertAdmin, assertStaff } = require('../config/permissions');
const { respondError, ephemeral, defer } = require('./respond');
const { errorEmbed } = require('../dashboard/embeds/cards');
const { createLogger } = require('../utils/logger');

const logger = createLogger('commands');
const CATEGORIES = ['admin', 'staff', 'player'];

/** Carrega os comandos de src/commands/<categoria>/*.js */
function loadCommands(rootDir = path.join(__dirname, '..', 'commands')) {
  const commands = new Map();
  for (const category of CATEGORIES) {
    const dir = path.join(rootDir, category);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.js'))) {
      const command = require(path.join(dir, file));
      if (!command?.data || typeof command.execute !== 'function') {
        logger.warn(`Comando inválido ignorado: ${category}/${file}`);
        continue;
      }
      command.category = category;
      commands.set(command.data.name, command);
      logger.debug(`Comando carregado: ${category}/${command.data.name}`);
    }
  }
  return commands;
}

/**
 * Executa um slash command com validação de permissão e erro global.
 * O contexto completo (client, services, env, runtime) é repassado ao comando —
 * comandos que precisam do client (ex.: /setup, /diagnostico) falham sem isso.
 */
async function executeCommand(interaction, context) {
  const { services } = context;
  const command = interaction.client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    const settings = services.settings;
    const member = interaction.member;

    if (command.category === 'admin') assertAdmin(member, settings);
    if (command.category === 'staff') assertStaff(member, settings);

    // Comandos administrativos e de staff podem demorar: adiamos a resposta.
    if (command.category !== 'player') await defer(interaction, { ephemeral: true });

    await command.execute({ ...context, interaction, member });
  } catch (error) {
    logger.error(`Erro no comando /${interaction.commandName}`, error);
    if (interaction.deferred || interaction.replied) {
      await interaction
        .editReply({ embeds: [errorEmbed(error.userMessage || 'Erro inesperado ao executar o comando.')] })
        .catch(() => null);
    } else {
      await interaction
        .reply(ephemeral({ embeds: [errorEmbed(error.userMessage || 'Erro inesperado ao executar o comando.')] }))
        .catch(() => null);
    }
  }
}

module.exports = { loadCommands, executeCommand };
