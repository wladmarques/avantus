'use strict';

/**
 * Construtores de embeds em JSON puro (sem depender do client do Discord),
 * o que permite testar a interface sem conexão.
 */
const { COLORS, BRAND } = require('../../config/theme');

function base(overrides = {}) {
  return {
    color: COLORS.PURPLE,
    footer: { text: BRAND.footer },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function card({ title, description, color = COLORS.PURPLE, fields = [], footer, thumbnail, image, timestamp = true }) {
  const embed = base({ title, description, color, fields });
  if (footer) embed.footer = { text: footer };
  if (thumbnail) embed.thumbnail = { url: thumbnail };
  if (image) embed.image = { url: image };
  if (!timestamp) delete embed.timestamp;
  return embed;
}

function success(title, description, fields = []) {
  return [card({ title, description, color: COLORS.SUCCESS, fields })];
}

function warning(title, description, fields = []) {
  return [card({ title, description, color: COLORS.WARNING, fields })];
}

function danger(title, description, fields = []) {
  return [card({ title, description, color: COLORS.DANGER, fields })];
}

function info(title, description, fields = []) {
  return [card({ title, description, color: COLORS.INFO, fields })];
}

function errorEmbed(description, title = '⛔ Não foi possível concluir') {
  return danger(title, description);
}

/** Divisor visual padrão dos cards. */
const DIVIDER = '─'.repeat(28);

module.exports = { card, success, warning, danger, info, errorEmbed, DIVIDER };
