import { describe, it, expect } from 'vitest'
import { buildNarrativeSystemPrompt } from '@/constants/prompts'
import { BUILTIN_WORLDS } from '@/data/builtinWorlds'
import { DEFAULT_REPLY_LENGTH } from '@/types/cards'
import type { PlayerCard, WorldCard } from '@/types/cards'

/**
 * 叙事提示词的**结构契约**。
 *
 * ## 这个文件的前身是 `prompts.length.test.ts`（460 行）
 *
 * 它当时测的是「篇幅与信息投放」那一大节：一场戏要有起承转合、场景氛围人不许缺席、
 * 线索不许当填充物、世情要能看见不要能背、NPC 不是围着主角转的……十八条。
 *
 * 2026-11 玩家说：「就照着原作改，原作的提示词除了必须改的部分以外原样照搬不要乱加东西。」
 * 于是那一整节（约 2000 字）连同 `buildLengthSection` 一起删掉了：
 * 原作没有「篇幅与信息投放」，它用 1601 个字 + 场景块里的 `[KEY ACTIONS]` 就解决了。
 *
 * 所以这里改测另外两件事：
 *
 *  1. **原作的骨架还在不在** —— 逐条钉住那些必须逐字保留的段落。
 *     以后谁想"优化"掉「物理事实优先」或「禁止直接提及性相名称」，这里会红。
 *  2. **我们加过的东西不许悄悄长回来** —— 冰山契约、在场的人不是道具、
 *     这一场是主角的场、内行/够用/不会……每一条都曾把提示词撑到 8200 字，
 *     而字数的代价是氛围被稀释。这里用反向断言看着它们。
 */

const player = (over: Partial<PlayerCard> = {}): PlayerCard => ({
  name: '沈砚', gender: '男', age: '三十',
  appearance: '左眉上有道旧疤', personality: '话少', background: '刑部正四品', extra: '',
  ...over,
})

const mkWorld = (over: Partial<WorldCard> = {}): WorldCard => ({
  id: 'w1', title: '测试世界', tagline: '',
  worldLore: '这是一座靠海的小镇。', rules: '',
  attributes: [], resources: [],
  backgrounds: [],
  attributePoints: 0,
  items: [],
  lores: [],
  story: {
    atmosphere: '（基调）', mainQuest: '',
    enableStages: false, stages: [], enableChoices: true, urgencyAfterTurns: 0,
    openerSlot: '', openingSeeds: {},
  },
  narrative: { pov: 'third', tense: 'present', replyLength: 1800, customStyle: '' },
  characters: [], enableMechanics: false,
  avatarStyle: 'ink', avatarTone: '#000',
  createdAt: 0, updatedAt: 0, builtin: true,
  ...over,
})

const promptOf = (world: WorldCard, chars: Parameters<typeof buildNarrativeSystemPrompt>[1] = [], briefing: Parameters<typeof buildNarrativeSystemPrompt>[3] = {}) =>
  buildNarrativeSystemPrompt(world, chars, player(), briefing)

