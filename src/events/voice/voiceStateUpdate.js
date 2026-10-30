'use strict';

const { createLogger } = require('../../utils/logger');
const { isStaff } = require('../../config/permissions');

const logger = createLogger('voice');

/**
 * Mantém a consistência entre fila, atendimento e canais de voz.
 * - jogador entrou no canal de atendimento → presença confirmada
 * - jogador saiu do canal → tolerância e encerramento
 * - staff conectado/desconectado → disponibilidade
 */
module.exports = {
  name: 'voiceStateUpdate',
  async execute(oldState, newState, context) {
    const { services } = context;
    const guildId = newState.guild?.id ?? oldState.guild?.id;
    if (!guildId || guildId !== services.settings.get('guild_id')) return;

    const member = newState.member ?? oldState.member;
    if (!member || member.user?.bot) return;

    const userId = member.id;
    const channelId = newState.channelId ?? null;
    const oldChannelId = oldState.channelId ?? null;
    if (channelId === oldChannelId) return;

    const attendanceChannels = services.settings.get('attendance_channel_ids') || [];
    const staffMember = isStaff(member, services.settings);

    try {
      if (staffMember) {
        await services.attendance.handleStaffVoiceUpdate({
          guildId,
          userId,
          channelId,
          attendanceChannelIds: attendanceChannels,
          memberInGuild: true,
        });
      }

      if (!staffMember) {
        await services.attendance.handlePlayerVoiceUpdate({
          guildId,
          userId,
          channelId,
          oldChannelId,
          attendanceChannelIds: attendanceChannels,
          isStaff: false,
          displayName: member.displayName || member.user?.username,
        });
      }
    } catch (error) {
      logger.error('Falha ao processar mudança de voz', error);
    }
  },
};
