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
 *   ② 信息投放（新事是上限不是配额，线索不许当填充物）
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
  it('★ 三块结构都在：这一场在哪 / 事情怎么走 / 落到结果上', () => {
    const out = promptOf(mkWorld())
    expect(out).toContain('这一场在哪、谁在')
    expect(out).toContain('事情怎么往前走')
    expect(out).toContain('落到一个具体的结果上')
  })

  it('★ 结尾的局面必须与开头不同（否则这一轮白走）', () => {
    expect(promptOf(mkWorld())).toMatch(/结尾必须与开头\*\*不同\*\*/)
  })

  it('结果那块要交代"这一场变了什么"（灯芯、雨、多出来的人）', () => {
    expect(promptOf(mkWorld())).toMatch(/以及这一场变了什么/)
  })

  it('写不完就留到下一轮，不许压成梗概', () => {
    expect(promptOf(mkWorld())).toMatch(/留到下一轮/)
  })
})

/**
 * 场景、氛围、人 —— **这是上一轮矫正过头的回归**（2026-11）。
 *
 * ## 上一轮我改坏了什么
 *
 * 为了治「字数花在景物上」，我写了两句过头的话：
 *  - 「要写的是办这件事的过程，**不是这件事周围的世界**」
 *  - 凑字数禁项里第一条是「**连着三段景物**」
 *
 * 玩家立刻打回：
 * > 「输出的正文也不能完全只有主角的行动，必须得符合场景，
 * >  一些帮助玩家体验世界氛围感的景色，场景，氛围，角色行动与 npc 都是必不可少的」
 *
 * 他说得对。这个项目卖的就是**能看见的世界**（九部世界书写了 40 万字志书），
 * 正文里没有场景，那些设定就白写了。
 *
 * ## 正确的判据不是「少写景物」
 *
 * 是「**这段景物换到别的场景还成立吗**」：
 *  - 「街上飘着细雨，远处传来钟声」→ 换到哪都成立 = 背景板
 *  - 「柜台比人高，得仰着头说话；窗上糊纸，只透进一线光，正照在掌柜翻账本的手上」
 *    → 换不走 = 这一场
 *
 * 下面这组断言盯的就是「判据还在不在」，防止下一次又改回「别写景物」。
 */
describe('场景 · 氛围与人不许缺席（回归）', () => {
  it('★ 有独立一节讲场景、氛围、人', () => {
    expect(promptOf(mkWorld())).toContain('场景、氛围、人，一个都不许缺席')
  })

  it('★ 判据是「换到别的场景还成立吗」，给了正反两个例子', () => {
    const out = promptOf(mkWorld())
    expect(out).toMatch(/这段描写换到别的场景还成立吗/)
    expect(out).toContain('背景板')
    expect(out).toContain('这是这一场')
  })

  it('★ 要求至少一个 NPC 动手（不能只有台词）', () => {
    const out = promptOf(mkWorld())
    expect(out).toMatch(/至少一个 NPC 要动手/)
    // 要给出可照做的动作，否则等于没说
    for (const act of ['拨算盘', '擦柜台']) expect(out).toContain(act)
  })

  it('★ 每一轮至少三样东西能被看见（场所 / 人的动作 / 声音或气味）', () => {
    expect(promptOf(mkWorld())).toMatch(/每一轮至少三样东西是能被看见的/)
  })

  it('★ 天气光线气味要参与事情，不是报幕', () => {
    const out = promptOf(mkWorld())
    expect(out).toMatch(/要参与事情，不是报幕/)
    expect(out).toContain('光暗，所以账本要凑近看')
  })

  it('★ 明确写清：与这一场咬合的景物**不是**灌水', () => {
    /*
      这一条是整组的核心。上一轮的错误就是没有这句区分，
      模型把「禁止灌水」读成了「禁止景物」。
    */
    const out = promptOf(mkWorld())
    expect(out).toMatch(/与这一场咬合的景物\*\*不是\*\*灌水/)
    expect(out).toMatch(/「柜台有多高」这一句删掉，这一场就变了/)
  })

  it('三块里的第一块必须包含场所与人（不是只写"谁在这里"）', () => {
    const out = promptOf(mkWorld())
    expect(out).toMatch(/场所的物质细节、在场的人各自正在做什么/)
  })

  it('战斗版同样要求场地参与（脚下/光/背后）', () => {
    const combat = mkWorld({ combatPacing: true })
    expect(promptOf(combat)).toMatch(/场地要参与进来/)
  })
})

