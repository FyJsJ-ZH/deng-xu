import { describe, it, expect } from 'vitest'
import { inferTraits, resolvePaletteName } from '@/utils/appearance'
import { recipeFor } from '@/utils/lpcSprite'

/**
 * 外貌推断。
 *
 * 这是「立绘和角色描述对不上」的修复核心，所以断言要贴着真实角色卡写 ——
 * 下面这些描述都是这个项目里会真实出现的样子（含管家、守卫队长这类具体身份）。
 */
describe('外貌推断 · 性别（立绘错配的头号来源）', () => {
  /*
    玩家截图反馈：「约莫四十出头的**妇人**」的立绘是一张**留胡子的男脸**。
    根因是 GENDERS 表里根本没有「妇人」，推断不出性别 → 头部从男女混合池随机抽。

    这一组用例把"实际角色卡里会出现的说法"逐个固化。
    注意**不能放"王/国王/皇帝"**这类称谓：它们会命中姓氏「王」和
    "老国王的侄女"这种指别人的表述（「静水堡的伊瑟琳」曾因此被判成男性）。
  */
  const cases: [string, 'male' | 'female'][] = [
    ['约莫四十出头的妇人，魏斯家当家主母。深灰色素面长裙堆在腰侧。', 'female'],
    ['约莫十七八岁的少年，魏斯家独子，月谷城法师塔学徒。', 'male'],
    ['老国王的侄女，三十岁上下，寡居。', 'female'],
    ['一位年轻的寡妇，带着两个孩子', 'female'],
    ['头发花白的老妇人', 'female'],
    ['镇上的接生婆', 'female'],
    ['十六岁的少女，扎着双马尾', 'female'],
    ['五十岁上下的老汉', 'male'],
    ['一名年轻的修士', 'male'],
  ]
  for (const [text, want] of cases) {
    it(`「${text.slice(0, 20)}…」→ ${want}`, () => {
      expect(inferTraits({ description: text }).gender, text).toBe(want)
    })
  }

  it('称谓不参与性别判断（避免命中姓氏「王」）', () => {
    // 「王」是常见姓氏，绝不能因为描述里出现"王"就判成男性
    expect(inferTraits({ description: '王掌柜的女儿，十七岁' }).gender).toBe('female')
    // 「国王」是指别人：伊瑟琳是老国王的侄女
    expect(inferTraits({ description: '老国王的侄女，寡居多年' }).gender).toBe('female')
  })

  it('代词指别人时不误判', () => {
    // "他的母亲"里的"他"不是被描述者
    const t = inferTraits({ description: '一个沉默的男人。他的母亲站在旁边。' })
    expect(t.gender).toBe('male')
  })

  it('完全没有性别线索时**不假定**某一性别', () => {
    // 旧版有 `if (age === 'elder' && !gender) gender = 'male'` —— 硬编码的男性偏见
    expect(inferTraits({ description: '上了年纪的老者' }).gender).toBe(undefined)
  })
})

describe('外貌推断 · 年龄（中文数字是普遍写法）', () => {
  /*
    ⚠️ 实测**内置角色卡里的岁数全部是中文数字**，一个阿拉伯数字都没有。
    旧版只写了 `\b\d+\s*岁`，于是 20 张卡只有 2 张推断出年龄；
    推断不出年龄的年轻人会从成年池随机抽头，**抽到老人脸**
    （「十七八岁的少年」被画成老头，审计抓到 3 张卡）。

    另一条坑：「老」原先裸写在 elder 规则里，于是「**老**板」「**老**师」
    全被判成老者 —— 酒馆老板随机拿到老年脸。
  */
  const cases: [string, 'child' | 'young' | 'adult' | 'elder'][] = [
    ['十九岁，宫廷文书的最低一级', 'young'],
    ['十四岁，出生在灾后第二年', 'child'],
    ['三十四岁，潮务处第七稽查组的组长', 'young'],
    ['四十岁上下，拾音人行的资深成员', 'adult'],
    ['五十多岁，慢钟旅店的老板', 'adult'],
    ['五十岁上下，在望江路加油站上夜班', 'adult'],
    ['六十岁上下，两只手都在抖', 'elder'],
    ['十七八岁的少年，魏斯家独子', 'young'],
    ['四十出头，把"账要对得上"当信条', 'adult'],
    ['约莫七八岁的小女孩', 'child'],
  ]
  for (const [text, want] of cases) {
    it(`「${text.slice(0, 22)}…」→ ${want}`, () => {
      expect(inferTraits({ description: text }).age, text).toBe(want)
    })
  }

  it('职业名里的「老」不算年龄线索', () => {
    // 老板/老师/老陈 里的"老"与年龄无关
    expect(inferTraits({ description: '酒馆的老板，围着皮围裙' }).age).not.toBe('elder')
    expect(inferTraits({ description: '加油站的老陈，夜班群里说话最多的人' }).age).not.toBe('elder')
  })
})

