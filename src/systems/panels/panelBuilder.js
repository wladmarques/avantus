'use strict';

/**
 * Reexporta os construtores de painel para uso nos comandos administrativos.
 */
const { buildPublicPanel } = require('../../dashboard/panels/publicPanel');
const { buildStaffPanel } = require('../../dashboard/panels/staffPanel');
const { PANEL_KEYS } = require('./panelService');

module.exports = { buildPublicPanel, buildStaffPanel, PANEL_KEYS };
