// ensureEmbedServer lifecycle (rowstore-embeddings design §8.2) — the eight pinned scenarios.
// NO fs/os mocks: exe/model existence is exercised against real temp files (mkdtempSync).
// HTTP side = real localhost: in-process node:http on an ephemeral port — raw fetch is not
// aliased anywhere in this repo. Spawn side = mocked via EmbedServerIo.spawn (records argv).
// The extension never kills: every scenario asserts the fake child's kill was never called.
// P2 pin: the LTROW-SRV lines below are byte-asserted against the single emitter (embeddings.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { EventEmitter } from "node:events";
import { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as logger from "../logger.js";
import { DEFAULT_CONFIG } from "../config.js";
import { ensureEmbedServer, EMBED_MODEL_ID, type EmbedServerIo } from "../embeddings.js";

let server: http.Server | null = null;
let loadTimer: NodeJS.Timeout | null = null;
let tmpDir: string;
let messages: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

interface FakeChild extends EventEmitter {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
}

let children: FakeChild[] = [];
let pidCounter = 0;

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = 10000 + ++pidCounter;
  ee.kill = vi.fn(() => true);
  ee.unref = vi.fn();
  children.push(ee);
  return ee;
}

async function getFreePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** Fake /v1/models endpoint: `body` is the response text (readiness = model-id containment). */
function startFakeModelsServer(port: number, body: string, status = 200): Promise<void> {
  const srv = http.createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  return new Promise<void>((resolve) => {
    srv.listen(port, "127.0.0.1", () => {
      server = srv;
      resolve();
    });
  });
}

function readyModelsBody(): string {
  return JSON.stringify({ data: [{ id: EMBED_MODEL_ID }] });
}

