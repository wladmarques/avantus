'use strict';

/**
 * Reexporta os construtores de painel para uso nos comandos administrativos.
 */
const { buildPublicPanel, buildPublicPanelV2, buildPublicPanelClassic } = require('../../dashboard/panels/publicPanel');
const { buildStaffPanel } = require('../../dashboard/panels/staffPanel');
const { PANEL_KEYS } = require('./panelService');

module.exports = { buildPublicPanel, buildPublicPanelV2, buildPublicPanelClassic, buildStaffPanel, PANEL_KEYS };