describe('照搬原作 · 那些必须逐字保留的段落', () => {
  const sys = promptOf(mkWorld())

  it('★ 开场三行是原作的（纯叙事生成器 / 不关心数值 / 天气工厂）', () => {
    expect(sys).toContain('由“天气工厂”风格驱动的**纯叙事生成器**')
    expect(sys).toContain('运行文字冒险游戏《测试世界》')
    expect(sys).toContain('你**完全不需要**关心游戏的数值、状态或逻辑判断')
  })

  it('★ 世界观设定的四条骨架（世界 / 人物 / 关系 / 知识）', () => {
    expect(sys).toContain('### 世界观设定 (World Setting)')
    for (const k of ['人物设定 (Character Profile)', '人物关系 (Relationships)', '知识系统 (Knowledge System)']) {
      expect(sys, k).toContain(k)
    }
    // 知识系统里那条「阅读风险要写成微型剧情，不能只扣数值」
    expect(sys).toContain('必须触发具体的叙事性负面事件')
    expect(sys).toContain('而不仅仅是一个结果')
  })

  it('★ 核心原则：清晰第一，风格第二（原文一字不改）', () => {
    expect(sys).toContain('### 核心原则：清晰第一，风格第二')
    expect(sys).toContain('**你的首要任务是讲一个好懂的故事。**')
    expect(sys).toContain('而不是在于让人读不懂的病句或过度堆砌的辞藻')
  })

  it('★ 动态指令优先级：三档，且靠性相决定"改表现不改文风"', () => {
    expect(sys).toContain('### 动态指令优先级')
    expect(sys).toContain('**可读性 (Readability)**')
    expect(sys).toContain('**章节指南 (Chapter Guide)**')
    expect(sys).toContain('**不要改变叙事风格**')
    expect(sys).toContain('**改变主角表现**')
  })

  it('★ 写作协议四条 + 每类的错误/正确对照', () => {
    expect(sys).toContain('### 写作协议 (Writing Protocol)')
    expect(sys).toContain('**物理事实优先 (Physics First)**')
    expect(sys).toContain('**节奏控制 (Pacing)**')
    expect(sys).toContain('**感官细节 (Sensory Details)**')

    // 禁止直接提性相名，而且给了正反对照 —— 这是原作最有效的一条
    expect(sys).toContain('**禁止直接提及性相名称**')
    expect(sys).toContain('*错误*：“你感受到了灯相的理性。”')
    expect(sys).toContain('*正确*：“冰冷的逻辑如手术刀般剖开了眼前的谎言')

    // 物理事实优先的对照
    expect(sys).toContain('*错误*：“光芒吞噬了理智。”')
    expect(sys).toContain('*正确*：“刺眼的红光充满了房间，你不得不眯起眼睛。”')

    // 纯叙事的正反对照（不许写 funds -1 / sanity -1）
    expect(sys).toContain('*错误*：“你买下了这本书（funds -1）')
    expect(sys).toContain('你把最后一枚银币拍在柜台上')
  })

  it('★ 剧情控制：严禁快进那一段（原文）', () => {
    expect(sys).toContain('### 剧情控制')
    expect(sys).toContain('**严禁跳过**')
    expect(sys).toContain('如果 Context 描写的是“在下水道发现尸体”')
    expect(sys).toContain('**绝对不能**直接写“你回家后...”')
    expect(sys).toContain('**保持当下**')
    expect(sys).toContain('**忽略数据指令**')
  })

  it('★ 输出格式：只要纯文本，且给出这一段的篇幅', () => {
    expect(sys).toContain('仅输出纯文本剧情。')
    expect(sys).toContain('不要输出任何 JSON。')
    expect(sys).toContain('不要输出任何元数据。')
    expect(sys).toContain('约 1800 字')
  })

  it('人称与时态跟着世界卡走（原作写死第二人称，我们的界面可选）', () => {
    expect(sys).toContain('**第三人称**')
    expect(promptOf(mkWorld({ narrative: { pov: 'second', tense: 'past', replyLength: 800, customStyle: '' } })))
      .toContain('**第二人称**')
  })
})

