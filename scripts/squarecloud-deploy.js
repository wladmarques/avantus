'use strict';

/**
 * Deploy na SquareCloud pela API oficial.
 *
 *   SQUARECLOUD_TOKEN=... SQUARECLOUD_APP_ID=... npm run deploy:squarecloud
 *
 * Opções:
 *   --reset-data     apaga data/vantus.sqlite (e backups) na aplicação antes do envio
 *   --no-restart     envia os arquivos mas não reinicia (aplicado no próximo start)
 *   --dry-run        monta o pacote e mostra o que faria, sem tocar na API
 *   --keep-package   usa o zip já existente em entrega/ em vez de regerar
 *
 * O token precisa dos escopos `apps:deploy`, `apps:control` e, se usar
 * --reset-data, `files:write`. Ele nunca é impresso no log.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SquareCloudClient, SquareCloudError } = require('../src/services/squarecloudClient');

const ROOT = path.resolve(__dirname, '..');
const ZIP = path.join(ROOT, 'entrega', 'vantus-atendimento-squarecloud.zip');
const RESET_FILES = ['data/vantus.sqlite', 'data/vantus.sqlite.bak'];

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const resetData = args.has('--reset-data');
const restart = !args.has('--no-restart');
const keepPackage = args.has('--keep-package');

const log = (message) => console.log(`[deploy] ${message}`);
const fail = (message) => {
  console.error(`[deploy] ERRO: ${message}`);
  process.exit(1);
};

function env(name) {
  const value = (process.env[name] || '').trim();
  return value || null;
}

function buildPackage() {
  if (keepPackage && fs.existsSync(ZIP)) {
    log('usando o pacote existente (--keep-package)');
    return;
  }
  log('gerando o pacote…');
  execFileSync(process.execPath, [path.join(__dirname, 'package.js')], { cwd: ROOT, stdio: 'inherit' });
}

async function main() {
  const token = env('SQUARECLOUD_TOKEN');
  const appId = env('SQUARECLOUD_APP_ID');

  if (!appId) {
    fail('SQUARECLOUD_APP_ID não configurado (ID que aparece na URL do painel da aplicação).');
  }
  if (!token && !dryRun) {
    fail(
      'SQUARECLOUD_TOKEN não configurado. Gere em squarecloud.app → Conta → Segurança ' +
        '(escopos apps:deploy, apps:control e files:write).',
    );
  }

  buildPackage();

  if (!fs.existsSync(ZIP)) fail(`pacote não encontrado em ${ZIP}`);
  const buffer = fs.readFileSync(ZIP);
  if (buffer.length > 100 * 1024 * 1024) fail('pacote maior que 100 MB (limite da API).');
  log(`pacote: ${(buffer.length / 1024).toFixed(0)} KB`);

  if (dryRun) {
    log(`[dry-run] commit do zip na aplicação ${appId}`);
    if (resetData) log('[dry-run] antes do envio: apagar data/vantus.sqlite');
    if (restart) log('[dry-run] depois do envio: reiniciar a aplicação');
    log('[dry-run] nada foi enviado.');
    return;
  }

  const client = new SquareCloudClient({ token });

  if (resetData) {
    log('limpando o banco antigo…');
    for (const file of RESET_FILES) {
      try {
        await client.deleteFile(appId, file);
        log(`  removido: ${file}`);
      } catch (error) {
        // 404/arquivo inexistente não é problema: o objetivo é não haver banco antigo.
        if (error instanceof SquareCloudError && error.status === 404) {
          log(`  já não existia: ${file}`);
        } else if (error instanceof SquareCloudError && (error.code === 'INVALID_PATH' || error.status === 400)) {
          log(`  ignorado: ${file}`);
        } else {
          throw error;
        }
      }
    }
  }

  log(`enviando arquivos para a aplicação ${appId}…`);
  await client.commit(appId, buffer, { fileName: 'vantus-atendimento-squarecloud.zip' });
  log('  commit aceito');

  if (restart) {
    log('reiniciando a aplicação…');
    await client.restart(appId);
    log('  reinício solicitado');
  } else {
    log('reinício ignorado (--no-restart)');
  }

  log('deploy concluído. Acompanhe o log no painel da SquareCloud.');
}

main().catch((error) => {
  if (error instanceof SquareCloudError) fail(error.message);
  fail(error?.stack ?? String(error));
});
