/**
 * 「同一个人」的判定 —— 2026-11 第十一轮。
 *
 * ## 症状
 *
 * 玩家截图里人物栏出现两张「小满」卡片：一张「对伦纳德放下戒备」，
 * 一张「认伦纳德作师父」。同一个孩子，两条独立记录。
 *
 * ## 根因
 *
 * `addCharacter` 原本**只按 id 去重**，而 `Character.id` 是**模型自己编的**：
 * 这一轮写 `xiao_man`、下一轮写 `xiaoman_pcj`，或者干脆用中文名当 id。
 * 于是同一个角色被判成两个 —— 各自记一半经历，两半都不足以让模型认出他是谁。
 *
 * 修法是补一道按**名字**的兜底。这里钉住那道兜底的尺度：
 * 该合的一定要合，不该合的**绝不能**合（并错比分开更坏 ——
 * 模型会把甲的来历安到乙头上，玩家一眼就能看出不对）。
 */
import { describe, it, expect } from 'vitest'
import {
  sameCharacterName,
  dedupeCharacters,
  looksLikeSamePerson,
  longestCommonRun,
  looksLikeEpithet,
  pickSurvivingName,
} from './game'
import { emptyMemory, mergeMemory, renameInMemory } from '@/utils/memory'

const mk = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  description: `${name}的描述`,
  relationship: '未知',
  status: '正常',
  ...extra,
})

describe('sameCharacterName', () => {
  it('同名 → 同一个', () => {
    expect(sameCharacterName('小满', '小满')).toBe(true)
  })

  it('空白与大小写不敏感', () => {
    expect(sameCharacterName('小满 ', ' 小满')).toBe(true)
    expect(sameCharacterName('Bran', 'bran')).toBe(true)
  })

  it('括号里的注解不参与比较', () => {
    expect(sameCharacterName('小满（男孩）', '小满')).toBe(true)
    expect(sameCharacterName('小满(七八岁)', '小满')).toBe(true)
  })

  it('★ 不做包含判断：短名不会吃掉长名', () => {
    // 这条是**故意**的。"小满" ⊂ "小满的爷爷"，但那是两个人。
    expect(sameCharacterName('小满', '小满的爷爷')).toBe(false)
    expect(sameCharacterName('布兰登', '巡警布兰登')).toBe(false)
  })

  it('完全不同的名字 → 不同的人', () => {
    expect(sameCharacterName('小满', '炉边女人')).toBe(false)
  })

  it('空名字不算匹配（否则所有空名角色会并成一个）', () => {
    expect(sameCharacterName('', '')).toBe(false)
    expect(sameCharacterName('   ', '')).toBe(false)
    expect(sameCharacterName('（）', '')).toBe(false)
  })
})

describe('dedupeCharacters（旧存档迁移）', () => {
  it('★ 同一个人的两张卡合成一张 —— 这是玩家截图的那个 bug', () => {
    const out = dedupeCharacters([
      mk('xiao_man', '小满', { relationship: '对伦纳德放下戒备' }),
      mk('xiaoman_pcj', '小满', { relationship: '认伦纳德作师父' }),
    ] as never)
    expect(out).toHaveLength(1)
    // 后出现的关系覆盖先出现的（它更新）
    expect(out[0].relationship).toBe('认伦纳德作师父')
    // id 保留先出现的：knownBy / dossiers / 历史里的称呼都按它引用
    expect(out[0].id).toBe('xiao_man')
  })

  it('id 相同、名字也改过 → 合成一张', () => {
    const out = dedupeCharacters([mk('c1', '小满'), mk('c1', '小满（师父）')] as never)
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('小满')
  })

  it('不同的人一个都不许并', () => {
    const out = dedupeCharacters([mk('a', '小满'), mk('b', '炉边女人'), mk('c', '小满的爷爷')] as never)
    expect(out).toHaveLength(3)
  })

  it('幂等：跑两次结果一样（否则刷新两次就把人并乱了）', () => {
    const once = dedupeCharacters([mk('a', '小满'), mk('b', '小满 '), mk('c', '炉边女人')] as never)
    const twice = dedupeCharacters(once)
    expect(twice).toEqual(once)
  })

  it('坏数据（null / 非对象）被跳过，不让整个存档崩', () => {
    const out = dedupeCharacters([mk('a', '小满'), null, undefined, 42] as never)
    expect(out).toHaveLength(1)
  })
})

