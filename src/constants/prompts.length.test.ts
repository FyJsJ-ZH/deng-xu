import { describe, it, expect } from 'vitest'
import { buildNarrativeSystemPrompt } from '@/constants/prompts'
import { BUILTIN_WORLDS } from '@/data/builtinWorlds'
import type { PlayerCard, WorldCard } from '@/types/cards'

/**
 * 「一次回复该写多长、往里装什么」。
 *
 * ## 玩家第五次打回的原话
 *
 * > 「文字输出长度实在是过短，通常需要三四个对话才能真正的推进事态发展，
 * >   线索出现的频率太高，知识却太低（也不要太高）」
 *
 * 这三句听起来是三个毛病，其实是同一个因果：**八百字装不下一个场景**。
 * 篇幅不够时，模型只能挑最省字的东西写，而最省字的东西就是**线索** ——
 * 一句话既能推进情节，也能把玩家送进下一轮。于是每轮都在抛线索，
 * 而「这个世界的质地」（价钱、手续、称呼、行当、气味）因为没有地方放，
 * 被挤了出去。玩家读到的就是节奏飞快、内容单薄的流水账。
 *
 * 所以下面这一节必须同时管住三件事，缺一条就会退回原来的样子：
 *   ① 篇幅（写满一场戏，不许写一半就收）
 *   ② 信息密度（一轮只出一件新事，线索不许当填充物）
 *   ③ 腾出来的空间用来做什么（写能看见的世情，不写说明书）
 */

const player = (): PlayerCard => ({
  name: '沈砚', gender: '男', age: '三十',
  appearance: '', personality: '', background: '', extra: '',
})

const mkWorld = (over: Partial<WorldCard> = {}): WorldCard => ({
  id: 'w1', title: '测试世界', tagline: '',
  worldLore: '', rules: '',
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

const promptOf = (world: WorldCard) => buildNarrativeSystemPrompt(world, [], player(), {})

describe('篇幅 · 目标字数要真的写进提示词', () => {
  it('★ 1800 字的世界，提示词里就有「约 1800 字」', () => {
    expect(promptOf(mkWorld())).toContain('约 1800 字')
  })

  it('改 replyLength，数字跟着改（不是写死的）', () => {
    const w = mkWorld({ narrative: { pov: 'third', tense: 'present', replyLength: 2600, customStyle: '' } })
    const out = promptOf(w)
    expect(out).toContain('约 2600 字')
    expect(out).not.toContain('约 1800 字')
  })

  it('「写满」而不是「写到」——要明说是下限不是上限', () => {
    const out = promptOf(mkWorld())
    expect(out).toMatch(/这是要写满的量，不是上限/)
  })
})

describe('篇幅 · 一场戏要有起承转合', () => {
  it('★ 三块结构都在：在场 / 过程 / 变化与决断点', () => {
    const out = promptOf(mkWorld())
    expect(out).toContain('在场')
    expect(out).toContain('过程')
    expect(out).toContain('变化与决断点')
  })

  it('★ 结尾的局面必须与开头不同（否则这一轮白走）', () => {
    expect(promptOf(mkWorld())).toMatch(/结尾的局面必须与开头\*\*不同\*\*/)
  })

  it('写不完就留到下一轮，不许压成梗概', () => {
    expect(promptOf(mkWorld())).toMatch(/留到下一轮/)
  })
})

describe('信息投放 · 线索不许当填充物', () => {
  it('★ 一轮只出一件新事', () => {
    const out = promptOf(mkWorld())
    expect(out).toContain('一轮只出一件新事')
    expect(out).toMatch(/只出一件/)
  })

  it('★ 新东西必须由具体的东西带出来，不许叙述者直接宣布', () => {
    expect(promptOf(mkWorld())).toMatch(/不要由叙述者直接宣布/)
  })

  it('给出之后不许解释、不许补第二条', () => {
    const out = promptOf(mkWorld())
    expect(out).toMatch(/不要解释/)
    expect(out).toMatch(/补上第二条/)
  })

  it('★ 不要主动投喂：玩家没问的事不许「恰好」撞见', () => {
    expect(promptOf(mkWorld())).toContain('不要主动投喂')
  })
})

describe('世情 · 要能看见，不要能背', () => {
  it('★ 明确禁止说明文', () => {
    const out = promptOf(mkWorld())
    expect(out).toMatch(/不写说明文/)
    expect(out).toMatch(/不解释制度/)
  })

  it('★ 每轮只放一到两处（这就是「知识不要太低也不要太高」）', () => {
    expect(promptOf(mkWorld())).toMatch(/一到两处/)
  })

  it('宁少勿多 —— 堆设定比不写设定更坏', () => {
    expect(promptOf(mkWorld())).toMatch(/宁少勿多/)
  })

  it('给了一个可照做的对照例子（数煤油灯芯 / 治安很严）', () => {
    const out = promptOf(mkWorld())
    expect(out).toContain('煤油灯芯')
    expect(out).toContain('这城治安很严')
  })
})

describe('篇幅节的位置 —— 放在禁令之前才像要求，不像又一次限制', () => {
  it('★ 在「叙事风格」之后、「写作协议」之前', () => {
    const out = promptOf(mkWorld())
    const style = out.indexOf('## 叙事风格')
    const len = out.indexOf('## 篇幅与信息投放')
    const proto = out.indexOf('## 写作协议')
    expect(style).toBeGreaterThanOrEqual(0)
    expect(len).toBeGreaterThan(style)
    expect(proto).toBeGreaterThan(len)
  })

  it('世界自己的文风要求仍然在，且排在篇幅节之前', () => {
    const w = mkWorld({ narrative: { pov: 'third', tense: 'present', replyLength: 1800, customStyle: '句子短，数字多。' } })
    const out = promptOf(w)
    expect(out).toContain('句子短，数字多。')
    expect(out.indexOf('句子短，数字多。')).toBeLessThan(out.indexOf('## 篇幅与信息投放'))
  })
})

describe('九张内置卡 · 都按新篇幅落地了', () => {
  it('★ 每张卡的目标字数都不低于 1500（不许哪一张被改回八百）', () => {
    for (const w of BUILTIN_WORLDS) {
      expect(w.narrative.replyLength, `《${w.title}》`).toBeGreaterThanOrEqual(1500)
    }
  })

  it('★ 世界卡自己的文风条款里不许再写旧数字（会跟上层打架）', () => {
    /*
      注意这两个 lookbehind：
        `(?<!千)` —— 「一千八百字」是**新**数字，不能因为含「八百字」就被判成旧值；
        `(?<!\d)` —— 同理，「1800 字」不能因为含「800 字」被误伤。
      上一版就是这两处漏了，测试把自己刚写进去的新数字抓了出来。
    */
    const stale = /(?<!千)八百(?:五十)?字|(?<!\d)(?:80[05])\s*字/
    for (const w of BUILTIN_WORLDS) {
      expect(stale.test(w.narrative.customStyle), `《${w.title}》里还留着旧字数：${w.narrative.customStyle.match(stale)?.[0]}`).toBe(false)
      expect(stale.test(w.rules), `《${w.title}》的 rules 里还留着旧字数：${w.rules.match(stale)?.[0]}`).toBe(false)
    }
  })

  it('每张卡生成的提示词都带上了自己的目标字数', () => {
    for (const w of BUILTIN_WORLDS) {
      expect(promptOf(w)).toContain(`约 ${w.narrative.replyLength} 字`)
    }
  })
})
