'use strict';

/**
 * Link de convite do bot (troca de aplicação no Developer Portal).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PERMISSIONS_BITFIELD,
  isValidClientId,
  inviteUrl,
  permissionNames,
} = require('../src/utils/invite');

const NEW_BOT = '1200967871480737912';

test('link de convite usa o Application ID, as permissões mínimas e os dois escopos', () => {
  const url = new URL(inviteUrl(NEW_BOT));
  assert.equal(url.origin + url.pathname, 'https://discord.com/api/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), NEW_BOT);
  assert.equal(url.searchParams.get('permissions'), '286346256');
  assert.equal(url.searchParams.get('scope'), 'bot applications.commands');
});

test('permissões são as que o bot realmente usa (e não Administrator)', () => {
  assert.equal(PERMISSIONS_BITFIELD.toString(), '286346256');
  const has = (bit) => (PERMISSIONS_BITFIELD & BigInt(bit)) === BigInt(bit);
  assert.ok(has(16), 'MANAGE_CHANNELS — /setup cria categoria e canais');
  assert.ok(has(268435456), 'MANAGE_ROLES — cargos do /setup');
  assert.ok(has(1024), 'VIEW_CHANNEL');
  assert.ok(has(2048), 'SEND_MESSAGES');
  assert.ok(has(16384), 'EMBED_LINKS');
  assert.ok(has(65536), 'READ_MESSAGE_HISTORY');
  assert.ok(has(1048576), 'CONNECT');
  assert.ok(has(16777216), 'MOVE_MEMBERS');
  assert.ok(!has(8), 'sem ADMINISTRATOR');
  assert.deepEqual(permissionNames(), [
    'manage channels',
    'view channel',
    'send messages',
    'embed links',
    'read message history',
    'connect',
    'move members',
    'manage roles',
  ]);
});

test('Application ID inválido é recusado', () => {
  assert.equal(isValidClientId(NEW_BOT), true);
  assert.equal(isValidClientId(' 1200967871480737912 '), true);
  assert.equal(isValidClientId('123'), false);
  assert.equal(isValidClientId('1200967871480737912abc'), false);
  assert.equal(isValidClientId(''), false);
  assert.equal(isValidClientId(null), false);
  assert.throws(() => inviteUrl('abc'), /CLIENT_ID inválido/);
});