/* ────────────────────────────────────────────────────────────
   「一问名字就多个人」—— 2026-11 第二十四轮
   ──────────────────────────────────────────────────────────── */

/** 实测那两张卡（玩家截图）：名字毫无关系，指纹一模一样 */
const KID_A = {
  id: 'a',
  name: '当表的孩子',
  description: '七八岁的孩子，穿一件大了两号的旧罩衫，湿头发贴在额头上，眼睛很大很黑。',
  relationship: '被伦纳德请了一顿肉，开始信任他，愿意讲自己的事',
  status: '正吃着肉，讲自己的来历',
} as never

const KID_B = {
  id: 'b',
  name: '小石头',
  description: '七八岁的男孩，瘦，穿一件大了两号的旧罩衫，头发乱蓬蓬的。爷爷从河边把他捡回来。',
  relationship: '被伦纳德请了一顿肉，开始信任他',
  status: '在酒馆里吃着面包',
} as never

describe('looksLikeSamePerson · 名字不同也要认出来', () => {
  it('★ 关系文案互相包含 + 描述有大段重复 → 同一个人', () => {
    expect(looksLikeSamePerson(KID_A, KID_B)).toBe(true)
  })

  it('只看关系文案也够（描述被模型改写时）', () => {
    const a = { ...(KID_A as object), description: '另一个孩子' } as never
    expect(looksLikeSamePerson(a, KID_B)).toBe(true)
  })

  it('只看描述也够（关系文案变了时）', () => {
    const b = { ...(KID_B as object), relationship: '欠他一枚铜钱' } as never
    expect(looksLikeSamePerson(KID_A, b)).toBe(true)
  })

  it('★ 泛泛的关系文案不算（「对他有戒心」只有 6 个字，够不到 8）', () => {
    const a = { id: 'x', name: '甲', description: '一个守卫', relationship: '对他有戒心', status: '' } as never
    const b = { id: 'y', name: '乙', description: '另一个守卫', relationship: '对他有戒心', status: '' } as never
    expect(looksLikeSamePerson(a, b)).toBe(false)
  })

  it('两个不同的人（描述各写各的）不许并', () => {
    const a = { id: 'x', name: '甲', description: '独眼的押运工，左脸一道疤', relationship: '收钱办事', status: '' } as never
    const b = { id: 'y', name: '乙', description: '瘦高的当铺朝奉，戴一副圆框眼镜', relationship: '压价收当', status: '' } as never
    expect(looksLikeSamePerson(a, b)).toBe(false)
  })
})

describe('longestCommonRun', () => {
  it('找出最长连续相同片段', () => {
    expect(longestCommonRun('穿一件大了两号的旧罩衫', '瘦，穿一件大了两号的旧罩衫，头发')).toBe(11)
  })

  it('忽略标点与空白', () => {
    expect(longestCommonRun('七八岁的孩子', '七八岁，的孩子')).toBe(6)
  })

  it('没有共同片段时是 0', () => {
    expect(longestCommonRun('押运工', '圆框镜')).toBe(0)
  })
})

