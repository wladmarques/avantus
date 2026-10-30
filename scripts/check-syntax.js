'use strict';

/**
 * Checagem rápida: requer todos os arquivos JS do projeto para garantir que
 * não há erro de sintaxe nem import quebrado. Usado no CI e no `npm run lint`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const targets = ['index.js', 'scripts', 'src', 'tests'];
let checked = 0;
let failed = 0;

function walk(entry) {
  const full = path.join(root, entry);
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(full)) {
      if (child === 'node_modules' || child.startsWith('.')) continue;
      walk(path.join(entry, child));
    }
    return;
  }
  if (!full.endsWith('.js')) return;
  checked += 1;
  try {
    execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
  } catch (error) {
    failed += 1;
    console.error(`✖ ${entry}\n${error.stderr?.toString() ?? error.message}`);
  }
}

for (const target of targets) walk(target);

if (failed > 0) {
  console.error(`\n${failed} arquivo(s) com erro de sintaxe de ${checked}.`);
  process.exit(1);
}
console.log(`✔ ${checked} arquivos verificados sem erro de sintaxe.`);
