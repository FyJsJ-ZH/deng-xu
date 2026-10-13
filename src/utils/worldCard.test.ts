import { describe, it, expect } from 'vitest'
import { flattenOpeningSeeds, normalizeWorldCard } from '@/utils/worldCard'
import type { WorldCard } from '@/types/cards'

/**
 * 旧世界卡字段迁移的测试。
 *
 * 这个模块补的是一个**只写在注释里的机制**：`types/cards.ts` 一直声称
 * 「导入时 `normalizeWorldCard()` 会把它搬到 `atmosphere`」，但那个函数不存在。
 * 于是两件事在暗处发生：
 *   · 老卡的氛围文本留在废弃字段上 —— 引擎靠 `atmosphere || opening` 的兜底读得到，
 *     但编辑器读不到，玩家一改就把原文覆盖掉；
 *   · 两层嵌套的 `openingSeeds` 在新代码里取不到素材，**开场静默退回世界基调**。
 * 两者都是"不报错、只让内容悄悄失效"，所以每一条都要钉住。
 */

const mk = (over: Partial<WorldCard> = {}): WorldCard => ({
  id: 'w1', title: '测试世界', tagline: '', worldLore: '', rules: '',
  attributes: [], resources: [], backgrounds: [], attributePoints: 0,
  items: [], lores: [],
  story: {
    atmosphere: '', mainQuest: '',
    enableStages: false, stages: [], enableChoices: true, urgencyAfterTurns: 0,
  },
  narrative: { pov: 'second', tense: 'present', replyLength: 500, customStyle: '' },
  characters: [], enableMechanics: true,
  createdAt: 0, updatedAt: 0,
  ...over,
})

describe('flattenOpeningSeeds · 两层嵌套 → 扁平', () => {
  it('已经是扁平的保持原样', () => {
    expect(flattenOpeningSeeds({ a: '甲', b: '乙' })).toEqual({ a: '甲', b: '乙' })
  })

  it('★ 旧的两层结构（槽位 → 选项 id → 文本）会被展平', () => {
    // 旧结构长这样：外层键是槽位 label，内层才是「选项 id → 素材」
    const old = {
      开局处境: { kai_yamen: '衙门的日常是案牍与传唤。', kai_zhou: '外任的日常在公堂与田亩之间。' },
      官场立场: { genghua: '要核账、要清田。' },
    }
    expect(flattenOpeningSeeds(old)).toEqual({
      kai_yamen: '衙门的日常是案牍与传唤。',
      kai_zhou: '外任的日常在公堂与田亩之间。',
      genghua: '要核账、要清田。',
    })
  })

  it('新旧混在一起时两种都能收进来', () => {
    expect(flattenOpeningSeeds({ flat: '扁平的一条', 槽位: { nested: '嵌套的一条' } }))
      .toEqual({ flat: '扁平的一条', nested: '嵌套的一条' })
  })

  it('空白与非法输入不产生空条目', () => {
    expect(flattenOpeningSeeds({ a: '', b: '   ', c: null, d: 42 })).toEqual({})
    expect(flattenOpeningSeeds(null)).toEqual({})
    expect(flattenOpeningSeeds('不是对象')).toEqual({})
    expect(flattenOpeningSeeds(undefined)).toEqual({})
  })
})

describe('normalizeWorldCard · opening → atmosphere', () => {
  it('★ atmosphere 为空时，把旧的 opening 搬过来', () => {
    const card = mk()
    ;(card.story as any).opening = '汴梁的秋天来得比西京早。'
    const out = normalizeWorldCard(card)
    expect(out.story.atmosphere).toBe('汴梁的秋天来得比西京早。')
    // 搬完就清掉废弃字段，免得下一个读代码的人以为这里还有两条路径
    expect(out.story.opening).toBeUndefined()
  })

  it('★ atmosphere 已经有内容时**不覆盖**（新字段永远优先）', () => {
    const card = mk()
    card.story.atmosphere = '新的氛围文本'
    ;(card.story as any).opening = '旧的、应该被忽略的文本'
    const out = normalizeWorldCard(card)
    expect(out.story.atmosphere).toBe('新的氛围文本')
  })

  it('两个都空时保持空（不要凭空造内容）', () => {
    expect(normalizeWorldCard(mk()).story.atmosphere).toBe('')
  })

  it('openingSeeds 一并展平', () => {
    const card = mk()
    ;(card.story as any).openingSeeds = { 开局处境: { kai_yamen: '素材' } }
    expect(normalizeWorldCard(card).story.openingSeeds).toEqual({ kai_yamen: '素材' })
  })

  it('★ 幂等：对新卡再跑一次不改变任何东西', () => {
    const card = mk()
    card.story.atmosphere = '汴梁的秋天'
    card.story.openingSeeds = { a: '甲' }
    const once = normalizeWorldCard(card)
    const twice = normalizeWorldCard(once)
    expect(twice.story.atmosphere).toBe(once.story.atmosphere)
    expect(twice.story.openingSeeds).toEqual(once.story.openingSeeds)
  })

  it('不碰其它字段（世界卡正文一个字都不能丢）', () => {
    const card = mk({ worldLore: '正文明文', rules: '规则明文', title: '某世界' })
    const out = normalizeWorldCard(card)
    expect(out.worldLore).toBe('正文明文')
    expect(out.rules).toBe('规则明文')
    expect(out.title).toBe('某世界')
    expect(out.id).toBe('w1')
  })
})
