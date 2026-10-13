import { describe, it, expect } from 'vitest'
import {
  attributeTier,
  buildAttributeBriefing,
  buildBackgroundBriefing,
  buildNarrativeSystemPrompt,
  buildOpeningInstruction,
  describeBackgroundChoices,
  resolveOpeningSeed,
} from '@/constants/prompts'
import type { CharacterCard, PlayerCard, WorldCard } from '@/types/cards'

/**
 * 开场指令的回归测试。
 *
 * ## 这段逻辑被玩家打回过**三次**，每一次的错法都不同，请全部记住
 *
 * 1. 「选角页挑了半天的背景，开场却一模一样。」
 *    → 根因：`buildOpeningInstruction` 压根没收到背景选择。
 * 2. 「我要的是同一个世界观里，各不相同的开场为各不相同的背景服务，
 *    而不是一样的开场因不一样的背景而略有改变。」
 *    → 根因：我只做了"同一场景 + 换视角"，官军商江湖全挤在同一间屋。
 * 3. 「背景槽位太详细、太固定了，连详细的背景都有就没有自设主角什么空间了
 *    （尤其是还**固定了背景与开场官职**）。我的自设主角是**刑部正四品**，
 *    开局却固定有俩**仓部**上司，这不是很影响代入感吗？」
 *    → 根因：我把处境写成了第一幕的**唯一依据**，还明令别的背景不许挪动它，
 *      于是背景槽位**顶掉了玩家自己写的主角设定**。优先级整个反了。
 *
 * 所以下面最要紧的三条是：
 *   · **主角自设设定优先于背景槽位**（不同自设 ⇒ 不同开场）
 *   · **处境素材只是素材**，不得成为"第一幕就发生在下面这个场面"的硬剧本
 *   · **不许替玩家认亲**（不得凭空安上司/同僚，不得给没写过的头衔）
 */

const mkWorld = (over: Partial<WorldCard> = {}): WorldCard => ({
  id: 'w1', title: '测试世界', tagline: '',
  worldLore: '', rules: '',
  attributes: [], resources: [],
  backgrounds: [
    {
      label: '开局处境',
      options: [
        { id: 'court', title: '在朝中当权', description: '要害位置上的人', startingItems: ['seal'] },
        { id: 'local', title: '在外任做官', description: '一方守土', startingItems: ['zhouyin'] },
        { id: 'jianghu', title: '在江湖上混', description: '没有官身', startingItems: ['saber'] },
      ],
    },
    {
      label: '官场立场',
      options: [
        { id: 'genghua', title: '更化派', description: '主张变法', startingItems: [] },
        { id: 'chizhong', title: '持重派', description: '主张守成', startingItems: [] },
      ],
    },
  ],
  attributePoints: 0,
  items: [
    { id: 'seal', name: '一枚印', description: '', tags: [] },
    { id: 'zhouyin', name: '州印', description: '', tags: [] },
    { id: 'saber', name: '一把刀', description: '', tags: [] },
  ],
  lores: [],
  story: {
    atmosphere: '（基调）汴梁的秋天来得比西京早。',
    mainQuest: '',
    enableStages: false, stages: [], enableChoices: true, urgencyAfterTurns: 0,
    openerSlot: '开局处境',
    openingSeeds: {
      court: '朝中的日常是案牍、奏对与同僚之间的分寸；消息在廊下比在公文里走得快。',
      local: '外任要面对的是一方的钱粮、讼案与胥吏的默契；上头的考课悬在头顶。',
      jianghu: '没有官身的人靠规矩和拳头吃饭；同行之间讲义气也讲价钱。',
    },
  },
  narrative: { pov: 'second', tense: 'present', replyLength: 500, customStyle: '' },
  characters: [], enableMechanics: true,
  avatarStyle: 'ink', avatarTone: '#000',
  createdAt: 0, updatedAt: 0, builtin: true,
  ...over,
})

const player = (over: Partial<PlayerCard> = {}): PlayerCard => ({
  name: '沈砚', gender: '男', age: '三十', appearance: '', personality: '', background: '', extra: '',
  ...over,
})
const noChars: CharacterCard[] = []

