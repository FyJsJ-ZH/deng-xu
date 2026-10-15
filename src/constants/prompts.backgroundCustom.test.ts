import { describe, it, expect } from 'vitest'
import {
  buildBackgroundBriefing,
  buildOpeningInstruction,
  describeBackgroundChoices,
  resolveOpeningSeed,
} from '@/constants/prompts'
import type { PlayerCard, WorldCard } from '@/types/cards'

/**
 * 「我自己写」背景项的回归测试（2026-10 第九轮）。
 *
 * ## 它治的是什么
 *
 * 玩家原话：「背景槽位**依旧过于具体，限制住了剧情的开展**」。
 *
 * 根子不在选项写得宽不宽，而在**清单是封闭的** ——
 * 一个想演"在四号线沿线卖热食的寡妇"的玩家，面前只有
 * 「合闸派 / 归地派 / 配额派」这类预设身份，他只能挑一个最接近的，
 * 然后被 AI 照着那个身份写下去。他心里那个角色永远出不来。
 *
 * 所以每个槽位末尾配一个 `custom: true` 的项：选中后玩家自己写，
 * 那段文本**原样取代**该槽位的 title 与 description，走**完全同一条链路**进提示词。
 *
 * ## 这里钉死的不变量
 *
 * 1. 玩家写的那段话**必须**出现在每一轮的简报里（不是只在开场）。
 * 2. 它**必须**取代预设标题，而不是并排出现 —— 否则玩家会看到自己写的东西
 *    被一个预设压着，那道门等于白开。
 * 3. 选了自填却一个字没写时，**必须**安静地退回预设标题，
 *    不能在提示词里留一个空标题，更不能把整段简报弄没。
 * 4. `openerSlot` 上的自填项：那段话是**规定**（照办），不是"素材"（仅供参考）。
 */

const mkWorld = (over: Partial<WorldCard> = {}): WorldCard => ({
  id: 'w1', title: '测试世界', tagline: '',
  worldLore: '设定正文', rules: '规则正文',
  attributes: [{ id: 'wu', name: '武艺' }],
  resources: [{ id: 'money', name: '钱财', initial: 0 }],
  backgrounds: [],
  attributePoints: 6,
  items: [
    { id: 'seal', name: '官印', description: '', tags: [] },
    { id: 'saber', name: '佩刀', description: '', tags: [] },
    { id: 'ledger', name: '账本', description: '', tags: [] },
  ],
  lores: [],
  story: {
    atmosphere: '这是一个用来测试的世界的氛围参考。',
    mainQuest: '',
    enableStages: false,
    stages: [],
    enableChoices: true,
    urgencyAfterTurns: 5,
  },
  narrative: { pov: 'third', tense: 'present', replyLength: 800, customStyle: '' },
  characters: [],
  enableMechanics: true,
  createdAt: 0, updatedAt: 0,
  ...over,
})

const mkPlayer = (over: Partial<PlayerCard> = {}): PlayerCard => ({
  name: '沈砚', gender: '男', age: '', appearance: '', personality: '',
  background: '', extra: '',
  ...over,
})

/** 两个槽：`来路`（预设 + 自填）、`开局处境`（openerSlot，预设 + 自填） */
const bgWorld = (): WorldCard => mkWorld({
  backgrounds: [
    {
      label: '来路',
      options: [
        { id: 'bg_a', title: '在粉尘与高炉边长大', description: '认编号、认师傅、认班次' },
        { id: 'bg_b', title: '在案牍堆里长大', description: '懂流程、会写公文' },
        { id: 'bg_self', title: '我自己写', description: '不受上面任何一项限制。', custom: true },
      ],
    },
    {
      label: '开局处境',
      options: [
        { id: 'bg_scene_x', title: '在车间与管廊之间上工', description: '高温、粉尘' },
        { id: 'bg_scene_self', title: '我自己写', description: '不受上面任何一项限制。', custom: true },
      ],
    },
  ],
  story: {
    atmosphere: '这是一个用来测试的世界的氛围参考。',
    mainQuest: '',
    openerSlot: '开局处境',
    openingSeeds: {
      bg_scene_x: '日常在作业面、管廊与台前：高温、粉尘、机器的低频噪音，一班十二小时。',
    },
    enableStages: false,
    stages: [],
    enableChoices: true,
    urgencyAfterTurns: 5,
  },
})

