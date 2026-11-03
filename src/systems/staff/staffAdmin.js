'use strict';

/**
 * Administração da equipe pelo painel web:
 * - bloquear/desbloquear o staff (impede entrar em serviço);
 * - remover o staff do quadro.
 *
 * As duas ações passam pelo fluxo de "tirar de serviço" (encerra a sessão do
 * banco de horas, desconecta do canal de trabalho e avisa o staff), mas nunca
 * atropelam um atendimento em andamento: nesse caso devolvem erro 409.
 */

const { COLORS, STAFF_STATUS } = require('../../config/theme');
const { AppError, ERRORS } = require('../../services/errors');
const { createLogger } = require('../../utils/logger');
const { takeStaffOffService, StaffServingError } = require('./offService');

const logger = createLogger('staff:admin');

/** Nome exibido (cadastro → Discord) para dar contexto à auditoria. */
async function displayName(services, guildId, userId) {
  try {
    const name = services.hourBank?.names?.(guildId)?.get(userId);
    if (name) return name;
  } catch {
    /* sem nome manual: segue para o Discord */
  }
  const member = await services.gateway.getMember(guildId, userId).catch(() => null);
  return member?.displayName ?? null;
}

/** O staff precisa existir no cadastro (status, nome ou escala). */
function requireKnown(services, guildId, userId) {
  const known =
    services.repositories.staff.getSync(guildId, userId) ||
    (services.hourBank?.listShifts?.(guildId, userId)?.length ?? 0) > 0 ||
    Boolean(services.hourBank?.names?.(guildId)?.has(userId));
  if (!known) {
    throw new AppError(ERRORS.STAFF_NAO_ENCONTRADO, 'Staff não encontrado na equipe.');
  }
}

async function notifyStaff(services, guildId, userId, content) {
  await services.gateway
    .sendDirectMessage(guildId, userId, { content })
    .catch(() => null);
}

/**
 * Bloqueia o staff: sai de serviço agora e não consegue voltar
 * (`/status disponível`, painel do Discord ou entrar no canal de atendimento).
 */
