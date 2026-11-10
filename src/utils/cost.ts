import type { TokenUsage } from '@/stores/game'

/**
 * 把 token 用量折算成**参考花费**。
 *
 * ## 为什么单独一个模块（2026-11）
 *
 * 玩家报：「之前有个存档显示我历史累计用了 30 多块钱，但我感觉没有那么多」。
 *
 * 查下来发现旧实现是一行写死的常量：
 *
 * ```ts
 * const PRICE_PER_1K = { prompt: 0.001, completion: 0.002 }  // 元 / 千 token
 * ```
 *
 * 也就是 **1 元/百万输入、2 元/百万输出**。而 DeepSeek 官方 2026 年的价目表
 * （<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>）是：
 *
 * | deepseek-flash | 空闲 | 高峰 |
 * |---|---|---|
 * | 输入（缓存命中） | 0.02 | 0.04 |
 * | 输入（未命中） | 1 | 2 |
 * | 输出 | 4 | 8 |
 *
 * 三个问题：
 *
 *  1. **输出被低估 2~4 倍**。这个项目的输出是每轮一两千字的小说正文，
 *     而输出单价恰恰是输出的 4 倍（4~8 对 1~2）。旧常量把它算成了和输入一个量级。
 *  2. **没有峰谷**。官方从 2026 年起按北京时间分峰谷，高峰贵一倍。
 *  3. **不分服务商**。项目支持 OpenAI / SiliconFlow / OpenRouter / Ollama / 自定义端点，
 *     却一律按 DeepSeek 的价算 —— 换个服务商，那个金额就是编的。
 *
 * 所以这里做三件事：按服务商查表、按当前时刻判峰谷、拿不到价目就**不显示金额**
 * （只显示 token）。宁可少一个数字，也不要给一个看着像账单的假数字。
 */

/** 元 / 百万 token。`idle` = 空闲时段，`peak` = 高峰时段 */
export interface PriceTier {
  idle: number
  peak: number
}

export interface PriceBook {
  /** 显示用的名字 */
  label: string
  /** 输入 · 缓存未命中（这是最常见的计价路径） */
  inputMiss: PriceTier
  /** 输入 · 缓存命中（便宜得多，拿到了就该按它算） */
  inputHit?: PriceTier
  output: PriceTier
  /** 什么时候算高峰的说明，供 UI 的悬浮提示用 */
  peakNote?: string
}

/**
 * DeepSeek 官方价目（2026）。
 *
 * 「空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）
 * 9:00-12:00、14:00-18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。」
 *
 * ⚠️ 法定节假日判断不了（要一份节假日表，且每年变），所以这里**只按周末与钟点算**。
 * 节假日的玩家会被按高峰计，也就是**估高**。宁可高一点，也不要让人以为自己还能再玩。
 */
const DEEPSEEK_FLASH: PriceBook = {
  label: 'DeepSeek Flash',
  inputMiss: { idle: 1, peak: 2 },
  inputHit: { idle: 0.02, peak: 0.04 },
  output: { idle: 4, peak: 8 },
  peakNote: '工作日 9:00–12:00、14:00–18:00（北京时间）为高峰时段，单价翻倍',
}

const DEEPSEEK_PRO: PriceBook = {
  label: 'DeepSeek V4 Pro',
  inputMiss: { idle: 4.5, peak: 9 },
  inputHit: { idle: 0.15, peak: 0.3 },
  output: { idle: 13.5, peak: 27 },
  peakNote: DEEPSEEK_FLASH.peakNote,
}

/**
 * 按服务商 + 模型名挑价目表。
 *
 * 拿不到就返回 `null` —— 调用方据此**不显示金额**。
 * 这是刻意的：给一个编出来的金额，比不给更糟（玩家会拿它当真去对账）。
 */
export function priceBookFor(provider: string, model: string): PriceBook | null {
  if (provider !== 'deepseek') return null
  /*
    ⚠️ 这一段原先写的是「旧模型名 deepseek-chat / deepseek-v4-flash 仍可调用，
    按 Flash 计费」—— 那半句是错的（2026-11 核对官方更新日志）。

    `deepseek-chat` / `deepseek-reasoner` 在官方日志里是**2026-07-24 停止使用**
    的旧名；`deepseek-v4-flash` 只是暂时路由到 V4.1 Flash。现行价目表上
    只有 `deepseek-flash` 与 `deepseek-v4-pro` 两行，迁移在 `api/llm.ts`
    的 `migrateDeepSeekModelName` 里做，这里只负责按名字挑表。

    按名字而不是按表里有没有来判：DeepSeek 一侧能确定 "pro 贵、其余按 Flash"，
    这个口径和官方价目表一致，多一个 if 反而会漏。
  */
  return /pro/i.test(model) ? DEEPSEEK_PRO : DEEPSEEK_FLASH
}