describe('外貌推断 · 衣色（颜色与衣物之间常夹布料词）', () => {
  /*
    玩家截图：「深灰色**素面**长裙」推断不出衣色。
    因为 GARMENT 只能跳过"的长短厚薄"，夹一个"素面"整条就匹配失败。
    现在用 CLOTH_MOD 覆盖常见布料/质地词。
  */
  const cases: [string, string][] = [
    ['深灰色素面长裙堆在腰侧', 'dark_gray'],
    ['穿着一件素色白色长袍', 'white'],
    ['墨色丝质长衫', 'black'],
    ['青色官袍', 'teal'],
    ['浅灰色麻布外衣', 'light_gray'],
    ['深蓝色绒面披风', 'navy'],
  ]
  for (const [text, want] of cases) {
    it(`「${text}」→ ${want}`, () => {
      expect(inferTraits({ description: text }).cloth, text).toBe(want)
    })
  }

  it('布料词不会让「灰色眼睛」被误判成衣物', () => {
    // 灰色是瞳色，不是衣色
    const t = inferTraits({ description: '一双灰色眼睛，穿着白色长袍' })
    expect(t.cloth, '衣色应是白袍').toBe('white')
  })
})

describe('立绘配方 · 年龄一致性（机检矛盾必须为 0）', () => {
  /*
    审计脚本（`pnpm check:sprites-audit`）在真实角色卡上抓到 3 张卡
    "推断为 young 却用了老年部件" —— 部件是 `head_nose_elderly`
    （鼻子！不是头）。根因有两处，各踩一次同一个坑：
      · pickHead 的 young 档忘了排除 elderly
      · 鼻子的池子一直是全池随机，`head_nose_elderly` 谁都能抽到
    现在两者都过 `agePool()`。这里把"年轻角色不得出现老年件"固化成断言。
  */
  const AGES: ['child' | 'young', string][] = [
    ['child', '约莫十岁的孩童'],
    ['young', '十九岁的少年，宫廷文书'],
    ['young', '十七八岁的少女，学徒'],
  ]
  for (const [age, desc] of AGES) {
    it(`${age}「${desc}」不得出现任何 elderly 部件`, () => {
      for (let i = 0; i < 30; i++) {
        const r = recipeFor(`age-check-${age}-${i}`, { profile: { description: desc } })
        const elders = r.parts.filter(p => /elderly/i.test(p))
        expect(elders, `${desc} 抽到了老年部件`).toHaveLength(0)
      }
    })
  }

  it('老者仍然拿得到老年部件（别把上面那条修成"永远不给"）', () => {
    let sawElderly = false
    for (let i = 0; i < 40; i++) {
      const r = recipeFor(`elder-check-${i}`, { profile: { description: '白发苍苍的老者，拄着拐杖' } })
      if (r.parts.some(p => /elderly/i.test(p))) { sawElderly = true; break }
    }
    expect(sawElderly, '老者应当能拿到 elderly 部件').toBe(true)
  })

  it('推断为女性时不得配胡须、不得只给男脸', () => {
    for (let i = 0; i < 30; i++) {
      const r = recipeFor(`fem-check-${i}`, { profile: { description: '约莫四十出头的妇人，穿着长裙' } })
      expect(r.parts.filter(p => /beards_/.test(p)), '女性配了胡须').toHaveLength(0)
      expect(r.parts.some(p => /heads_human_female/.test(p)), '女性应当拿到 female 头').toBe(true)
      expect(r.parts.some(p => /heads_human_male/.test(p)), '女性不该拿到 male 头').toBe(false)
    }
  })
})

