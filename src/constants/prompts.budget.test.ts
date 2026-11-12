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

describe('角色档案的篇幅上限', () => {
  it('★ 单个字段超长会被截断，并写明原文有多长', () => {
    const long = '设定'.repeat(2000)   // 4000 字
    const text = formatCharacter(character('a', { description: long }))
    expect(text.length).toBeLessThan(2000)
    expect(text).toContain('已按篇幅截断')
  })

  it('★ 六个字段都超长时，整份档案仍封在 1800 字', () => {
    const long = '内容'.repeat(1500)
    const text = formatCharacter(character('a', {
      description: long, personality: long, scenario: long,
      messageExamples: long, systemPrompt: long, postHistoryInstructions: long,
    }))
    expect(text.length).toBeLessThanOrEqual(1900)
  })

  it('正常长度的卡一个字都不砍', () => {
    const text = formatCharacter(character('a', { description: '一个沉默的守夜人。' }))
    expect(text).toContain('一个沉默的守夜人。')
    expect(text).not.toContain('截断')
  })
})

describe('在场人物数量上限', () => {
  it('★ 勾了 9 个人 → 只列 6 位，其余用一句话交代', () => {
    const chars = Array.from({ length: 9 }, (_, i) => character(String(i)))
    const prompt = buildNarrativeSystemPrompt(world(), chars, player)
    expect(prompt).toContain('另有 3 位在场人物未列出')
    // 第 7 位之后的详细档案不该出现
    expect(prompt).not.toContain('### 角色6')
  })
})

describe('其它外部字段的上限', () => {
  it('★ 文风要求封在 2400 字符（预设的 style 段也叠在这里）', () => {
    const prompt = buildNarrativeSystemPrompt(
      world({ narrative: { pov: 'third', tense: 'past', replyLength: 1800, customStyle: '文'.repeat(9000) } }),
      [], player,
    )
    expect(prompt).toContain('已按篇幅截断')
    const block = prompt.slice(prompt.indexOf('### 本世界的文风要求'))
    expect(block.length).toBeLessThan(2600)
  })

  it('★ 世界规则封在 3000 字符', () => {
    const prompt = buildNarrativeSystemPrompt(world({ rules: '规'.repeat(9000) }), [], player)
    const block = prompt.slice(prompt.indexOf('5. **世界规则'), prompt.indexOf('### 核心原则'))
    expect(block.length).toBeLessThan(3300)
    expect(block).toContain('已按篇幅截断')
  })

  it('★ 世界氛围封在 1500 字符', () => {
    const w = world()
    ;(w.story as { atmosphere: string }).atmosphere = '雾'.repeat(6000)
    const prompt = buildNarrativeSystemPrompt(w, [], player)
    const start = prompt.indexOf('### 世界观设定')
    const end = prompt.indexOf('2. **人物设定')
    expect(prompt.slice(start, end).length).toBeLessThan(1800)
  })
})
