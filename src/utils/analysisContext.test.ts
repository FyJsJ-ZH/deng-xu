import { describe, it, expect } from 'vitest'
import { slimCharactersForAnalysis, ANALYSIS_DESC_LIMIT } from '@/utils/analysisContext'
import type { Character } from '@/stores/game'

/**
 * 「正文极快，三十秒就出，结算却慢，三四分钟才好」（2026-11 玩家原话）。
 *
 * 结算那一次请求原来是 `JSON.stringify(afterNarrative.characters)` ——
 * 角色卡上挂着 `avatar`（base64 data URL）、`look`（LPC 立绘部件）、
 * `prompt`（整份人物资料），全部跟着报文一起发出去，几十万字符。
 *
 * 那一整坨对「这一轮数值该不该变」毫无用处，而模型要为它完整思考一遍。
 *
 * 这一组钉住：**这些东西一个都不许进结算报文**。
 */

const base = (over: Partial<Character> = {}): Character => ({
  id: 'c1',
  name: '苏黎',
  description: '行政与法务联合核查室的科员。',
  relationship: '被拿捏把柄的核查对象',
  status: '在岗',
  ...over,
})

describe('结算报文里的角色卡', () => {
  it('★ avatar（base64）不进报文 —— 一张几十 KB 的图片它一个字都用不上', () => {
    const fat = base({
      avatar: 'data:image/png;base64,' + 'A'.repeat(50_000),
    })
    const out = slimCharactersForAnalysis([fat]) as any[]
    expect(JSON.stringify(out)).not.toContain('base64')
    expect(out[0].avatar).toBeUndefined()
  })

  it('★ prompt 与 look 也不进报文', () => {
    const fat = base({
      prompt: '这是一整份角色卡的人物资料，'.repeat(200),
      look: { body: 'x', head: 'y' } as any,
      avatarId: 'npc_female_1',
    })
    const out = slimCharactersForAnalysis([fat]) as any[]
    expect(out[0].prompt).toBeUndefined()
    expect(out[0].look).toBeUndefined()
    expect(out[0].avatarId).toBeUndefined()
  })

  it('★ 体积对比：50 KB 的头像卡，裁完不到 1 KB', () => {
    const fat = base({
      avatar: 'data:image/png;base64,' + 'A'.repeat(50_000),
      prompt: '资料'.repeat(3000),
    })
    const before = JSON.stringify([fat]).length
    const after = JSON.stringify(slimCharactersForAnalysis([fat])).length
    expect(before).toBeGreaterThan(50_000)
    expect(after).toBeLessThan(1_000)
  })

  it('description 截到 400 字 —— 结算看的是这一轮发生了什么，不是人物小传', () => {
    const long = base({ description: '人'.repeat(3000) })
    const out = slimCharactersForAnalysis([long]) as any[]
    expect(out[0].description).toHaveLength(ANALYSIS_DESC_LIMIT)
  })

  it('判断要用的字段一个都不少', () => {
    const c = base({
      location: '第 43 层配给科',
      aka: ['郑铖'],
      stats: { lan: 2 } as any,
    })
    const out = slimCharactersForAnalysis([c]) as any[]
    expect(out[0]).toMatchObject({
      id: 'c1',
      name: '苏黎',
      description: '行政与法务联合核查室的科员。',
      relationship: '被拿捏把柄的核查对象',
      status: '在岗',
      location: '第 43 层配给科',
      aka: ['郑铖'],
    })
  })

  it('可选字段空着就不出现（少一个键就是少几个 token）', () => {
    const out = slimCharactersForAnalysis([base()]) as any[]
    expect(out[0]).not.toHaveProperty('location')
    expect(out[0]).not.toHaveProperty('aka')
    expect(out[0]).not.toHaveProperty('stats')
  })

  it('undefined / 空数组都安全（开局那几轮里角色表还是空的）', () => {
    expect(slimCharactersForAnalysis(undefined)).toEqual([])
    expect(slimCharactersForAnalysis([])).toEqual([])
  })

  it('多个人时按原顺序保留 —— 顺序是提示词的一部分', () => {
    const out = slimCharactersForAnalysis([
      base({ id: 'c1', name: '甲' }),
      base({ id: 'c2', name: '乙' }),
      base({ id: 'c3', name: '丙' }),
    ]) as any[]
    expect(out.map(c => c.name)).toEqual(['甲', '乙', '丙'])
  })
})