/**
 * 玩家第四条投诉：「一章实际上并没有达到 1200 字」。
 *
 * 根因有两层，这一层是**提示词层**（另一层是 `max_tokens`，见 `api/llm.ts`）：
 *  1. 只说「约 N 字」，没有下限 —— 模型写 600 字也算"完成任务"；
 *  2. 没有告诉它**篇幅该花在哪** —— 于是它把字数花在景物与心理上，
 *     玩家真正做的那件事只占三分之一。
 */
describe('篇幅 · 字数要有硬门槛，且花在玩家的行动上', () => {
  it('★ 给出下限（目标字数的七成），不是只给目标', () => {
    const out = promptOf(mkWorld())   // replyLength = 1800
    expect(out).toContain('下限 1260 字')
  })

  it('★ 要求自己数一遍，不够就接着写、不许收尾', () => {
    const out = promptOf(mkWorld())
    expect(out).toMatch(/写完之后自己数一遍/)
    expect(out).toMatch(/不要收尾/)
  })

  it('★ 核心要求：篇幅要花在玩家做的事上', () => {
    const out = promptOf(mkWorld())
    expect(out).toContain('篇幅要花在**玩家做的事**上')
    expect(out).toMatch(/玩家这一轮说要做的事，就是这一场的主线/)
  })

  it('★ 玩家提到的每一样东西都要有下文', () => {
    expect(promptOf(mkWorld())).toMatch(/他提到的每一样东西都要有下文/)
  })

  it('给了可照做的例子（当铺赎外套 → 五步）', () => {
    const out = promptOf(mkWorld())
    expect(out).toContain('当铺')
    expect(out).toContain('当票')
  })

  it('★ 明令禁止五种凑字数的手法', () => {
    const out = promptOf(mkWorld())
    expect(out).toMatch(/不许用这些东西凑字数/)
    for (const t of ['景物', '心理独白', '升华句']) expect(out).toContain(t)
  })

  it('「什么也没做」的那一轮另有写法（把环境写厚，但必须有人）', () => {
    const out = promptOf(mkWorld())
    expect(out).toMatch(/什么也没做/)
    expect(out).toMatch(/但即使这样也要有人/)
  })
})