describe('外貌推断 · 发色', () => {
  const cases: [string, string][] = [
    ['星夜堡的管家，黑发束成笔直的马尾，戴单片眼镜', 'black'],
    ['一头银白的长发垂至腰际', 'silver'],
    ['金发碧眼的年轻女子', 'blonde'],
    ['红发艾拉是北门最凶的守卫', 'red'],
    ['深棕色的短发，看起来很干练', 'dark_brown'],
    // 「鸦羽」比纯黑更具体：调色板里 raven 是独立的一档
    ['she had raven hair and pale skin', 'raven'],
  ]
  for (const [text, want] of cases) {
    it(`「${text.slice(0, 18)}…」→ ${want}`, () => {
      expect(inferTraits({ description: text }).hairColor).toBe(want)
    })
  }

  /*
    中文角色卡里的发色常常**不是标准色名** —— 这些说法原先一个都认不出来，
    于是立绘退回随机发色，玩家看到的就是"和我写的不像"。
    下面这批覆盖了最常见的非标准说法。
  */
  const chineseCases: [string, string][] = [
    ['浅亚麻色的长发编成一条辫子垂在肩前', 'sandy'],
    ['麦色的头发挽成发髻', 'gold'],
    ['栗棕色的卷发', 'chestnut'],
    ['一头乌黑锃亮的长发', 'raven'],
    ['铂金色的长发', 'platinum'],
    ['月白色的发丝', 'silver'],
    ['焦糖色的短发', 'light_brown'],
    ['灰烬色的头发', 'ash'],
    ['稻草色的乱发', 'sandy'],
    ['茶色的短发', 'brown'],
    ['咖啡色的长发', 'dark_brown'],
    ['姜红色的编发', 'ginger'],
    ['草莓金的卷发', 'strawberry'],
    ['深灰色的头发', 'dark_gray'],
    ['雪白的短发', 'white'],
  ]
  for (const [text, want] of chineseCases) {
    it(`非标准发色「${text.slice(0, 12)}…」→ ${want}`, () => {
      expect(inferTraits({ description: text }).hairColor).toBe(want)
    })
  }

  it('白手套这类白色物件不会被误认成发色', () => {
    // 第一版就踩过：裸的 white 匹配到「白手套上永远残留墨痕」→ 管家一头白发
    const t = inferTraits({ description: '他身着黑色燕尾服，手上戴着白手套，袖口没有一丝褶皱' })
    expect(t.hairColor, '不该从白手套推出白发').not.toBe('white')
  })

  it('**银丝眼镜框不会被误认成银发**（与白手套同类错误）', () => {
    /*
      管家的真实描述：「他有着一头乌黑锃亮的**长发**……右眼佩戴着一枚
      镶有**银丝**的精致单片眼镜」。原先的银发模式里有裸的 `银丝`，
      它命中了眼镜框，于是管家被画成一头银发 —— 而描述明写乌黑。
      修法：去掉裸词，银发模式必须绑定"发"。
    */
    const desc = '他有着一头乌黑锃亮的长发，右眼佩戴着一枚镶有银丝的精致单片眼镜，深邃的暗绿色眼眸透过镜片观察着一切。'
    const t = inferTraits({ description: desc })
    expect(t.hairColor, '应识别出乌黑长发，而不是眼镜框上的银丝').not.toBe('silver')
    expect(['black', 'raven'], `实际=${t.hairColor}`).toContain(t.hairColor)
  })

  it('真正的银发仍然识别得出来', () => {
    for (const d of ['银白色的长发', '银发的老者', '一头霜白的长发', 'gray hair and a scar']) {
      expect(inferTraits({ description: d }).hairColor, d).toBe('silver')
    }
  })

  it('名字里的外貌词优先级最高', () => {
    // 名字说红发，描述里又提到"黑色的靴子" —— 应当以名字为准
    const t = inferTraits({ name: '红发艾拉', description: '穿着黑色的靴子' })
    expect(t.hairColor).toBe('red')
  })

  it('没有任何发色线索时不乱猜', () => {
    expect(inferTraits({ description: '一个沉默的人' }).hairColor).toBeUndefined()
  })
})

