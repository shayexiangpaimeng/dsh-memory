import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AppendInput, AppendResult, Layer, MemoryEntry, RecallQuery, VerifyResult } from './types.js'
import { LAYERS } from './types.js'

/** Fix-claim signal words. A claim without an anchor is a diagnosed defect. */
const CLAIM_PATTERN = /修复|已修|修好|修完|fixed|resolved|fixed the|已解决/

/** Maximum entries rendered into the injected summary. */
const SUMMARY_LIMIT = 20

function isLayer(value: unknown): value is Layer {
  return typeof value === 'string' && (LAYERS as readonly string[]).includes(value)
}

/**
 * Append-only layered memory store.
 *
 * The store file is a JSONL stream: every append writes one line and never
 * rewrites history. The in-memory cache mirrors the stream; reads after the
 * first load never touch the file again.
 */
export class MemoryStore {
  private cache: MemoryEntry[] = []
  private loaded = false
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  /** Load the stream into cache once. The file is authoritative: the cache is rebuilt from it, never merged into. */
  private async load(): Promise<MemoryEntry[]> {
    if (this.loaded) return this.cache
    const entries: MemoryEntry[] = []
    if (existsSync(this.filePath)) {
      const raw = await readFile(this.filePath, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as Partial<MemoryEntry>
          if (typeof parsed.event === 'string' && isLayer(parsed.layer)) {
            entries.push(parsed as MemoryEntry)
          }
        } catch {
          // skip corrupt line
        }
      }
    }
    this.cache = entries
    this.loaded = true
    return this.cache
  }

  /**
   * Append one entry. The write gate rejects empty events and unknown layers;
   * a fix claim without an anchor passes but carries a warning.
   */
  async append(input: AppendInput): Promise<AppendResult> {
    const event = input.event.trim()
    if (!event) return { ok: false, ts: '', warning: 'event 为空：写档五问第一问不通过' }
    const layer = input.layer ?? 'rolling'
    if (!isLayer(layer)) return { ok: false, ts: '', warning: `未知层 ${String(input.layer)}：写入前过五问（放哪层？）` }
    const anchor = input.anchor?.trim()
    const entry: MemoryEntry = {
      ts: new Date().toISOString(),
      layer,
      event,
      ...(anchor ? { anchor } : {}),
    }
    await this.ensureDir()
    await appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8')
    this.cache.push(entry)
    const warning = CLAIM_PATTERN.test(event) && !anchor
      ? '检测到修复声称但缺少 anchor 验证锚点：声称与实盘脱节=已诊断故障'
      : undefined
    return { ok: true, ts: entry.ts, warning }
  }

  /** Read entries, optionally restricted to the given layers. Newest first. */
  async read(layers?: Layer[]): Promise<MemoryEntry[]> {
    const all = await this.load()
    const filtered = layers ? all.filter(e => layers.includes(e.layer)) : all
    return [...filtered].reverse()
  }

  /** Keyword recall over events (case-insensitive substring scoring). */
  async recall(query: RecallQuery): Promise<MemoryEntry[]> {
    const terms = query.query.toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return []
    const all = await this.read(query.layers)
    const scored = all
      .map(entry => {
        const hay = `${entry.event} ${entry.anchor ?? ''}`.toLowerCase()
        const score = terms.reduce((sum, term) => sum + (hay.includes(term) ? 1 : 0), 0)
        return { entry, score }
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.ts.localeCompare(a.entry.ts))
    return scored.slice(0, query.topK ?? 5).map(x => x.entry)
  }

  /**
   * Claim-anchors verification: find fix claims mentioning the query and
   * report whether each carries an anchor.
   */
  async verify(claim: string): Promise<VerifyResult> {
    const terms = claim.toLowerCase().split(/\s+/).filter(Boolean)
    const matches = (await this.read()).filter(entry => {
      if (!CLAIM_PATTERN.test(entry.event)) return false
      const hay = entry.event.toLowerCase()
      return terms.every(term => hay.includes(term))
    })
    return {
      found: matches.length > 0,
      entries: matches.slice(0, 10),
      anchored: matches.every(e => Boolean(e.anchor)),
    }
  }

  /** Synchronous summary over the cached stream, for prompt injection. */
  summarySync(layers: Layer[] = ['permanent', 'session']): string {
    const picked = this.cache.filter(e => layers.includes(e.layer)).slice(-SUMMARY_LIMIT)
    if (picked.length === 0) return ''
    return picked
      .map(e => `- ${e.ts} [${e.layer}] ${e.event}${e.anchor ? ` (anchor: ${e.anchor})` : ''}`)
      .join('\n')
  }

  /** Warm the cache at plugin start; the first prompt assembly sees the stream. */
  async warm(): Promise<void> {
    await this.load()
  }

  private async ensureDir(): Promise<void> {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  }
}