describe('describeBackgroundChoices · 自填项', () => {
  it('★ 玩家写的话取代预设标题，而不是并排出现', () => {
    const picks = describeBackgroundChoices(
      bgWorld(),
      { 来路: 'bg_self' },
      { 来路: '在一间没人管的档案室里替人抄旧卷宗' },
    )
    const p = picks.find(x => x.label === '来路')!
    expect(p.custom).toBe(true)
    expect(p.title).toBe('在一间没人管的档案室里替人抄旧卷宗')
    // 预设的标题与说明都不该再出现 —— 否则玩家写的会被它压着
    expect(p.title).not.toBe('我自己写')
    expect(p.description).toBe('')
  })

  it('★ 选了自填却一个字没写 ⇒ 当作没选这个槽位', () => {
    /*
      退回预设标题（"我自己写"）看着更"容错"，其实更糟：
      提示词里会出现 `- **来路**：我自己写`，AI 读到的是
      "他自己写的是『我自己写』"—— 既没有信息又让它困惑。
      少一个槽位比多一句废话强。
    */
    const picks = describeBackgroundChoices(bgWorld(), { 来路: 'bg_self', 开局处境: 'bg_scene_x' }, {})
    expect(picks.find(x => x.label === '来路')).toBeUndefined()
    // 但别的槽位不受影响
    expect(picks.find(x => x.label === '开局处境')?.title).toBe('在车间与管廊之间上工')
  })

  it('只有空白字符也算没写', () => {
    const picks = describeBackgroundChoices(bgWorld(), { 来路: 'bg_self' }, { 来路: '   \n  ' })
    expect(picks.find(x => x.label === '来路')).toBeUndefined()
  })

  it('预设项不受影响，custom 恒为 false', () => {
    const picks = describeBackgroundChoices(bgWorld(), { 来路: 'bg_a' }, { 来路: '不该被用上' })
    const p = picks.find(x => x.label === '来路')!
    expect(p.custom).toBe(false)
    expect(p.title).toBe('在粉尘与高炉边长大')
    expect(p.description).toContain('认编号')
  })

  it('不传 custom 参数时：预设项行为与从前完全一致（兼容旧调用点）', () => {
    const picks = describeBackgroundChoices(bgWorld(), { 来路: 'bg_a' })
    expect(picks.find(x => x.label === '来路')!.title).toBe('在粉尘与高炉边长大')
  })
})

describe('buildBackgroundBriefing · 自填项每轮都要进提示词', () => {
  it('★ 玩家写的原话出现在简报里，并标明是他自己写的', () => {
    const out = buildBackgroundBriefing(
      bgWorld(),
      { 来路: 'bg_self' },
      { 来路: '在四号线沿线卖热食，丈夫三年前死在轧机上' },
    )
    expect(out).toContain('在四号线沿线卖热食，丈夫三年前死在轧机上')
    expect(out).toContain('他自己写的')
    expect(out).toContain('来路')
  })

  it('★ 它同时带着"边界"那一节 —— 背景是起点不是枷锁', () => {
    /*
      这一节是这一轮针对"限制住了剧情的开展"直接加的：
      光让玩家写得自由没用，还得让 AI 知道**不许拿它当笼子**。
    */
    const out = buildBackgroundBriefing(bgWorld(), { 来路: 'bg_a' })
    expect(out).toContain('它的边界必须说清楚')
    expect(out).toContain('它不规定他能做什么')
    expect(out).toContain('它是起点，不是主题')
  })

  it('预设项不带"他自己写的"字样', () => {
    const out = buildBackgroundBriefing(bgWorld(), { 来路: 'bg_a' })
    expect(out).toContain('在粉尘与高炉边长大')
    expect(out).not.toContain('他自己写的')
  })

  it('一个都没选 ⇒ 不注入（空区块只浪费 token）', () => {
    expect(buildBackgroundBriefing(bgWorld(), {})).toBe('')
  })
})

