import { describe, it, expect } from 'vitest'
import { buildNarrativeSystemPrompt, formatCharacter } from '@/constants/prompts'
import type { WorldCard, PlayerCard, CharacterCard } from '@/types/cards'

/**
 * 提示词里的**篇幅上限**（2026-11，玩家问「还有哪些地方在吃输入」）。
 *
 * 把最大的两张卡拆开量过之后，占大头的五块里有四块**原本一点上限都没有**：
 *
 * | 块 | 来源 | 实测（大晟 / 帷幕） |
 * |---|---|---|
 * | 文风要求 | `narrative.customStyle`（预设的 style 段也叠在这） | 2822 / 2743 字符 |
 * | 世界书索引 | `digestLore` 的 rest | 3392 / 3525 字符 |
 * | 人物档案 | `formatCharacter` × 人数（人数也没有上限） | 1744 / 1581 |
 * | 世界规则 | `world.rules` | 475 / 508 |
 *
 * 这些都**不该按"卡作者想写多少"来定价** —— 卡是外部输入，几千字的
 * `systemPrompt` 在 SillyTavern 那边很常见。所以各自给了上限。
 */

const player = { name: '测试者', gender: '男', age: '25' } as unknown as PlayerCard

function world(over: Partial<WorldCard> = {}): WorldCard {
  return {
    id: 'w', title: '测试世界', tagline: '', worldLore: '', rules: '',
    attributes: [], resources: [], backgrounds: [], attributePoints: 0,
    items: [], lores: [],
    story: {
      atmosphere: '', mainQuest: '', enableStages: false, stages: [],
      enableChoices: false, urgencyAfterTurns: 0, openerSlot: '', openingSeeds: {},
    },
    narrative: { pov: 'third', tense: 'past', replyLength: 1800, customStyle: '' },
    characters: [],
    enableMechanics: false,
    createdAt: 0, updatedAt: 0,
    ...over,
  } as WorldCard
}

function character(id: string, over: Partial<CharacterCard> = {}): CharacterCard {
  return {
    id, name: `角色${id}`, description: '描述', personality: '性格',
    scenario: '', messageExamples: '', systemPrompt: '', postHistoryInstructions: '',
    ...over,
  } as unknown as CharacterCard
}

describe('角色档案的篇幅上限（只挡病态数据）', () => {
  it('★ 病态超长的单个字段才截，并写明原文有多长', () => {
    const long = '设定'.repeat(5000)   // 10000 字
    const text = formatCharacter(character('a', { description: long }))
    expect(text).toContain('已按篇幅截断')
    expect(text).toContain('原文 10000 字')
  })

  it('★ 六个字段都写到 4000 时，整份档案仍封在 12000 字', () => {
    const long = '内容'.repeat(2000)   // 每个 4000 字
    const text = formatCharacter(character('a', {
      description: long, personality: long, scenario: long,
      messageExamples: long, systemPrompt: long, postHistoryInstructions: long,
    }))
    expect(text.length).toBeLessThanOrEqual(12500)
  })

  it('★ 正常写厚一点的角色卡（每字段两三千字）**一个字都不砍**', () => {
    const thick = '设'.repeat(2500)
    const text = formatCharacter(character('a', {
      description: thick, personality: thick, messageExamples: thick,
    }))
    expect(text).not.toContain('截断')
    expect(text).toContain('设'.repeat(2500))
  })

  it('正常长度的卡一个字都不砍', () => {
    const text = formatCharacter(character('a', { description: '一个沉默的守夜人。' }))
    expect(text).toContain('一个沉默的守夜人。')
    expect(text).not.toContain('截断')
  })
})

describe('在场人物数量上限', () => {
  it('★ 勾了 15 个人 → 列 12 位，其余用一句话交代', () => {
    const chars = Array.from({ length: 15 }, (_, i) => character(String(i)))
    const prompt = buildNarrativeSystemPrompt(world(), chars, player)
    expect(prompt).toContain('另有 3 位在场人物未列出')
    expect(prompt).toContain('### 角色11')
    expect(prompt).not.toContain('### 角色12')
  })
})

describe('其它外部字段的上限', () => {
  /*
    ⚠️ 这两个上限是**拼接体**的闸，不是世界卡自己的闸（2026-11 修过一次）。

    `world.rules` 在这里已经含「预设的 rules 段」，`customStyle` 更是叠了三层
    （卡自己的 + 预设的文风段 + 玩家现拨的文风选择）。所以闸必须开在
    "三层之和"之上 —— 否则被切掉的是**排在最后的那几条预设**，
    而玩家看到的现象是"预设好像没生效"（他原话：「输出格式直接不见了」）。
  */
  it('★ 文风要求的安全闸是 40000 字符（正常预设一条都不该掉）', () => {
    const prompt = buildNarrativeSystemPrompt(
      world({ narrative: { pov: 'third', tense: 'past', customStyle: '文'.repeat(120000) } }),
      [], player,
    )
    expect(prompt).toContain('已按篇幅截断')
    const block = prompt.slice(prompt.indexOf('### 本世界的文风要求'))
    expect(block.length).toBeLessThan(40500)
  })

  it('★ 世界规则的安全闸是 40000 字符（卡 + 预设合并后的合计）', () => {
    const prompt = buildNarrativeSystemPrompt(world({ rules: '规'.repeat(120000) }), [], player)
    const block = prompt.slice(prompt.indexOf('5. **世界规则'), prompt.indexOf('### 核心原则'))
    expect(block.length).toBeLessThan(40500)
    expect(block).toContain('已按篇幅截断')
  })

  it('正常体量的规则（一万字）**不该**出现截断提示', () => {
    const prompt = buildNarrativeSystemPrompt(world({ rules: '规'.repeat(10000) }), [], player)
    expect(prompt).not.toContain('已按篇幅截断')
  })

  it('★ 世界氛围的安全闸是 8000 字符；正常写的氛围一点不砍', () => {
    const w = world()
    ;(w.story as { atmosphere: string }).atmosphere = '雾'.repeat(6000)
    const prompt = buildNarrativeSystemPrompt(w, [], player)
    // 6000 字在闸下，原样保留
    expect(prompt).toContain('雾'.repeat(6000))
    expect(prompt).not.toContain('已按篇幅截断')

    const huge = world()
    ;(huge.story as { atmosphere: string }).atmosphere = '雾'.repeat(30000)
    const p2 = buildNarrativeSystemPrompt(huge, [], player)
    expect(p2).toContain('已按篇幅截断')
  })
})
