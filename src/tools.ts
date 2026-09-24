import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryStore } from './storage.js'
import { LAYERS, STATUSES } from './types.js'

const ENTRY_PROPS = {
  ts: { type: 'string', required: true },
  layer: { type: 'string', required: true },
  event: { type: 'string', required: true },
  anchor: { type: 'string' },
  status: { type: 'string' },
  supersedes: { type: 'string' },
} as const

function renderEntries(value: Array<{ ts: string; layer: string; event: string; anchor?: string }>): string {
  return value.length === 0
    ? '无匹配记忆'
    : value.map(e => `- ${e.ts} [${e.layer}] ${e.event}${e.anchor ? ` (anchor: ${e.anchor})` : ''}`).join('\n')
}

/** Register the memory tools on the given context. */
export function registerMemoryTools(ctx: Context, store: MemoryStore): void {
  ctx.tools.register(defineTool({
    name: 'memory_append',
    description: 'Append a fact or event to the append-only memory stream. Partition into five layers: permanent (never forget), session (this session), rolling (recent context), config (configuration), ephemeral (not saved). Fix claims must carry an anchor (measured value / checksum / command output). To retract an earlier conclusion, do not rewrite it: append a new entry with supersedes set to the old entry\'s ts; mark withdrawn entries status=retired (they stay in the stream for audit but never enter an injected summary).',
    parameters: {
      event: { type: 'string', required: true, description: 'The fact or event to remember' },
      layer: { type: 'string', enum: [...LAYERS], description: 'Partition layer; defaults to rolling' },
      anchor: { type: 'string', description: 'Verification anchor for fix claims' },
      status: { type: 'string', enum: [...STATUSES], description: 'Lifecycle status; defaults to active. retired = kept for audit, never injected' },
      supersedes: { type: 'string', description: 'ts of the entry this one supersedes (replacement chain)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          ts: { type: 'string', required: true },
          warning: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `已写入记忆 (${value.ts})${value.warning ? `；警告：${value.warning}` : ''}`
          : `写入被拒：${value.warning ?? '未知原因'}`,
      }],
    },
    async execute(args) {
      return store.append({
        event: args.event,
        layer: args.layer,
        anchor: args.anchor,
        status: args.status,
        supersedes: args.supersedes,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: 'Keyword recall over the memory stream, for TOPIC questions ("what is X", "what is the evidence for Y"). Returns matching entries scored by term overlap, newest first. It has no time axis: do not use it for time questions ("what is the latest", "how long since", "where did we get to") — use memory_recent for those. Query with concrete anchors (ids, DOIs, proper nouns, dates), not filler words like "latest" or "status".',
    parameters: {
      query: { type: 'string', required: true, description: 'Keywords to match' },
      topK: { type: 'number', description: 'Maximum entries to return; defaults to 5' },
      layer: { type: 'string', enum: [...LAYERS], description: 'Restrict recall to one layer' },
    },
    output: {
      schema: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, properties: ENTRY_PROPS },
      },
      render: (_args, value) => [{ type: 'text', text: renderEntries(value) }],
    },
    async execute(args) {
      return store.recall({ query: args.query, topK: args.topK, layers: args.layer ? [args.layer] : undefined })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recent',
    description: 'Time-axis read of the memory stream: newest first, with an optional time window and keyword filter. Use this for TIME questions — "what is the latest", "what changed in the last week", "how long has this been untouched", "where did we get to". Keyword recall cannot answer those, because the words in the question never appear in the entries. Every returned entry carries its timestamp so freshness is visible.',
    parameters: {
      limit: { type: 'number', description: 'Maximum entries to return, newest first; defaults to 5' },
      since: { type: 'string', description: 'Only entries at or after this ISO date/date-time (e.g. 2026-09-01)' },
      until: { type: 'string', description: 'Only entries at or before this ISO date/date-time' },
      keyword: { type: 'string', description: 'Optional keyword filter; every space-separated term must appear' },
      layer: { type: 'string', enum: [...LAYERS], description: 'Restrict to one layer' },
    },
    output: {
      schema: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, properties: ENTRY_PROPS },
      },
      render: (_args, value) => [{ type: 'text', text: renderEntries(value) }],
    },
    async execute(args) {
      return store.recent({
        limit: args.limit,
        since: args.since,
        until: args.until,
        keyword: args.keyword,
        layers: args.layer ? [args.layer] : undefined,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_verify',
    description: 'Claim-anchors verification: check whether a fix claim among the active entries carries a verification anchor. Claim without anchor = diagnosed defect. Retired entries are skipped (they are no longer current claims).',
    parameters: {
      claim: { type: 'string', required: true, description: 'The fix claim to verify' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          anchored: { type: 'boolean', required: true },
          entries: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, properties: ENTRY_PROPS },
            required: true,
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: !value.found
          ? '未找到匹配的修复声称'
          : value.anchored
            ? `全部 ${value.entries.length} 条匹配声称均带锚点`
            : `发现 ${value.entries.length} 条匹配声称，其中存在缺少锚点的条目（声称与实盘脱节=已诊断故障）`,
      }],
    },
    async execute(args) {
      return store.verify(args.claim)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_audit',
    description: 'Whole-stream anchor audit: list every fix claim that carries no anchor. Run it periodically instead of relying on write-time warnings — a claim can be rephrased as a plain statement to dodge the write gate, but the audit reads the file.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scanned: { type: 'number', required: true },
          claims: { type: 'number', required: true },
          missing: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, properties: ENTRY_PROPS },
            required: true,
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.missing.length === 0
          ? `扫描 ${value.scanned} 条，${value.claims} 条修复声称全部带锚点`
          : `扫描 ${value.scanned} 条，${value.claims} 条修复声称中 ${value.missing.length} 条缺锚点：\n${renderEntries(value.missing)}`,
      }],
    },
    async execute() {
      return store.auditAnchors()
    },
  }))
}
