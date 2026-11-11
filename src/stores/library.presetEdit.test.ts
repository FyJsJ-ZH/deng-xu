import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { NarrativePreset, PresetEntry } from '@/types/cards'

/**
 * 预设的就地编辑（2026-11 第三十八轮）。
 *
 * 玩家原话：「把预设做成可编辑的」。
 *
 * 这一组盯的不是"按钮点得动"，而是**编辑之后那三段快照有没有跟上** ——
 * `rules` / `style` / `lore` 平时没人看，但它们才是真正注入提示词的东西；
 * 快照没重算的表现是"我明明改了，模型还在按旧的写"，
 * 而玩家只会怀疑模型不听话。
 */

const h = vi.hoisted(() => {
  const mem = new Map<string, unknown>()
  return {
    mem,
    kv: {
      get: async <T,>(k: string) => (mem.has(k) ? (mem.get(k) as T) : null),
      set: async (k: string, v: unknown) => { mem.set(k, v) },
      del: async (k: string) => { mem.delete(k) },
      clear: async () => { mem.clear() },
    },
  }
})

vi.mock('@/utils/idb', () => ({
  createKVStore: () => h.kv,
  isIdbAvailable: () => true,
}))

const { useLibraryStore } = await import('@/stores/library')

function entry(id: string, name: string, content: string, kind: PresetEntry['kind'] = 'rules', enabled = true): PresetEntry {
  return { id, name, content, kind, enabled }
}

