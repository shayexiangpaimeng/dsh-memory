import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryStore } from './storage.js'
import { LAYERS } from './types.js'

/** Register the three memory tools on the given context. */
export function registerMemoryTools(ctx: Context, store: MemoryStore): void {
  ctx.tools.register(defineTool({
    name: 'memory_append',
    description: 'Append a fact or event to the append-only memory stream. Partition into five layers: permanent (never forget), session (this session), rolling (recent context), config (configuration), ephemeral (not saved). Fix claims must carry an anchor (measured value / checksum / command output).',
    parameters: {
      event: { type: 'string', required: true, description: 'The fact or event to remember' },
      layer: { type: 'string', enum: [...LAYERS], description: 'Partition layer; defaults to rolling' },
      anchor: { type: 'string', description: 'Verification anchor for fix claims' },
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
    async execute(args, exec) {
      return store.append({ event: args.event, layer: args.layer, anchor: args.anchor })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: 'Keyword recall over the memory stream. Returns matching entries, newest first.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keywords to match' },
      topK: { type: 'number', description: 'Maximum entries to return; defaults to 5' },
      layer: { type: 'string', enum: [...LAYERS], description: 'Restrict recall to one layer' },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ts: { type: 'string', required: true },
            layer: { type: 'string', required: true },
            event: { type: 'string', required: true },
            anchor: { type: 'string' },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.length === 0
          ? '无匹配记忆'
          : value.map(e => `- ${e.ts} [${e.layer}] ${e.event}${e.anchor ? ` (anchor: ${e.anchor})` : ''}`).join('\n'),
      }],
    },
    async execute(args) {
      return store.recall({ query: args.query, topK: args.topK, layers: args.layer ? [args.layer] : undefined })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_verify',
    description: 'Claim-anchors verification: check whether a fix claim in the memory stream carries a verification anchor. Claim without anchor = diagnosed defect.',
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
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ts: { type: 'string', required: true },
                layer: { type: 'string', required: true },
                event: { type: 'string', required: true },
                anchor: { type: 'string' },
              },
            },
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
}
