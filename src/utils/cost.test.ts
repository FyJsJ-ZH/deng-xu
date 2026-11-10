import { describe, it, expect } from 'vitest'
import { estimateCost, formatCost, isPeakHour, priceBookFor, priceSourceNote } from '@/utils/cost'
import { addUsage, type TokenUsage } from '@/stores/game'

/**
 * 计价。
 *
 * ## 这组测试的来由
 *
 * 玩家报：「之前有个存档显示我历史累计用了 30 多块钱，但我感觉没有那么多」。
 *
 * 查出来旧实现是一行写死的常量 —— **1 元/百万输入、2 元/百万输出**。
 * 而 DeepSeek 官方 2026 年的价目表里，输出是 **4 元（空闲）/ 8 元（高峰）**，
 * 也就是说这个项目最贵的那一半（每轮一两千字的小说正文）被低估了二到四倍；
 * 同时它不分峰谷、也不分服务商 —— 换个 OpenAI 端点，那个金额就是编的。
 *
 * 所以这里把口径钉死：按服务商查表、按时刻判峰谷、拿不到价目就不出金额。
 */
const u = (p: number, c: number, hit?: number): TokenUsage => {
  const out: TokenUsage = { promptTokens: p, completionTokens: c, totalTokens: p + c, estimated: false }
  if (hit !== undefined) out.cacheHitTokens = hit
  return out
}

/** 北京时间周二 10:00 —— 高峰 */
const PEAK = new Date('2026-11-10T10:00:00+08:00')
/** 北京时间周二 22:00 —— 空闲 */
const IDLE = new Date('2026-11-10T22:00:00+08:00')

describe('isPeakHour：北京时间峰谷', () => {
  const at = (iso: string) => new Date(iso)

  it('工作日 9:00–12:00 与 14:00–18:00 是高峰', () => {
    expect(isPeakHour(at('2026-11-10T09:00:00+08:00'))).toBe(true)
    expect(isPeakHour(at('2026-11-10T11:59:00+08:00'))).toBe(true)
    expect(isPeakHour(at('2026-11-10T14:00:00+08:00'))).toBe(true)
    expect(isPeakHour(at('2026-11-10T17:59:00+08:00'))).toBe(true)
  })

  it('午休、早晚、深夜都是空闲', () => {
    expect(isPeakHour(at('2026-11-10T08:59:00+08:00'))).toBe(false)
    expect(isPeakHour(at('2026-11-10T12:00:00+08:00'))).toBe(false)
    expect(isPeakHour(at('2026-11-10T13:59:00+08:00'))).toBe(false)
    expect(isPeakHour(at('2026-11-10T18:00:00+08:00'))).toBe(false)
    expect(isPeakHour(at('2026-11-10T23:30:00+08:00'))).toBe(false)
  })

  it('周末全天都是空闲', () => {
    // 2026-11-08 是周日，2026-11-07 是周六
    expect(isPeakHour(at('2026-11-08T10:00:00+08:00'))).toBe(false)
    expect(isPeakHour(at('2026-11-07T15:00:00+08:00'))).toBe(false)
  })

  it('按**北京时间**判，不按本地时区', () => {
    // UTC 02:00 = 北京 10:00，高峰；UTC 15:00 = 北京 23:00，空闲
    expect(isPeakHour(new Date('2026-11-10T02:00:00Z'))).toBe(true)
    expect(isPeakHour(new Date('2026-11-10T15:00:00Z'))).toBe(false)
  })
})

describe('priceBookFor：只认有价目表的服务商', () => {
  it('DeepSeek 的 chat / flash 走 Flash 价', () => {
    expect(priceBookFor('deepseek', 'deepseek-chat')?.label).toContain('Flash')
    expect(priceBookFor('deepseek', 'deepseek-flash')?.label).toContain('Flash')
  })

  it('Pro 模型走另一档', () => {
    expect(priceBookFor('deepseek', 'deepseek-v4-pro')?.label).toContain('Pro')
  })

  it('★ 其它服务商返回 null —— 宁可不显示金额，也不编一个', () => {
    expect(priceBookFor('openai', 'gpt-4o')).toBeNull()
    expect(priceBookFor('siliconflow', 'deepseek-ai/DeepSeek-V3')).toBeNull()
    expect(priceBookFor('ollama', 'llama3')).toBeNull()
    expect(priceBookFor('custom', 'whatever')).toBeNull()
  })
})