function makePreset(over: Partial<NarrativePreset> = {}): NarrativePreset {
  return {
    id: 'p1',
    name: '剑仙',
    source: '剑仙.json',
    rules: '',
    style: '',
    lore: '',
    entries: [
      entry('e1', '铁律', '不要解释，不要总结。'),
      entry('e2', '旧口吻', '句子要短。'),
      entry('e3', '作者说明', '这是一份自用预设。', 'other'),
    ],
    counts: { total: 3, rules: 1, style: 0, other: 1, dropped: [] },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function seed(preset: NarrativePreset) {
  useLibraryStore.setState({ narrativePresets: [preset], activeNarrativePresetId: preset.id })
}

const current = () => useLibraryStore.getState().narrativePresets[0]

describe('预设编辑 · 正文', () => {
  beforeEach(() => seed(makePreset()))

  it('★ 改正文 → 条目变了、`rules` 快照跟着重算', async () => {
    await useLibraryStore.getState().updateNarrativePresetEntry('p1', 'e1', { content: '直接写正文，别铺垫。' })
    const p = current()
    expect(p.entries?.find(e => e.id === 'e1')?.content).toBe('直接写正文，别铺垫。')
    // 快照是真正注入提示词的那一段，必须一起变
    expect(p.rules).toContain('直接写正文，别铺垫。')
    expect(p.rules).not.toContain('不要解释，不要总结。')
  })

  it('★ 改名留空 → 保留原名（删掉抬头会让注入的段落没有标题）', async () => {
    await useLibraryStore.getState().updateNarrativePresetEntry('p1', 'e1', { name: '   ' })
    expect(current().entries?.find(e => e.id === 'e1')?.name).toBe('铁律')
  })

  it('★ 编辑**不动**勾选状态 —— 改错字不该把一条偷偷打开或关掉', async () => {
    await useLibraryStore.getState().toggleNarrativePresetEntry('p1', 'e2', false)
    await useLibraryStore.getState().updateNarrativePresetEntry('p1', 'e2', { content: '句子要短，节奏要快。' })
    expect(current().entries?.find(e => e.id === 'e2')?.enabled).toBe(false)
    // 没勾的条目不该出现在快照里
    expect(current().rules).not.toContain('句子要短，节奏要快。')
  })

  it('★ 编辑过的条目摘掉「超预算」角标，并从 counts.dropped 里除名', async () => {
    seed(makePreset({
      entries: [
        entry('e1', '铁律', '不要解释，不要总结。'),
        { ...entry('e2', '太长的一条', '很长的内容'), enabled: false, dropped: true },
      ],
      counts: { total: 1, rules: 1, style: 0, other: 0, dropped: ['太长的一条'] },
    }))
    await useLibraryStore.getState().updateNarrativePresetEntry('p1', 'e2', { content: '短了。' })
    const p = current()
    expect(p.entries?.find(e => e.id === 'e2')?.dropped).toBe(false)
    expect(p.counts.dropped).toEqual([])
  })

  it('没有任何字段真的变了 → 不写库（updatedAt 不动）', async () => {
    const before = current().updatedAt
    await useLibraryStore.getState().updateNarrativePresetEntry('p1', 'e1', { content: '不要解释，不要总结。' })
    expect(current().updatedAt).toBe(before)
  })

  it('★ 改落点：从「其他」挪到「规则」，快照跟着搬家', async () => {
    /*
      玩家截图里那份「剑仙」就卡在这里：唯一的一条被归进 `other`，
      界面上勾着、每轮注入却是 0 字。能改落点，它才有用武之地。
    */
    await useLibraryStore.getState().updateNarrativePresetEntry('p1', 'e3', { kind: 'rules' })
    const p = current()
    expect(p.entries?.find(e => e.id === 'e3')?.kind).toBe('rules')
    expect(p.rules).toContain('这是一份自用预设。')
    expect(p.lore).not.toContain('这是一份自用预设。')
    expect(p.counts.rules).toBe(3)
    expect(p.counts.other).toBe(0)
  })
})

describe('预设编辑 · 增删', () => {
  beforeEach(() => seed(makePreset()))

  it('★ 新增条目 → 立刻可见、默认勾上，但空正文不进快照', async () => {
    const id = await useLibraryStore.getState().addNarrativePresetEntry('p1', 'style')
    expect(id).toBeTruthy()
    const p = current()
    const added = p.entries?.find(e => e.id === id)
    expect(added?.kind).toBe('style')
    expect(added?.enabled).toBe(true)
    // 还没写内容 → 提示词里不该多出一段空标题
    expect(p.style).toBe('')
  })

  it('新增后写正文 → 进入快照', async () => {
    const id = (await useLibraryStore.getState().addNarrativePresetEntry('p1', 'style'))!
    await useLibraryStore.getState().updateNarrativePresetEntry('p1', id, { name: '人称', content: '第二人称。' })
    expect(current().style).toContain('第二人称。')
  })

  it('★ 删一条 → 快照里不再有它', async () => {
    await useLibraryStore.getState().deleteNarrativePresetEntry('p1', 'e1')
    const p = current()
    expect(p.entries?.some(e => e.id === 'e1')).toBe(false)
    expect(p.rules).not.toContain('不要解释，不要总结。')
  })

  it('★ 删到一条不剩 → 三段快照必须清空（否则列表空着、提示词还在注入）', async () => {
    for (const id of ['e1', 'e2', 'e3']) {
      await useLibraryStore.getState().deleteNarrativePresetEntry('p1', id)
    }
    const p = current()
    expect(p.entries).toEqual([])
    expect(p.rules).toBe('')
    expect(p.style).toBe('')
    expect(p.lore).toBe('')
    expect(p.counts).toMatchObject({ total: 0, rules: 0, style: 0, other: 0 })
  })

  it('删不存在的 id → 原样不动', async () => {
    const before = JSON.stringify(current())
    await useLibraryStore.getState().deleteNarrativePresetEntry('p1', 'nope')
    expect(JSON.stringify(current())).toBe(before)
  })
})

describe('预设改名', () => {
  beforeEach(() => seed(makePreset()))

  it('★ 改名进列表与提示词抬头', async () => {
    await useLibraryStore.getState().renameNarrativePreset('p1', '  自用剑仙合集  ')
    expect(current().name).toBe('自用剑仙合集')
  })

  it('空白名字不生效（列表里会变成一行空白，点都点不到）', async () => {
    await useLibraryStore.getState().renameNarrativePreset('p1', '   ')
    expect(current().name).toBe('剑仙')
  })
})
