'use strict';

const { createLogger } = require('../../utils/logger');

const logger = createLogger('members');

module.exports = {
  name: 'guildMemberUpdate',
  async execute(oldMember, newMember, context) {
    const { services } = context;
    const guildId = newMember.guild?.id;
    if (guildId !== services.settings.get('guild_id')) return;

    const roleIds = services.staff.panelRoleIds?.() ?? [];
    if (roleIds.length === 0) return;

    const before = [...(oldMember.roles?.cache?.keys?.() ?? [])].sort().join(',');
    const after = [...(newMember.roles?.cache?.keys?.() ?? [])].sort().join(',');
    if (before === after) return;

    // Cargo mudou: o painel precisa refletir em QUEM aparece em EQUIPE.
    logger.debug(`Cargos de ${newMember.id} mudaram — atualizando o painel da equipe.`);
    // `force`: a troca de cargo precisa refletir já (o throttle evita rajadas).
    await services.staff.refreshRoleCache(guildId, { force: true }).catch(() => null);
    await services.panels.refresh(guildId).catch((error) => logger.warn(`Painel: ${error.message}`));
  },
};
