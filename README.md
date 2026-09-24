# @shayexiangpaimeng/dsh-memory

Append-only layered memory for DeepSeek Harness agents.

> 上下文会缩，记忆不该缩。

A community plugin (`dsh-plugin`) that gives an agent a durable, append-only
memory stream with five-layer partitioning, a write gate, keyword recall,
time-axis reads, and claim-anchors verification. Built by a deep user of
DeepSeek Harness, as a generalized, privacy-free re-implementation of the
memory system that has kept a companion AI continuous since the memory system
was first built (August 2026).

## What it does

- **Append-only write stream** — every append writes one JSONL line; history is
  never rewritten.
- **Five-layer partitioning** — `permanent` (never forget) / `session` (this
  session) / `rolling` (recent context) / `config` (configuration) / `ephemeral`
  (not saved).
- **Write gate** — empty events, unknown layers, unknown statuses and orphan
  supersedes pointers are rejected or flagged before they can rot the stream.
- **Claim-anchors verification** — a fix claim ("已修复…") without an `anchor`
  (measured value / checksum / command output) is flagged as a warning:
  claim detached from the disk = diagnosed defect, not a slip.
- **Whole-stream anchor audit** (`memory_audit`) — write-time warnings are a soft
  constraint, because a claim can be rephrased as a plain statement. The audit
  reads the file, so it cannot be talked around.
- **Time-axis read** (`memory_recent`) — newest first, with an optional time
  window and keyword filter. Keyword recall cannot answer "what is the latest" or
  "how long has this been untouched": those words never appear in the entries.
- **Retirement and replacement chain** — retract a conclusion without rewriting
  it: append a new entry with `supersedes: <old ts>`, optionally mark the old one
  `status: retired`. Retired entries stay in the stream for audit but are filtered
  out of the injected summary, so a withdrawn claim cannot come back as a current
  fact.
- **Prompt state rendering** — a dynamic `memory:state` section renders the recent
  permanent + session layers at each assembly, from a cache warmed once at
  startup (read-once-per-session holds after warm-up).
- **Keyword recall** — case-insensitive substring scoring, newest first.

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_append` | Append an event to the stream, with optional layer, anchor, status, supersedes |
| `memory_recall` | Keyword recall over the stream (topic questions) |
| `memory_recent` | Time-axis read: newest first, optional window and keyword filter |
| `memory_verify` | Check whether a fix claim carries an anchor |
| `memory_audit` | Scan the whole stream for fix claims that carry no anchor |

## What's new in 0.2

Everything here came out of running the 0.1 design for another stretch, and each
item maps to a failure that actually happened:

- **A time axis.** Recall alone answers topic questions well and time questions
  badly — asked "what is the latest", it returned a three-month-old entry with the
  same wording, stated just as confidently. `memory_recent` is the separate path.
- **Anchor audit.** Write-time warnings can be dodged by phrasing; an audit over
  the file cannot.
- **Retirement + replacement chain.** Governance usually checks "was the new
  thing written"; the rarer bug is "the old thing came back". Retired entries must
  stay in the authoritative stream *and* stay out of every projection.

Tool descriptions carry the guidance directly ("topical → `memory_recall`,
temporal → `memory_recent`"), because a tool description is what the model
actually reads when choosing a tool; a rule in a system prompt is a soft
constraint.

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
- `memory_recent` bounds are parsed with `Date.parse`, so a bare date
  (`2026-09-01`) means UTC midnight. An unparseable bound throws instead of being
  ignored — a filter that silently matches everything is worse than an error.
- `status` and `supersedes` are optional fields: streams written by 0.1 load
  unchanged, and a missing `status` means `active`.
- The prompt section renders from the startup-warmed cache; entries appended
  before the first assembly are included, but a cold cache on very first boot
  may render an empty section for one assembly.
- DeepSeek Harness is in developer preview; the `systemPrompt`/`tools` APIs may
  break compatibility. This package follows DSH releases; pin your Harness
  version.
