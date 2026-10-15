import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    deps: {
      // memfs is CJS — force ESM interop so vi.doMock works cleanly
      interopDefault: true,
    },
  },
  resolve: {
    alias: {
      "@earendil-works/pi-ai": resolve(__dirname, "test/mocks/pi-ai.ts"),
    },
  },
});
