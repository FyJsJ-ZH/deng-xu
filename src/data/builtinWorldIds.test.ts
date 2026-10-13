import { describe, it, expect } from 'vitest'
import {
  BUILTIN_WORLD_IDS,
  BUILTIN_WORLD_LOADER_IDS,
  loadBuiltinWorlds,
  missingBuiltinIds,
} from '@/data/builtinWorldIds'
import { BUILTIN_WORLDS } from '@/data/builtinWorlds'

/**
 * 内置世界清单的一致性，以及"缺卡补齐"的判据。
 *
 * ## 这里防的是哪一类 bug
 *
 * 2026-10 给项目加了四张新世界卡（艺创区素材做的）。加完才发现一个**只影响老玩家**
 * 的漏洞：内置卡原先只在 `worlds === null`（首次运行）时播种，
 * 而老玩家的卡片库里早就不是 null 了 —— 于是**新装的机器一切正常，
 * 只有已经玩过的人看不到新世界**。
 *
 * 修法是把"缺什么补什么"抽出来（`missingBuiltinIds`），
 * 并给它一份**独立的 id 清单**（`BUILTIN_WORLD_IDS`），
 * 这样启动时不必加载 2.5 MB 的世界书正文就能回答"缺不缺"。
 *
 * 代价是清单可能与世界卡脱节（加了卡却忘了加 id ⇒ 新卡依然不可见），
 * 所以第一条断言就是它们必须完全一致。
 */
describe('BUILTIN_WORLD_IDS 与 BUILTIN_WORLDS 的一致性', () => {
  it('★ id 清单与世界卡完全对得上（漏一个 ⇒ 老玩家永远看不到那张新卡）', () => {
    expect([...BUILTIN_WORLD_IDS].sort()).toEqual(BUILTIN_WORLDS.map(w => w.id).sort())
  })

  it('清单里没有重复 id', () => {
    expect(new Set(BUILTIN_WORLD_IDS).size).toBe(BUILTIN_WORLD_IDS.length)
  })

  it('★ 懒加载器覆盖了每一个 id（漏一个 ⇒ 那张卡永远加载不出来）', () => {
    expect([...BUILTIN_WORLD_LOADER_IDS]).toEqual([...BUILTIN_WORLD_IDS].sort())
  })
})

describe('loadBuiltinWorlds · 按需加载（首屏不背那 640 KB）', () => {
  it('只取请求的 id，未知 id 静默忽略', async () => {
    const got = await loadBuiltinWorlds(['builtin_deepcore', 'world_not_builtin'])
    expect(got.map(w => w.id)).toEqual(['builtin_deepcore'])
    expect(got[0].title).toBeTruthy()
  })

  it('★ 懒加载路径也要补上头像风格（与同步路径共用 worldAvatarStyle.ts）', async () => {
    const [w] = await loadBuiltinWorlds(['builtin_deepcore'])
    expect(w.avatarStyle).toBe('ink')
    expect(w.avatarTone).toBe('#4a5568')
  })

  it('空清单 ⇒ 一张都不加载（这是老玩家平时启动走的那条路）', async () => {
    expect(await loadBuiltinWorlds([])).toEqual([])
  })
})

describe('missingBuiltinIds · 决定启动时要不要动态加载世界书', () => {
  it('库是空的 ⇒ 全部缺（首次运行，照旧整批播种）', () => {
    expect(missingBuiltinIds([])).toEqual([...BUILTIN_WORLD_IDS])
  })

  it('★ 全都在库里 ⇒ 一张都不缺（这条决定老玩家平时启动不必下那 640 KB）', () => {
    expect(missingBuiltinIds([...BUILTIN_WORLD_IDS])).toEqual([])
  })

  it('只缺后加的那几张 ⇒ 只报它们', () => {
    const have = BUILTIN_WORLD_IDS.slice(0, 4)
    expect(missingBuiltinIds(have)).toEqual([...BUILTIN_WORLD_IDS.slice(4)])
  })

  it('★ 玩家删过的内置卡不再补回来（否则"删除"看起来完全没生效）', () => {
    const have = BUILTIN_WORLD_IDS.slice(0, 4)
    const removed = [BUILTIN_WORLD_IDS[4]]
    const missing = missingBuiltinIds(have, removed)
    expect(missing).not.toContain(BUILTIN_WORLD_IDS[4])
    expect(missing).toEqual([...BUILTIN_WORLD_IDS.slice(5)])
  })

  it('全被删过 ⇒ 什么都不补（库该是空的）', () => {
    expect(missingBuiltinIds([], [...BUILTIN_WORLD_IDS])).toEqual([])
  })

  it('库里有用户自己的卡也不影响判断', () => {
    expect(missingBuiltinIds(['world_abc', 'world_def', ...BUILTIN_WORLD_IDS])).toEqual([])
    expect(missingBuiltinIds(['world_abc'])).toEqual([...BUILTIN_WORLD_IDS])
  })
})
