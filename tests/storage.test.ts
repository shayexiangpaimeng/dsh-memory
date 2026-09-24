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

  it('rejects unknown statuses', async () => {
    const { store } = tempStore()
    const result = await store.append({ event: 'x', status: 'gone' as never })
    expect(result.ok).toBe(false)
    expect(result.warning).toContain('未知状态')
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
    await store.append({ event: '分层记忆新增写入门禁', layer: 'permanent' })
    await store.append({ event: '今天天气很好', layer: 'rolling' })
    const hits = await store.recall({ query: '门禁 记忆' })
    expect(hits.map(e => e.event)).toEqual(['分层记忆新增写入门禁'])
    const none = await store.recall({ query: '不存在的词' })
    expect(none).toHaveLength(0)
  })

  it('recent returns newest first and honours the limit', async () => {
    const { store } = tempStore()
    await store.append({ event: 'oldest', layer: 'rolling' })
    await store.append({ event: 'middle', layer: 'rolling' })
    await store.append({ event: 'newest', layer: 'rolling' })
    const two = await store.recent({ limit: 2 })
    expect(two.map(e => e.event)).toEqual(['newest', 'middle'])
    const all = await store.recent()
    expect(all).toHaveLength(3)
  })

  it('recent filters by window and keyword', async () => {
    const { store } = tempStore()
    const first = await store.append({ event: '示例条目甲', layer: 'rolling' })
    await store.append({ event: '示例条目乙', layer: 'rolling' })
    const after = await store.recent({ since: first.ts })
    expect(after.map(e => e.event)).toEqual(['示例条目乙', '示例条目甲'])
    const before = await store.recent({ until: first.ts })
    expect(before.map(e => e.event)).toEqual(['示例条目甲'])
    const filtered = await store.recent({ keyword: '条目甲' })
    expect(filtered.map(e => e.event)).toEqual(['示例条目甲'])
  })

  it('recent rejects an unparseable bound instead of silently ignoring it', async () => {
    const { store } = tempStore()
    await store.append({ event: 'x', layer: 'rolling' })
    await expect(store.recent({ since: '前天' })).rejects.toThrow('since')
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

  it('skips retired entries in verify', async () => {
    const { store } = tempStore()
    await store.append({ event: '已修复阈值问题', layer: 'session', anchor: 'hash 1' })
    const retired = await store.append({ event: '已修复阈值问题', layer: 'session', status: 'retired' })
    expect(retired.ok).toBe(true)
    const verified = await store.verify('阈值')
    expect(verified.entries.every(e => e.status !== 'retired')).toBe(true)
    expect(verified.anchored).toBe(true)
  })

  it('keeps retired entries in the stream but out of the injected summary', async () => {
    const { store } = tempStore()
    await store.append({ event: '现行结论', layer: 'permanent' })
    await store.append({ event: '已撤回的旧结论', layer: 'permanent', status: 'retired' })
    const summary = store.summarySync(['permanent'])
    expect(summary).toContain('现行结论')
    expect(summary).not.toContain('已撤回的旧结论')
    const entries = await store.read(['permanent'])
    expect(entries.map(e => e.event)).toContain('已撤回的旧结论')
  })

  it('records a replacement chain and warns when the target is missing', async () => {
    const { store } = tempStore()
    const old = await store.append({ event: '旧结论：A 成立', layer: 'permanent' })
    const replaced = await store.append({ event: '新结论：A 不成立', layer: 'permanent', supersedes: old.ts })
    expect(replaced.warning).toBeUndefined()
    const orphan = await store.append({ event: '新结论：B 不成立', layer: 'permanent', supersedes: 'nope' })
    expect(orphan.warning).toContain('supersedes')
    const entries = await store.read(['permanent'])
    const chained = entries.find(e => e.event === '新结论：A 不成立')
    expect(chained?.supersedes).toBe(old.ts)
  })

  it('audits the whole stream for missing anchors', async () => {
    const { store } = tempStore()
    await store.append({ event: '已修复甲问题', layer: 'session', anchor: 'hash a' })
    await store.append({ event: '已修复乙问题', layer: 'session' })
    await store.append({ event: '普通记录', layer: 'rolling' })
    const audit = await store.auditAnchors()
    expect(audit.scanned).toBe(3)
    expect(audit.claims).toBe(2)
    expect(audit.missing.map(e => e.event)).toEqual(['已修复乙问题'])
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
