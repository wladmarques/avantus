'use strict';

/**
 * Gera o pacote de deploy para a SquareCloud:
 *   npm run package
 * Resultado: ../vantus-atendimento-squarecloud.zip (fora do repositório).
 *
 * Exclui node_modules, .git, .github, tests, data, .env e arquivos SQLite.
 * O squarecloud.app fica na raiz do zip, como a SquareCloud exige.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const outFile = path.join(root, '..', 'vantus-atendimento-squarecloud.zip');
const exclude = new Set([
  'node_modules',
  '.git',
  '.github',
  'tests',
  'data',
  'coverage',
  'snapshots',
]);
const excludeFiles = [/^\.env$/, /\.sqlite(\.bak|\.tmp|-journal|-wal|-shm)?$/, /\.zip$/, /\.log$/];

function collect(dir, base = '') {
  const entries = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (exclude.has(entry.name)) continue;
    const rel = path.posix.join(base, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) entries.push(...collect(full, rel));
    else if (!excludeFiles.some((regex) => regex.test(entry.name))) entries.push(rel);
  }
  return entries;
}

function main() {
  const files = collect(root).sort();
  if (!files.includes('squarecloud.app') || !files.includes('index.js')) {
    console.error('✖ squarecloud.app ou index.js ausente.');
    process.exit(1);
  }

  fs.rmSync(outFile, { force: true });
  try {
    execFileSync('zip', ['-q', outFile, ...files], { cwd: root, stdio: 'inherit' });
  } catch (error) {
    console.error('✖ Não foi possível criar o zip. Instale o utilitário "zip" ou compacte manualmente.');
    process.exit(1);
  }

  const size = (fs.statSync(outFile).size / 1024).toFixed(0);
  console.log(`✔ Pacote criado: ${outFile}`);
  console.log(`  ${files.length} arquivos • ${size} KB`);
}

main();
