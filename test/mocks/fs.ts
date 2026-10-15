/**
 * Shared memfs mock for node:fs and fs imports.
 *
 * Usage in a test file:
 *   vi.doMock("node:fs", async () => createFsMock());
 *   vi.doMock("fs", async () => createFsMock());
 *
 * Then use `import { vol } from "memfs"` to set up files.
 */
import { fs as memfsFs, vol } from "memfs";
import type { FSWatcher, Stats } from "node:fs";

export { vol };

/** Returns a memfs-based replacement for node:fs / fs. */
export function createFsMock() {
  return {
    default: memfsFs,
    ...memfsFs,
    // memfs doesn't implement every watcher — provide no-ops so imports don't crash
    watch: (() => ({ close: () => {}, closeSync: () => {} }) as unknown as FSWatcher),
    unwatchFile: () => {},
    createReadStream: memfsFs.createReadStream,
    createWriteStream: memfsFs.createWriteStream,
    // Re-export constants the production code may pull
    constants: memfsFs.constants,
  };
}

/** Reset the in-memory volume between tests. */
export function resetFs() {
  vol.reset();
}
