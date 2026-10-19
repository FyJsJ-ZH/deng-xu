import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { WorldCard } from '@/types/cards'

/**
 * 内置卡的**内容更新** —— 老玩家库里那张卡会不会被换成新版。
 *
 * ## 这一组测试防的是什么（2026-10 第十一轮，玩家第三次说「改了没生效」）
 *
 * 玩家原话：
 * > 「我打开网页用起来输出的字数没变化，世界书设定内的叙事参数……
 * >   依然是 800 字，怎么回事？浏览器网页的自动更新不起作用？还是你没改好？」
 *
 * 当时的逻辑只补「**缺 id**」的内置卡：
 *
 *     const missing = missingBuiltinIds(已有 id, 删过的 id)
 *     if (firstRun || missing.length) { 补卡 }
 *
 * 而老玩家库里 `builtin_london1905` 这个 id 一直都在 —— 他一路在玩这张卡 ——
 * 于是它**永远停在第一次播种时的样子**。源码里 `replyLength` 早已是 1800，
 * 线上 bundle 里也确实写着 1800，屏幕上却还是 800。
 *
 * 修法是给内置卡一个内容指纹（`data/builtinStamp.ts`），指纹变了就整批刷新。
 * 这一组测试盯的就是那条刷新的**边界**：该换的换、不该动的一个都不许动。
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
    /** 「源码里现在是第几版」—— 测试里随时改，模拟发版 */
    newReplyLength: { value: 1800 },
    loadCalls: [] as string[][],
  }
})

vi.mock('@/utils/idb', () => ({
  createKVStore: () => h.kv,
  isIdbAvailable: () => true,
}))

vi.mock('@/data/builtinWorldIds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/builtinWorldIds')>()
  return {
    ...actual,
    // 只替换"从源码加载新卡"这一步，id 清单与缺卡算法仍然用真的
    loadBuiltinWorlds: async (ids: readonly string[]) => {
      h.loadCalls.push([...ids])
      return ids.map(id => fakeWorld(id, h.newReplyLength.value, true))
    },
  }
})

const { useLibraryStore } = await import('@/stores/library')
const { BUILTIN_STAMP } = await import('@/data/builtinStamp')
const { BUILTIN_WORLD_IDS } = await import('@/data/builtinWorldIds')

function fakeWorld(id: string, replyLength: number, builtin: boolean): WorldCard {
  return {
    id, title: id, tagline: '', worldLore: '', rules: '',
    attributes: [], resources: [], backgrounds: [], attributePoints: 0,
    items: [], lores: [],
    story: {
      atmosphere: '', mainQuest: '', enableStages: false, stages: [],
      enableChoices: false, urgencyAfterTurns: 0, openerSlot: '', openingSeeds: {},
    },
    narrative: { pov: 'third', tense: 'present', replyLength, customStyle: '' },
    characters: [], enableMechanics: false,
    avatarStyle: 'ink', avatarTone: '#000',
    createdAt: 0, updatedAt: 0, builtin,
  }
}

/** 库里已经存着九张卡（`replyLength` 可以是旧值），外加可选的指纹与删除记录 */
function seedStorage(opts: {
  worlds: WorldCard[]
  stamp?: string | null
  removed?: string[]
}) {
  h.mem.clear()
  h.mem.set('worlds', JSON.stringify(opts.worlds))
  if (opts.stamp !== undefined && opts.stamp !== null) h.mem.set('builtinStamp', opts.stamp)
  if (opts.removed?.length) h.mem.set('removedBuiltinWorlds', JSON.stringify(opts.removed))
  useLibraryStore.setState({ loaded: false, worlds: [], loadError: null })
}

const allBuiltins = (replyLength: number) =>
  BUILTIN_WORLD_IDS.map(id => fakeWorld(id, replyLength, true))

const loaded = () => useLibraryStore.getState().worlds
const findWorld = (id: string) => loaded().find(w => w.id === id)

beforeEach(() => {
  h.newReplyLength.value = 1800
  h.loadCalls.length = 0
})

