// Deploy the extension to ~/.pi/agent/extensions/session-recall/
//
// Two jobs:
//   1. Copy the source files (top-level .ts, vcc/, config.example.yaml).
//   2. Make sure the extension's runtime npm dependencies can be resolved
//      FROM THE DEPLOY DIR. Pi loads the extension from that folder (not from
//      this repo), and Node resolves `import "better-sqlite3"` by looking in
//      <deploy dir>/node_modules (or a parent directory). A fresh machine has
//      nothing there, and pi hangs at startup while the extension fails to
//      load. This script installs the deps into the deploy dir on first run.
//
// Idempotent: re-run it any time (e.g. after `git pull`), then restart pi.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const d = path.join(os.homedir(), '.pi/agent/extensions/session-recall');
fs.mkdirSync(d, { recursive: true });

// --------------------------------------------------------------- copy ---

// Copy top-level source files
const files = ['index.ts', 'summarizer.ts', 'discoverer.ts', 'config.ts', 'embeddings.ts', 'rowstore.ts', 'logger.ts', 'types.ts', 'config.example.yaml'];
for (const f of files) {
  fs.copyFileSync(path.join(REPO, f), path.join(d, f));
}

// Copy vcc/ directory recursively
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}
copyDir(path.join(REPO, 'vcc'), path.join(d, 'vcc'));
console.log(`Copied ${files.length} source files + vcc/ -> ${d}`);

// --------------------------------------------------------------- deps ---

// Value imports the extension makes at runtime. (@earendil-works/pi-coding-agent
// is type-only here and is provided by pi's own loader; no install needed.)
const RUNTIME_DEPS = ['@earendil-works/pi-ai', 'better-sqlite3', 'typebox', 'yaml'];

const depExists = (name) =>
  fs.existsSync(path.join(d, 'node_modules', ...(name.startsWith('@') ? name.split('/') : [name])));

const missing = RUNTIME_DEPS.filter((n) => !depExists(n));

if (missing.length === 0) {
  console.log('Runtime dependencies: already present');
} else {
  console.log(`Runtime dependencies: installing ${missing.join(', ')}`);

  const pkgPath = path.join(d, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    // Minimal manifest so `npm install` is deterministic. A package.json that
    // already exists (e.g. from a manual install) is left untouched.
    const repoDeps = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).dependencies || {};
    const manifest = {
      name: 'pi-session-recall-deploy',
      private: true,
      description: 'Runtime dependencies for the session-recall extension (created by scripts/sync.cjs)',
      dependencies: Object.fromEntries(RUNTIME_DEPS.map((n) => [n, repoDeps[n] || '*'])),
    };
    fs.writeFileSync(pkgPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Wrote ${pkgPath}`);
  }

  // Run npm's JS entry directly with the same node that runs this script
  // (npm ships inside the node installation) — no shell involved.
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const r = spawnSync(process.execPath, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: d,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(
      `\nDependency install FAILED. The extension will not load until the runtime\n` +
      `dependencies are present in ${path.join(d, 'node_modules')}.\n` +
      `Manual fix: cd "${d}" && npm install --omit=dev ${RUNTIME_DEPS.join(' ')}`,
    );
    process.exit(1);
  }
  console.log('Runtime dependencies: installed');
}

console.log('Synced to', d);