/**
 * 此刻是不是高峰时段。
 *
 * 只按**北京时间**的星期与钟点判断，节假日不判（见价目表的说明）。
 */
export function isPeakHour(at: Date = new Date()): boolean {
  // 拿到"北京时间"的字段值：加 8 小时后按 UTC 读
  const bj = new Date(at.getTime() + 8 * 3600_000)
  const day = bj.getUTCDay()          // 0 = 周日, 6 = 周六
  if (day === 0 || day === 6) return false
  const h = bj.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

/** 从用量里挑出计价要走哪一档：有缓存命中数就分开算，没有就全按未命中 */
function splitInput(u: TokenUsage): { hit: number; miss: number } {
  const prompt = Math.max(0, u.promptTokens)
  /*
    命中数要 **clamp 到输入总数**：这是脏数据的兜底。
    某些中转会把 `prompt_cache_hit_tokens` 填成别的量纲（或者干脆重复累加），
    不夹一下的话"命中比输入还多"，成本会凭空多出来一截 ——
    而这种数错了没人看得出来，只会让玩家觉得账单可疑。
  */
  const hit = Math.min(Math.max(0, Math.floor(u.cacheHitTokens ?? 0)), prompt)
  return { hit, miss: prompt - hit }
}

/**
 * 折算参考花费（**元**）。拿不到价目表时返回 `null`。
 *
 * 口径：`token / 1e6 * 单价（元/百万）`。
 *
 * ⚠️ 这只是**参考值**。真实账单以服务商为准 —— 峰谷、缓存命中、赠送额度、
 * 中转加价、失败重试是否计费，都可能有出入。UI 上必须标明「约」。
 */
export function estimateCost(
  provider: string,
  model: string,
  usage: TokenUsage | null | undefined,
  at?: Date,
): number | null {
  if (!usage) return null
  const book = priceBookFor(provider, model)
  if (!book) return null

  /*
    ⚠️ 峰谷要按**这一轮发生的那一刻**算，不是按"现在看工具条的时刻"（2026-11）。

    玩家对过账：中午那一轮后台扣了七分，晚上翻工具条只显示四分 ——
    同一批 token，单价差一倍，只是因为我们拿错了时间。

    优先级：`usage.at`（记录时打的时间戳）→ 显式传入的 `at`（测试用）→ 现在。
    老存档里没有 `usage.at`，只能退回现在，这一档是承认不准的。
  */
  const effective = typeof usage.at === 'number' ? new Date(usage.at) : (at ?? new Date())

  const peak = isPeakHour(effective)
  const pick = (t: PriceTier) => (peak ? t.peak : t.idle)

  const { hit, miss } = splitInput(usage)
  const hitPrice = book.inputHit ? pick(book.inputHit) : pick(book.inputMiss)
  const missPrice = pick(book.inputMiss)
  const outPrice = pick(book.output)

  const cny =
    (hit * hitPrice) / 1e6 +
    (miss * missPrice) / 1e6 +
    (Math.max(0, usage.completionTokens) * outPrice) / 1e6

  return cny
}

/**
 * 金额的显示形态。
 *
 * 一位小数不够（单轮常常是几厘），四位又太吵。所以按量级换：
 * 小于一分显示到四位，小于一元两位，再多就一位。
 */
export function formatCost(cny: number | null): string {
  if (cny === null || !Number.isFinite(cny) || cny <= 0) return ''
  if (cny < 0.01) return `¥${cny.toFixed(4)}`
  if (cny < 1) return `¥${cny.toFixed(2)}`
  return `¥${cny.toFixed(1)}`
}

/** 给悬浮提示用的一句话：这个价是从哪来的 */
export function priceSourceNote(provider: string, model: string, at: Date = new Date()): string {
  const book = priceBookFor(provider, model)
  if (!book) {
    return '当前服务商没有内置价目表（金额只对 DeepSeek 官方报价有效），所以这里只显示 token 数。'
  }
  const tier = isPeakHour(at) ? '高峰' : '空闲'
  const hit = book.inputHit ? `，缓存命中 ${book.inputHit[tier === '高峰' ? 'peak' : 'idle']} 元` : ''
  return `按 ${book.label} 官方价（${tier}时段）折算：输入 ${book.inputMiss[tier === '高峰' ? 'peak' : 'idle']} 元 / 百万 token${hit}，`
    + `输出 ${book.output[tier === '高峰' ? 'peak' : 'idle']} 元 / 百万 token。\n`
    + `${book.peakNote ?? ''}\n实际账单以服务商为准。`
}
