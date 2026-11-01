'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../utils/logger');

const logger = createLogger('events');
const GROUPS = ['client', 'voice', 'members'];

/**
 * Carrega os listeners de src/events/<grupo>/*.js.
 * Cada arquivo exporta { name, once?, execute }.
 */
function loadEvents(client, context, rootDir = path.join(__dirname, '..', 'events')) {
  for (const group of GROUPS) {
    const dir = path.join(rootDir, group);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.js'))) {
      const event = require(path.join(dir, file));
      if (!event?.name || typeof event.execute !== 'function') {
        logger.warn(`Evento inválido ignorado: ${group}/${file}`);
        continue;
      }
      const handler = (...args) => {
        Promise.resolve(event.execute(...args, context)).catch((error) => {
          logger.error(`Erro no evento ${event.name}`, error);
        });
      };
      if (event.once) client.once(event.name, handler);
      else client.on(event.name, handler);
      logger.debug(`Evento carregado: ${group}/${event.name}`);
    }
  }
}

module.exports = { loadEvents };
