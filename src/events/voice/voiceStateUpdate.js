'use strict';

const { createLogger } = require('../../utils/logger');
const { isStaff } = require('../../config/permissions');

const logger = createLogger('voice');

// Aviso de divergência de servidor: uma vez a cada 10 minutos, para não poluir o log.
let lastGuildWarningAt = 0;

function warnGuildMismatch(guildId, configuredGuildId) {
  const now = Date.now();
  if (now - lastGuildWarningAt < 10 * 60 * 1000) return;
  lastGuildWarningAt = now;
  logger.warn(
    `Evento de voz ignorado: servidor ${guildId} diferente do configurado (guild_id=${configuredGuildId}). ` +
      'A fila por voz só funciona no servidor configurado — confira /diagnostico.',
  );
}

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
    if (!guildId) return;

    const configuredGuildId = services.settings.get('guild_id');
    if (configuredGuildId && guildId !== configuredGuildId) {
      warnGuildMismatch(guildId, configuredGuildId);
      return;
    }

    const cachedMember = newState.member ?? oldState.member ?? null;
    if (cachedMember?.user?.bot) return; // bots nunca entram na fila

    const memberId = cachedMember?.id ?? newState.id ?? oldState.id ?? null;
    if (!memberId) return;

    // Cache frio (guilds grandes / membro parcial): resolve pelo gateway em vez de
    // descartar o evento — antes, quem não estava em cache simplesmente não entrava na fila.
    let member = cachedMember;
    if (!member) {
      const resolved = await services.gateway.getMember(guildId, memberId).catch(() => null);
      if (!resolved?.inGuild) {
        logger.debug(`Evento de voz ignorado (${guildId}/${memberId}): membro não está no servidor.`);
        return;
      }
      member = {
        id: memberId,
        displayName: resolved.displayName ?? memberId,
        user: { id: memberId, bot: false },
        roles: { cache: new Map((resolved.staffRoles ?? []).map((role) => [role, { id: role }])) },
        permissions: { has: () => false },
      };
    }

    const userId = member.id;
    const channelId = newState.channelId ?? null;
    const oldChannelId = oldState.channelId ?? null;
    if (channelId === oldChannelId) return;

    logger.debug(`[voz] ${member.displayName ?? userId}: ${oldChannelId ?? 'fora'} → ${channelId ?? 'fora'}`);

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
