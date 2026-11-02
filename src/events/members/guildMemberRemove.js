'use strict';

const { createLogger } = require('../../utils/logger');
const { isStaff } = require('../../config/permissions');

const logger = createLogger('members');

module.exports = {
  name: 'guildMemberRemove',
  async execute(member, context) {
    const { services } = context;
    const guildId = member.guild.id;
    if (guildId !== services.settings.get('guild_id')) return;

    const wasStaff = isStaff(member, services.settings);
    try {
      await services.attendance.handleMemberLeave({
        guildId,
        userId: member.id,
        displayName: member.user?.username ?? member.displayName,
      });
      if (wasStaff) {
        await services.attendance.handleStaffLeave({
          guildId,
          userId: member.id,
          displayName: member.displayName,
        });
      }
    } catch (error) {
      logger.error('Falha ao tratar saída de membro', error);
    }
  },
};
