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
  renderPresetEntries, presetEntryStats, syncPresetSnapshot,
} from './narrativePreset'
import { EMPTY_STYLE_CHOICE, styleById, type StyleChoice } from '@/data/narrativeStyles'
import type { NarrativePreset, PresetEntry, WorldCard } from '@/types/cards'

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

/* ══════════════════════════════════════════════════════════════
   2026-11 第三十七轮：逐条勾选
   ══════════════════════════════════════════════════════════════ */

const entry = (
  id: string,
  kind: 'rules' | 'style' | 'other',
  content: string,
  patch: Partial<PresetEntry> = {},
): PresetEntry => ({ id, name: `条目${id}`, kind, content, enabled: true, ...patch })

/** 一份带逐条清单的预设 */
const presetWithEntries = (entries: PresetEntry[]): NarrativePreset => presetOf({
  entries,
  rules: '',
  style: '',
  lore: '',
})

describe('逐条勾选 · 注入只认勾着的', () => {
  const p = presetWithEntries([
    entry('r1', 'rules', '不许替玩家做决定'),
    entry('r2', 'rules', '正文里不要出现属性名', { enabled: false }),
    entry('s1', 'style', '比喻要克制'),
    entry('s2', 'style', '对白单独成段', { enabled: false }),
    entry('o1', 'other', '作者说明：禁止二创'),
  ])

  it('★ 关掉的那一条下一轮就不进提示词', () => {
    const out = withNarrativePreset(world, p)
    expect(out.rules).toContain('不许替玩家做决定')
    expect(out.rules).not.toContain('正文里不要出现属性名')
    expect(out.narrative.customStyle).toContain('比喻要克制')
    expect(out.narrative.customStyle).not.toContain('对白单独成段')
  })

  it('★ `other` 类勾着也不注入（它本来就不是给模型的）', () => {
    const out = withNarrativePreset(world, p)
    expect(out.rules).not.toContain('禁止二创')
    expect(out.narrative.customStyle).not.toContain('禁止二创')
  })

  it('★ 全勾时拼出来的，与旧的整块字符串**逐字相同**（格式没变）', () => {
    const on = presetWithEntries([
      entry('r1', 'rules', '甲'),
      entry('r2', 'rules', '乙'),
      entry('s1', 'style', '丙'),
    ])
    expect(renderPresetEntries(on, 'rules')).toBe('【条目r1】\n甲\n\n【条目r2】\n乙')
    expect(renderPresetEntries(on, 'style')).toBe('【条目s1】\n丙')
  })

  it('一条都没勾 ⇒ 只剩世界卡自己的那段（不该多出一个空标题）', () => {
    const off = presetWithEntries([entry('r1', 'rules', '甲', { enabled: false })])
    expect(withNarrativePreset(world, off)).toBe(world)
  })

  it('★ 注入顺序按 `order`，不按数组下标（2026-11 玩家报「顺序错乱」）', () => {
    // 故意把数组顺序和作者顺序反过来
    const p2 = presetWithEntries([
      entry('b', 'rules', '第二句', { order: 1 }),
      entry('a', 'rules', '第一句', { order: 0 }),
      entry('c', 'rules', '第三句', { order: 2 }),
    ])
    expect(renderPresetEntries(p2, 'rules')).toBe('【条目a】\n第一句\n\n【条目b】\n第二句\n\n【条目c】\n第三句')
  })

  it('没有 `order` 的旧数据按数组下标兜底（不至于乱掉）', () => {
    const p3 = presetWithEntries([
      entry('x', 'rules', '甲'),
      entry('y', 'rules', '乙'),
    ])
    expect(renderPresetEntries(p3, 'rules')).toBe('【条目x】\n甲\n\n【条目y】\n乙')
  })

  it('没有 entries 的旧预设仍然走整块字符串（向后兼容）', () => {
    const out = withNarrativePreset(world, presetOf())
    expect(out.rules).toContain('不许替玩家做决定')
  })
})

describe('逐条勾选 · 统计与快照', () => {
  const p = presetWithEntries([
    entry('r1', 'rules', '甲甲甲'),
    entry('r2', 'rules', '乙', { enabled: false }),
    entry('s1', 'style', '丙丙'),
    entry('o1', 'other', '丁'),
  ])

  it('presetEntryStats 分别报三类', () => {
    const s = presetEntryStats(p)
    expect(s.rules).toEqual({ on: 1, all: 2, chars: 3 })
    expect(s.style).toEqual({ on: 1, all: 1, chars: 2 })
    expect(s.other).toEqual({ on: 1, all: 1, chars: 1 })
  })

  it('★ syncPresetSnapshot 把三段快照与 counts 跟上勾选', () => {
    const next = syncPresetSnapshot(p)
    expect(next.rules).toBe('【条目r1】\n甲甲甲')
    expect(next.style).toBe('【条目s1】\n丙丙')
    expect(next.lore).toBe('【条目o1】\n丁')
    expect(next.counts.rules).toBe(1)
    expect(next.counts.style).toBe(1)
    expect(next.counts.total).toBe(3)
  })

  it('没有 entries 的原样返回（不误伤旧预设）', () => {
    const old = presetOf()
    expect(syncPresetSnapshot(old)).toBe(old)
  })

  it('★ presetHasContent：只勾着 other 类时算"没有可注入的内容"', () => {
    expect(presetHasContent(presetWithEntries([entry('o1', 'other', '说明')]))).toBe(false)
    expect(presetHasContent(presetWithEntries([entry('r1', 'rules', '甲')]))).toBe(true)
    expect(presetHasContent(presetWithEntries([entry('r1', 'rules', '  ')]))).toBe(false)
  })

  it('describeNarrativePreset 报的是**实际勾选**而不是导入时的数字', () => {
    const s = describeNarrativePreset(p)
    expect(s).toContain('3/4 条勾选')
    expect(s).toContain('每轮注入 5 字')
  })

  it('★ presetWarnings 只看勾着的条目（关掉了就别再吓唬玩家）', () => {
    const quiet = presetWithEntries([
      entry('s1', 'style', '正文底部输出 <SUOT> 行动选项 </SUOT>', { enabled: false }),
    ])
    expect(presetWarnings(quiet)).toEqual([])
    const loud = presetWithEntries([
      entry('s1', 'style', '正文底部输出 <SUOT> 行动选项 </SUOT>'),
    ])
    expect(presetWarnings(loud).join()).toContain('状态栏')
  })
})