describe('resolveOpeningSeed · 自填处境', () => {
  it('★ 玩家写的处境被当作 seed 交出去，并打上 custom 标记', () => {
    const seed = resolveOpeningSeed(
      bgWorld(),
      { 开局处境: 'bg_scene_self' },
      { 开局处境: '我在第 41 层的档案室整理旧卷宗，已经三个月没人来看过' },
    )
    expect(seed).not.toBeNull()
    expect(seed!.custom).toBe(true)
    expect(seed!.seed).toContain('第 41 层的档案室')
  })

  it('选了自填却没写 ⇒ 返回 null（退回世界氛围兜底，而不是空 seed）', () => {
    expect(resolveOpeningSeed(bgWorld(), { 开局处境: 'bg_scene_self' }, {})).toBeNull()
    expect(resolveOpeningSeed(bgWorld(), { 开局处境: 'bg_scene_self' }, { 开局处境: '  ' })).toBeNull()
  })

  it('预设项走原来的 openingSeeds，custom 恒为 false', () => {
    const seed = resolveOpeningSeed(bgWorld(), { 开局处境: 'bg_scene_x' }, {})
    expect(seed!.custom).toBe(false)
    expect(seed!.title).toBe('在车间与管廊之间上工')
    expect(seed!.seed).toContain('一班十二小时')
  })

  it('★ 自填项**不需要**在 openingSeeds 里写素材（那条路读不到）', () => {
    // 上面的用例已经证明了：就算 openingSeeds 里没有 bg_scene_self，也能拿到 seed。
    const w = bgWorld()
    expect(Object.keys(w.story.openingSeeds || {})).not.toContain('bg_scene_self')
  })
})

describe('buildOpeningInstruction · 自填处境是"照办"不是"参考"', () => {
  it('★ 自填处境走"照办"分支，明说这不是素材', () => {
    const out = buildOpeningInstruction(
      bgWorld(),
      mkPlayer(),
      [],
      { 开局处境: 'bg_scene_self' },
      { 开局处境: '我在第 41 层的档案室整理旧卷宗' },
    )
    expect(out).toContain('他自己写下的处境')
    expect(out).toContain('照办')
    expect(out).toContain('我在第 41 层的档案室整理旧卷宗')
    // 不许再对他念"这只是素材"
    expect(out).not.toContain('附加参考：这是素材，不是剧本')
  })

  it('★ 预设处境仍走原来的"素材不是剧本"分支', () => {
    const out = buildOpeningInstruction(bgWorld(), mkPlayer(), [], { 开局处境: 'bg_scene_x' })
    expect(out).toContain('附加参考：这是素材，不是剧本')
    expect(out).not.toContain('他自己写下的处境')
  })

  it('自填处境的四条硬限制都在（不许替换场合／照他写的人／简略则往具体补／不许认亲）', () => {
    const out = buildOpeningInstruction(
      bgWorld(), mkPlayer(), [],
      { 开局处境: 'bg_scene_self' },
      { 开局处境: '我姑母在西街开一间浆洗铺' },
    )
    expect(out).toContain('不要把它替换成别的场合')
    expect(out).toContain('照他写的来')
    expect(out).toContain('往具体里补')
    expect(out).toContain('不要替他认亲')
  })

  it('★ 主角自设设定的优先级仍然最高（这一条被打回过三次，不能被新功能挤掉）', () => {
    const out = buildOpeningInstruction(
      bgWorld(),
      mkPlayer({ background: '刑部正四品' }),
      [],
      { 开局处境: 'bg_scene_self' },
      { 开局处境: '我在码头上扛包' },
    )
    expect(out).toContain('刑部正四品')
    expect(out).toContain('最高优先级')
  })

  it('自填项与其它槽位可以同时在（一个自填处境 + 一个预设来路）', () => {
    const out = buildOpeningInstruction(
      bgWorld(), mkPlayer(), [],
      { 来路: 'bg_b', 开局处境: 'bg_scene_self' },
      { 开局处境: '我在档案室整理旧卷宗' },
    )
    expect(out).toContain('我在档案室整理旧卷宗')
    expect(out).toContain('在案牍堆里长大')
    expect(out).toContain('他带进第一幕的东西')
  })
})
