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
import { sameCharacterName, dedupeCharacters } from './game'

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