describe('外貌推断 · 发型', () => {
  it('马尾 → 命中马尾相关部件关键词', () => {
    const t = inferTraits({ description: '黑发束成笔直的马尾' })
    expect(t.hairStyle).toContain('ponytail')
  })
  it('光头', () => {
    expect(inferTraits({ description: '光头的中年男人' }).hairStyle).toContain('bald')
  })
  it('长发 + 卷发可以叠加', () => {
    const t = inferTraits({ description: '一头卷曲的长发' })
    expect(t.hairStyle).toContain('long')
    expect(t.hairStyle).toContain('curly')
  })
})

describe('外貌推断 · 年龄与体型', () => {
  it('老者', () => {
    expect(inferTraits({ description: '年迈的老者，白发苍苍' }).age).toBe('elder')
  })
  it('少年', () => {
    expect(inferTraits({ description: '一个瘦弱的少年' }).age).toBe('child')
  })
  it('瘦弱', () => {
    expect(inferTraits({ description: '瘦弱的身形' }).build).toBe('slim')
  })
  it('魁梧', () => {
    expect(inferTraits({ description: '魁梧的壮汉' }).build).toBe('muscular')
  })
})

describe('外貌推断 · 身份暗示衣着', () => {
  /*
    断言检查的是**真实部件 id**，不再是抽象词。
    第一版这里写的是 `toContain('armour')`、`toContain('robe')` 之类，
    而我后来把关键词换成了实际 id（`torso_armour_plate` 等）——
    抽象词根本不存在于库里，那样的断言等于在验证一个假接口。
    「关键词必须指向真实部件」这件事由 spritePool.test.ts 统一守着。
  */
  it('守卫队长 → 盔甲部件', () => {
    const t = inferTraits({ description: '北门哨塔的守卫队长' })
    expect(t.role!.some(k => k.startsWith('torso_armour_'))).toBe(true)
  })
  it('管家 → 正装外套', () => {
    const t = inferTraits({ description: '星夜堡的管家' })
    expect(t.role!.some(k => k.startsWith('torso_jacket_'))).toBe(true)
  })
  it('法师 → 长袍', () => {
    const t = inferTraits({ description: '塔里的老法师' })
    expect(t.role).toContain('torso_clothes_robe')
  })
  it('铁匠 → 皮围裙（不是工装裤）', () => {
    const t = inferTraits({ description: '镇上的铁匠' })
    expect(t.role![0]).toMatch(/^torso_aprons_apron/)
  })
  it('身份可以叠加（守卫 + 队长）', () => {
    const t = inferTraits({ description: '巡逻队长与他的守卫' })
    expect(t.role!.length).toBeGreaterThanOrEqual(1)
  })
})

describe('外貌推断 · 头饰与胡须', () => {
  it('头盔 → 真实头盔部件', () => {
    const t = inferTraits({ description: '戴着铁头盔' })
    expect(t.headwear!.some(k => k.startsWith('hat_helmet_'))).toBe(true)
  })
  it('兜帽 → 兜帽部件（库里确实有 hat_hood_cloth）', () => {
    const t = inferTraits({ description: '披着兜帽的旅人' })
    expect(t.headwear!.some(k => k.startsWith('hat_hood_'))).toBe(true)
  })
  it('王冠 → 王冠部件', () => {
    const t = inferTraits({ description: '头戴王冠的女王' })
    expect(t.headwear).toContain('hat_formal_crown')
  })
  it('单片眼镜：读到了设定，但因为没有素材而不加任何头饰', () => {
    /*
      有意为之的行为。上游**没有**眼镜类部件，所以这条规则的匹配关键词是空数组：
        - headwear 是空数组 ⇒ 配方不加头饰（而不是随机给一顶头盔）；
        - evidence 里仍留下「头饰:单片眼镜」⇒ 作者的设定被读到了。
      将来补了眼镜素材，把 id 填进 appearance.ts 那条规则即可。
    */
    const t = inferTraits({ description: '戴单片眼镜的管家' })
    expect(t.headwear).toBeDefined()
    expect(t.headwear).toHaveLength(0)
    expect(t.evidence.some(e => e.includes('单片眼镜'))).toBe(true)
  })
  it('胡须', () => {
    expect(inferTraits({ description: '留着络腮胡的铁匠' }).beard).toBe(true)
  })
  it('没有胡须线索时不设值', () => {
    expect(inferTraits({ description: '一个年轻人' }).beard).toBeUndefined()
  })
})

