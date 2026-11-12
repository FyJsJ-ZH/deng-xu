import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { NarrativePreset } from '@/types/cards'

/**
 * 「同一个文件重新导入 = 更新，不是再存一份」（2026-11）。
 *
 * ## 这条为什么值得单独钉
 *
 * 判据第一版写成 `preset.id ? undefined : 查 source`，而导入器生成的对象
 * **总是带 id** —— 于是"查 source"那一支永远走不到，每次导入都多存一份。
 *
 * 后果不是"列表变长"这么轻：`activeNarrativePresetId` 只指向其中一份。
 * 玩家在另一份里改字、改勾选，改的是一份**没启用**的预设，
 * 而它就在同一个展开区里，看起来一模一样 —— 他报上来的现象是
 * 「我的预设时有时无」。
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

const makePreset = (id: string, source: string, name = 'Izumi 1029'): NarrativePreset => ({
  id, name, source,
  rules: '', style: '', lore: '',
  entries: [{ id: 'e1', name: '规则', kind: 'rules', content: '不许抢话', enabled: true }],
  counts: { total: 1, rules: 1, style: 0, other: 0, dropped: [] },
  createdAt: 1, updatedAt: 1,
})

const list = () => useLibraryStore.getState().narrativePresets

describe('同文件重导入 = 覆盖', () => {
  beforeEach(() => {
    useLibraryStore.setState({ narrativePresets: [], activeNarrativePresetId: '' })
  })

  it('★ 带新 id、同 source → 复用已有那份的 id，库里仍然只有一份', async () => {
    await useLibraryStore.getState().saveNarrativePreset(makePreset('old-id', 'Izumi.json'))
    expect(list()).toHaveLength(1)

    // 模拟"重新导入"：导入器每次都会生成一个新 id
    await useLibraryStore.getState().saveNarrativePreset(makePreset('new-id', 'Izumi.json'))
    expect(list()).toHaveLength(1)
    expect(list()[0].id).toBe('old-id')
  })

  it('★ 覆盖后启用状态不丢（activeId 仍然指着它）', async () => {
    await useLibraryStore.getState().saveNarrativePreset(makePreset('old-id', 'Izumi.json'), { activate: true })
    expect(useLibraryStore.getState().activeNarrativePresetId).toBe('old-id')

    await useLibraryStore.getState().saveNarrativePreset(makePreset('new-id', 'Izumi.json'), { activate: false })
    expect(useLibraryStore.getState().activeNarrativePresetId).toBe('old-id')
    expect(list()).toHaveLength(1)
  })

  it('不同文件名 → 老老实实存两份', async () => {
    await useLibraryStore.getState().saveNarrativePreset(makePreset('a', 'A.json'))
    await useLibraryStore.getState().saveNarrativePreset(makePreset('b', 'B.json'))
    expect(list()).toHaveLength(2)
  })

  it('已有 id 就地替换（真的改内容时）', async () => {
    await useLibraryStore.getState().saveNarrativePreset(makePreset('same', 'Izumi.json'))
    const edited = makePreset('same', 'Izumi.json')
    edited.entries![0].content = '改过的内容'
    await useLibraryStore.getState().saveNarrativePreset(edited)
    expect(list()).toHaveLength(1)
    expect(list()[0].entries![0].content).toBe('改过的内容')
  })
})
