import { describe, it, expect } from 'vitest'
import { formatPlayer, formatCharacter } from '@/constants/prompts'
import type { PlayerCard, CharacterCard } from '@/types/cards'

/**
 * 提示词拼装对**脏数据**的容忍度。
 *
 * ## 为什么单独钉这个（2026-11，走查里真炸过一次）
 *
 * `formatPlayer` / `formatCharacter` 里原来是一串裸的 `.trim()`。
 * 类型上这些字段都是必填的，可**卡是外部输入** —— 导入的旧存档、
 * 手改过的 JSON、少写一栏的第三方世界包，运行时都可能给出 undefined。
 *
 * 后果很难看：玩家点「开始故事」，请求还没发出去就抛
 * `Cannot read properties of undefined (reading 'trim')`，
 * 屏幕上只有这一句英文 —— 他完全不知道是哪张卡、哪一栏。
 *
 * 所以这两条断言守的是"**永远能拼出一段提示词**"，而不是"内容对"：
 * 缺字段就少那一行，不该让整轮生成炸掉。
 */

describe('formatPlayer · 缺字段也要能拼出来', () => {
  it('★ 只有姓名：其余字段全缺，不抛错', () => {
    const p = { name: '古夜' } as unknown as PlayerCard
    const out = formatPlayer(p)
    expect(out).toContain('古夜')
    expect(out).not.toContain('undefined')
  })

  it('★ 字段是 undefined / null / 数字（脏存档的常见样子）都不炸', () => {
    const p = {
      name: '古夜',
      gender: undefined,
      age: null,
      appearance: 42,
      personality: undefined,
      background: null,
      extra: undefined,
    } as unknown as PlayerCard
    expect(() => formatPlayer(p)).not.toThrow()
    expect(formatPlayer(p)).toContain('古夜')
  })

  it('正常卡该有的行一条不少', () => {
    const p = {
      name: '古夜', gender: '男', age: '二十七',
      appearance: '黑衣长发', personality: '寡言', background: '北地', extra: '左手有旧伤',
    } as unknown as PlayerCard
    const out = formatPlayer(p)
    for (const s of ['男', '二十七', '黑衣长发', '寡言', '北地', '左手有旧伤']) expect(out).toContain(s)
  })
})

describe('formatCharacter · 同一套兜底', () => {
  it('★ 缺描述/性格/示例时只输出名字那一行，且不抛错', () => {
    const c = { name: '殷玥', relationship: '同行' } as unknown as CharacterCard
    expect(() => formatCharacter(c)).not.toThrow()
    const out = formatCharacter(c)
    expect(out).toContain('殷玥')
    expect(out).toContain('同行')
    expect(out).not.toContain('undefined')
  })
})
