import { describe, it, expect } from 'vitest'
import { computeStats, startingItemsOf } from '@/utils/runRebuild'
import type { WorldCard } from '@/types/cards'

/**
 * 「重开本局」用的重算函数。
 *
 * 玩家报过三次「重开一局的选项怎么没了」。原因是入口挂在 turn 0 快照上，
 * 老存档没有那份快照 —— 而重开其实不需要它，配置全在 session 里。
 *
 * 这里钉的是**算法与选角页一致**：属性点 + 背景加成、资源初始值 + 加成并夹上限、
 * 开局物品按背景槽汇总。任何一条跑偏，重开出来的局都会和第一次不一样。
 */

function mkWorld(): WorldCard {
  return {
    id: 'w', title: '测试世界', description: '', avatarStyle: 'parchment',
    narrative: { pov: 'second', tense: 'past', tone: 'neutral', replyLength: 1800, opening: '' },
    attributes: [
      { id: 'force', name: '武力', description: '', initial: 0 },
      { id: 'wit', name: '机敏', description: '', initial: 0 },
    ],
    resources: [
      { id: 'hp', name: '气血', description: '', initial: 6, max: 10 },
    ],
    backgrounds: [
      {
        label: '出身',
        options: [
          { id: 'a', label: '镖师', description: '', attributeBonus: { force: 2 }, resourceBonus: { hp: 2 }, startingItems: ['sword'] },
          { id: 'b', label: '账房', description: '', attributeBonus: { wit: 2 }, startingItems: ['abacus'] },
          { id: 'c', label: '自填', description: '', custom: true },
        ],
      },
    ],
    items: [
      { id: 'sword', name: '单刀', description: '', tags: [] },
      { id: 'abacus', name: '算盘', description: '', tags: [] },
    ],
    characters: [],
    lores: [],
  } as unknown as WorldCard
}

describe('重开本局 · 从会话配置重算开局状态', () => {
  it('★ 属性 = 分配 + 背景加成', () => {
    const w = mkWorld()
    const r = computeStats(w, { force: 1, wit: 1 }, { 出身: 'a' }, {})
    expect(r.attributes).toEqual({ force: 3, wit: 1 })
  })

  it('★ 资源 = 初始值 + 背景加成，并夹在上限内', () => {
    const w = mkWorld()
    const r = computeStats(w, {}, { 出身: 'a' }, {})
    expect(r.resources.hp).toBe(8)
    // 再叠一层也超不过 10
    const capped = computeStats(w, {}, { 出身: 'a' }, {})
    expect(capped.resources.hp).toBeLessThanOrEqual(10)
  })

  it('★ 开场物品按背景槽汇总', () => {
    const w = mkWorld()
    expect(startingItemsOf(w, { 出身: 'a' }, {}).map(i => i.id)).toEqual(['sword'])
    expect(startingItemsOf(w, { 出身: 'b' }, {}).map(i => i.id)).toEqual(['abacus'])
  })

  it('没选背景 / 选了自定义项却没写字 → 只给初始值，不给加成', () => {
    const w = mkWorld()
    expect(computeStats(w, { force: 1, wit: 0 }, {}, {}).attributes).toEqual({ force: 1, wit: 0 })
    // 自定义项空文本 = 没选
    expect(computeStats(w, {}, { 出身: 'c' }, { 出身: '   ' }).resources.hp).toBe(6)
    expect(startingItemsOf(w, { 出身: 'c' }, {})).toEqual([])
  })
})
