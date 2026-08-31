import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryStore } from './storage.js'
import { registerMemoryTools } from './tools.js'
import type { Layer } from './types.js'

export const name = 'dsh-memory'

export const inject = ['tools', 'systemPrompt']

export interface Config {
  /** JSONL store path. Defaults to ~/.dsh-memory/memory.jsonl */
  filePath?: string
  /** Layers rendered into the injected prompt summary. Defaults to permanent + session. */
  summaryLayers?: Layer[]
}

export function apply(ctx: Context, config: Config = {}): void {
  const store = new MemoryStore(config.filePath ?? join(homedir(), '.dsh-memory', 'memory.jsonl'))
  const summaryLayers = config.summaryLayers ?? ['permanent', 'session']

  registerMemoryTools(ctx, store)

  // Warm the cache once at startup; the prompt section reads the cache only,
  // so "read once per session" stays a real invariant.
  void store.warm()

  // Dynamic prompt section: evaluated at each assembly from the cache.
  ctx.systemPrompt.section({
    name: 'memory:state',
    order: 80,
    text: () => {
      const summary = store.summarySync(summaryLayers)
      return summary ? `近期记忆（append-only 写档流）：\n${summary}` : ''
    },
  })
}
