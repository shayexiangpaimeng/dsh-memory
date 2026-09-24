import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AppendInput,
  AppendResult,
  AuditResult,
  EntryStatus,
  Layer,
  MemoryEntry,
  RecentQuery,
  RecallQuery,
  VerifyResult,
} from './types.js'
import { LAYERS, STATUSES } from './types.js'

/** Fix-claim signal words. A claim without an anchor is a diagnosed defect. */
const CLAIM_PATTERN = /修复|已修|修好|修完|fixed|resolved|已解决/

/** Maximum entries rendered into the injected summary. */
const SUMMARY_LIMIT = 20

function isLayer(value: unknown): value is Layer {
  return typeof value === 'string' && (LAYERS as readonly string[]).includes(value)
}

function isStatus(value: unknown): value is EntryStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
}

/** Parse an ISO date or date-time; throws so a bad filter never silently returns everything. */
function parseBound(value: string, field: 'since' | 'until'): number {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new Error(`${field} 不是合法时间戳：${value}（用 ISO 日期或日期时间）`)
  return parsed
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
            if (parsed.status !== undefined && !isStatus(parsed.status)) delete parsed.status
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
   * Append one entry. The write gate rejects empty events, unknown layers and
   * unknown statuses; a fix claim without an anchor passes but carries a
   * warning, and so does a supersedes pointer to an entry that is not in the
   * stream (the chain has to stay walkable).
   */
  async append(input: AppendInput): Promise<AppendResult> {
    const event = input.event.trim()
    if (!event) return { ok: false, ts: '', warning: 'event 为空：写档五问第一问不通过' }
    const layer = input.layer ?? 'rolling'
    if (!isLayer(layer)) return { ok: false, ts: '', warning: `未知层 ${String(input.layer)}：写入前过五问（放哪层？）` }
    if (input.status !== undefined && !isStatus(input.status)) {
      return { ok: false, ts: '', warning: `未知状态 ${String(input.status)}：只接受 active / retired` }
    }
    const anchor = input.anchor?.trim()
    const supersedes = input.supersedes?.trim()
    const entry: MemoryEntry = {
      ts: new Date().toISOString(),
      layer,
      event,
      ...(anchor ? { anchor } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(supersedes ? { supersedes } : {}),
    }

    const warnings: string[] = []
    if (CLAIM_PATTERN.test(event) && !anchor) {
      warnings.push('检测到修复声称但缺少 anchor 验证锚点：声称与实盘脱节=已诊断故障')
    }
    if (supersedes) {
      const existing = await this.load()
      if (!existing.some(e => e.ts === supersedes)) {
        warnings.push(`supersedes 指向的条目不在流里：${supersedes}（取代链要能走通）`)
      }
    }

    await this.ensureDir()
    await appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8')
    this.cache.push(entry)
    return { ok: true, ts: entry.ts, warning: warnings.length > 0 ? warnings.join('；') : undefined }
  }

  /** Read entries, optionally restricted to the given layers. Newest first. */
  async read(layers?: Layer[]): Promise<MemoryEntry[]> {
    const all = await this.load()
    const filtered = layers ? all.filter(e => layers.includes(e.layer)) : all
    return [...filtered].reverse()
  }

  /** Keyword recall over events and anchors (case-insensitive substring scoring). */
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
   * Time-axis read: newest first, with an optional window and keyword filter.
   * Use this for "what changed lately / since when / how long has it been
   * untouched" — keyword recall cannot answer those, because the words in the
   * question never appear in the entries.
   */
  async recent(query: RecentQuery = {}): Promise<MemoryEntry[]> {
    const all = await this.read(query.layers)
    const since = query.since ? parseBound(query.since, 'since') : undefined
    const until = query.until ? parseBound(query.until, 'until') : undefined
    const terms = query.keyword?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
    const picked = all.filter(entry => {
      const ts = Date.parse(entry.ts)
      if (since !== undefined && ts < since) return false
      if (until !== undefined && ts > until) return false
      if (terms.length > 0) {
        const hay = `${entry.event} ${entry.anchor ?? ''}`.toLowerCase()
        if (!terms.every(term => hay.includes(term))) return false
      }
      return true
    })
    return picked.slice(0, query.limit ?? 5)
  }

  /**
   * Claim-anchors verification over active entries: find fix claims mentioning
   * the query and report whether each carries an anchor. Retired entries are
   * skipped — they are no longer current claims.
   */
  async verify(claim: string): Promise<VerifyResult> {
    const terms = claim.toLowerCase().split(/\s+/).filter(Boolean)
    const matches = (await this.read()).filter(entry => {
      if (entry.status === 'retired') return false
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

  /**
   * Whole-stream anchor audit. Write-time warnings are a soft constraint (a
   * claim can be rephrased as a plain statement); this audit reads the file, so
   * it cannot be talked around.
   */
  async auditAnchors(): Promise<AuditResult> {
    const all = await this.load()
    const claims = all.filter(e => CLAIM_PATTERN.test(e.event))
    const missing = claims.filter(e => !e.anchor).reverse()
    return { missing, scanned: all.length, claims: claims.length }
  }

  /**
   * Synchronous summary over the cached stream, for prompt injection. Retired
   * entries are filtered out: a retired claim must never come back as a current
   * fact through the injected projection.
   */
  summarySync(layers: Layer[] = ['permanent', 'session']): string {
    const picked = this.cache
      .filter(e => layers.includes(e.layer) && e.status !== 'retired')
      .slice(-SUMMARY_LIMIT)
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