describe('外貌推断 · 性别', () => {
  it('显式 gender 字段优先', () => {
    expect(inferTraits({ gender: '女', description: '他站在那里' }).gender).toBe('female')
  })
  it('没有字段时从代词推断', () => {
    expect(inferTraits({ description: '她推开门' }).gender).toBe('female')
  })
  it('性别中立的年长表述不假定性别（旧版硬编码成男性）', () => {
    /*
      ⚠️ 这条断言**推翻了旧版行为**。
      旧版是 `if (age === 'elder' && !gender) gender = 'male'`，理由是
      "避免年长者抽到少女脸"。但那是个**用偏见治症状**的补丁：
        · 它把「四十出头的妇人」直接变成男脸（玩家截图反馈的就是这个）
        · 它并没有解决"抽到不合适的脸"，只是把不合适的方向固定成了男性
      正确做法是**不猜性别**，而让 pickHead 在性别未知时只从
      "年龄相符的池子"里挑（见 lpcSprite.test 的年龄一致性用例）。
    */
    expect(inferTraits({ description: '年迈的老者' }).gender).toBeUndefined()
  })

  /*
    ── 回归：自述性别名词 优先于 关系称谓 ──
    实测事故（70 张内置角色卡的立绘审计抓出来的）：
    两个明写「三十四岁男子」「三十七岁男子」的角色被判成 female，
    于是立绘给他们配了胡子，审计报"推断为女性却配了胡须"。

    原因是他们的 personality 里提到了**别人的**关系称谓：
      · 「他能把机器的煤耗算到磅，却算不清自己家里这个月的开销（他妻子算）」
      · 「他替自己和一个寡妇的账户各买了三百索尔——寡妇那笔钱没了」
    「妻子」「寡妇」被当成被描述者自己的性别证据。

    根治办法不是"再加几条剥除规则"（那是打地鼠），而是**排序**：
    `男子`/`女子` 这类自述性别名词几乎不会指别人，必须先判；
    `妻子`/`寡妇` 这类关系词默认指别人，只能当最后的兜底。
  */
  it('自述性别名词优先于关系称谓（妻子）', () => {
    const d = '三十四岁男子，工程师。他能把机器的煤耗算到磅，却算不清家里这个月的开销（他妻子算）。'
    expect(inferTraits({ description: d }).gender).toBe('male')
  })
  it('自述性别名词优先于关系称谓（寡妇）', () => {
    const d = '三十七岁男子，破产的股票经纪人。他替自己和一个寡妇的账户各买了三百索尔——寡妇那笔钱没了。'
    expect(inferTraits({ description: d }).gender).toBe('male')
  })
  it('关系词描述别人时，不能反转结论（女性版本同样成立）', () => {
    const d = '三十来岁的妇人，在码头替人记账。她丈夫三年前出海没回来，她一个人带着两个孩子。'
    expect(inferTraits({ description: d }).gender).toBe('female')
  })
  it('全文没有自述性别名词时，关系词仍可作兜底', () => {
    // 「老国王的侄女，寡居」——没有任何"女子/妇人"这类自述词，只能靠关系推断
    expect(inferTraits({ description: '老国王的侄女，寡居，三十岁上下' }).gender).toBe('female')
  })

  /*
    ── 回归：**分档**（2026-10 第二次修正）──

    扁平的性别表同时有**两个方向相反**的错，每个都有真实事故，
    而且它们互相掩盖 —— 修了一个就会踩到另一个：

    ① 「明确性别词」被「隐含性别的职业词」压过
       埃律西昂的冷鸢写的是「震旦天朝来的元婴**修士**，**女子**」。
       「修士」在西幻里指 friar（男），在中式修仙里却**男女通用**；
       它出现得更早，于是这位女修士长了男脸。

    ② 同一档里女性词排在男性词之前，于是**提到别人**的女性词赢了本人
       织命星典的艾德·黑钢写的是「二十六岁的**男性**……这道疤反而让他在
       **女性**群体中人气更高」——后者指的是别人，却把他画成了女性；
       埃律西昂的卡西乌斯（本人是「男子」，`relationship` 里提到「女皇」）同理。

    修法是**分档 + 档内比位置与年龄邻近**：
    明确性别词 → 隐含职业词 → 亲属短语 → 裸关系词 → 代词。
    两个案子因此同时判对（这两条断言就是照真实角色卡写的）。
  */
  it('★ 隐含性别的职业词不得压过明确性别词（"元婴修士，女子"）', () => {
    const d = '震旦天朝来的元婴修士，女子，在晚钟别馆的餐桌上用小勺吃一碗精灵香草沙拉。'
    expect(inferTraits({ description: d }).gender).toBe('female')
  })
  it('★ 提到别人的性别词不得反转本人（"二十六岁的男性……女性群体"）', () => {
    const d = '二十六岁的男性，帝国陆军少校。右嘴角有一道旧疤——征兵总局的调研显示这道疤反而让他在女性群体中人气更高。'
    expect(inferTraits({ description: d }).gender).toBe('male')
  })
  it('★ relationship 里提到「女皇」不得把本人判成女性', () => {
    expect(inferTraits({
      description: '阿斯特拉帝国的情报首脑，男子。他从帝都黑街一路爬上来。',
      relationship: '为女皇效力，掌管帝国的情报网。',
    }).gender).toBe('male')
  })
  it('只有隐含职业词时仍然可用它（西幻语境的「修士」）', () => {
    expect(inferTraits({ description: '一位云游的修士，背着旧书箱' }).gender).toBe('male')
  })
})

