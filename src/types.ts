/** Memory layers, from "never forget" to "never save". */
export const LAYERS = ['permanent', 'session', 'rolling', 'config', 'ephemeral'] as const

export type Layer = (typeof LAYERS)[number]

/**
 * Lifecycle status. A `retired` entry stays in the append-only stream (audit
 * needs it) but never enters an injected projection — retired claims must not
 * come back as current facts.
 */
export const STATUSES = ['active', 'retired'] as const

export type EntryStatus = (typeof STATUSES)[number]

/** One append-only memory entry (one JSON line in the store file). */
export interface MemoryEntry {
  /** ISO timestamp of the append. Also serves as the entry fingerprint. */
  ts: string
  /** Partition layer; decides retention policy. */
  layer: Layer
  /** The remembered fact or event. */
  event: string
  /** Claim-anchors: verification anchor (measured value / checksum / command output). */
  anchor?: string
  /** Lifecycle status. Defaults to active when absent. */
  status?: EntryStatus
  /**
   * Replacement chain: fingerprint (ts) of the entry this one supersedes.
   * Superseded entries are never rewritten — the chain is how history stays
   * replayable and how "we used to believe X" stays auditable.
   */
  supersedes?: string
}

export interface AppendInput {
  /** The fact or event to remember. Non-empty after trimming. */
  event: string
  /** Partition layer. Defaults to `rolling`. */
  layer?: Layer
  /** Claim-anchors: attach a verification anchor to a fix claim. */
  anchor?: string
  /** Lifecycle status. Defaults to `active`. */
  status?: EntryStatus
  /** Fingerprint (ts) of the entry this one supersedes. */
  supersedes?: string
}

export interface AppendResult {
  ok: boolean
  /** ISO timestamp of the written entry. Empty when the append was rejected. */
  ts: string
  /** Present when the entry was accepted but carries a hygiene warning. */
  warning?: string
}

export interface RecallQuery {
  /** Keywords to match against events and anchors. */
  query: string
  /** Maximum number of entries to return. Defaults to 5. */
  topK?: number
  /** Restrict recall to these layers. Defaults to all layers. */
  layers?: Layer[]
}

/**
 * Time-axis read. Answers "recent / latest / since when" questions that keyword
 * recall cannot: the words in those questions never appear in the entries.
 */
export interface RecentQuery {
  /** Maximum number of entries to return, newest first. Defaults to 5. */
  limit?: number
  /** Only entries at or after this timestamp (ISO date or date-time). */
  since?: string
  /** Only entries at or before this timestamp (ISO date or date-time). */
  until?: string
  /** Optional keyword filter; every space-separated term must appear. */
  keyword?: string
  /** Restrict to these layers. Defaults to all layers. */
  layers?: Layer[]
}

export interface VerifyResult {
  /** Whether a matching fix claim exists among active entries. */
  found: boolean
  /** The matched entries, newest first. */
  entries: MemoryEntry[]
  /** Whether every matched fix claim carries an anchor. */
  anchored: boolean
}

/** Result of a whole-stream anchor audit (post-hoc, not a write-time warning). */
export interface AuditResult {
  /** Fix claims without an anchor, newest first. */
  missing: MemoryEntry[]
  /** Total entries scanned. */
  scanned: number
  /** Entries carrying a fix claim. */
  claims: number
}
