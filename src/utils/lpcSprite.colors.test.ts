import { describe, it, expect } from 'vitest'
import { recipeFor } from '@/utils/lpcSprite'
import { inferTraits } from '@/utils/appearance'

/**
 * 缺省配色 —— 「描述没写肤色/发色的时候，画什么」。
 *
 * ## 为什么需要这一组测试（2026-10，玩家第四次打回）
 *
 * 玩家原话：
 * > 「人物立绘出现不相符的**黑人**（1905 年伦敦贵族勋爵生出一个黑人女儿？）
 * >   也很影响代入感」
 *
 * 查下来的根因是两条**等概率随机**的兜底语句：
 *
 *   描述没写肤色 ⇒ 在 7 个人类肤色里摸一个，摸到 `black` 的概率是 1/7
 *   描述没写发色 ⇒ 在 26 个发色里摸一个，「蓝头发的邮差」就是这么来的
 *
 * 那一张卡的描述是「浅金色长发，灰蓝色眼睛」—— 写了发色、没写肤色。
 * 于是发色走关键词推断拿到金色（对），肤色落到兜底，摸到了一个不属于
 * 一九〇五年伦敦的肤色。
 *
 * ## 这些断言守的是同一句话
 *
 * **描述没写，不等于可以随便画。**
 * 没线索的时候应当画「这个世界的多数人」，而不是在调色板上闭着眼睛摸一个 ——
 * 摸出来的不是"多样性"，是错误。
 *
 * 异色（蓝绿粉紫、兽人皮、亡灵灰）当然还是画得出来，
 * 但必须由描述或 `look` **明确要求**，不再靠随机撞。
 */

/** 不含任何颜色 / 人种 / 年龄线索的描写（免得推断层先命中） */
const NEUTRAL = '一个走过的人，手里提着东西。'

/** 「不可能是随机撞出来的」的那一类发色 */
const UNNATURAL_HAIR = [
  'blue', 'navy', 'sky', 'teal',
  'green', 'bright_green', 'dark_green',
  'purple', 'violet',
  'pink', 'rose',
  'orange', 'carrot',
]

/** 老年默认应当落在这几个里 */
const ELDER_HAIR = ['gray', 'silver', 'white', 'dark_gray', 'ash']

const look = (key: string, description = NEUTRAL) =>
  recipeFor(key, { profile: { description } })

describe('缺省配色 · 描述没写的时候不许乱画', () => {
  it('★ 没写肤色时，兜底不会画出深肤色（黑人贵族女儿的来源）', () => {
    const bodies = new Set<string>()
    for (let i = 0; i < 60; i++) bodies.add(look(`npc-${i}`).colors.body ?? '')

    /*
      black 当然不行；**bronze / brown 也不行**。
      第一版按"小权重"把它们留在池里，结果那位伦敦贵族女儿抽到了 bronze ——
      技术上不算黑人，但一个足不出户的上议院小姐晒成古铜色，同样出戏。
      小概率不等于合理。
    */
    for (const dark of ['black', 'bronze', 'brown']) {
      expect(bodies.has(dark), `不该默认画成 ${dark}；实际抽到：${[...bodies].join(' / ')}`).toBe(false)
    }
    // 顺带守住兽人 / 亡灵那几个：人类默认池里本来就不该有
    for (const bad of ['green', 'blue', 'lavender', 'pale_green', 'zombie']) {
      expect(bodies.has(bad), `不该默认画成 ${bad}`).toBe(false)
    }
  })

  it('★ 没写发色时，兜底不会画出蓝绿粉紫（蓝头发邮差的来源）', () => {
    const hairs = new Set<string>()
    for (let i = 0; i < 60; i++) hairs.add(look(`npc-${i}`).colors.hair ?? '')

    for (const bad of UNNATURAL_HAIR) {
      expect(hairs.has(bad), `不该默认画成 ${bad}；实际抽到：${[...hairs].join(' / ')}`).toBe(false)
    }
  })

  it('兜底仍然要有变化 —— 不是把所有人画成同一个', () => {
    const bodies = new Set<string>()
    const hairs = new Set<string>()
    for (let i = 0; i < 60; i++) {
      const r = look(`npc-${i}`)
      bodies.add(r.colors.body ?? '')
      hairs.add(r.colors.hair ?? '')
    }
    expect(bodies.size).toBeGreaterThanOrEqual(3)
    expect(hairs.size).toBeGreaterThanOrEqual(4)
  })

  it('同一个角色 id 拿到的配色是稳定的（重渲染不会换脸）', () => {
    const a = look('npc-stable')
    const b = look('npc-stable')
    expect(a.colors).toEqual(b.colors)
  })
})