describe('性相表 · 原作 PRINCIPLE_STYLES 的三栏', () => {
  const world = (over: Partial<WorldCard> = {}) => mkWorld({
    enableMechanics: true,
    attributes: [
      {
        id: 'lantern', name: '灯', description: '理智，光明',
        traits: ['理性', '残酷', '揭示'],
        reactions: ['倾向于冷静分析而非情感流露', '面对恐怖时会试图寻找逻辑而非惊慌'],
        behaviors: ['用冷漠的目光审视', '强迫自己直视恐惧'],
      },
      {
        id: 'edge', name: '刃', description: '斗争，征服',
        traits: ['斗争', '征服'],
        reactions: ['时刻保持警惕，评估威胁'],
        behaviors: ['冷笑'],
      },
    ],
    ...over,
  })

  it('★ 每一相都在，且带 id（省掉模型自己把中文名翻成 id 的一步）', () => {
    const sys = promptOf(world())
    expect(sys).toContain('### 灯（lantern）')
    expect(sys).toContain('### 刃（edge）')
    expect(sys).toContain('## 性相（PRINCIPLE_STYLES）')
  })

  it('★ 三栏齐全：关键词 / 人物反应 / 典型行为', () => {
    const sys = promptOf(world())
    expect(sys).toContain('- **关键词**: 理性、残酷、揭示。')
    expect(sys).toContain('    - **人物反应**: 倾向于冷静分析而非情感流露；面对恐怖时会试图寻找逻辑而非惊慌。')
    expect(sys).toContain('    - **典型行为**: "用冷漠的目光审视"、"强迫自己直视恐惧"。')
  })

  it('旧卡没有这三栏时用 description 兜底，不留空相', () => {
    const sys = promptOf(world({
      attributes: [{ id: 'wu', name: '武艺', description: '刀剑弓马' }],
    }))
    expect(sys).toContain('### 武艺（wu）')
    expect(sys).toContain('- **关键词**: 刀剑弓马。')
  })

  it('关了机制层 ⇒ 不给性相表', () => {
    expect(promptOf(world({ enableMechanics: false }))).not.toContain('PRINCIPLE_STYLES')
  })

  it('★ 当前性相的数值念成中文名（最高的一相单独点出来）', () => {
    const sys = promptOf(world(), [], { aspects: { lantern: 2, edge: 5 } })
    expect(sys).toContain('### 他此刻的性相')
    expect(sys).toContain('刃 5、灯 2')
    expect(sys).toContain('最高的是「刃」')
    // 性相不是技能，不做检定 —— 这是它和「内行/不会」那套能力面板的分界线
    expect(sys).toContain('性相不是技能，不做能力检定')
  })

  it('全 0 ⇒ 不念数值（那时玩家还没分配点数）', () => {
    expect(promptOf(world(), [], { aspects: { lantern: 0, edge: 0 } })).not.toContain('### 他此刻的性相')
  })
})

describe('人物与场景 · 该进去的东西进去了', () => {
  it('主角自设的每一项都进「人物设定」', () => {
    const sys = promptOf(mkWorld())
    expect(sys).toContain('- **姓名**: 沈砚')
    expect(sys).toContain('- **外貌**: 左眉上有道旧疤')
    expect(sys).toContain('- **自述背景**: 刑部正四品')
    expect(sys).toContain('请在叙事中自然地体现这些特征')
  })

  it('在场角色进「人物关系」，并说明他们不是围着主角转的道具', () => {
    const chars = [{
      id: 'c1', name: '裴无咎', description: '度支司郎中，袖口磨得发亮',
      personality: '惜字如金', scenario: '', firstMessage: '', messageExamples: '',
      creatorNotes: '', systemPrompt: '', postHistoryInstructions: '',
      alternateGreetings: [], tags: [], creator: '', characterVersion: '',
    }] as unknown as Parameters<typeof buildNarrativeSystemPrompt>[1]
    const sys = promptOf(mkWorld(), chars)
    expect(sys).toContain('### 裴无咎')
    expect(sys).toContain('度支司郎中')
    expect(sys).toContain('不是围着主角转的')
  })

  it('世界规则有就注入，并明说优先级高于文风', () => {
    const sys = promptOf(mkWorld({ rules: '严禁出现枪械。' }))
    expect(sys).toContain('严禁出现枪械。')
    expect(sys).toContain('优先级高于一切文风偏好')
  })

  it('核心氛围与世界氛围都进「世界观设定」', () => {
    const sys = promptOf(mkWorld({
      story: {
        atmosphere: '雨下了三天，屋檐一直在滴水。', coreMood: '狠劲与不肯认命',
        mainQuest: '', enableStages: false, stages: [], enableChoices: true,
        urgencyAfterTurns: 0, openerSlot: '', openingSeeds: {},
      },
    }))
    expect(sys).toContain('（核心氛围：狠劲与不肯认命）')
    expect(sys).toContain('雨下了三天，屋檐一直在滴水。')
  })

  it('世界文风要求有就注入', () => {
    expect(promptOf(mkWorld({ narrative: { pov: 'third', tense: 'present', replyLength: 800, customStyle: '句子要短。' } })))
      .toContain('句子要短。')
  })

  it('启用章节卡时注出当前这一章；没启用时一个字都不提', () => {
    const withStage = mkWorld({
      story: {
        atmosphere: '', coreMood: '', mainQuest: '',
        enableStages: true,
        stages: [{
          id: 'ch1', title: '第一夜', text: '他要在雨里找到那家客栈。',
          principleGuide: '节制形容词。', options: [], triggers: [], chapterId: 0,
        }],
        enableChoices: true, urgencyAfterTurns: 0, openerSlot: '', openingSeeds: {},
      },
    })
    const sys = promptOf(withStage)
    expect(sys).toContain('### 当前章节（Chapter Guide）')
    expect(sys).toContain('第一夜')
    expect(sys).toContain('节制形容词。')
    expect(sys).toContain('"target":"ch1"')
    expect(promptOf(mkWorld())).not.toContain('### 当前章节')
  })
})

