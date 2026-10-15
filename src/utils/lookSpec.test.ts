/**
 * `lookSpec` 的单元测试。
 *
 * 这一层是"AI 现场创造的 NPC"唯一的可控外观来源，而它有一个**不变量**必须守住：
 *
 * > **它只会在推断之上叠加确定性，绝不会把结果改坏。**
 *
 * 具体说：任何 AI 给的值，只要不在白名单里，就必须被**静默丢弃**，
 * 让 `recipeFor` 退回 `inferTraits` 的推断 —— 也就是"改了只会更好，不会更差"。
 *
 * 所以下面大半测试都在喂**垃圾输入**（编造的部件名、不存在的颜色、
 * 字符串而不是对象、数组、null），确认它们不会污染输出。
 */
import { describe, it, expect } from 'vitest'
import { resolveAiLook, aiLookCatalogPrompt, LOOK_SPEC_META } from '@/utils/lookSpec'

describe('resolveAiLook · 基本解析', () => {
  it('性别决定头部件（这是历史上出错最多的一项）', () => {
    expect(resolveAiLook({ sex: 'male' }, 'a')?.head).toBe('heads_human_male')
    expect(resolveAiLook({ sex: 'female' }, 'a')?.head).toBe('heads_human_female')
  })

  it('年龄覆盖性别之外的体型（小孩与老人各有专属头）', () => {
    expect(resolveAiLook({ sex: 'female', age: 'child' }, 'a')?.head).toBe('heads_human_female_small')
    expect(resolveAiLook({ sex: 'male', age: 'child' }, 'a')?.head).toBe('heads_human_male_small')
    expect(resolveAiLook({ sex: 'male', age: 'elder' }, 'a')?.head).toBe('heads_human_male_elderly')
    expect(resolveAiLook({ sex: 'female', age: 'elder' }, 'a')?.head).toBe('heads_human_female_elderly')
  })

  it('成年男性的体型走 gaunt / plump 两个头', () => {
    expect(resolveAiLook({ sex: 'male', build: 'slim' }, 'a')?.head).toBe('heads_human_male_gaunt')
    expect(resolveAiLook({ sex: 'male', build: 'heavy' }, 'a')?.head).toBe('heads_human_male_plump')
  })

  it('★ 没写性别时不锁头 —— 不能默认成男性把"妇人"压成男人', () => {
    expect(resolveAiLook({ age: 'elder' }, 'a')?.head).toBeUndefined()
    expect(resolveAiLook({ hair: 'long' }, 'a')?.head).toBeUndefined()
  })

  it('发型与衣着的语义键翻成真实部件 id', () => {
    expect(resolveAiLook({ hair: 'braid' }, 'a')?.hair).toBe('hair_braid')
    expect(resolveAiLook({ hair: 'pixie' }, 'a')?.hair).toBe('hair_pixie')
    expect(resolveAiLook({ cloth: 'armour' }, 'a')?.torso).toBe('torso_armour_leather')
    expect(resolveAiLook({ cloth: 'plate' }, 'a')?.torso).toBe('torso_armour_plate')
  })

  it('bald 翻成空串（空串是有意义的："明确光头"）', () => {
    expect(resolveAiLook({ hair: 'bald' }, 'a')?.hair).toBe('')
  })

  it('同一个 seed 稳定落同一个部件，不同 seed 会分散开', () => {
    const a1 = resolveAiLook({ hair: 'short' }, 'npc-1')?.hair
    const a2 = resolveAiLook({ hair: 'short' }, 'npc-1')?.hair
    expect(a1).toBe(a2)
    // "short" 有 3 个候选件，多个 seed 不该全部撞在同一个上
    const many = new Set(['x1', 'x2', 'x3', 'x4', 'x5', 'x6'].map(s => resolveAiLook({ hair: 'short' }, s)?.hair))
    expect(many.size).toBeGreaterThan(1)
  })
})

