/** Memory layers, from "never forget" to "never save". */
export const LAYERS = ['permanent', 'session', 'rolling', 'config', 'ephemeral'] as const

export type Layer = (typeof LAYERS)[number]

/** One append-only memory entry (one JSON line in the store file). */
export interface MemoryEntry {
  /** ISO timestamp of the append. */
  ts: string
  /** Partition layer; decides retention policy. */
  layer: Layer
  /** The remembered fact or event. */
  event: string
  /** Claim-anchors: verification anchor (measured value / checksum / command output). */
  anchor?: string
}

export interface AppendInput {
  /** The fact or event to remember. Non-empty after trimming. */
  event: string
  /** Partition layer. Defaults to `rolling`. */
  layer?: Layer
  /** Claim-anchors: attach a verification anchor to a fix claim. */
  anchor?: string
}

export interface AppendResult {
  ok: boolean
  /** ISO timestamp of the written entry. Empty when the append was rejected. */
  ts: string
  /** Present when the entry was accepted but carries a hygiene warning. */
  warning?: string
}

export interface RecallQuery {
  /** Keywords to match against events and tags. */
  query: string
  /** Maximum number of entries to return. Defaults to 5. */
  topK?: number
  /** Restrict recall to these layers. Defaults to all layers. */
  layers?: Layer[]
}

export interface VerifyResult {
  /** Whether a matching fix claim exists in the stream. */
  found: boolean
  /** The matched entries, newest first. */
  entries: MemoryEntry[]
  /** Whether every matched fix claim carries an anchor. */
  anchored: boolean
}