describe('信息投放 · 线索不许当填充物', () => {
  /*
    ⚠️ 这里原先断言的是「一轮只出一件新事」。
    模型把它读成了**下限**（玩家报：「必须要写出一件新事，有点太刻意了」），
    于是每轮真去凑一条新线索。现在标题与正文都改成**上限**口吻，
    并显式写明「一件都不出也正常」。断言的语义没变，跟着文案走。
  */
  it('★ 新事是上限不是下限：写明了「一件都不出也正常」', () => {
    const out = promptOf(mkWorld())
    expect(out).toContain('新东西是写到那儿自己长出来的，不是每轮要交的指标')
    expect(out).toMatch(/上限是\*\*一件\*\*/)
    expect(out).toMatch(/一件都不出也正常/)
    // 反向：不许再出现"必须出一件"那种配额口吻
    expect(out).not.toMatch(/只出一件/)
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

describe('十二张内置卡 · 都按新篇幅落地了', () => {
  it('★ 每张卡的目标字数都不低于 1000（不许哪一张被改回去）', () => {
    for (const w of BUILTIN_WORLDS) {
      expect(w.narrative.replyLength, `《${w.title}》`).toBeGreaterThanOrEqual(1000)
    }
  })

  it('★ 世界卡文风里写的字数，必须等于它自己的 replyLength', () => {
    /*
      ## 为什么改成「比对」而不是「查旧值」

      这一段原来是一条查旧数字的正则。它在 800→1800 和 1800→2400 各改过一次，
      **每次都要重写一遍正则**，而漏改一次就会让测试和实现互相打脸 ——
      而这条测试存在的本意恰恰是"防止两边打架"。

      所以判据换成本质的那一条：**文风里只要点了字数，就必须等于 `replyLength`**。
      改参数不改文风、或改文风不改参数，都会红，且不需要维护任何"旧值清单"。

      历史旧值（供参考）：八百 / 一千八百 / 两千四百 —— 下一个值是什么都不重要。
    */
    const STATED = [
      { n: 800, re: /(?<!千)八百(?:五十)?字|(?<!\d)80[05]\s*字/ },
      { n: 1100, re: /一千一百字|(?<!\d)1100\s*字/ },
      { n: 1800, re: /一千八百字|(?<!\d)1800\s*字/ },
      { n: 2400, re: /两千四百字|(?<!\d)2400\s*字/ },
    ]
    for (const w of BUILTIN_WORLDS) {
      const text = `${w.narrative.customStyle}\n${w.rules}`
      for (const { n, re } of STATED) {
        if (!re.test(text)) continue
        expect(n, `《${w.title}》文风里写的是 ${n} 字，但 replyLength 是 ${w.narrative.replyLength}`)
          .toBe(w.narrative.replyLength)
      }
    }
  })

  it('每张卡生成的提示词都带上了自己的目标字数', () => {
    for (const w of BUILTIN_WORLDS) {
      expect(promptOf(w)).toContain(`约 ${w.narrative.replyLength} 字`)
    }
  })
})

/**
 * 战斗向世界（`WorldCard.combatPacing`）。
 *
 * ## 为什么这组测试值得单独写
 *
 * 做《刀口账》时发现的坑，而且**光靠世界卡的 rules 修不了**：
 *
 *  - `rules` 注入在提示词第三位，篇幅节在第九位；
 *  - 这个文件里对「沙盒优先」的注释已经写明「靠后的段落更容易被当成更近的指令」；
 *  - 于是 rules 里写「战斗例外」会被篇幅节的「写不顺手的地方」压回去。
 *
 * 所以要有一个引擎开关。而开关最大的风险不是"开了不管用"，是**"不小心开到别的世界上"**，
 * 后者会让九张生活流世界全部退化成打斗流水账 —— 所以最后一条测试盯着这件事。
 */
describe('战斗向世界 · 篇幅节要换一套节拍', () => {
  const combatWorld = (over: Partial<WorldCard> = {}) => mkWorld({ combatPacing: true, ...over })

  it('★ 默认（不填）时，行为与之前完全一致', () => {
    const out = promptOf(mkWorld())
    expect(out).toMatch(/写不顺手的地方/)
    expect(out).toMatch(/上限是\*\*一件\*\*/)
    expect(out).not.toContain('交手例外')
    expect(out).not.toContain('不要停在半招上')
  })

  it('★ 开了开关：过程块改成动作节拍', () => {
    const out = promptOf(combatWorld())
    expect(out).toMatch(/打起来的时候句子要短/)
    expect(out).toMatch(/动作要连着走完一串，写到分出上风为止/)
    expect(out).toMatch(/不要停在半招上/)
  })

  it('★ 开了开关：反爽的那一句必须消失', () => {
    // 「写不顺手的地方」在生活流里对、在战斗里错：它逼 AI 每轮写"这一刀砍空了"
    expect(promptOf(combatWorld())).not.toMatch(/写不顺手的地方/)
  })

  it('战斗版反过来把「砍空了」写成禁令', () => {
    expect(promptOf(combatWorld())).toContain('不要写「这一刀砍空了」')
  })

  it('★ 开了开关：打斗不许停在中途问玩家要不要继续', () => {
    const out = promptOf(combatWorld())
    expect(out).toContain('交手例外')
    expect(out).toMatch(/分出上风之后再停/)
  })

  it('两版共有的部分仍然在（这一场在哪 / 结果 / 场景 / 世情 / 留到下一轮）', () => {
    for (const w of [mkWorld(), combatWorld()]) {
      const out = promptOf(w)
      expect(out).toContain('这一场在哪、谁在')
      expect(out).toContain('落到一个具体的结果上')
      expect(out).toContain('场景、氛围、人，一个都不许缺席')
      expect(out).toContain('留到下一轮')
      expect(out).toContain('不写说明文')
      expect(out).toContain('不要主动投喂')
    }
  })

  it('目标字数在两版里都照常生效', () => {
    expect(promptOf(combatWorld({ narrative: { pov: 'third', tense: 'present', replyLength: 2200, customStyle: '' } })))
      .toContain('约 2200 字')
  })

  it('★ 九张内置卡都不许开这个开关（它们全是生活流，开了就全变打斗流水账）', () => {
    for (const w of BUILTIN_WORLDS) {
      expect(w.combatPacing ?? false, `《${w.title}》不该开 combatPacing`).toBe(false)
    }
  })
})

/**
 * 在场的人不是等主角开口的道具（2026-11）。
 *
 * ## 玩家原话
 *
 * > 「优化 npc 之间的互动，他们一般来说不是围绕着主角进行（除非他们的目的就是主角），
 * >  当主角确实做出了会影响到整个场景或 npc 的行动，或主角搭话时，
 * >  npc 再把注意力转向主角」
 *
 * ## 改之前的状况
 *
 * 提示词里只有「NPC 独立意志：可以拒绝、撒谎、误解、主动行动」——
 * 那说的是**态度**，不是**注意力**。模型于是默认：主角一进画面，
 * 所有人放下手里的事看着他。世界成了摄影棚：所有灯都打在主角身上。
 *
 * 而这一层是**默认行为**，不写就会一直这样 —— 所以必须有独立一节，且要有断言。
 */
describe('NPC 自主 · 他们不是围着主角转的', () => {
  it('★ 有独立一节讲这件事', () => {
    expect(promptOf(mkWorld())).toContain('在场的人，不是等主角开口的道具')
  })

  it('★ 「什么时候才转向主角」给了三条判据（不是笼统的一句"看情况"）', () => {
    const out = promptOf(mkWorld())
    expect(out).toMatch(/主角搭话/)
    expect(out).toMatch(/牵动这一场的事/)
    expect(out).toMatch(/存在本身造成了麻烦/)
  })

  it('★ 要求 NPC 之间至少一次交换（不只有"主角—NPC"这根线）', () => {
    const out = promptOf(mkWorld())
    expect(out).toMatch(/至少让两个 NPC 之间发生一次交换/)
    expect(out).toMatch(/哪怕主角一个字都听不懂/)
  })

  it('★ 明确禁止"一见主角就放下手里的活"（最假的反应）', () => {
    expect(promptOf(mkWorld())).toMatch(/别让他们一见主角就放下手里的东西/)
  })

  it('★ 转向之后要落回去（世界活着的感觉来自这一"回"）', () => {
    expect(promptOf(mkWorld())).toMatch(/转向之后也要落回去/)
  })

  it('★ 不许排队：三个人同时看向主角是演出，不是场景', () => {
    expect(promptOf(mkWorld())).toMatch(/不要让他们排队/)
  })

  it('★ 留了例外：目的就是主角的角色不受这条约束', () => {
    expect(promptOf(mkWorld())).toMatch(/除非这个角色的目的\*\*就是\*\*主角/)
  })

  it('位置：在「主角」之后（先给档案再讲怎么动）', () => {
    const out = promptOf(mkWorld())
    const hero = out.indexOf('## 主角（玩家角色）')
    const npc = out.indexOf('## 在场的人，不是等主角开口的道具')
    expect(hero).toBeGreaterThanOrEqual(0)
    expect(npc).toBeGreaterThan(hero)
  })
})
