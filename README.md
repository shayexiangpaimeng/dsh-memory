# @shayexiangpaimeng/dsh-memory

Append-only layered memory for DeepSeek Harness agents.

> 上下文会缩，记忆不该缩。

A community plugin (`dsh-plugin`) that gives an agent a durable, append-only
memory stream with five-layer partitioning, a write gate, keyword recall, and
claim-anchors verification. Built by a deep user of DeepSeek Harness, as a
generalized, privacy-free re-implementation of the memory system that has kept
a companion AI continuous since its memory system was first built on 2026-08-03.

## What it does

- **Append-only write stream** — every append writes one JSONL line; history is
  never rewritten.
- **Five-layer partitioning** — `permanent` (never forget) / `session` (this
  session) / `rolling` (recent context) / `config` (configuration) / `ephemeral`
  (not saved).
- **Write gate** — empty events and unknown layers are rejected before they hit
  the file.
- **Claim-anchors verification** — a fix claim ("已修复…") without an `anchor`
  (measured value / checksum / command output) is flagged as a warning:
  claim detached from the disk = diagnosed defect, not a slip.
- **Prompt state rendering** — a dynamic `memory:state` section renders the recent
  permanent + session layers at each assembly, from a cache warmed once at
  startup (read-once-per-session holds after warm-up).
- **Keyword recall** — case-insensitive substring scoring, newest first.

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_append` | Append an event to the stream, with optional layer and anchor |
| `memory_recall` | Keyword recall over the stream |
| `memory_verify` | Check whether a fix claim carries an anchor |

## Install

From GitHub (current distribution channel):

```sh
npm i github:shayexiangpaimeng/dsh-memory
```

From npm registry (once published):

```sh
npm i @shayexiangpaimeng/dsh-memory
```

Mount in a `cordis.yml`:

```yaml
plugins:
  - '@shayexiangpaimeng/dsh-memory'
```

Store path defaults to `~/.dsh-memory/memory.jsonl`; override with
`config.filePath`. Injection layers default to `permanent` + `session`;
override with `config.summaryLayers`.

## Development

```sh
npm install
npm test        # vitest, no API key required
npm run build   # tsc → lib/
```

## Known Limitations and Deferred Work

- Recall is keyword substring scoring, not vector search. A vector index is
  deferred; the storage format is stable enough to add one behind the same
  `recall()` contract.
- The prompt section renders from the startup-warmed cache; entries appended
  before the first assembly are included, but a cold cache on very first boot
  may render an empty section for one assembly.
- DeepSeek Harness is in developer preview; the `systemPrompt`/`tools` APIs may
  break compatibility. This package follows DSH releases; pin your Harness
  version.