describe('缺省配色 · 写了的照办', () => {
  it('推断层确实读得到「浅金色长发」（兜底不该抢它的活）', () => {
    const t = inferTraits({ description: '二十二岁，浅金色长发，灰蓝色眼睛。' })
    expect(t.hairColor, t.evidence.join(' / ')).toBeTruthy()
  })

  it('★ 描述写了深肤色，就画深肤色', () => {
    const r = look('npc-dark', '一个深肤色的码头工人。')
    expect(['black', 'brown', 'bronze']).toContain(r.colors.body)
  })

  it('★ 描述写了蓝发，就画蓝发', () => {
    const r = look('npc-bluehair', '她有一头蓝发。')
    expect(['blue', 'navy']).toContain(r.colors.hair)
  })

  it('描述写了金发，就画金发（那条卡的发色本来就是对的）', () => {
    const r = look('npc-blonde', '二十二岁，浅金色长发，灰蓝色眼睛。')
    expect(['blonde', 'sandy', 'gold', 'light_brown']).toContain(r.colors.hair)
  })

  it('★ look 里的显式配色优先级最高，连"异色"也照办', () => {
    const r = recipeFor('npc-look', {
      profile: { description: NEUTRAL },
      look: { skin: 'black', hairColor: 'blue', clothColor: 'red', eye: 'red' },
    })
    expect(r.colors.body).toBe('black')
    expect(r.colors.hair).toBe('blue')
    expect(r.colors.cloth).toBe('red')
    expect(r.colors.eye).toBe('red')
  })

  it('老年角色的默认发色偏灰白', () => {
    const hairs = new Set<string>()
    for (let i = 0; i < 30; i++) {
      hairs.add(look(`elder-${i}`, '一位老人，坐在炉边。').colors.hair ?? '')
    }
    expect(hairs.size).toBeGreaterThan(0)
    for (const h of hairs) {
      expect(ELDER_HAIR, `老年不该默认画成 ${h}`).toContain(h)
    }
  })
})

describe('发型池 · 染不上颜色的件不许混进来', () => {
  /*
    `hair_long_tied` / `hair_pigtails` 的贴图把颜色画死了（`recolors: null`），
    `hairColor` 对它们无效。混在池子里就会出现这种情况：

      兜底抽到 `black` ⇒ 部件抽到 `hair_long_tied` ⇒ 画出来一头**橙发**

    这不是"猜错了"，是**猜对了也画不出来** —— 玩家说的"立绘与描述对不上"
    里最刺眼的一类。`lookSpec.ts` 早就有这条硬规则，但只管"AI 登记外观"
    那条路；没登记的 NPC 走的是这个池子，所以这里也要守。
  */
  const FIXED_ORANGE = /^(hair_long_tied|hair_pigtails)$/

  it('★ 没指定 look.hair 时，不会落到固定橙的那两件', () => {
    for (let i = 0; i < 80; i++) {
      const r = look(`npc-${i}`)
      const bad = r.parts.filter(p => FIXED_ORANGE.test(p))
      expect(bad, `第 ${i} 个角色落到了染色无效的 ${bad.join(',')}`).toEqual([])
    }
  })

  it('显式指定 look.hair 时照办 —— 这一层不替作者改主意', () => {
    const r = recipeFor('npc-explicit', { look: { hair: 'hair_long_tied' } })
    expect(r.parts).toContain('hair_long_tied')
  })

  it('光头角色仍然完全不叠头发层', () => {
    const r = look('npc-bald', '一个光头男人，脸上有疤。')
    expect(r.parts.some(p => /^hair_/.test(p))).toBe(false)
  })
})

describe('缺省配色 · 与推断层的分工没被动过', () => {
  it('描述里写了具体发色时，仍然由推断层说了算', () => {
    // 「红发」是真实发色，推断层要能读到；它不属于"异色"，兜底改它才叫修坏了
    const r = look('npc-red', '一头红发的年轻女子。')
    expect(['red', 'redhead', 'ginger', 'strawberry']).toContain(r.colors.hair)
  })

  it('肤色兜底改过之后，衣色仍然避开肤色（防"像没穿衣服"）', () => {
    for (let i = 0; i < 20; i++) {
      const r = look(`npc-clash-${i}`)
      expect(r.colors.cloth).not.toBe(r.colors.body)
    }
  })
})