describe('resolveAiLook · 颜色必须真实存在于调色板', () => {
  it('合法色键照办', () => {
    expect(resolveAiLook({ hairColor: 'black' }, 'a')?.hairColor).toBe('black')
    expect(resolveAiLook({ hairColor: 'blonde' }, 'a')?.hairColor).toBe('blonde')
    expect(resolveAiLook({ eye: 'green' }, 'a')?.eye).toBe('green')
    expect(resolveAiLook({ clothColor: 'charcoal' }, 'a')?.clothColor).toBe('charcoal')
  })

  it('★ 编造的色键被丢弃（不是报错、更不是兜到别的颜色）', () => {
    expect(resolveAiLook({ hairColor: '银白' }, 'a')?.hairColor).toBeUndefined()
    expect(resolveAiLook({ hairColor: 'silver' }, 'a')?.hairColor).toBeUndefined() // hair 板里没有 silver
    expect(resolveAiLook({ eye: 'amber' }, 'a')?.eye).toBeUndefined()
    expect(resolveAiLook({ clothColor: 'gold' }, 'a')?.clothColor).toBeUndefined()
  })

  it('瞳色与发色的板子不通用（green 在两边都有，silver 只在 metal 里有）', () => {
    expect(resolveAiLook({ eye: 'purple' }, 'a')?.eye).toBe('purple')
    expect(resolveAiLook({ eye: 'violet' }, 'a')?.eye).toBeUndefined()
  })
})

describe('resolveAiLook · 连衣裙按颜色选 id', () => {
  it('dress + 颜色 → 挑对应色的 bodice', () => {
    expect(resolveAiLook({ cloth: 'dress', clothColor: 'red' }, 'a')?.torso).toBe('dress_bodice_red')
    expect(resolveAiLook({ cloth: 'dress', clothColor: 'white' }, 'a')?.torso).toBe('dress_bodice_white')
  })

  it('连衣裙系的颜色不在 10 色表里时，退回一个确定色而不是拼出空 id', () => {
    const t = resolveAiLook({ cloth: 'dress', clothColor: 'teal' }, 'a')?.torso
    expect(t).toMatch(/^dress_bodice_(black|blue|brown|gray|green|navy|pink|purple|red|white)$/)
  })

  it('sash / slit 同理', () => {
    expect(resolveAiLook({ cloth: 'sash', clothColor: 'navy' }, 'a')?.torso).toBe('dress_sash_navy')
    expect(resolveAiLook({ cloth: 'slit', clothColor: 'black' }, 'a')?.torso).toBe('dress_slit_black')
  })
})

describe('resolveAiLook · 下装（★ 这一条是回归）', () => {
  it('登记了 skirt 就给裙装', () => {
    const legs = resolveAiLook({ legs: 'skirt' }, 'a')?.legs || ''
    expect(legs).toMatch(/^legs_skirt/)
  })

  it('登记了具体裤型就照办', () => {
    expect(resolveAiLook({ legs: 'leggings' }, 'a')?.legs).toBe('legs_leggings')
    expect(resolveAiLook({ legs: 'widepants' }, 'a')?.legs).toBe('legs_widepants')
  })

  it('none 翻成空串（明确不要下装）', () => {
    expect(resolveAiLook({ legs: 'none' }, 'a')?.legs).toBe('')
  })

  it('★ 只登记了上衣时**不要**擅自补一条裤子', () => {
    /*
      这是实测抓出来的 bug：原先"给了上衣就顺手补裤子"，
      结果"穿深蓝色制服短裙的女学生"那张，AI 登记了上衣没登记下装，
      补上去的长裤把 inferTraits 已经读到的"短裙"顶掉了 ——
      左右对照图里从裙子变成长裤，比改之前还差。
    */
    const look = resolveAiLook({ sex: 'female', cloth: 'formal', clothColor: 'navy' }, 'a')
    expect(look?.torso).toBeTruthy()
    expect(look?.legs).toBeUndefined()
  })
})

