/**
 * 叙事预设叠加到世界卡上。
 *
 * 这一层的职责只有一句话：**别把世界卡作者定的东西冲掉**。
 * 玩家下载的预设往往来自完全不同的题材（轻小说综漫流、西式文学…），
 * 而世界卡可能是《极乐》那种明确「不写露骨细节」的卡。
 * 两份要求撞在一起时，模型需要一句明确的裁决，而不是自己去猜。
 */
import { describe, it, expect } from 'vitest'
import {
  withNarrativePreset, presetHasContent, describeNarrativePreset, presetWarnings,
  renderStyleChoice, styleConflicts,
} from './narrativePreset'
import { EMPTY_STYLE_CHOICE, styleById, type StyleChoice } from '@/data/narrativeStyles'
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

/* ══════════════════════════════════════════════════════════════
   2026-11 第三十轮：文风做成可切换的开关
   ══════════════════════════════════════════════════════════════ */

const choice = (patch: Partial<StyleChoice> = {}): StyleChoice => ({ ...EMPTY_STYLE_CHOICE, ...patch })

describe('renderStyleChoice（把选中的文风拼成正文）', () => {
  it('什么都没选时是空串（不该往提示词里塞一个空标题）', () => {
    expect(renderStyleChoice(EMPTY_STYLE_CHOICE)).toBe('')
    expect(renderStyleChoice(null)).toBe('')
  })

  it('★ 核心文风：单选，选一条就只有那一条', () => {
    const a = renderStyleChoice(choice({ core: 'plain-web' }))
    expect(a).toContain('简练流畅')
    expect(a).not.toContain('大量冗长描写')
    const b = renderStyleChoice(choice({ core: 'ultra-delicate' }))
    expect(b).toContain('大量冗长描写')
    expect(b).not.toContain('简练流畅')
  })

  it('附加 / 基础 / 纠偏是多选，可以一起上', () => {
    const text = renderStyleChoice(choice({
      core: 'plain-web',
      extra: ['western'],
      base: ['base-baimiao'],
      polish: ['polish-anti-sublime'],
    }))
    expect(text).toContain('简练流畅')       // 核心
    expect(text).toContain('翻译腔')         // 附加
    expect(text).toContain('白描')           // 基础
    expect(text).toContain('情感升华')       // 纠偏
  })

  it('★ 顺序是 核心 → 附加 → 基础 → 纠偏（纠偏最该被记住，放最后）', () => {
    const text = renderStyleChoice(choice({
      core: 'plain-web',
      extra: ['western'],
      base: ['base-baimiao'],
      polish: ['polish-anti-sublime'],
    }))
    expect(text.indexOf('简练流畅')).toBeLessThan(text.indexOf('翻译腔'))
    expect(text.indexOf('翻译腔')).toBeLessThan(text.indexOf('白描'))
    expect(text.indexOf('白描')).toBeLessThan(text.indexOf('情感升华'))
  })

  it('存档里混进不认识的 id 时，静默跳过而不是拼出 "undefined"', () => {
    const text = renderStyleChoice(choice({ core: 'not-a-real-style' }))
    expect(text).toBe('')
  })
})

describe('styleConflicts（真冲突要说出来）', () => {
  it('★ 西式文学 vs 基础文风：一个要翻译腔，一个明令杜绝欧化句式', () => {
    const c = styleConflicts(choice({ extra: ['western'], base: ['base-prose'] }))
    expect(c.length).toBe(1)
    expect(c[0].a + c[0].b).toContain('西式文学')
    expect(c[0].a + c[0].b).toContain('基础文风')
  })

  it('只开一条时不报冲突', () => {
    expect(styleConflicts(choice({ extra: ['western'] }))).toEqual([])
    expect(styleConflicts(EMPTY_STYLE_CHOICE)).toEqual([])
  })

  it('超细腻与简练网文属于"选一个"而不是"禁止同开" —— 核心本来就单选', () => {
    // 核心只能存一个 id，所以这条冲突在 UI 层就不可达
    expect(styleConflicts(choice({ core: 'ultra-delicate' }))).toEqual([])
  })
})

describe('withNarrativePreset 三层（世界卡 → 预设 → 文风选择）', () => {
  it('★ 只选文风、不启用预设时也生效', () => {
    const out = withNarrativePreset(world, null, choice({ core: 'plain-web' }))
    expect(out.narrative.customStyle).toContain('简练流畅')
    expect(out.narrative.customStyle).toContain('短句为主')   // 世界卡自己那段还在
  })

  it('★ 三层都在时，文风选择排在最后（玩家刚拨的那一下最强）', () => {
    const out = withNarrativePreset(world, presetOf({ style: '比喻要克制。' }), choice({ core: 'plain-web' }))
    const s = out.narrative.customStyle
    expect(s.indexOf('短句为主')).toBeLessThan(s.indexOf('比喻要克制'))
    expect(s.indexOf('比喻要克制')).toBeLessThan(s.indexOf('简练流畅'))
  })

  it('世界卡原有的规则在预设之前（冲突时以世界为准）', () => {
    const out = withNarrativePreset(world, presetOf(), choice({ core: 'plain-web' }))
    expect(out.rules.indexOf('本作不写露骨细节')).toBeLessThan(out.rules.indexOf('不许替玩家做决定'))
  })

  it('文风选择**不进** rules（它管笔法，不管世界法则）', () => {
    const out = withNarrativePreset(world, null, choice({ polish: ['polish-anti-sublime'] }))
    expect(out.rules).toBe(world.rules)
    expect(out.narrative.customStyle).toContain('情感升华')
  })

  it('三层全空时返回同一个引用', () => {
    expect(withNarrativePreset(world, null, EMPTY_STYLE_CHOICE)).toBe(world)
  })
})

describe('内置文风库本身', () => {
  it('每条都有正文与一句"强项"（选了才知道自己在选什么）', () => {
    for (const id of ['plain-web', 'ultra-delicate', 'immersive', 'western', 'base-baimiao', 'polish-dialogue']) {
      const s = styleById(id)!
      expect(s, id).toBeTruthy()
      expect(s.text.length, id).toBeGreaterThan(20)
      expect(s.note.length, id).toBeGreaterThan(5)
    }
  })

  it('不含 ST 宏与未替换的占位（灯叙不替换这些，会原样发出去）', () => {
    for (const id of ['plain-web', 'base-prose', 'base-baimiao', 'polish-anti-omniscient']) {
      const s = styleById(id)!
      expect(s.text, id).not.toContain('{{')
      expect(s.text, id).not.toContain('<user>')
    }
  })
})