describe('开场指令 · 主角自设优先，背景槽位只是素材', () => {
  it('★ 主角自述背景必须出现在指令里，且标为最高优先级', () => {
    const out = buildOpeningInstruction(
      mkWorld(), player({ background: '刑部正四品，掌一司刑名' }), noChars, { 开局处境: 'court' },
    )
    expect(out).toContain('刑部正四品')
    expect(out).toContain('最高优先级')
  })

  it('★ 不同自设背景 ⇒ 不同开场指令（这才是玩家要的"自设空间"）', () => {
    const w = mkWorld()
    const a = buildOpeningInstruction(w, player({ background: '刑部正四品' }), noChars, { 开局处境: 'court' })
    const b = buildOpeningInstruction(w, player({ background: '工部营缮司主事' }), noChars, { 开局处境: 'court' })
    expect(a).not.toBe(b)
    expect(a).toContain('刑部正四品')
    expect(b).toContain('工部营缮司主事')
    expect(a).not.toContain('工部营缮司主事')
  })

  it('★ 处境素材不得被写成"第一幕就发生在这个场面"的硬剧本', () => {
    const out = buildOpeningInstruction(mkWorld(), player({ background: '刑部正四品' }), noChars, { 开局处境: 'court' })
    // 素材在，但明确标为附加参考 / 素材而非剧本
    expect(out).toContain('案牍')
    expect(out).toContain('附加参考')
    expect(out).toContain('这是素材，不是剧本')
    // 不能再出现旧版那种"以它为准 / 就发生在下面这个场面"的说法
    expect(out).not.toContain('第一幕就发生在下面这个场面')
    expect(out).not.toContain('请以它为准')
  })

  it('★ 与主角设定冲突时以主角设定为准（写进了指令）', () => {
    const out = buildOpeningInstruction(mkWorld(), player({ background: '刑部正四品' }), noChars, { 开局处境: 'court' })
    expect(out).toContain('一律以主角的设定为准')
  })

  it('★ 不许替玩家认亲：明确禁止凭空安上司/同僚与没写过的头衔', () => {
    const out = buildOpeningInstruction(mkWorld(), player({ background: '刑部正四品' }), noChars, { 开局处境: 'court' })
    expect(out).toContain('不要凭空给他安上司、下属、同僚或亲戚')
    expect(out).toContain('也不要给他加一个他没写过的上司')
  })

  it('主角没填自设背景时，说明处境可以更大程度充当依据', () => {
    const out = buildOpeningInstruction(mkWorld(), player(), noChars, { 开局处境: 'local' })
    expect(out).toContain('主角没有自述背景')
    expect(out).toContain('外任要面对')
  })

  it('没有素材时，退回世界基调，并要求只取氛围不照搬人事', () => {
    const base = mkWorld()
    const w = mkWorld({ story: { ...base.story, openingSeeds: {} } })
    const out = buildOpeningInstruction(w, player(), noChars, { 开局处境: 'court' })
    expect(out).toContain('汴梁的秋天')
    expect(out).toContain('不要照搬其中的具体人与事')
  })

  it('其他槽位只加质感，且不得改主角身份', () => {
    const out = buildOpeningInstruction(
      mkWorld(), player({ background: '刑部正四品' }), noChars, { 开局处境: 'court', 官场立场: 'genghua' },
    )
    expect(out).toContain('更化派')
    expect(out).toContain('不要因为它们去改主角的身份与职位')
  })

  it('在场角色被说明为"客观立场、不是你的谁"，且可以一个都不出场', () => {
    const chars = [{
      id: 'c1', name: '裴无咎', gender: '男', age: '五十', appearance: '', personality: '',
      relationship: '度支司郎中', description: '', presentAtStart: true,
    }] as unknown as CharacterCard[]
    const out = buildOpeningInstruction(mkWorld(), player({ background: '刑部正四品' }), chars, { 开局处境: 'court' })
    expect(out).toContain('裴无咎')
    expect(out).toContain('不是"你的谁"')
    expect(out).toContain('也可以一个人都不出场')
  })

  it('选了一个不存在的处境 id 不会造成异常', () => {
    const out = buildOpeningInstruction(mkWorld(), player(), noChars, { 开局处境: '不存在' })
    expect(out).toContain('汴梁的秋天')
  })

  it('resolveOpeningSeed 解析出槽位/选项/素材', () => {
    const r = resolveOpeningSeed(mkWorld(), { 开局处境: 'local' })
    expect(r).toMatchObject({ slot: '开局处境', id: 'local', title: '在外任做官' })
    expect(r?.seed).toContain('外任要面对')
    expect(resolveOpeningSeed(mkWorld(), {})).toBeNull()
  })

  it('describeBackgroundChoices 解析出分类/选项/说明/携带物', () => {
    const picked = describeBackgroundChoices(mkWorld(), { 开局处境: 'court', 官场立场: 'genghua' })
    expect(picked).toHaveLength(2)
    expect(picked[0]).toMatchObject({ label: '开局处境', id: 'court', title: '在朝中当权' })
    expect(picked[0].items).toEqual(['一枚印'])
  })
})