describe('外貌推断 · 裙装', () => {
  it('「长裙」「和服」等命中裙装', () => {
    for (const desc of ['穿着白色长裙', '一身红色和服', '裙摆很长', 'a long dress', 'wearing a skirt']) {
      expect(inferTraits({ description: desc }).skirt, desc).toBe(true)
    }
  })

  it('**没有**裙装线索时不误判 —— 这里踩过一个正则坑', () => {
    /*
      第一版 SKIRT_RE 里写了 `robe-like`，而正则里 `-` 是普通字符、
      `e` 被它修饰成"零或多个"，于是 `rob-?like` 实际匹配了
      `torso_clothes_shortsleeve` 里的 "robe"。
      结果"村里的年轻人"被判成穿裙装，拿到没有颜色变体的和服，
      而且裤腿与裙子同时出现。
    */
    for (const desc of ['村里的年轻人', '穿短袖的人', '一个普通的旅人', 'a villager']) {
      expect(inferTraits({ description: desc }).skirt, desc).toBeFalsy()
    }
  })

  it('裙装会去掉腿部件（否则裤腿从裙摆里透出来）', async () => {
    const { recipeFor } = await import('@/utils/lpcSprite')
    const dress = recipeFor('t1', { profile: { description: '穿着白色长裙的女子', gender: '女' }, gender: '女' })
    expect(dress.clothing).toMatch(/^dress_/)
    expect(dress.parts.some(p => /^legs_/.test(p)), '穿裙子时不应有腿部件').toBe(false)

    const pants = recipeFor('t2', { profile: { description: '穿长裤的旅人', gender: '男' }, gender: '男' })
    expect(pants.parts.some(p => /^legs_/.test(p)), '不穿裙子时应有腿部件').toBe(true)
  })

  it('裙装按描述的颜色选对应变体', async () => {
    const { recipeFor } = await import('@/utils/lpcSprite')
    const white = recipeFor('t3', { profile: { description: '穿着白色长裙', gender: '女' }, gender: '女' })
    expect(white.clothing).toMatch(/_white$/)
    const red = recipeFor('t4', { profile: { description: '穿着红色长裙', gender: '女' }, gender: '女' })
    expect(red.clothing).toMatch(/_red$/)
  })
})

