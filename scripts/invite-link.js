'use strict';

/**
 * Mostra o link para convidar o bot no servidor.
 *   npm run invite
 *   npm run invite -- 1200967871480737912
 *
 * Usa o CLIENT_ID do .env quando nenhum ID é informado na linha de comando.
 */
const { env } = require('../src/config/env');
const { inviteUrl, permissionNames, PERMISSIONS_BITFIELD, isValidClientId } = require('../src/utils/invite');

const arg = process.argv[2];
const clientId = (arg || env.clientId || '').trim();

if (!isValidClientId(clientId)) {
  console.error('Informe o Application ID do bot (17 a 20 dígitos):');
  console.error('  npm run invite -- 1200967871480737912');
  console.error('  ou defina CLIENT_ID no .env');
  process.exit(1);
}

console.log('');
console.log('  Convite do bot');
console.log('  ─────────────────────────────────────────────');
console.log(`  Application ID: ${clientId}`);
console.log(`  Permissões:     ${PERMISSIONS_BITFIELD} (${permissionNames().join(', ')})`);
console.log('');
console.log(`  ${inviteUrl(clientId)}`);
console.log('');
console.log('  Abra o link, escolha o servidor e autorize. Em seguida,');
console.log('  rode /setup no servidor para criar canais e cargos.');
console.log('');