async function blockStaff({ services, guildId, userId, reason = null, source = 'painel web' }) {
  requireKnown(services, guildId, userId);

  if (services.staff.isBlocked(guildId, userId)) {
    return {
      ok: true,
      alreadyBlocked: true,
      blocked: services.staff.get(guildId, userId),
      endedSession: null,
    };
  }

  const name = await displayName(services, guildId, userId);

  // Encerra a sessão atual, desconecta do canal de trabalho e deixa indisponível.
  const off = await takeStaffOffService({
    services,
    guildId,
    userId,
    source,
    disconnectVoice: true,
    notify: false,
  });

  const blocked = await services.staff.setBlocked(guildId, userId, {
    blocked: true,
    by: source,
    reason,
  });

  await notifyStaff(
    services,
    guildId,
    userId,
    [
      '⛔ Seu acesso ao serviço na equipe **VANTUS** foi **bloqueado** pela administração.',
      reason ? `Motivo: **${reason}**` : null,
      'Você continua no servidor e na equipe, mas não pode ficar disponível até ser liberado.',
      'Fale com um administrador se precisar de mais informações.',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  await services.audit.log({
    guildId,
    type: 'STAFF_BLOCK',
    actorId: source,
    targetId: userId,
    message: [
      `⛔ O **${source}** bloqueou <@${userId}>${name ? ` (${name})` : ''} de entrar em serviço.`,
      reason ? `Motivo: **${reason}**` : null,
      off?.endedSession ? `Sessão encerrada: ${off.endedSession.label}.` : null,
      'Ele continua na equipe, mas não pode ficar disponível até ser desbloqueado.',
    ]
      .filter(Boolean)
      .join('\n'),
    color: COLORS.DANGER,
    metadata: { reason: reason ?? null },
  });

  await services.panels.refresh(guildId, { immediate: true }).catch(() => null);
  logger.info(`Staff ${userId} bloqueado (${source}).`);
  return { ok: true, blocked, endedSession: off?.endedSession ?? null };
}

/** Remove o bloqueio (o staff volta a poder ficar disponível). */
async function unblockStaff({ services, guildId, userId, source = 'painel web' }) {
  requireKnown(services, guildId, userId);
  if (!services.staff.isBlocked(guildId, userId)) {
    return {
      ok: true,
      alreadyUnblocked: true,
      blocked: services.staff.get(guildId, userId),
    };
  }

  const blocked = await services.staff.setBlocked(guildId, userId, { blocked: false });
  const name = await displayName(services, guildId, userId);

  await notifyStaff(
    services,
    guildId,
    userId,
    '✅ Sua liberação para entrar em serviço foi **restabelecida**.\n' +
      'Use `/status situacao:Disponível` (ou o painel da equipe) quando puder atender.',
  );

  await services.audit.log({
    guildId,
    type: 'STAFF_UNBLOCK',
    actorId: source,
    targetId: userId,
    message: `✅ O **${source}** liberou <@${userId}>${
      name ? ` (${name})` : ''
    } para voltar a entrar em serviço.`,
    color: COLORS.SUCCESS,
  });

  await services.panels.refresh(guildId, { immediate: true }).catch(() => null);
  logger.info(`Staff ${userId} desbloqueado (${source}).`);
  return { ok: true, blocked };
}

/**
 * Remove o staff da equipe.
 *
 * Apaga o cadastro (status, nome e escala). O histórico de sessões e de
 * atendimentos é preservado — os relatórios do período continuam corretos.
 */
async function removeStaff({ services, guildId, userId, source = 'painel web' }) {
  requireKnown(services, guildId, userId);

  const serving = services.repositories.attendance.findServingByStaffSync(guildId, userId);
  if (serving) throw new StaffServingError(serving);

  const name = await displayName(services, guildId, userId);
  const staff = services.staff.get(guildId, userId);

  // Encerra a sessão aberta e desconecta dos canais de trabalho.
  const off = await takeStaffOffService({
    services,
    guildId,
    userId,
    source,
    disconnectVoice: true,
    notify: false,
  }).catch((error) => {
    logger.warn(`Falha ao tirar ${userId} de serviço antes de remover: ${error.message}`);
    return { endedSession: null };
  });

  await services.db.transaction(async () => {
    services.repositories.staff.deleteSync(guildId, userId);
    services.db.run('DELETE FROM staff_names WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    services.db.run('DELETE FROM staff_shifts WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    services.db.run('DELETE FROM staff_shift_reminders WHERE guild_id = ? AND user_id = ?', [
      guildId,
      userId,
    ]);
  });

  await notifyStaff(
    services,
    guildId,
    userId,
    '🗑️ Você foi **removido da equipe** de atendimento da **VANTUS** pelo painel administrativo.\n' +
      'Seu histórico de horas continua registrado. Fale com um administrador se tiver dúvidas.',
  );

  await services.audit.log({
    guildId,
    type: 'STAFF_REMOVE',
    actorId: source,
    targetId: userId,
    message: [
      `🗑️ O **${source}** removeu <@${userId}>${name ? ` (${name})` : ''} da equipe.`,
      `Status anterior: **${staff.meta?.label ?? staff.status}**${staff.blocked ? ' • bloqueado' : ''}.`,
      off?.endedSession ? `Sessão encerrada: ${off.endedSession.label}.` : null,
      'O histórico de horas e atendimentos foi mantido nos relatórios.',
    ]
      .filter(Boolean)
      .join('\n'),
    color: COLORS.DANGER,
  });

  await services.panels.refresh(guildId, { immediate: true }).catch(() => null);
  logger.info(`Staff ${userId} removido da equipe (${source}).`);
  return {
    ok: true,
    staffName: name,
    endedSession: off?.endedSession ?? null,
    status: staff.status,
    blocked: staff.blocked,
    statusLabel: staff.meta?.label ?? STAFF_STATUS.INDISPONIVEL,
  };
}

module.exports = {
  blockStaff,
  unblockStaff,
  removeStaff,
  displayName,
  StaffServingError,
};
