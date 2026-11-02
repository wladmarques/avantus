'use strict';

/**
 * Link de convite do bot com as permissões que o VANTUS realmente usa.
 *
 * Usado pelo `npm run invite` e mostrado no boot quando o `CLIENT_ID` está
 * configurado — trocar de bot no Developer Portal exige reconvidar a aplicação
 * nova com este link.
 */

/** Permissões mínimas (bitfield) — nada de Administrator. */
const PERMISSIONS = {
  MANAGE_CHANNELS: 16n,
  VIEW_CHANNEL: 1024n,
  SEND_MESSAGES: 2048n,
  EMBED_LINKS: 16384n,
  READ_MESSAGE_HISTORY: 65536n,
  CONNECT: 1048576n,
  MOVE_MEMBERS: 16777216n,
  MANAGE_ROLES: 268435456n,
};

/**
 * Soma das permissões: 286346256.
 * - gerenciar canais/cargos: `/setup` cria categorias, canais e cargos;
 * - ver/enviar/embeds/histórico: painéis e mensagens;
 * - conectar/mover membros: fila por canal de voz.
 */
const PERMISSIONS_BITFIELD = Object.values(PERMISSIONS).reduce((total, bit) => total + bit, 0n);

const SCOPES = ['bot', 'applications.commands'];

/** Um ID de aplicação do Discord (snowflake) é válido? */
function isValidClientId(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value.trim());
}

/**
 * Monta o link de convite.
 * @param {string} clientId Application ID (Developer Portal → General Information)
 * @returns {string}
 */
function inviteUrl(clientId) {
  const id = String(clientId ?? '').trim();
  if (!isValidClientId(id)) {
    throw new Error('CLIENT_ID inválido: use o Application ID (17 a 20 dígitos).');
  }
  const permissions = String(PERMISSIONS_BITFIELD);
  return `https://discord.com/api/oauth2/authorize?client_id=${id}&permissions=${permissions}&scope=${SCOPES.map(
    (scope) => encodeURIComponent(scope),
  ).join('%20')}`;
}

/** Lista legível das permissões pedidas (para conferência no Portal). */
function permissionNames() {
  return Object.keys(PERMISSIONS).map((name) => name.toLowerCase().replace(/_/g, ' '));
}

module.exports = { PERMISSIONS, PERMISSIONS_BITFIELD, SCOPES, isValidClientId, inviteUrl, permissionNames };
