import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/storage.js'

function tempStore(): { store: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  return { store: new MemoryStore(join(dir, 'memory.jsonl')), dir }
}

describe('MemoryStore', () => {
  it('rejects empty events', async () => {
    const { store } = tempStore()
    const result = await store.append({ event: '   ' })
    expect(result.ok).toBe(false)
    expect(result.warning).toContain('为空')
  })

  it('rejects unknown layers', async () => {
    const { store } = tempStore()
    const result = await store.append({ event: 'x', layer: 'blackhole' as never })
    expect(result.ok).toBe(false)
  })

  it('appends to the file and to the cache', async () => {
    const { store } = tempStore()
    const result = await store.append({ event: '第一次写档', layer: 'permanent' })
    expect(result.ok).toBe(true)
    expect(result.ts).toBeTruthy()
    const entries = await store.read()
    expect(entries).toHaveLength(1)
    expect(entries[0].event).toBe('第一次写档')
    expect(entries[0].layer).toBe('permanent')
  })

  it('reads newest first and filters by layer', async () => {
    const { store } = tempStore()
    await store.append({ event: 'a', layer: 'permanent' })
    await store.append({ event: 'b', layer: 'rolling' })
    const all = await store.read()
    expect(all.map(e => e.event)).toEqual(['b', 'a'])
    const permanent = await store.read(['permanent'])
    expect(permanent.map(e => e.event)).toEqual(['a'])
  })

  it('warns on fix claims without an anchor', async () => {
    const { store } = tempStore()
    const bare = await store.append({ event: '已修复阈值问题', layer: 'session' })
    expect(bare.ok).toBe(true)
    expect(bare.warning).toContain('anchor')
    const anchored = await store.append({ event: '已修复阈值问题', layer: 'session', anchor: 'verify_all passed: []' })
    expect(anchored.warning).toBeUndefined()
  })

  it('recalls by keyword with scoring', async () => {
    const { store } = tempStore()
    await store.append({ event: '协议树新增读人纪律', layer: 'permanent' })
    await store.append({ event: '今天天气很好', layer: 'rolling' })
    const hits = await store.recall({ query: '协议树 纪律' })
    expect(hits.map(e => e.event)).toEqual(['协议树新增读人纪律'])
    const none = await store.recall({ query: '不存在的词' })
    expect(none).toHaveLength(0)
  })

  it('verifies anchors on fix claims', async () => {
    const { store } = tempStore()
    const result = await store.verify('阈值')
    expect(result.found).toBe(false)
    await store.append({ event: '已修复阈值问题', layer: 'session', anchor: 'file hash abc123' })
    const verified = await store.verify('阈值')
    expect(verified.found).toBe(true)
    expect(verified.anchored).toBe(true)
    await store.append({ event: '已修复缓存问题', layer: 'session' })
    const mixed = await store.verify('问题')
    expect(mixed.found).toBe(true)
    expect(mixed.anchored).toBe(false)
  })

  it('survives reload from the JSONL file', async () => {
    const { store, dir } = tempStore()
    await store.append({ event: '持久化条目', layer: 'permanent' })
    const reloaded = new MemoryStore(join(dir, 'memory.jsonl'))
    const entries = await reloaded.read()
    expect(entries).toHaveLength(1)
    expect(entries[0].event).toBe('持久化条目')
    rmSync(dir, { recursive: true, force: true })
  })

  it('renders a bounded summary for injection', async () => {
    const { store } = tempStore()
    expect(store.summarySync()).toBe('')
    await store.append({ event: 'first', layer: 'permanent' })
    await store.append({ event: 'second', layer: 'rolling' })
    const summary = store.summarySync(['permanent'])
    expect(summary).toContain('first')
    expect(summary).not.toContain('second')
  })
})
