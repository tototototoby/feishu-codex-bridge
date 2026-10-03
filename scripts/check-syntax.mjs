import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../src/settings.mjs';

async function collect(path) {
  const files = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error('Source symlinks are not accepted by the syntax checker.');
    const child = join(path, item.name);
    if (item.isDirectory()) files.push(...await collect(child));
    else if (item.name.endsWith('.mjs')) files.push(child);
  }
  return files;
}
const files = [...await collect(join(PROJECT_ROOT, 'src')), ...await collect(join(PROJECT_ROOT, 'scripts'))];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    console.error(result.stderr || `Syntax inspection failed for ${file}`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(`JavaScript syntax inspection passed for ${files.length} source files. No software tests or live services were run.`);
