'use strict';

/** 对所有 js 文件做一次语法检查：node scripts/check-syntax.js */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', '.vscode']);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
}

walk(ROOT);

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    failed += 1;
    console.error(`✗ ${path.relative(ROOT, file)}`);
    console.error(res.stderr);
  } else {
    console.log(`✓ ${path.relative(ROOT, file)}`);
  }
}

if (failed) {
  console.error(`\n${failed} 个文件有语法错误`);
  process.exit(1);
}
console.log(`\n${files.length} 个文件全部通过`);
