# pi-session-recall

A [pi](https://github.com/earendil-works/pi) extension that recovers lessons
from your past pi sessions and injects them into new ones. Everything runs on
your own machine: no telemetry, no external services, and the only LLM
involved is the one pi itself is configured with.

## What you get

- **Session-start context injection** — every new pi session begins with a
  compact brief of the lessons you have accumulated across past sessions:
  the most-used lessons first, plus a **RECENT CORRECTIONS** block carrying
  the things you recently corrected.
- **`/recall`** — search your recent session summaries for a topic and get
  matching excerpts with session metadata.
- **`/recall-health`** — a one-call diagnostic: config, database, model
  resolution, and recent merge activity.
- **`/recall-flush`** — fold the current session's fresh content into the
  long-term store now, instead of waiting for the next session start.
- **Agent tools** (`recall`, `recall_sessions`, `recall-health`) — the same
  queries available from inside a session's toolset, so the agent can look
  up lost context itself.

At session start the agent sees something shaped like this (illustrative):

```
LONG TERM (most-used first):
| Item | Score | Last-Seen |
| Prefer the repo's own git remote over re-cloning | 9 | 2026-10-12 |
| ... | ... | ... |

RECENT CORRECTIONS (last 7d):
(not new user input — corrections you made, folded in by the engine)
- Use `git -C <path>` instead of cd-ing into the repo
```

## Prerequisites

- A working **pi** install — this is a pi extension, not a standalone app.
  The extension reads pi's session directory and pi's own model config.
- **Node 20+** and npm.
- For the LLM stage (long-term consolidation): pi must have at least one
  provider/model configured in `~/.pi/agent/models.json`. The extension uses
  the first entry it finds and ships no model of its own. If none is
  configured, the LLM stages degrade gracefully — the algorithmic summaries
  and injection from already-stored data still work.

## Install

```sh
git clone https://github.com/driderr/pi-session-recall
cd pi-session-recall
npm install
npm run sync     # copies the .ts sources to ~/.pi/agent/extensions/session-recall/
```

Then run `/reload` in pi and check with `/recall-health`. The config file
auto-seeds to `~/.pi/agent/session-recall.yaml` on first run;
[`config.example.yaml`](config.example.yaml) documents every key.

**No build step, no database install.** pi loads the TypeScript sources
directly, and the extension reuses *pi's own* session-index SQLite file,
self-creating its tables on first run.

## How it works

```
pi session JSONL files (~/.pi/agent/sessions/**)
  → discovery: finds sessions via pi's own SQLite index + filesystem
  → per-session summaries: pure-code extraction — goals, files, decisions,
    signals, and preferences are pulled from each transcript (no LLM)
  → long-term consolidation: the LLM (your pi model) distills new session
    summaries into the persistent lesson store — one call per chunk of
    ~24K characters of new summaries, capped per run
  → session start: the store is injected into the new session's context

Optional Tier 2 (row store, useRowStore: true):
  → each lesson is a row carrying a 768-dim embedding from a local
    llama-server + nomic-embed-text-v1.5 model (auto-spawned on port 5002)
  → similar lessons are deduped/consolidated by cosine similarity instead of
    LLM judgment
```

The properties that matter:

- **The LLM is cheap and bounded.** It only does the long-term consolidation
  (batched, capped calls at session start). Per-session summaries are pure
  code, and injection is a SQL read.
- **Everything is local.** The only network traffic is to your own LLM
  endpoint (whatever pi is configured with). No telemetry, no external
  services, nothing phoned home.
- **The "database" is pi's own index file.** The extension adds three tables
  to `~/.pi/agent/sessions/session-index.sqlite` (created automatically on
  first run): `session_summaries`, `long_term`, `long_term_rows`. Nothing to
  install, no migrations to manage, no per-user DB file to ship.
- **Fail-safe degradation.** If the LLM is unavailable, already-stored data
  still injects. If the Tier 2 embedding server is missing, the probe fails
  closed and Tier 2 simply stays off — nothing crashes.

### Corrections

Corrections you make to the agent ("no, use X", "that's wrong") are captured
at turn end by a pattern detector — no LLM, no network — and surfaced as the
**RECENT CORRECTIONS** block in the next session's injection. The freshest
things you have fixed get priority over the general lesson table.

### Two operating tiers

| | Tier 1 (default) | Tier 2 (row store, opt-in) |
|---|---|---|
| Extra binaries | none | local `llama-server` (llama.cpp) + nomic-embed-text-v1.5 GGUF |
| Long-term store | one merged prose brief | per-lesson rows with embeddings |
| Deduplication | LLM judgment at merge time | cosine similarity (LLM-free) |
| Enable | works out of the box | `useRowStore: true` in config |

## Tier 2 setup (optional)

1. Get a `llama-server` build from [llama.cpp](https://github.com/ggml-org/llama.cpp)
   (any OS).
2. Download the embedding model:
   [nomic-ai/nomic-embed-text-v1.5-GGUF](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF)
   (768-dim; `Q8_0` is the usual pick).
3. In `~/.pi/agent/session-recall.yaml`:
   ```yaml
   useRowStore: true
   embedServerExePath: 'C:\tools\llama-server.exe'   # your llama.cpp build
   embedServerModelPath: 'C:\models\nomic-embed-text-v1.5.Q8_0.gguf'
   ```
4. Restart pi. At the first consolidation the extension auto-spawns the
   embedding server on `127.0.0.1:5002`. Note the spawn discipline: the
   server is detached, so it outlives pi; the extension never kills any
   process, so an orphan is a manual kill — the pid is recorded in the
   `LTROW-SRV SPAWNED` log line. If the exe or model path is wrong, the
   probe fails closed with a log line naming the config key, and Tier 2
   stays off while Tier 1 keeps working.

## What it touches on disk

- `~/.pi/agent/sessions/session-index.sqlite` — pi's own session index;
  the extension adds its three tables here.
- `~/.pi/agent/extensions/session-recall/` — the deployed sources (from
  `npm run sync`) plus daily logs (`log-YYYY-MM-DD.txt`, UTC timestamps).
- `~/.pi/agent/session-recall.yaml` — config (auto-seeded on first run).
- `127.0.0.1:5002` — the spawned embedding server (Tier 2 only, localhost
  only).

Nothing else.

## Configuration

See [`config.example.yaml`](config.example.yaml) — every key, with defaults
and clamp ranges. Highlights: `maxSessions` and `maxTokens` (injection
budget), `useRowStore` (the Tier 2 switch), `embedServerExePath` /
`embedServerModelPath` (Tier 2 paths), `correctionDetectionEnabled`
(kill-switch for correction capture).

## Testing

`npm test` runs the full hermetic unit suite (55 files, ~840 tests) — the
LLM is mocked and there is no network, so it runs green on any machine.
This is exactly what CI runs.

`test/` also contains **operator live-gate vehicles** (`rowstore-live`,
`rowstore-merge-live`, `rowstore-consolidate-live`, `rowstore-migrate-live`,
`embeddings-live`, `lt-conversion-live`):
environment-gated tests that run the real engine against *your* production
store through read-only `VACUUM INTO` snapshots, so they cannot corrupt
live data. They are **operator-only and never run in CI** — they self-skip
unless you set their opt-in env vars (each file's header lists its own).

## Credits

The algorithmic summarization pipeline in [`vcc/`](vcc/) is ported from
[pi-vcc](https://github.com/buihongduc132/pi-vcc) v0.4.x
([buihongduc132](https://github.com/buihongduc132), MIT) — a fork of
[sting8k/pi-vcc](https://github.com/sting8k/pi-vcc) (MIT) — adapted for
per-session use with `@earendil-works/pi-ai` (type swap, per-turn merge
semantics, full-session entry points dropped). Both upstream projects are
MIT-licensed; the ported files carry "Ported from pi-vcc" header notes.

## License

MIT — see [LICENSE](LICENSE).
