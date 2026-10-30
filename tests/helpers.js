'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/database/connection');
const { runMigrations } = require('../src/database/migrations');
const { createServices } = require('../src/services');
const { MemoryGateway } = require('../src/services/discordGateway');

const GUILD = '100000000000000001';
const WAIT_CHANNEL = '200000000000000001';
const ATT_CHANNEL = 'att-1';

let counter = 0;

/**
 * Monta um ambiente completo (banco em arquivo temporário + gateway em memória).
 */
async function createTestEnv({ members = {}, voice = {}, settings = {}, filePath } = {}) {
  counter += 1;
  const dbFile = filePath || path.join(os.tmpdir(), `vantus-test-${process.pid}-${counter}.sqlite`);
  const db = await openDatabase({ filePath: dbFile });
  await runMigrations(db);

  const gateway = new MemoryGateway({ settings: null, members, voice });
  const services = await createServices({ db, gateway });
  gateway.settings = services.settings;

  const defaults = {
    guild_id: GUILD,
    central_manual: 'open',
    public_channel_id: '300000000000000001',
    staff_channel_id: '300000000000000002',
    log_channel_id: '300000000000000003',
    category_id: '400000000000000001',
    wait_channel_id: WAIT_CHANNEL,
    attendance_channel_ids: [ATT_CHANNEL],
    staff_role_ids: ['500000000000000001'],
    admin_role_ids: ['500000000000000002'],
    panel_refresh_seconds: 30,
    ...settings,
  };

  await services.settings.setMany(defaults);

  return {
    db,
    services,
    gateway,
    guildId: GUILD,
    waitChannelId: WAIT_CHANNEL,
    attChannelId: ATT_CHANNEL,
    filePath: dbFile,
    cleanup: async () => {
      await db.close();
      for (const suffix of ['', '.bak', '.tmp']) {
        fs.rmSync(`${dbFile}${suffix}`, { force: true });
      }
    },
  };
}

function addMember(gateway, userId, { voiceChannelId = null, displayName } = {}) {
  gateway.members.set(userId, { inGuild: true, voiceChannelId, displayName: displayName || `Jogador ${userId}` });
}

function addStaffInVoice(gateway, staffId, { channelId = ATT_CHANNEL, channelName = 'ATENDIMENTO 01' } = {}) {
  gateway.members.set(staffId, { inGuild: true, voiceChannelId: channelId, displayName: `Staff ${staffId}` });
  gateway.staffVoice.set(staffId, { channelId, channelName });
}

function removeMemberFromGuild(gateway, userId) {
  const entry = gateway.members.get(userId);
  if (entry) gateway.members.set(userId, { ...entry, inGuild: false });
}

function countDms(gateway, userId) {
  return gateway.dms.filter((dm) => dm.userId === userId).length;
}

module.exports = {
  createTestEnv,
  addMember,
  addStaffInVoice,
  removeMemberFromGuild,
  countDms,
  GUILD,
  WAIT_CHANNEL,
  ATT_CHANNEL,
};

/* ------------------------------------------------------------------ */
/* Utilitários para inspecionar payloads de painel (Components V2)     */
/* ------------------------------------------------------------------ */

/** Percorre recursivamente todos os componentes de um payload. */
function flattenComponents(payload, acc = []) {
  const walk = (component) => {
    if (!component || typeof component !== 'object') return;
    acc.push(component);
    if (Array.isArray(component.components)) component.components.forEach(walk);
    // Section pode ter uma thumbnail ou um botão como accessory
    if (component.accessory) walk(component.accessory);
  };
  (payload?.components ?? []).forEach(walk);
  return acc;
}

/** Todo o texto visível (embeds + text displays) de um payload. */
function panelText(payload) {
  const parts = [];
  for (const embed of payload?.embeds ?? []) {
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    for (const field of embed.fields ?? []) parts.push(`${field.name}: ${field.value}`);
    if (embed.footer?.text) parts.push(embed.footer.text);
  }
  for (const component of flattenComponents(payload)) {
    if (component.type === 10 && component.content) parts.push(component.content);
  }
  return parts.join('\n');
}

/** IDs dos botões de um payload (embeds ou Components V2). */
function panelButtonIds(payload) {
  return flattenComponents(payload)
    .filter((component) => component.type === 2)
    .map((component) => component.custom_id);
}

/** Containers (cards) de um payload V2. */
function panelCards(payload) {
  return flattenComponents(payload).filter((component) => component.type === 17);
}

module.exports.flattenComponents = flattenComponents;
module.exports.panelText = panelText;
module.exports.panelButtonIds = panelButtonIds;
module.exports.panelCards = panelCards;
