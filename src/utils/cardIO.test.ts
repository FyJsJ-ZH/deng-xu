import { describe, it, expect } from 'vitest'
import { fromSillyTavern, toSillyTavern, createEmptyCharacter } from '@/utils/cardIO'
import type { CharacterCard } from '@/types/cards'

/**
 * 角色卡的导入/导出往返。
 *
 * ## 这里守的是「导出再导入还能原样用」
 *
 * 2026-11 做《殷玥》那张卡时发现：`look`（结构化立绘）**既不被导入也不被导出** ——
 * 它既不在 `KNOWN_KEYS` 里，也没有映射行。于是：
 *
 *  · 一张带精确立绘的卡，导入本项目后立绘退化成「中文描述 → 正则猜」；
 *  · 玩家在编辑器里改完再导出，关系/状态/地点/在场标记全没了。
 *
 * 而「把卡导出来改一改再导回去」恰恰是最常见的用法。
 * 所以下面这些字段必须双向存活，少一个都会在某天变成「我改的东西没了」。
 */
const look = {
  head: 'heads_human_female',
  hair: 'hair_long_straight',
  hairColor: 'white',
  torso: 'torso_armour_plate',
  legs: 'legs_skirts_slit',
  feet: 'feet_boots_basic',
  skin: 'light',
  eye: 'gray',
  note: '白发垂腰，银灰甲',
}

function mkCard(over: Partial<CharacterCard> = {}): CharacterCard {
  return createEmptyCharacter({
    name: '殷玥',
    description: '白发，极高，甲胄在身。',
    personality: '对主人软，对旁人硬。',
    relationship: '护卫',
    status: '健康',
    location: '随主人行止',
    look,
    present: true,
    tags: ['武侠', '护卫'],
    creator: '大肥鱼',
    characterVersion: 'v1.0',
    ...over,
  })
}

describe('fromSillyTavern：读得回来的字段', () => {
  it('★ 裸对象（本项目自有 JSON）能被识别并映射', () => {
    const card = fromSillyTavern({ name: '殷玥', description: '白发', relationship: '护卫' })
    expect(card.name).toBe('殷玥')
    expect(card.description).toBe('白发')
    expect(card.relationship).toBe('护卫')
  })

  it('★ ST V2 包装也能识别，关系/状态/地点/在场都在', () => {
    const card = fromSillyTavern({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '殷玥',
        description: '白发',
        relationship: '护卫',
        status: '健康',
        location: '渡口',
        present: false,
      },
    })
    expect(card.name).toBe('殷玥')
    expect(card.relationship).toBe('护卫')
    expect(card.status).toBe('健康')
    expect(card.location).toBe('渡口')
    expect(card.present).toBe(false)
  })

  it('look 能读进来（这是 2026-11 补的那一条）', () => {
    const card = fromSillyTavern({ name: '殷玥', description: '白发', look })
    expect(card.look).toEqual(look)
  })

  it('look 不是对象时直接忽略，不写进卡里', () => {
    const card = fromSillyTavern({ name: '殷玥', description: '白发', look: '白发女子' })
    expect(card.look).toBeUndefined()
  })

  it('没写 present 时按到场处理（第三方卡没有这个概念，到场更接近它的原意）', () => {
    expect(fromSillyTavern({ name: '无名', description: 'x' }).present).toBe(true)
  })
})

describe('toSillyTavern：导得出去的字段', () => {
  it('★ 项目扩展字段（关系/状态/地点/立绘/在场）都写进 data', () => {
    const out = toSillyTavern(mkCard()) as { data: Record<string, unknown> }
    expect(out.spec).toBe('chara_card_v2')
    expect(out.data.relationship).toBe('护卫')
    expect(out.data.status).toBe('健康')
    expect(out.data.location).toBe('随主人行止')
    expect(out.data.look).toEqual(look)
    expect(out.data.present).toBe(true)
  })

  it('空字段不硬塞进去（避免 data 里一堆空串）', () => {
    const card = mkCard({ relationship: '', status: '', location: undefined, look: undefined })
    const out = toSillyTavern(card) as { data: Record<string, unknown> }
    expect('relationship' in out.data).toBe(false)
    expect('status' in out.data).toBe(false)
    expect('location' in out.data).toBe(false)
    expect('look' in out.data).toBe(false)
  })

  it('present === false 也要写（默认值是 true，不写就变成"在场"了）', () => {
    const out = toSillyTavern(mkCard({ present: false })) as { data: Record<string, unknown> }
    expect(out.data.present).toBe(false)
  })
})

describe('往返：导出来再导回去，一个字都不许丢', () => {
  it('★ 主要字段全部存活', () => {
    const before = mkCard()
    const after = fromSillyTavern(JSON.parse(JSON.stringify(toSillyTavern(before))))

    expect(after.name).toBe(before.name)
    expect(after.description).toBe(before.description)
    expect(after.personality).toBe(before.personality)
    expect(after.relationship).toBe(before.relationship)
    expect(after.status).toBe(before.status)
    expect(after.location).toBe(before.location)
    expect(after.tags).toEqual(before.tags)
    expect(after.creator).toBe(before.creator)
    expect(after.characterVersion).toBe(before.characterVersion)
    expect(after.look).toEqual(before.look)
    expect(after.present).toBe(before.present)
  })

  it('未知字段仍然原样保留在 extensions.__unknown 里（这条是原有行为，别改坏）', () => {
    const card = fromSillyTavern({
      name: '无名',
      description: 'x',
      自定义字段: '要留着',
    })
    expect((card.extensions as Record<string, Record<string, unknown>>)?.__unknown?.自定义字段).toBe('要留着')
  })
})