describe('外貌推断 · 多色衣色', () => {
  it('收集全部衣色，并按出现位置排序（第一个是外衣）', () => {
    /*
      角色描述常写「黑色燕尾服，纯白的衬衫」这类搭配。
      只取第一个颜色会丢掉"白衬衫"，立绘就与描述不像 ——
      这是玩家反馈"贴合度不足"的常见原因之一。
    */
    const t = inferTraits({ description: '他身着黑色燕尾服，纯白的衬衫，颈系领结' })
    expect(t.cloth, '第一个（外衣）应为黑').toBe('black')
    expect(t.clothAll, '应收集到多个颜色').toBeTruthy()
    expect(t.clothAll!.length).toBeGreaterThanOrEqual(2)
    expect(t.clothAll).toContain('black')
    expect(t.clothAll, '白衬衫不能被丢掉').toContain('white')
  })

  it('顺序按文本位置，而不是词表顺序', () => {
    // 「棕色皮甲」在前、「绿色束腰」在后 → brown 必须是第一个
    const t = inferTraits({ description: '棕色皮甲配绿色束腰' })
    expect(t.cloth).toBe('brown')
    expect(t.clothAll![0]).toBe('brown')
  })

  it('单色描述不会产生多余项', () => {
    const t = inferTraits({ description: '穿着红色长裙的女子' })
    expect(t.cloth).toBe('red')
    expect(t.clothAll).toEqual(['red'])
  })

  /*
    ⚠️ 这条测试是为了防住一类**很难发现的表格不一致**：
    改衣色表时，brown 那一条漏用了 `clothRe()`、手写成窄列表
    `(?:衣|袍|裙|衫|服|甲|外套|大衣)` —— 里面没有「围裙」，
    于是「围着棕色围裙」推断不出衣色。
    `GARMENT` 常量里明明有围裙，但表格另写了一份 —— 两份词表不一致，
    而且不报错、只是静默失效。这里把两者接起来测。
  */
  const GARMENTS = [
    ['围裙', '围着棕色围裙的厨师'],
    ['外套', '穿橙色外套的人'],
    ['衬衫', '白色衬衫'],
    ['燕尾服', '黑色燕尾服'],
    ['制服', '蓝色制服的店员'],
    ['斗篷', '灰色斗篷'],
    ['皮甲', '绿色皮甲'],
    ['长袍', '紫色长袍'],
    ['和服', '红色和服'],
    ['胸甲', '银色胸甲'],
    ['马甲', '棕色马甲'],
    ['背心', '黑色背心'],
  ]
  for (const [label, desc] of GARMENTS) {
    it(`衣物名「${label}」能推出衣色：${desc}`, () => {
      expect(inferTraits({ description: desc }).cloth, `${label} 没推出衣色`).toBeTruthy()
    })
  }
})

describe('外貌推断 · evidence 可解释', () => {
  it('每个推断都留下原文依据', () => {
    const t = inferTraits({
      description: '黑发束成马尾的管家，戴单片眼镜，年迈',
    })
    expect(t.evidence.length).toBeGreaterThanOrEqual(3)
    for (const e of t.evidence) expect(e).toMatch(/[\u4e00-\u9fa5]/)
  })

  it('完全无特征时 evidence 为空数组（不是 undefined）', () => {
    expect(inferTraits({ description: '……' }).evidence).toEqual([])
  })
})

describe('调色板名解析', () => {
  const pal = ['black', 'dark_brown', 'blonde', 'silver', 'red', 'blue', 'green']

  it('精确命中', () => {
    expect(resolvePaletteName('black', pal)).toBe('black')
  })
  it('语义色 → 调色板里的实际名字', () => {
    expect(resolvePaletteName('silver', pal)).toBe('silver')
    expect(resolvePaletteName('blonde', pal)).toBe('blonde')
  })
  it('找不到候选时返回 undefined（让调用方回退到随机）', () => {
    expect(resolvePaletteName('chartreuse', pal)).toBeUndefined()
    expect(resolvePaletteName(undefined, pal)).toBeUndefined()
  })
  it('别名映射：调色板里没有该色时退到最近的一个', () => {
    // cloth 调色板里确有 white，所以直接命中
    expect(resolvePaletteName('white', ['white', 'black'])).toBe('white')
    // 只有 silver 的调色板里，white 退到 light
    expect(resolvePaletteName('white', ['silver', 'light'])).toBe('light')
  })
  it('大小写不敏感', () => {
    expect(resolvePaletteName('BLACK', ['Black', 'Red'])).toBe('Black')
  })
})