describe("ensureEmbedServer (rowstore-embeddings design §8.2 — eight pinned scenarios)", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sr-embed-server-"));
    writeFileSync(join(tmpDir, "llama-server.exe"), "dummy exe");
    writeFileSync(join(tmpDir, "nomic.gguf"), "dummy model");
    children = [];
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation((m: string) => { messages.push(m); });
  });

  afterEach(async () => {
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = null;
    if (server) {
      const s = server;
      server = null;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    logSpy.mockRestore();
  });

  function makeConfig(overrides: Partial<typeof DEFAULT_CONFIG> = {}): typeof DEFAULT_CONFIG {
    return {
      ...DEFAULT_CONFIG,
      embedServerExePath: join(tmpDir, "llama-server.exe"),
      embedServerModelPath: join(tmpDir, "nomic.gguf"),
      embedServerReadyTimeoutMs: 5000, // keep the worst case (timeout scenario) short
      ...overrides,
    };
  }

  it("(1) probe-ready → source=probe, zero spawn attempts, READY source=probe line", async () => {
    const port = await getFreePort();
    await startFakeModelsServer(port, readyModelsBody());
    const spawnStub = vi.fn(() => { throw new Error("spawn must not be attempted"); });

    const status = await ensureEmbedServer(makeConfig({ embedServerPort: port }), { spawn: spawnStub });

    expect(status).toEqual({ status: "ready", source: "probe", port });
    expect(spawnStub).not.toHaveBeenCalled();
    expect(messages).toContain(`LTROW-SRV READY port=${port} source=probe`);
    expect(messages.some((m) => m.includes("LTROW-SRV SPAWNED"))).toBe(false);
  });

  it("(2) refused → spawn (P4 argv byte-exact) → 1s poll → source=spawn + pid + SPAWNED/READY lines", async () => {
    const port = await getFreePort(); // released — the probe gets ECONNREFUSED
    let recordedExe = "";
    let recordedArgs: string[] = [];
    let spawnedChild: FakeChild | null = null;
    const spawnStub = vi.fn((exe: string, args: string[]) => {
      recordedExe = exe;
      recordedArgs = args;
      const child = makeFakeChild();
      spawnedChild = child;
      // Fake server starts ~1.5s after "spawn" (simulating the 146MB model load).
      loadTimer = setTimeout(() => { void startFakeModelsServer(port, readyModelsBody()); }, 1500);
      return child;
    });
    const config = makeConfig({ embedServerPort: port, embedServerReadyTimeoutMs: 30000 });

    const status = await ensureEmbedServer(config, { spawn: spawnStub });

    expect(spawnStub).toHaveBeenCalledTimes(1);
    expect(status).toEqual({ status: "ready", source: "spawn", port, pid: spawnedChild!.pid });
    // P4 — argv byte-identical to the validated command: exe, then -m <modelPath> FIRST,
    // --port <port> config-driven, --log-timestamps --log-prefix at the tail.
    expect([recordedExe, ...recordedArgs]).toEqual([
      config.embedServerExePath,
      "-m", config.embedServerModelPath,
      "--embedding", "--pooling", "mean", "-ngl", "99", "-c", "2048",
      "-b", "4096", "-ub", "4096", "-np", "1", "--load-mode", "mlock",
      "--host", "127.0.0.1",
      "--port", String(port),
      "--alias", EMBED_MODEL_ID,
      "--log-timestamps", "--log-prefix",
    ]);
    const spawnedLine = `LTROW-SRV SPAWNED port=${port} pid=${status.pid}`;
    const readyLine = `LTROW-SRV READY port=${port} source=spawn`;
    const spawnedIdx = messages.indexOf(spawnedLine);
    const readyIdx = messages.indexOf(readyLine);
    expect(spawnedIdx, "SPAWNED line").toBeGreaterThanOrEqual(0);
    expect(readyIdx, "READY source=spawn line").toBeGreaterThan(spawnedIdx);
    for (const c of children) expect(c.kill).not.toHaveBeenCalled();
  });

  it("(3) refused + missing exe → UNAVAILABLE reason=exe-missing, no spawn", async () => {
    const port = await getFreePort();
    const spawnStub = vi.fn(() => { throw new Error("spawn must not be attempted"); });

    const status = await ensureEmbedServer(
      makeConfig({ embedServerPort: port, embedServerExePath: join(tmpDir, "does-not-exist.exe") }),
      { spawn: spawnStub },
    );

    expect(status).toEqual({ status: "unavailable", reason: "exe-missing", port });
    expect(spawnStub).not.toHaveBeenCalled();
    expect(messages).toContain(`LTROW-SRV UNAVAILABLE port=${port} reason=exe-missing`);
  });

  it("(4) refused + missing model → UNAVAILABLE reason=model-missing, no spawn", async () => {
    const port = await getFreePort();
    const spawnStub = vi.fn(() => { throw new Error("spawn must not be attempted"); });

    const status = await ensureEmbedServer(
      makeConfig({ embedServerPort: port, embedServerModelPath: join(tmpDir, "missing.gguf") }),
      { spawn: spawnStub },
    );

    expect(status).toEqual({ status: "unavailable", reason: "model-missing", port });
    expect(spawnStub).not.toHaveBeenCalled();
    expect(messages).toContain(`LTROW-SRV UNAVAILABLE port=${port} reason=model-missing`);
  });

  it("(5) port occupied by a non-embed process → UNAVAILABLE reason=wrong-model, no spawn, no kill (model-id check gates readiness)", async () => {
    const port = await getFreePort();
    await startFakeModelsServer(port, JSON.stringify({ data: [{ id: "some-chat-model" }] })); // 200, wrong model list
    const spawnStub = vi.fn(() => { throw new Error("spawn must not be attempted"); });

    const status = await ensureEmbedServer(makeConfig({ embedServerPort: port }), { spawn: spawnStub });

    expect(status).toEqual({ status: "unavailable", reason: "wrong-model", port });
    expect(spawnStub).not.toHaveBeenCalled();
    expect(messages).toContain(`LTROW-SRV UNAVAILABLE port=${port} reason=wrong-model`);
    for (const c of children) expect(c.kill).not.toHaveBeenCalled();
  });

  it("(6) child `error` event → UNAVAILABLE reason=spawn-failed, no kill", async () => {
    const port = await getFreePort();
    let spawnedChild: FakeChild | null = null;
    const spawnStub = vi.fn(() => {
      const child = makeFakeChild();
      spawnedChild = child;
      setTimeout(() => child.emit("error", new Error("spawn ENOENT")), 0);
      return child;
    });
    const io: EmbedServerIo = { spawn: spawnStub, sleep: async () => {} }; // fast poll — the error event wins

    const status = await ensureEmbedServer(makeConfig({ embedServerPort: port }), io);

    expect(status).toEqual({ status: "unavailable", reason: "spawn-failed", port });
    expect(spawnedChild).not.toBeNull();
    expect(spawnedChild!.kill).not.toHaveBeenCalled();
    expect(messages).toContain(`LTROW-SRV UNAVAILABLE port=${port} reason=spawn-failed`);
  });

  it("(7) never-ready server + short timeout (fake clock) → UNAVAILABLE reason=timeout, no kill", async () => {
    const port = await getFreePort(); // stays refused — the "server" never becomes ready
    let fakeNow = 0;
    const spawnStub = vi.fn(() => makeFakeChild());
    const io: EmbedServerIo = {
      spawn: spawnStub,
      sleep: async () => {}, // no real waiting
      now: () => (fakeNow += 1000), // advances 1000ms per call
    };

    const status = await ensureEmbedServer(
      makeConfig({ embedServerPort: port, embedServerReadyTimeoutMs: 5000 }),
      io,
    );

    expect(status).toEqual({ status: "unavailable", reason: "timeout", port });
    expect(spawnStub).toHaveBeenCalledTimes(1);
    expect(messages).toContain(`LTROW-SRV UNAVAILABLE port=${port} reason=timeout`);
    for (const c of children) expect(c.kill).not.toHaveBeenCalled();
  });

  it("(8) port always comes from config — this fixture file references no chat-instance port", async () => {
    // Self-source check: no fixture in this file may hardcode the main chat instance's port
    // (chat-instance-port independence — the port always comes from config; the model-id
    // check, not the port, prevents instance conflation). The banned port is assembled at
    // runtime so this file itself stays free of the literal (a literal regex would match
    // its own source).
    const self = readFileSync(fileURLToPath(new URL("./ensure-embed-server.test.ts", import.meta.url)), "utf-8");
    expect(self).not.toMatch(new RegExp("500" + "1"));

    const port = await getFreePort();
    await startFakeModelsServer(port, readyModelsBody());
    const status = await ensureEmbedServer(makeConfig({ embedServerPort: port }), { spawn: vi.fn() });
    expect(status.port).toBe(port); // the returned status echoes the configured port
  });
});
