'use strict';

/**
 * Tirar um staff de serviço fora do Discord (painel web).
 *
 * Serve para o caso clássico de esquecimento: o staff ficou como disponível,
 * o banco de horas continua contando e ele nem está mais na call. O painel
 * encerra a sessão e marca INDISPONÍVEL, com cuidado para não atropelar o
 * atendimento de um jogador em andamento.
 */

const { COLORS, STAFF_STATUS } = require('../../config/theme');
const { formatDuration } = require('../../utils/time');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('staff:off-service');

/** O staff está atendendo alguém: não dá para tirar de serviço. */
class StaffServingError extends Error {
  constructor(attendance) {
    const protocol = String(attendance.protocol).padStart(4, '0');
    super(
      `Esse staff está atendendo o jogador #${protocol}. ` +
        'Encerre ou transfira o atendimento no Discord antes de tirar de serviço.',
    );
    this.name = 'StaffServingError';
    this.code = 'EM_ATENDIMENTO';
    this.protocol = attendance.protocol;
  }
}

/** Canais de voz em que o staff "está trabalhando" (espera + atendimento). */
function workChannels(settings) {
  const ids = [
    ...(settings.get('attendance_channel_ids') || []),
    settings.get('wait_channel_id') || null,
  ];
  return new Set(ids.filter(Boolean));
}

/**
 * @param {object} params
 * @param {object} params.services container de serviços
 * @param {string} params.guildId
 * @param {string} params.userId
 * @param {string} [params.source] origem da ação (auditoria/log)
 * @param {boolean} [params.disconnectVoice] desconectar da call, se estiver nela
 * @param {boolean} [params.notify] avisar o staff por DM
 * @param {number} [params.at] instante do encerramento
 */
async function takeStaffOffService({
  services,
  guildId,
  userId,
  source = 'painel web',
  disconnectVoice = true,
  notify = true,
  at = Date.now(),
}) {
  const serving = services.repositories.attendance.findServingByStaffSync(guildId, userId);
  if (serving) throw new StaffServingError(serving);

  const staff = services.staff.get(guildId, userId);
  const session = services.hourBank.activeSession(guildId, userId);
  const closed = await services.hourBank.endSession({ guildId, userId, at });
  const minutes = closed ? Number(closed.minutes) || 0 : 0;

  await services.staff.setStatus({
    guildId,
    userId,
    status: STAFF_STATUS.INDISPONIVEL,
    updatedBy: source,
    manual: true,
  });

  // Só desconecta de canais de trabalho — nunca de uma call particular.
  let disconnected = false;
  if (disconnectVoice) {
    const member = await services.gateway.getMember(guildId, userId).catch(() => null);
    const voiceChannelId = member?.voiceChannelId ?? null;
    if (voiceChannelId && workChannels(services.settings).has(voiceChannelId)) {
      disconnected = Boolean(
        await services.gateway.disconnectFromVoice(guildId, userId).catch(() => false),
      );
    }
  }

  const name =
    services.hourBank.nameOf(guildId, userId) ||
    closed?.staff_name ||
    session?.staff_name ||
    userId;
  logger.info(
    `Staff ${userId} retirado de serviço por ${source}` +
      `${closed ? ` (sessão de ${formatDuration(minutes * 60)} encerrada)` : ''}.`,
  );

  await services.audit
    .log({
      guildId,
      type: 'STAFF_OFF_SERVICE',
      targetId: userId,
      message:
        `🛡️ O staff <@${userId}> foi retirado de serviço pelo **${source}**.` +
        (closed ? `\nSessão encerrada com **${formatDuration(minutes * 60)}** de trabalho.` : '') +
        (disconnected ? '\nRemovido do canal de voz.' : ''),
      color: COLORS.WARNING,
      metadata: { source, minutes, disconnected, hadSession: Boolean(session) },
    })
    .catch(() => null);

  if (notify) {
    await services.gateway
      .sendDirectMessage(guildId, userId, {
        content:
          `Você foi **retirado de serviço** pelo painel da equipe (${source}).` +
          (closed ? `\nSessão encerrada: **${formatDuration(minutes * 60)}**.` : '') +
          '\nSe ainda estiver trabalhando, use `/status situacao:Disponível` para voltar a contar as horas.',
      })
      .catch(() => null);
  }

  await services.panels.refresh(guildId).catch(() => null);

  return {
    userId,
    name,
    status: STAFF_STATUS.INDISPONIVEL,
    previousStatus: staff?.status ?? null,
    endedSession: closed
      ? {
          minutes,
          startedAt: Number(closed.started_at),
          endedAt: Number(closed.ended_at),
          label: formatDuration(minutes * 60),
        }
      : null,
    disconnected,
  };
}

module.exports = { takeStaffOffService, StaffServingError };
