'use strict';

/**
 * Garante que nenhum arquivo-fonte ficou de fora do Git (ex.: pasta que
 * colide com uma regra do .gitignore). Sem isso, o deploy de um clone do
 * repositório pode falhar com "Cannot find module".
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const skipDirs = new Set(['node_modules', '.git', 'data', 'coverage']);
const extensions = new Set(['.js', '.json', '.md', '.yml', '.app']);

function listFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, acc);
    else if (extensions.has(path.extname(entry.name))) acc.push(path.relative(root, full));
  }
  return acc;
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

let tracked;
try {
  git(['rev-parse', '--is-inside-work-tree']);
} catch {
  console.log('ℹ️  Sem repositório Git — verificação ignorada.');
  process.exit(0);
}

tracked = new Set(
  git(['ls-files']).split('\n').filter(Boolean),
);
const files = listFiles(root);
const missing = files.filter((file) => !tracked.has(file.replaceAll('\\', '/')));

if (missing.length > 0) {
  console.error('✖ Arquivos fora do controle de versão (copie e adicione ao Git):');
  for (const file of missing) console.error(`  - ${file}`);
  console.error('\nVerifique se alguma regra do .gitignore capturou o diretório sem querer:');
  console.error('  git check-ignore -v <arquivo>');
  process.exit(1);
}

console.log(`✔ ${files.length} arquivos-fonte versionados, nenhum fora do Git.`);
