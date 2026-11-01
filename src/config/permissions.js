'use strict';

const { AppError, ERRORS } = require('../services/errors');

/** IDs de cargos de um GuildMember (Collection, array ou mock). */
function roleIdsOf(member) {
  if (!member) return [];
  const cache = member.roles?.cache;
  if (cache?.keys) return [...cache.keys()];
  if (Array.isArray(member.roles)) return member.roles;
  if (Array.isArray(member._roles)) return member._roles;
  return [];
}

function intersects(a, b) {
  if (!a?.length || !b?.length) return false;
  const set = new Set(a);
  return b.some((id) => set.has(id));
}

function hasAdministrator(member) {
  return Boolean(member?.permissions?.has?.('Administrator')) || Boolean(member?.permissions?.has?.('ManageGuild'));
}

function isGuildOwner(member) {
  return Boolean(member?.guild?.ownerId && member.guild.ownerId === member.id);
}

function isAdmin(member, settings) {
  if (!member) return false;
  if (isGuildOwner(member) || hasAdministrator(member)) return true;
  return intersects(roleIdsOf(member), settings.get('admin_role_ids') || []);
}

function isStaff(member, settings) {
  if (isAdmin(member, settings)) return true;
  return intersects(roleIdsOf(member), settings.get('staff_role_ids') || []);
}

function assertStaff(member, settings) {
  if (!isStaff(member, settings)) {
    throw new AppError(
      ERRORS.STAFF_SEM_PERMISSAO,
      'Você não faz parte da equipe de atendimento da VANTUS.',
    );
  }
  return true;
}

function assertAdmin(member, settings) {
  if (!isAdmin(member, settings)) {
    throw new AppError(
      ERRORS.STAFF_SEM_PERMISSAO,
      'Apenas administradores podem executar esta ação.',
    );
  }
  return true;
}

module.exports = {
  roleIdsOf,
  isAdmin,
  isStaff,
  assertAdmin,
  assertStaff,
  intersects,
};
