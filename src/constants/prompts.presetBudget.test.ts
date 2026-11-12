import { describe, it, expect } from 'vitest'
import { buildNarrativeSystemPrompt } from '@/constants/prompts'
import { withNarrativePreset } from '@/utils/narrativePreset'
import type { WorldCard, PlayerCard, NarrativePreset, PresetEntry } from '@/types/cards'

/**
 * 世界卡 + 叙事预设**合并之后**的上限（2026-11，玩家报「预设的输出格式不见了」）。
 *
 * ## 踩的坑
 *
 * 上一轮为了压输入体积，给 `world.rules` 与 `narrative.customStyle` 各加了
 * 3000 / 2400 字符的截断。但那时忘了：**这两段在进入提示词之前已经被拼过了** ——
 *
 *     withNarrativePreset() 把「预设的 rules 段（最多 4000）」接在世界卡自己的
 *     rules 后面，customStyle 同理。
 *
 * 于是 3000 这道闸实际砍的是"世界 + 预设"的合计：世界卡占几百字，
 * 预设那三四千字从中间被切掉，**排在后面的条目（输出格式、字数要求、
 * 收尾规矩）整条消失**，而玩家看到的现象是"预设好像没生效"。
 *
 * 这一组钉的是：预设的每一条都必须活到提示词里。
 */

const player = { name: '林晚', gender: '女', age: '24' } as unknown as PlayerCard

function world(over: Partial<WorldCard> = {}): WorldCard {
  return {
    id: 'w', title: '测试世界', tagline: '', worldLore: '', rules: '本作不写露骨细节。',
    attributes: [], resources: [], backgrounds: [], attributePoints: 0,
    items: [], lores: [],
    story: {
      atmosphere: '', mainQuest: '', enableStages: false, stages: [],
      enableChoices: false, urgencyAfterTurns: 0, openerSlot: '', openingSeeds: {},
    },
    narrative: { pov: 'third', tense: 'past', customStyle: '短句为主。' },
    characters: [],
    enableMechanics: false,
    createdAt: 0, updatedAt: 0,
    ...over,
  } as WorldCard
}

const entry = (id: string, name: string, content: string, kind: PresetEntry['kind']): PresetEntry => ({
  id, name, kind, content, enabled: true,
})

function preset(entries: PresetEntry[]): NarrativePreset {
  return {
    id: 'p1', name: '剑仙', source: '剑仙.json',
    rules: '', style: '', lore: '',
    entries,
    counts: { total: entries.length, rules: 0, style: 0, other: 0, dropped: [] },
    createdAt: 0, updatedAt: 0,
  }
}

describe('世界卡 + 预设合并后的篇幅上限', () => {
  it('★ 预设里排最后的那条 rules（输出格式）必须活下来', () => {
    // 造一份接近真实体量的预设：四条 rules，合计约 5000 字，最后一条是输出格式
    const entries = [
      entry('r1', '总控', '甲'.repeat(1500), 'rules'),
      entry('r2', '破甲', '乙'.repeat(1500), 'rules'),
      entry('r3', '字数要求', '丙'.repeat(900), 'rules'),
      entry('r4', '输出格式', '【输出格式】只写正文，不写任何解释与标题。', 'rules'),
    ]
    const merged = withNarrativePreset(world(), preset(entries))
    const sys = buildNarrativeSystemPrompt(merged, [], player, {})

    expect(sys).toContain('【输出格式】只写正文，不写任何解释与标题。')
    expect(sys).toContain('本作不写露骨细节。')   // 世界卡自己的规则也在
  })

  it('★ 预设里排最后的 style 条目也要活下来', () => {
    const entries = [
      entry('s1', '文风甲', '丁'.repeat(1800), 'style'),
      entry('s2', '文风乙', '戊'.repeat(1800), 'style'),
      entry('s3', '结尾规矩', '【结尾】停在动作上，不要升华。', 'style'),
    ]
    const merged = withNarrativePreset(world(), preset(entries))
    const sys = buildNarrativeSystemPrompt(merged, [], player, {})
    expect(sys).toContain('【结尾】停在动作上，不要升华。')
    expect(sys).toContain('短句为主。')
  })

  it('外部卡塞了极长的规则时仍然要被挡住（上限不是取消了，是抬到病态线）', () => {
    const huge = '规'.repeat(120000)
    const sys = buildNarrativeSystemPrompt(world({ rules: huge }), [], player, {})
    const block = sys.slice(sys.indexOf('5. **世界规则'), sys.indexOf('### 核心原则'))
    expect(block.length).toBeLessThan(40500)
    expect(block).toContain('已按篇幅截断')
  })

  it('★ 「完完整整生效」：一万多字的预设，每一条都得进提示词', () => {
    /*
      玩家原话：「我要预设完完整整的生效」。

      这条从**两端**钉：既要在 `withNarrativePreset` 的拼接里活下来，
      也要在提示词层的安全闸下活下来。任何一头按老预算切，
      最后一条都会消失 —— 而它往往正是「输出格式」。
    */
    const entries = Array.from({ length: 12 }, (_, i) => entry(
      `r${i}`, `第${i + 1}条`, `${'条'.repeat(1000)}-END${i + 1}-`, 'rules',
    ))
    entries.push(entry('last', '输出格式', '【输出格式】只写正文。-TAIL-', 'rules'))
    const merged = withNarrativePreset(world(), preset(entries))
    const sys = buildNarrativeSystemPrompt(merged, [], player, {})

    for (let i = 0; i < 12; i++) expect(sys, `第 ${i + 1} 条被切了`).toContain(`-END${i + 1}-`)
    expect(sys).toContain('-TAIL-')
    expect(sys).not.toContain('已按篇幅截断')
  })
})