describe('estimateCost：折算口径', () => {
  it('★ 空闲时段：100 万输入（全未命中）= 1 元', () => {
    expect(estimateCost('deepseek', 'deepseek-flash', u(1_000_000, 0), IDLE)).toBeCloseTo(1, 6)
  })

  it('★ 高峰时段同样的量 = 2 元（翻倍）', () => {
    expect(estimateCost('deepseek', 'deepseek-flash', u(1_000_000, 0), PEAK)).toBeCloseTo(2, 6)
  })

  it('★ 输出 100 万：空闲 4 元 / 高峰 8 元（旧实现只按 2 元算）', () => {
    expect(estimateCost('deepseek', 'deepseek-flash', u(0, 1_000_000), IDLE)).toBeCloseTo(4, 6)
    expect(estimateCost('deepseek', 'deepseek-flash', u(0, 1_000_000), PEAK)).toBeCloseTo(8, 6)
  })

  it('★ 缓存命中单独计价：100 万命中只要 0.02 元', () => {
    expect(estimateCost('deepseek', 'deepseek-flash', u(1_000_000, 0, 1_000_000), IDLE)).toBeCloseTo(0.02, 6)
  })

  it('一半命中一半未命中时分开算', () => {
    const cost = estimateCost('deepseek', 'deepseek-flash', u(1_000_000, 0, 500_000), IDLE)
    // 50 万命中 = 0.01，50 万未命中 = 0.5
    expect(cost).toBeCloseTo(0.51, 6)
  })

  it('没有缓存字段时按全部未命中算（偏保守，估高不估低）', () => {
    const withUnknown = estimateCost('deepseek', 'deepseek-flash', u(1_000_000, 0), IDLE)
    const allMiss = estimateCost('deepseek', 'deepseek-flash', u(1_000_000, 0, 0), IDLE)
    expect(withUnknown).toBeCloseTo(allMiss!, 6)
  })

  it('缓存命中数超过输入数也不算出负数（坏数据的兜底）', () => {
    const cost = estimateCost('deepseek', 'deepseek-flash', u(100, 0, 999), IDLE)
    expect(cost).toBeGreaterThanOrEqual(0)
    expect(cost).toBeCloseTo(0.000002, 9)
  })

  it('null 用量 / 没价目表 ⇒ null（调用方据此不出金额）', () => {
    expect(estimateCost('deepseek', 'deepseek-chat', null, IDLE)).toBeNull()
    expect(estimateCost('openai', 'gpt-4o', u(1000, 1000), IDLE)).toBeNull()
  })

  it('真实量级：一轮 2.5 万输入 + 2700 输出，空闲时段约 4 分钱', () => {
    const cost = estimateCost('deepseek', 'deepseek-flash', u(25_000, 2_700), IDLE)!
    expect(cost).toBeGreaterThan(0.03)
    expect(cost).toBeLessThan(0.06)
  })
})

describe('formatCost', () => {
  it('按量级换精度', () => {
    expect(formatCost(0.0034)).toBe('¥0.0034')
    expect(formatCost(0.5)).toBe('¥0.50')
    expect(formatCost(12.34)).toBe('¥12.3')
  })

  it('零 / 负数 / null ⇒ 空串（界面显示 token 就好）', () => {
    expect(formatCost(0)).toBe('')
    expect(formatCost(-1)).toBe('')
    expect(formatCost(null)).toBe('')
    expect(formatCost(NaN)).toBe('')
  })
})

describe('priceSourceNote：把价目来源讲清楚', () => {
  it('有价目表时给出时段与单价', () => {
    const note = priceSourceNote('deepseek', 'deepseek-chat', PEAK)
    expect(note).toContain('高峰')
    expect(note).toContain('输出 8 元')
  })

  it('没价目表时直说不显示金额的原因', () => {
    expect(priceSourceNote('openai', 'gpt-4o')).toContain('没有内置价目表')
  })
})

describe('addUsage：缓存命中也要累加', () => {
  it('两边的命中数相加', () => {
    const a = addUsage(u(100, 10, 60), u(200, 20, 40))
    expect(a.promptTokens).toBe(300)
    expect(a.cacheHitTokens).toBe(100)
  })

  it('两边都没报命中 ⇒ 保持 undefined（0 会让"未知"看起来像"没命中"）', () => {
    expect(addUsage(u(100, 10), u(200, 20)).cacheHitTokens).toBeUndefined()
  })

  it('只有一边报 ⇒ 用那一边的', () => {
    expect(addUsage(u(100, 10, 50), u(200, 20)).cacheHitTokens).toBe(50)
  })

  it('累加仍然是"有一次估算就算估算"', () => {
    const est: TokenUsage = { ...u(100, 10), estimated: true }
    expect(addUsage(est, u(100, 10)).estimated).toBe(true)
  })

  it('★ 累加保留"最近一次"的时刻（峰谷折算要用它）', () => {
    const early = { ...u(100, 10), at: 1000 }
    const late = { ...u(100, 10), at: 2000 }
    expect(addUsage(early, late).at).toBe(2000)
    // 只有一边有时间戳时也要留住
    expect(addUsage(u(1, 1), late).at).toBe(2000)
    expect(addUsage(early, u(1, 1)).at).toBe(1000)
  })
})

/**
 * 峰谷必须按**这一轮发生的那一刻**算（2026-11）。
 *
 * 玩家对过一次账：中午那一轮后台扣了七分，晚上翻工具条只显示四分 ——
 * 同一批 token，只是因为我们拿"看表的时刻"去查了价目表。
 */
describe('estimateCost：峰谷按发生时刻，不按查看时刻', () => {
  const usage = (at?: number): TokenUsage => ({ ...u(1_000_000, 0), ...(at !== undefined ? { at } : {}) })

  it('★ 中午打的、晚上看 —— 仍然按高峰算（不能拿现在的时段重算过去）', () => {
    const noon = new Date('2026-11-10T11:00:00+08:00').getTime()  // 高峰
    const night = new Date('2026-11-10T23:00:00+08:00')            // 空闲
    // 输入 1M，未命中，Flash：高峰 2 元
    expect(estimateCost('deepseek', 'deepseek-flash', usage(noon), night)).toBeCloseTo(2, 6)
  })

  it('★ 深夜打的、白天看 —— 仍然按空闲算', () => {
    const night = new Date('2026-11-10T23:00:00+08:00').getTime()
    const noon = new Date('2026-11-10T11:00:00+08:00')
    expect(estimateCost('deepseek', 'deepseek-flash', usage(night), noon)).toBeCloseTo(1, 6)
  })

  it('没有 usage.at（老存档）才退回传入的时刻', () => {
    expect(estimateCost('deepseek', 'deepseek-flash', usage(), PEAK)).toBeCloseTo(2, 6)
    expect(estimateCost('deepseek', 'deepseek-flash', usage(), IDLE)).toBeCloseTo(1, 6)
  })
})