/**
 * 反向断言 —— 我们加过的那些"好心"解释，不许悄悄长回来。
 *
 * 每一条都曾是真实存在过的一节，每一条都把提示词撑长、把氛围稀释掉。
 * 玩家换掉它们的理由只有一句：「原作是这么写的吗？」
 */
describe('反向 · 我们自己加的东西不许长回来', () => {
  const sys = promptOf(mkWorld({ enableMechanics: true, attributes: [{ id: 'wu', name: '武艺' }] }), [], { aspects: { wu: 4 } })

  const banished: Array<[string, string]> = [
    ['冰山契约', '这是一座冰山'],
    ['在场的人不是道具', '等主角开口的道具'],
    ['这一场是主角的场', '主角的场'],
    ['能力三档', '内行'],
    ['能力三档', '够用'],
    ['篇幅与信息投放', '一次回复写多长'],
    ['五种凑字数手法', '凑字数'],
    ['线索不许当填充物', '填充物'],
    ['世情要能看见不要能背', '说明文'],
  ]

  for (const [name, needle] of banished) {
    it(`不再出现「${name}」`, () => {
      expect(sys).not.toContain(needle)
    })
  }

  it('★ 提示词总长控制在 3000 汉字以内（原作的量级是 1601）', () => {
    const big = promptOf(mkWorld({
      worldLore: '海。'.repeat(200),
      rules: '不许写枪。',
      enableMechanics: true,
      attributes: [
        { id: 'a', name: '甲', description: '一', traits: ['一'], reactions: ['一'], behaviors: ['一'] },
        { id: 'b', name: '乙', description: '二', traits: ['二'], reactions: ['二'], behaviors: ['二'] },
      ],
      narrative: { pov: 'third', tense: 'past', replyLength: 700, customStyle: '句子要短。' },
    }), [], { aspects: { a: 3, b: 1 } })
    const cjk = (big.match(/[\u4e00-\u9fff]/g) || []).length
    expect(cjk).toBeLessThan(3000)
  })
})

describe('十二张内置卡 · 目标字数（2026-11 改由局内滑块决定）', () => {
  /*
    玩家原话：「那就直接删掉世界书里自带单次回复字数，毕竟没用了」。

    于是卡里不再写这个字段，`NarrativeStyle.replyLength` 变成可选，
    读取一律走 `resolveReplyLength`（缺 → 1800）。这一组钉三件事：
    卡里真的没有了、没有时用兜底、旧卡带着值也照常工作。
  */
  it('★ 卡里不再写 replyLength —— 那个开关在局内「笔」面板', () => {
    for (const w of BUILTIN_WORLDS) {
      expect(w.narrative.replyLength, `《${w.title}》还留着 replyLength`).toBeUndefined()
    }
  })

  it('★ 没有这个字段时，提示词用兜底值', () => {
    for (const w of BUILTIN_WORLDS) {
      expect(buildNarrativeSystemPrompt(w, [], player(), {}))
        .toContain(`约 ${DEFAULT_REPLY_LENGTH} 字`)
    }
  })

  it('旧卡（带着 replyLength）照常生效 —— 这次删除不需要任何迁移', () => {
    const base = BUILTIN_WORLDS[0]
    const w = { ...base, narrative: { ...base.narrative, replyLength: 900 } }
    const sys = buildNarrativeSystemPrompt(w, [], player(), {})
    expect(sys).toContain('约 900 字')
    expect(sys).not.toContain(`约 ${DEFAULT_REPLY_LENGTH} 字`)
  })
})
