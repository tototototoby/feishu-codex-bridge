// Source publication guard: reports locations, never the matching private value.
import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, extname } from 'node:path';
import { PROJECT_ROOT } from '../src/settings.mjs';

const directories = new Set(['src', 'scripts', 'examples', 'docs', 'licenses']);
const rootFiles = new Set(['package.json', 'package-lock.json', 'README.md', 'README.en.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'CONTRIBUTING.md', '.gitignore', '.gitattributes', 'release-files.json']);
const extensions = new Set(['.mjs', '.ps1', '.cmd', '.json', '.md', '.txt', '.patch']);
const rules = [
  ['hardcoded-user-profile', /[A-Z]:[\\/]+Users[\\/]+(?!<|YOUR_|example\b)[A-Za-z0-9_-]+[\\/]/i],
  ['live-feishu-identifier', /\b(?:cli|ou|oc|on)_[a-f0-9]{12,}\b/i],
  ['live-thread-identifier', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-credential', /\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{24,})\b/],
  ['openai-credential', /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/],
  ['literal-bearer', /Bearer\s+[A-Za-z0-9._-]{24,}/],
];
const denylistPath = process.env.FEISHU_CODEX_AUDIT_DENYLIST;
const denylist = denylistPath ? JSON.parse(await readFile(denylistPath, 'utf8')) : [];
if (!Array.isArray(denylist) || denylist.some(x => typeof x !== 'string' || !x)) throw new Error('Audit denylist must be an array of nonempty strings.');
const findings = [];
const entries = [];
let expected;
try {
  const manifest = JSON.parse(await readFile(join(PROJECT_ROOT, 'release-files.json'), 'utf8'));
  if (!Array.isArray(manifest.files) || manifest.files.some(x => typeof x !== 'string' || !x || x.startsWith('/') || x.includes('\\') || x.split('/').includes('..'))) throw new Error('Invalid file manifest.');
  expected = new Set(manifest.files);
  if (expected.size !== manifest.files.length || !expected.has('release-files.json')) throw new Error('Invalid file manifest.');
} catch { throw new Error('A valid explicit release-files.json manifest is required before publication.'); }
async function visit(path, top = false) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (top && ['.git', 'node_modules'].includes(entry.name)) continue;
    const child = join(path, entry.name);
    const rel = relative(PROJECT_ROOT, child).replaceAll('\\', '/');
    if ((await lstat(child)).isSymbolicLink()) { findings.push({ file: rel, rule: 'symlink' }); continue; }
    if (entry.isDirectory()) {
      if (top && !directories.has(entry.name)) { findings.push({ file: rel, rule: 'unexpected-directory' }); continue; }
      await visit(child);
      continue;
    }
    if (!expected.has(rel)) { findings.push({ file: rel, rule: 'not-in-exact-public-manifest' }); continue; }
    if (top ? !rootFiles.has(entry.name) : (!extensions.has(extname(entry.name)) && !/^(?:LICENSE|NOTICE)(?:\..*)?$/.test(entry.name))) {
      findings.push({ file: rel, rule: 'not-in-public-allowlist' }); continue;
    }
    if (/\.bak|\.log$|\.sqlite|\.db$|\.pid|outbox|receipt|(?:^|\/)cli-office\.mjs$|(?:^|\/)cli\.original\.mjs$/.test(rel)) {
      findings.push({ file: rel, rule: 'runtime-artifact' }); continue;
    }
    const bytes = await readFile(child);
    if (bytes.includes(0)) { findings.push({ file: rel, rule: 'binary-content' }); continue; }
    const text = bytes.toString('utf8');
    // Licenses legitimately contain author identifiers; scan owned source/examples
    // for deployment bindings, and all text files for credential-shaped strings.
    const scanRules = rel.startsWith('licenses/') ? rules.slice(3) : rules;
    for (const [rule, pattern] of scanRules) {
      const match = pattern.exec(text);
      if (match) findings.push({ file: rel, line: text.slice(0, match.index).split('\n').length, rule });
    }
    for (const privateValue of denylist) {
      const at = text.indexOf(privateValue);
      if (at >= 0) findings.push({ file: rel, line: text.slice(0, at).split('\n').length, rule: 'private-deployment-value' });
    }
    if (extname(rel) === '.json') {
      try { JSON.parse(text.replace(/^\uFEFF/, '')); } catch { findings.push({ file: rel, rule: 'invalid-json' }); }
    }
    entries.push({ path: rel, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}
await visit(PROJECT_ROOT, true);
for (const path of expected) {
  if (!entries.some(x => x.path === path)) findings.push({ file: path, rule: 'expected-public-file-missing' });
}
if (findings.length) {
  console.error(JSON.stringify({ ok: false, findings }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, files: entries.length, bytes: entries.reduce((sum, x) => sum + x.size, 0), boundary: 'Explicit source allowlist; runtime data excluded.', limitation: 'Pattern/source audit, not a complete security or functional test.', entries }, null, 2));
}
