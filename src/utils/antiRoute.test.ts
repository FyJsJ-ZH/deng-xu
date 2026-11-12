import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ANTI_ROUTE,
  renderAntiRoute,
  routeAnchor,
  antiRouteActive,
  nextTier, nextRefract, nextTrunc,
  type AntiRouteConfig,
} from '@/utils/antiRoute'

/**
 * 防降级加固层（2026-11，从酒馆脚本「卢克之光 V0.94」移植）。
 *
 * 这一层最容易出的不是"文案不好"，而是三件事：
 *  1. **没开也注入** —— 玩家明明全关，token 却在涨；
 *  2. **不幂等** —— 流式失败后重发一次，提示词就变了（等于加固层自己成了指纹）；
 *  3. **占位符漏进正文** —— `<user>` 之类没换掉，模型照着抄。
 * 所以这三条先钉死，再谈文案。
 */

const cfg = (p: Partial<AntiRouteConfig> = {}): AntiRouteConfig => ({ ...DEFAULT_ANTI_ROUTE, ...p })

describe('防降级 · 开关语义', () => {
  it('★ 全关时一个字都不注入', () => {
    expect(antiRouteActive(DEFAULT_ANTI_ROUTE)).toBe(false)
    expect(renderAntiRoute(DEFAULT_ANTI_ROUTE, { userName: '林晚' })).toBe('')
    expect(renderAntiRoute(undefined, { userName: '林晚' })).toBe('')
    expect(renderAntiRoute(null)).toBe('')
  })

  it('★ 反 OOC 总闸关着时，四个子项即使都为 true 也不注一个字', () => {
    const c = cfg({ ooc: false, oocRoll: true, oocTpl: true, oocChg: true, oocVoice: true })
    expect(renderAntiRoute(c, { userName: '林晚', cast: ['老周'] })).toBe('')
  })

  it('三档循环：关 → 轻 → 强 → 关', () => {
    expect(nextTier('off')).toBe('lite')
    expect(nextTier('lite')).toBe('full')
    expect(nextTier('full')).toBe('off')
    expect(nextRefract('off')).toBe('light')
    expect(nextRefract('light')).toBe('mid')
    expect(nextRefract('mid')).toBe('off')
    expect(nextTrunc('off')).toBe('lite')
    expect(nextTrunc('lite')).toBe('mid')
    expect(nextTrunc('mid')).toBe('off')
  })
})

describe('防降级 · 文案', () => {
  it('★ 防全知没有把占位符漏出去（<user> 之类）', () => {
    const text = renderAntiRoute(cfg({ know: 'full' }), { userName: '林晚' })
    expect(text).toContain('画面可以拉远，人不行')
    expect(text).not.toMatch(/<user>|\{\{user\}\}/)
  })

  it('★ 去媚把主角名换进去了', () => {
    const text = renderAntiRoute(cfg({ charm: 'full' }), { userName: '林晚' })
    expect(text).toContain('林晚')
    expect(text).not.toContain('<user>')
    // 拿不到名字时退回「你」，仍然不留占位符
    const fallback = renderAntiRoute(cfg({ charm: 'full' }), {})
    expect(fallback).not.toContain('<user>')
  })

  it('★ 抗截断带上当前的目标字数', () => {
    const text = renderAntiRoute(cfg({ trunc: 'lite' }), { replyLength: 2400 })
    expect(text).toContain('不少于 2400 字')
    expect(text).toContain('不能停在半句')
    expect(text).toContain('以上就是')
  })

  it('抗截断：字数未知时不编一个数出来', () => {
    const text = renderAntiRoute(cfg({ trunc: 'mid' }), {})
    expect(text).not.toMatch(/不少于\s*\d+\s*字/)
    expect(text).toContain('不能停在半句')
  })

  it('点名会把在场角色列出来', () => {
    const text = renderAntiRoute(cfg({ ooc: true, oocRoll: true, oocTpl: false, oocChg: false, oocVoice: false }), {
      userName: '林晚', cast: ['老周', '阿蘅'],
    })
    expect(text).toContain('老周、阿蘅')
  })
})

describe('防路由 · 幂等与随机', () => {
  it('★ 同一个种子两次渲染完全一致（重发不能变成新指纹）', () => {
    const c = cfg({ refract: 'light', know: 'lite' })
    const a = renderAntiRoute(c, { seed: 't3|w1', replyLength: 1800 })
    const b = renderAntiRoute(c, { seed: 't3|w1', replyLength: 1800 })
    expect(a).toBe(b)
  })

  it('★ 换了轮次就换一个标记（这才叫随机）', () => {
    const a = routeAnchor('light', 't3|w1')
    const b = routeAnchor('light', 't4|w1')
    expect(a).not.toBe(b)
  })

  it('★ 标记永远在**末尾** —— 前面几万 token 的前缀缓存照常命中', () => {
    const text = renderAntiRoute(cfg({ refract: 'light', know: 'lite' }), { seed: 't1', userName: '林晚' })
    expect(text.trimEnd().endsWith('〕')).toBe(true)
    expect(text.indexOf('〔本轮标记')).toBeGreaterThan(text.indexOf('画面可以拉远'))
  })

  it('mid 档多一句「不要引用」，免得模型去解释它', () => {
    expect(routeAnchor('mid', 'x')).toContain('不要引用')
    expect(routeAnchor('off', 'x')).toBe('')
  })
})

describe('防降级 · 失败安全', () => {
  it('★ 传进来的东西再脏也不抛错，最差就是什么都不注', () => {
    const bad = { ...DEFAULT_ANTI_ROUTE, know: 'weird', charm: undefined } as unknown as AntiRouteConfig
    expect(() => renderAntiRoute(bad, { userName: undefined, cast: undefined })).not.toThrow()
  })
})
