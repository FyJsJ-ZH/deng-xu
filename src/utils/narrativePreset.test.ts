/**
 * 叙事预设叠加到世界卡上。
 *
 * 这一层的职责只有一句话：**别把世界卡作者定的东西冲掉**。
 * 玩家下载的预设往往来自完全不同的题材（轻小说综漫流、西式文学…），
 * 而世界卡可能是《极乐》那种明确「不写露骨细节」的卡。
 * 两份要求撞在一起时，模型需要一句明确的裁决，而不是自己去猜。
 */
import { describe, it, expect } from 'vitest'
import { withNarrativePreset, presetHasContent, describeNarrativePreset, presetWarnings } from './narrativePreset'
import type { NarrativePreset, WorldCard } from '@/types/cards'

const world = {
  id: 'w1',
  title: '测试世界',
  tagline: '',
  worldLore: '',
  rules: '本作不写露骨细节。',
  attributes: [],
  resources: [],
  backgrounds: [],
  attributePoints: 0,
  items: [],
  lores: [],
  story: {
    atmosphere: '',
    mainQuest: '',
    enableStages: false,
    stages: [],
    enableChoices: true,
    urgencyAfterTurns: 0,
  },
  narrative: { pov: 'third' as const, tense: 'past' as const, replyLength: 1800, customStyle: '短句为主。' },
  characters: [],
  enableMechanics: false,
  createdAt: 0,
  updatedAt: 0,
} satisfies WorldCard

const presetOf = (patch: Partial<NarrativePreset> = {}): NarrativePreset => ({
  id: 'p1',
  name: '夏瑾 天琴座',
  source: '夏瑾.json',
  rules: '不许替玩家做决定。',
  style: '比喻要克制。',
  lore: '作者说明：禁止二创。',
  counts: { total: 3, rules: 1, style: 1, other: 1, dropped: [] },
  createdAt: 0,
  updatedAt: 0,
  ...patch,
})

describe('withNarrativePreset', () => {
  it('没有预设时返回**同一个引用**（渲染路径上不新建对象）', () => {
    expect(withNarrativePreset(world, null)).toBe(world)
    expect(withNarrativePreset(world, undefined)).toBe(world)
  })

  it('★ 两段都拼上去，且世界原有的规则一个字不丢', () => {
    const out = withNarrativePreset(world, presetOf())
    expect(out.rules).toContain('本作不写露骨细节')
    expect(out.rules).toContain('不许替玩家做决定')
    expect(out.narrative.customStyle).toContain('短句为主')
    expect(out.narrative.customStyle).toContain('比喻要克制')
  })

  it('★ 世界规则在前、预设在后，并写明冲突时以世界为准', () => {
    const out = withNarrativePreset(world, presetOf())
    expect(out.rules.indexOf('本作不写露骨细节')).toBeLessThan(out.rules.indexOf('不许替玩家做决定'))
    expect(out.narrative.customStyle).toContain('以世界为准')
  })

  it('不修改原对象（世界卡在库里要原样不动）', () => {
    const before = JSON.stringify(world)
    withNarrativePreset(world, presetOf())
    expect(JSON.stringify(world)).toBe(before)
  })

  it('只有文风没有规则时也能叠加（不至于整份预设失效）', () => {
    const out = withNarrativePreset(world, presetOf({ rules: '' }))
    expect(out.rules).toBe(world.rules)
    expect(out.narrative.customStyle).toContain('比喻要克制')
  })

  it('两段都空 → 原样返回（"已启用"不能是假的）', () => {
    expect(withNarrativePreset(world, presetOf({ rules: '', style: '' }))).toBe(world)
  })

  it('超长内容被截断（每轮全量注入，不能无限膨胀）', () => {
    const out = withNarrativePreset(world, presetOf({ rules: '规'.repeat(9000) }))
    expect(out.rules.length).toBeLessThan(6000)
  })

  it('世界自己没规则时，预设段不会以空行开头', () => {
    const bare = { ...world, rules: '' }
    const out = withNarrativePreset(bare, presetOf())
    expect(out.rules.startsWith('###')).toBe(true)
  })
})

describe('presetHasContent', () => {
  it('空预设不算有内容', () => {
    expect(presetHasContent(null)).toBe(false)
    expect(presetHasContent(presetOf({ rules: '', style: '' }))).toBe(false)
    expect(presetHasContent(presetOf())).toBe(true)
  })
})

describe('describeNarrativePreset', () => {
  it('报条目数与两段字数', () => {
    const s = describeNarrativePreset(presetOf())
    expect(s).toContain('3 条启用条目')
    expect(s).toContain('规则')
    expect(s).toContain('文风')
  })

  it('有超预算条目时如实写出来', () => {
    const s = describeNarrativePreset(presetOf({
      counts: { total: 4, rules: 1, style: 1, other: 1, dropped: ['📙光速模式'] },
    }))
    expect(s).toContain('超预算 1 条')
  })
})

describe('presetWarnings（会跟本作打架的东西要提前说）', () => {
  it('★ 思维链前缀：ST 会让模型输出 <think>，本作不会摘掉，会漏进正文', () => {
    const w = presetWarnings(presetOf({ rules: '你的内部思考必须以 <think> 开始' }))
    expect(w.join()).toContain('思维链')
  })

  it('状态栏 / 行动选项：本作界面已经有一套', () => {
    const w = presetWarnings(presetOf({ style: '正文底部输出 <SUOT> 行动选项 </SUOT>' }))
    expect(w.join()).toContain('状态栏')
  })

  it('未替换的 ST 宏', () => {
    const w = presetWarnings(presetOf({ style: '描写 {{user}} 的动作' }))
    expect(w.join()).toContain('{{user}}')
  })

  it('干净的预设不报任何警告', () => {
    expect(presetWarnings(presetOf())).toEqual([])
  })
})