describe('looksLikeEpithet / pickSurvivingName', () => {
  it('「当表的孩子」是称呼，「小石头」不是', () => {
    expect(looksLikeEpithet('当表的孩子')).toBe(true)
    expect(looksLikeEpithet('那个穿旧罩衫的男孩')).toBe(true)
    expect(looksLikeEpithet('小石头')).toBe(false)
    expect(looksLikeEpithet('小满')).toBe(false)
  })

  it('★ 称呼不覆盖名字（否则卡片标题会变成「当表的孩子」）', () => {
    expect(pickSurvivingName('小满', '当表的孩子')).toBe('小满')
  })

  it('★ 真名要落地（「问名字」这个动作的全部意义）', () => {
    expect(pickSurvivingName('小满', '小石头')).toBe('小石头')
  })

  it('只差括号注解时保留原写法', () => {
    expect(pickSurvivingName('小满', '小满（师父）')).toBe('小满')
  })
})

describe('renameInMemory · 改名 = 身份迁移', () => {
  const base = mergeMemory(emptyMemory(), {
    dossiers: { 小满: ['爷爷上月去世，临终把怀表给了他'] },
    knownBy: { 小满: ['在成衣行做工'] },
    bonds: [{ who: '小满', state: '认得他' }],
    affinity: [{ who: '小满', inner: '近', outer: '疏' }],
  })

  it('★ 四层全部跟着改名（否则这个人等于从记忆里被删掉）', () => {
    const m = renameInMemory(base, '小满', '小石头')
    expect(m.dossiers['小石头']).toEqual(['爷爷上月去世，临终把怀表给了他'])
    expect(m.dossiers['小满']).toBeUndefined()
    expect(m.knownBy['小石头']).toEqual(['在成衣行做工'])
    expect(m.knownBy['小满']).toBeUndefined()
    expect(m.bonds).toEqual([{ who: '小石头', state: '认得他' }])
    expect(m.affinity).toEqual([{ who: '小石头', inner: '近', outer: '疏' }])
  })

  it('目标名下已有条目时**合并**，不覆盖（覆盖会丢掉一半经历）', () => {
    const withBoth = mergeMemory(emptyMemory(), {
      dossiers: { 小满: ['旧事一'], 小石头: ['新事二'] },
    })
    const m = renameInMemory(withBoth, '小满', '小石头')
    expect(m.dossiers['小石头']).toHaveLength(2)
    expect(m.dossiers['小石头'].join()).toContain('旧事一')
    expect(m.dossiers['小石头'].join()).toContain('新事二')
  })

  it('bonds 是「现状」：目标已有一条时保留目标那条（它更新）', () => {
    const withBoth = mergeMemory(emptyMemory(), {
      bonds: [{ who: '小满', state: '旧关系' }, { who: '小石头', state: '新关系' }],
    })
    const m = renameInMemory(withBoth, '小满', '小石头')
    expect(m.bonds).toHaveLength(1)
    expect(m.bonds[0].state).toBe('新关系')
  })

  it('新旧同名 → 原样返回（不做无意义的迁移）', () => {
    expect(renameInMemory(base, '小满', '小满')).toEqual(base)
  })
})

describe('dedupeCharacters · 指纹合并 + 回调改名', () => {
  it('★ 名字完全不同也合成一张，并回调改名（供 store 迁移记忆键）', () => {
    const renamed: [string, string][] = []
    const out = dedupeCharacters([KID_A, KID_B], (o, n) => renamed.push([o, n]))
    expect(out).toHaveLength(1)
    // id 保留先出现的那条（记忆里的键按它引用）
    expect(out[0].id).toBe('a')
    /*
      名字这一条有讲究：先登记的是**称呼**（「当表的孩子」），
      后登记的是**真名**（「小石头」）—— 后者才该留下。
      反过来（先真名、后称呼）时名字不变，见下一条。
    */
    expect(out[0].name).toBe('小石头')
    expect(renamed).toEqual([['当表的孩子', '小石头']])
  })

  it('先出现的是真名、后出现的是称呼 → 名字不变', () => {
    const out = dedupeCharacters([KID_B, KID_A] as never)
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('小石头')
  })

  it('★ 改名后旧名进别名表（否则旧名下的线索会从抽屉里消失）', () => {
    const out = dedupeCharacters([KID_A, KID_B] as never)
    expect(out[0].aka).toEqual(['当表的孩子'])
  })
})