/**
 * 背景与属性的**每轮**注入（A2 / A3）。
 *
 * ## 玩家第二次打回时的原话
 *
 * > 「只有开局处境对剧情有影响（实际上，这是负面影响，因为开局处境被限定了
 * > 是非常影响自由度的，**我的想法是背景、出身、主角背景、属性全部对剧情有
 * > 直接的影响**），那些属性对游戏剧情的影响也几乎没有」
 *
 * 两条根因，都钉在这里：
 *
 *  1. 背景只喂给第一幕 —— `describeBackgroundChoices` 的**唯一**调用点是
 *     `buildOpeningInstruction`，第二幕起玩家挑的出身/立场再没进过提示词。
 *  2. 属性**从来没进过叙事 AI 的提示词** —— `buildNarrativeSystemPrompt` 的入参里
 *     压根没有 `aspects`，它只进数据 AI 当加减法用。
 *
 * 所以下面最要紧的是最后一条：**两段简报都要出现在 `buildNarrativeSystemPrompt`
 * 的产物里** —— 这才是"每一轮"与"只在开场"的分界线。
 */
describe('每轮注入 · 他的来路与立场', () => {
  it('包含槽位名、选项、说明与随身物', () => {
    const out = buildBackgroundBriefing(mkWorld(), { 开局处境: 'court', 官场立场: 'genghua' })
    expect(out).toContain('开局处境')
    expect(out).toContain('在朝中当权')
    expect(out).toContain('要害位置上的人')
    expect(out).toContain('一枚印')
    expect(out).toContain('官场立场')
    expect(out).toContain('更化派')
    // 它必须自称"每一轮都要用上"，而不是一份开场表单
    expect(out).toContain('每一轮')
  })

  it('没选任何背景 ⇒ 返回空串（不注入一个空区块）', () => {
    expect(buildBackgroundBriefing(mkWorld(), {})).toBe('')
    expect(buildBackgroundBriefing(mkWorld(), undefined)).toBe('')
  })

  it('★ 明确要求写出"不会的地方"，防止 AI 把主角写成全能', () => {
    const out = buildBackgroundBriefing(mkWorld(), { 开局处境: 'court' })
    expect(out).toContain('外行')
  })
})

describe('每轮注入 · 他的能力面板', () => {
  const attrWorld = (over: Partial<WorldCard> = {}) => mkWorld({
    attributes: [
      { id: 'wu', name: '武艺', description: '刀剑弓马' },
      { id: 'cha', name: '洞察', description: '从账册里看出不对' },
    ],
    ...over,
  })

  it('attributeTier 按 0~1 不会 / 2~3 够用 / 4+ 内行 分档', () => {
    expect(attributeTier(0)).toBe('none')
    expect(attributeTier(1)).toBe('none')
    expect(attributeTier(2)).toBe('ok')
    expect(attributeTier(3)).toBe('ok')
    expect(attributeTier(4)).toBe('expert')
    expect(attributeTier(9)).toBe('expert')
    // 脏数据不能把档位算崩（存档里出现过字符串与 NaN）
    expect(attributeTier(NaN)).toBe('none')
    expect(attributeTier(-3)).toBe('none')
  })

  it('带当前值、档位与属性说明，且明说"不要凭空给他"', () => {
    const out = buildAttributeBriefing(attrWorld(), { wu: 0, cha: 5 })
    expect(out).toContain('武艺')
    expect(out).toContain('不会')
    expect(out).toContain('洞察')
    expect(out).toContain('内行')
    expect(out).toContain('刀剑弓马')
    expect(out).toContain('一个字都不要提属性名与数字')
  })

  it('全为 0（还没分配点数）⇒ 不注入', () => {
    expect(buildAttributeBriefing(attrWorld(), { wu: 0, cha: 0 })).toBe('')
    expect(buildAttributeBriefing(attrWorld(), {})).toBe('')
    expect(buildAttributeBriefing(attrWorld(), undefined)).toBe('')
  })

  it('世界关了机制层 ⇒ 不注入（那时属性本来就不参与结算）', () => {
    expect(buildAttributeBriefing(attrWorld({ enableMechanics: false }), { wu: 6 })).toBe('')
  })

  it('★ 两段简报都进了叙事 system prompt —— 这才是"每一轮"与"只在开场"的分界', () => {
    const sys = buildNarrativeSystemPrompt(attrWorld(), noChars, player({ background: '刑部正四品' }), {
      backgroundChoices: { 开局处境: 'court' },
      aspects: { wu: 4, cha: 1 },
    })
    expect(sys).toContain('在朝中当权')
    expect(sys).toContain('武艺')
    expect(sys).toContain('内行')
    expect(sys).toContain('洞察')
    expect(sys).toContain('不会')
  })

  it('不传 briefing 时行为不变（兼容尚未改到的调用点）', () => {
    const sys = buildNarrativeSystemPrompt(mkWorld(), noChars, player())
    expect(sys).toContain('沈砚')
    expect(sys).not.toContain('每一轮都要用上')
  })
})