describe('内置卡内容更新 · 指纹变了就该换新', () => {
  it('★ 旧卡的 replyLength 是 800，加载后被换成源码里的 1800', async () => {
    seedStorage({ worlds: allBuiltins(800), stamp: 'old-stamp-0000' })

    await useLibraryStore.getState().loadWorlds()

    expect(findWorld('builtin_london1905')?.narrative.replyLength).toBe(1800)
    // 九张全换，不是只换一张
    for (const id of BUILTIN_WORLD_IDS) {
      expect(findWorld(id)?.narrative.replyLength, id).toBe(1800)
    }
  })

  it('★ 换过之后写上新的指纹，下次启动不再重复刷新', async () => {
    seedStorage({ worlds: allBuiltins(800), stamp: 'old-stamp-0000' })
    await useLibraryStore.getState().loadWorlds()

    expect(h.mem.get('builtinStamp')).toBe(BUILTIN_STAMP)

    // 再模拟一次启动：指纹已经一致，此时不该再去加载任何 chunk
    h.loadCalls.length = 0
    useLibraryStore.setState({ loaded: false })
    await useLibraryStore.getState().loadWorlds()
    expect(h.loadCalls).toEqual([])
    expect(findWorld('builtin_london1905')?.narrative.replyLength).toBe(1800)
  })

  it('★ 指纹一致时**不许**动已有的卡（哪怕它看着旧）', async () => {
    seedStorage({ worlds: allBuiltins(800), stamp: BUILTIN_STAMP })

    await useLibraryStore.getState().loadWorlds()

    expect(h.loadCalls).toEqual([])
    expect(findWorld('builtin_london1905')?.narrative.replyLength).toBe(800)
  })

  it('指纹读不出来（老库升级到这一版）也走一次刷新', async () => {
    seedStorage({ worlds: allBuiltins(800) })   // 没有 builtinStamp 这个键

    await useLibraryStore.getState().loadWorlds()

    expect(findWorld('builtin_london1905')?.narrative.replyLength).toBe(1800)
  })
})

describe('内置卡内容更新 · 边界：不该动的绝不碰', () => {
  it('★ 玩家自己建的卡原样保留', async () => {
    const mine = fakeWorld('my_custom_world', 500, false)
    seedStorage({ worlds: [mine, ...allBuiltins(800)], stamp: 'old-stamp-0000' })

    await useLibraryStore.getState().loadWorlds()

    expect(findWorld('my_custom_world')?.narrative.replyLength).toBe(500)
    expect(findWorld('my_custom_world')?.title).toBe('my_custom_world')
  })

  it('★ 玩家删过的内置卡不会因为换戳而复活', async () => {
    const kept = allBuiltins(800).filter(w => w.id !== 'builtin_veil')
    seedStorage({ worlds: kept, stamp: 'old-stamp-0000', removed: ['builtin_veil'] })

    await useLibraryStore.getState().loadWorlds()

    expect(findWorld('builtin_veil')).toBeUndefined()
    expect(findWorld('builtin_london1905')?.narrative.replyLength).toBe(1800)
  })

  it('★ 同 id 但 builtin=false 的副本不被覆盖（那是他自己的卡）', async () => {
    const copy = fakeWorld('builtin_london1905', 777, false)
    const rest = BUILTIN_WORLD_IDS.filter(id => id !== 'builtin_london1905')
      .map(id => fakeWorld(id, 800, true))
    seedStorage({ worlds: [copy, ...rest], stamp: 'old-stamp-0000' })

    await useLibraryStore.getState().loadWorlds()

    expect(findWorld('builtin_london1905')?.narrative.replyLength).toBe(777)
  })

  it('★ 刷新是**就地替换**，卡片顺序不变（不许把换过的卡甩到末尾）', async () => {
    const before = allBuiltins(800)
    seedStorage({ worlds: before, stamp: 'old-stamp-0000' })

    await useLibraryStore.getState().loadWorlds()

    expect(loaded().map(w => w.id)).toEqual(before.map(w => w.id))
  })
})

describe('内置卡内容更新 · 首次运行与新增卡', () => {
  it('★ 空库照样播入九张（不能因为加了刷新逻辑就漏掉播种）', async () => {
    seedStorage({ worlds: [], stamp: null })
    h.mem.delete('worlds')   // 真空库：模拟首次运行

    await useLibraryStore.getState().loadWorlds()

    expect(loaded()).toHaveLength(BUILTIN_WORLD_IDS.length)
    expect(h.mem.get('builtinStamp')).toBe(BUILTIN_STAMP)
  })

  it('★ 缺一张内置卡时只补那一张，不去重下已经有的', async () => {
    const partial = allBuiltins(1800).filter(w => w.id !== 'builtin_ximeng')
    seedStorage({ worlds: partial, stamp: BUILTIN_STAMP })

    await useLibraryStore.getState().loadWorlds()

    expect(h.loadCalls).toEqual([['builtin_ximeng']])
    expect(findWorld('builtin_ximeng')).toBeTruthy()
    // 新补的卡在末尾
    expect(loaded().at(-1)?.id).toBe('builtin_ximeng')
  })
})
