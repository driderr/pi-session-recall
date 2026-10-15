const fs = require('fs');
const path = require('path');
const os = require('os');

const d = path.join(os.homedir(), '.pi/agent/extensions/session-recall');
fs.mkdirSync(d, { recursive: true });

// Copy top-level source files
const files = ['index.ts', 'summarizer.ts', 'discoverer.ts', 'config.ts', 'embeddings.ts', 'rowstore.ts', 'logger.ts', 'types.ts', 'config.example.yaml'];
for (const f of files) {
  fs.copyFileSync(f, path.join(d, f));
}

// Copy vcc/ directory recursively
const vccSrc = path.join(__dirname, '..', 'vcc');
const vccDst = path.join(d, 'vcc');
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
copyDir(vccSrc, vccDst);

console.log('Synced to', d);