describe('resolveAiLook · 垃圾输入', () => {
  it('非对象一律返回 undefined', () => {
    expect(resolveAiLook(undefined, 'a')).toBeUndefined()
    expect(resolveAiLook(null, 'a')).toBeUndefined()
    expect(resolveAiLook('male', 'a')).toBeUndefined()
    expect(resolveAiLook(42, 'a')).toBeUndefined()
    expect(resolveAiLook(['male'], 'a')).toBeUndefined()
  })

  it('空对象返回 undefined（"什么都没登记"与"没登记"等价）', () => {
    expect(resolveAiLook({}, 'a')).toBeUndefined()
  })

  it('全部字段都是编造值时返回 undefined，而不是返回一个残缺 look', () => {
    expect(resolveAiLook({
      sex: 'other', age: 'ancient', build: 'huge',
      hair: 'mohawk_spiky', cloth: 'spacesuit', hat: 'sombrero',
      hairColor: 'rainbow', clothColor: 'neon', eye: 'laser',
    }, 'a')).toBeUndefined()
  })

  it('字段值是数字 / null / 数组时被忽略，不影响其它字段', () => {
    const look = resolveAiLook({ sex: 1, hair: null, eye: ['blue'], hairColor: 'black' }, 'a')
    expect(look?.hairColor).toBe('black')
    expect(look?.head).toBeUndefined()
    expect(look?.hair).toBeUndefined()
    expect(look?.eye).toBeUndefined()
  })

  it('大小写与空白被容忍', () => {
    expect(resolveAiLook({ sex: '  MALE ' }, 'a')?.head).toBe('heads_human_male')
    expect(resolveAiLook({ sex: 'Female' }, 'a')?.head).toBe('heads_human_female')
    expect(resolveAiLook({ hairColor: ' Black ' }, 'a')?.hairColor).toBe('black')
  })

  it('★ 中文值：只认性别，其余一律丢弃（这是刻意的设计）', () => {
    /*
      数据 AI 是中文模型，把键值翻成中文是最容易犯的错 ——
      所以提示词里把「取值一律用表里的英文词，不要翻译」写在规则的第一条。

      但代码这一层**只给 `sex` 开了中文口子**（男/女），理由：
        · 性别是观感里最要紧的一项（历史 bug 就是它出错的），值得多一层容错；
        · 其余字段丢了也不要紧 —— 它们会**退回 `inferTraits` 的推断**，
          而推断读的正是中文描述本身。所以"丢弃"的代价是"回到改造之前"，
          不会更差；反过来若在这里硬塞一个中文映射表，
          就等于又把"猜"引进来了 —— 那正是这一轮要拆掉的东西。
    */
    const look = resolveAiLook({ sex: '男', hair: '长发', cloth: '长袍', hat: '兜帽' }, 'a')
    expect(look?.head).toBe('heads_human_male')
    expect(look?.hair).toBeUndefined()
    expect(look?.torso).toBeUndefined()
    expect(look?.hat).toBeUndefined()
  })

  it('给的是 LPC 部件 id 而不是语义键时，同样被丢弃（不猜、不静默混用）', () => {
    const look = resolveAiLook({ sex: 'male', hair: 'hair_buzzcut', cloth: 'torso_clothes_robe' }, 'a')
    expect(look?.head).toBe('heads_human_male')
    expect(look?.hair).toBeUndefined()
    expect(look?.torso).toBeUndefined()
  })
})

describe('resolveAiLook · 不碰玩家与作者的部件', () => {
  it('★ 产出里不会出现固定橙的那两个发型件', () => {
    /*
      `hair_long_tied` 与 `hair_pigtails` 的贴图颜色是画死的橙色，
      `hairColor` 对它们无效 —— "乌黑长发"会画成橙色。
      所以映射表必须绕开它们（宁可形制近似，也不要颜色对不上）。
    */
    for (const key of LOOK_SPEC_META.hairKeys) {
      for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
        const hair = resolveAiLook({ hair: key }, seed)?.hair
        expect(hair === 'hair_long_tied' || hair === 'hair_pigtails').toBe(false)
      }
    }
  })

  it('映射表里的部件 id 全部以正确前缀开头（防止手写错前缀）', () => {
    for (const [key, pool] of [['hair', LOOK_SPEC_META.hairKeys]]) {
      void key
      for (const k of pool) {
        const id = resolveAiLook({ hair: k }, 'seed')?.hair
        if (id) expect(id).toMatch(/^hair_/)
      }
    }
    for (const k of LOOK_SPEC_META.clothKeys) {
      const id = resolveAiLook({ cloth: k }, 'seed')?.torso
      if (id) expect(id).toMatch(/^(torso_|dress_)/)
    }
  })
})

describe('aiLookCatalogPrompt', () => {
  it('清单里列出了全部语义键与色键', () => {
    const p = aiLookCatalogPrompt()
    for (const k of LOOK_SPEC_META.hairKeys) expect(p).toContain(k)
    for (const k of LOOK_SPEC_META.clothKeys) expect(p).toContain(k)
    for (const k of LOOK_SPEC_META.hatKeys) expect(p).toContain(k)
    expect(p).toContain('sex')
    expect(p).toContain('hairColor')
  })

  it('清单里的色键与调色板一致（防止提示词与数据漂移）', () => {
    const p = aiLookCatalogPrompt()
    for (const c of LOOK_SPEC_META.colorPalettes.hair.split('|')) expect(p).toContain(c)
    for (const c of LOOK_SPEC_META.colorPalettes.eye.split('|')) expect(p).toContain(c)
  })
})
