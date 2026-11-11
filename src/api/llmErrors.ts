/**
 * LLM 请求的错误分类
 *
 * 为什么需要：
 * 之前所有失败都只是一个裸 `Error("429 Too Many Requests - {...}")`，
 * 界面上完全分不清「余额不足」「Key 写错了」「被限流」「网络断了」——
 * 而这四者的处理方式完全不同：前两个改配置没用，后两个等一会儿就好。
 * 玩家看到的是一串原始 JSON，只能瞎猜。
 *
 * 这里把错误归成几类，每类给出：能不能重试、以及一句人话。
 */

export type LlmErrorKind =
  /** Key 无效或没权限 —— 重试无用，必须改配置 */
  | 'auth'
  /** 余额/额度不足 —— 重试无用，必须充值 */
  | 'quota'
  /** 被限流 —— 等待后重试有效 */
  | 'rate_limit'
  /** 服务端错误（5xx）—— 重试有效 */
  | 'server'
  /** 网络层失败（断网、DNS、连接重置）—— 重试有效 */
  | 'network'
  /** 请求超时 —— 重试有效 */
  | 'timeout'
  /** 请求本身有问题（400：模型名不存在、上下文超长等）—— 重试无用 */
  | 'bad_request'
  /**
   * 服务商不认识这个**模型名**（2026-11）。
   *
   * 单独一类值得，因为它有独有的下一步：去核对模型名。
   * 玩家截图里的原文是 `{"detail":"未知模型: vtx-抗截断-gemini-4-Argon-high"}` ——
   * 同一家中转他填的叙事模型写 `Argon`、结算模型写 `argon`，
   * 而"测试连接"只测了结算那个，于是出现「链接成功但一生成就说模型未知」。
   */
  | 'model'
  /**
   * 输出的 `max_tokens` 超出服务商允许范围 —— 重试无用，但**能自动降级**。
   *
   * 单独一类是因为它有一个别的错误没有的性质：报错里写着真正的上限。
   * 抓到那个数，把额度压下去重发，这一轮就活了 —— 玩家什么都不用改。
   */
  | 'max_tokens'
  /**
   * Gemini 系（含中转）拒了 OpenAI 的 JSON 模式 —— **能自动降级**。
   *
   * 报错原文是 Vertex 的：
   * `Forced function calling (mode = ANY) is not supported when
   *  'response_mime_type' is not set to 'text/plain'`
   *
   * 起因是 `response_format: {type:'json_object'}` 被翻成
   * `response_mime_type: 'application/json'`，与 Vertex 默认的强制
   * function calling 冲突。`llmChat` 会把 `response_format` 摘掉重发一次，
   * 详见 `isGeminiLike` 的说明与实测表。
   */
  | 'function_calling'
  /** 用户在生成过程中主动取消 —— 不算错误 */
  | 'aborted'
  | 'unknown'

export interface LlmErrorInfo {
  kind: LlmErrorKind
  /** 是否值得自动重试 */
  retryable: boolean
  /** 给玩家看的一句话（中文，不含原始 JSON） */
  message: string
  /** 给玩家看的下一步建议 */
  hint?: string
  /** 服务端原始状态码（若有） */
  status?: number
  /**
   * 服务商允许的输出上限（仅 `kind === 'max_tokens'` 时会有）。
   *
   * 来源是报错正文里的那个数字，不是我们猜的 —— 各家差得很远
   * （Gemini 65536、Gemini 系中转 65536、GPT-4o 16384、DeepSeek 393216）。
   * 抓到了就能原样重发，抓不到就只能报错让玩家自己改。
   */
  outputLimit?: number
  /** 原始错误文本，仅用于调试面板 */
  raw?: string
}

export class LlmError extends Error {
  readonly info: LlmErrorInfo
  constructor(info: LlmErrorInfo) {
    super(info.message)
    this.name = 'LlmError'
    this.info = info
  }
}

/** 从各家服务商的错误体里挖出可读信息 */
function extractServerMessage(body: string): string | undefined {
  if (!body) return undefined
  try {
    const j = JSON.parse(body)
    // OpenAI / DeepSeek / 硅基流动 / OpenRouter 大体都是 { error: { message } }
    const m = j?.error?.message || j?.message || j?.error?.type
    if (typeof m === 'string' && m.trim()) return m.trim().slice(0, 300)
    /*
      ── FastAPI 风格的中转（2026-11 玩家截图）──

      原文是 `{"detail":"未知模型: vtx-抗截断-gemini-4-Argon-high"}`。
      不认这个字段的后果很直接：界面上原样显示一整串 JSON（连花括号都在），
      而真正那句话只有五个字 —— "未知模型"。
    */
    const d = j?.detail
    if (typeof d === 'string' && d.trim()) return d.trim().slice(0, 300)
    if (Array.isArray(d)) {
      // FastAPI 的 422 校验错误：detail 是 [{ loc, msg, type }, ...]
      const parts = d
        .map((x: any) => (typeof x === 'string' ? x : x?.msg))
        .filter((x: any): x is string => typeof x === 'string' && !!x.trim())
      if (parts.length) return parts.join('；').slice(0, 300)
    }
  } catch {
    /* 不是 JSON，退回纯文本 */
  }
  const t = body.trim()
  if (!t) return undefined
  // 有些网关直接返回 HTML 错误页，截断并去掉标签
  return t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || undefined
}

const QUOTA_RE = /(insufficient|quota|balance|credit|billing|欠费|余额|额度|超出.*配额)/i
const AUTH_RE = /(invalid.*api.*key|incorrect.*api.*key|unauthorized|authentication|api key|密钥|无效的.*key|token.*invalid)/i
const CONTEXT_RE = /(context.*length|too many tokens|maximum context|上下文|token.*limit)/i
/**
 * "模型名不对"的各种说法。
 *
 * 中文那几种是 2026-11 补的：玩家那家中转回的是 `未知模型: xxx`，
 * 而这里原来只认英文 —— 于是它落进通用 400，提示变成"模型名不对、
 * 参数不被支持、上下文过长"三选一，等于让他自己猜。
 */
const MODEL_RE = /(model.*not.*found|unknown model|does not exist|no such model|invalid model|未知模型|未知的模型|模型.*不存在|没有这个模型|模型.*无效)/i

/**
 * 报错里出现这些字样，才可能是「输出上限超范围」。
 * 先做这道闸，避免后面的数字正则去吃上下文超长、限流之类的报错。
 */
const MAX_TOKENS_RE = /(max[_\s-]?output[_\s-]?tokens?|max[_\s-]?completion[_\s-]?tokens?|max[_\s-]?tokens?)/i

/**
 * 从「输出上限超出范围」的报错里，把**服务商真正的上限**挖出来。
 *
 * 为什么值得单独解析：这个错误是极少数「报错正文里带着解法」的情况。
 * 抓到那个数字，把 `max_tokens` 压下去重发，这一轮就救回来了；
 * 抓不到就只能把原始 JSON 甩给玩家，让他自己去猜该填多少。
 *
 * 已知的几种说法：
 *
 * ```
 * Gemini   maxOutputTokens value of 1000000 but the supported range is
 *          from 1 (inclusive) to 65537 (exclusive)        → 65536
 * OpenAI   max_tokens is too large: 1000000. This model supports
 *          at most 16384 completion tokens                → 16384
 * 通用     max_tokens must be less than or equal to 32768  → 32768
 * 通用     max_tokens: 1000000 > 8192                      → 8192
 * ```
 *
 * 注意 Gemini 那句是**开区间**（`65537 (exclusive)`），所以要用 hi - 1。
 *
 * @returns 服务商允许的最大输出 token 数；解析不出来时返回 undefined
 */
export function parseOutputTokenLimit(body: string): number | undefined {
  if (!body || !MAX_TOKENS_RE.test(body)) return undefined

  // Gemini 系：from 1 (inclusive) to 65537 (exclusive)
  let m = body.match(/from\s+\d+\s*\(inclusive\)\s*to\s+(\d+)\s*\(exclusive\)/i)
  if (m) {
    const hi = Number(m[1])
    if (Number.isFinite(hi) && hi > 1) return hi - 1
  }

  // OpenAI 系：supports at most 16384 completion tokens
  m = body.match(/supports?\s+at\s+most\s+(\d+)/i)
  if (m) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0) return n
  }

  // 通用：must be less than or equal to 32768 / maximum is 32768 / <= 32768
  m = body.match(/(?:less than or equal to|not exceed|at most|maximum(?:\s+is)?|<=?)\s*(\d{3,8})/i)
  if (m) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0) return n
  }

  // 通用比较式：max_tokens: 1000000 > 8192 / 1000000 exceeds 8192
  m = body.match(/(?:[>\uFF1E]|exceed(?:s|ing)?)\s*[\s:]*(\d{3,8})/i)
  if (m) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0) return n
  }

  return undefined
}

/**
 * 把各种失败归一成一个 LlmErrorInfo。
 * @param status HTTP 状态码，网络层失败时传 undefined
 * @param body   错误响应体
 * @param err    网络层抛出的原始异常
 */
export function classifyLlmError(
  status: number | undefined,
  body: string,
  err?: unknown
): LlmErrorInfo {
  const raw = err ? String((err as Error)?.message || err) : body
  const serverMsg = extractServerMessage(body)

  // 用户主动取消：不是错误，别报红
  if ((err as Error)?.name === 'AbortError') {
    return { kind: 'aborted', retryable: false, message: '已取消本次生成', raw }
  }

  if (status === undefined) {
    // 没有状态码 → 网络层就没通
    const m = String((err as Error)?.message || '')
    if (/timeout|timed out|ETIMEDOUT/i.test(m)) {
      return {
        kind: 'timeout', retryable: true, status,
        message: '请求超时', hint: '可能是网络慢或服务商拥堵，稍后会自动重试', raw,
      }
    }
    return {
      kind: 'network', retryable: true, status,
      message: '网络连接失败',
      hint: '检查网络或代理设置。若用了 VPN，注意部分服务商会拒绝代理出口',
      raw,
    }
  }

  if (status === 401 || status === 403) {
    if (QUOTA_RE.test(body)) {
      return {
        kind: 'quota', retryable: false, status,
        message: serverMsg || '账户额度不足', hint: '请到模型服务商处充值或更换可用的 Key', raw,
      }
    }
    const authish = AUTH_RE.test(body) || status === 401
    return {
      kind: 'auth', retryable: false, status,
      message: authish ? (serverMsg || 'API Key 无效或没有权限') : (serverMsg || '没有访问权限'),
      hint: '请到「模型设置」检查 API Key 与服务商是否匹配', raw,
    }
  }

  if (status === 402) {
    return {
      kind: 'quota', retryable: false, status,
      message: serverMsg || '账户余额不足', hint: '请充值后重试', raw,
    }
  }

  if (status === 429) {
    if (QUOTA_RE.test(body)) {
      return {
        kind: 'quota', retryable: false, status,
        message: serverMsg || '额度已用尽', hint: '请充值或更换 Key', raw,
      }
    }
    return {
      kind: 'rate_limit', retryable: true, status,
      message: serverMsg || '请求过于频繁，已被限流',
      hint: '稍等片刻即可，正在自动重试', raw,
    }
  }

  /*
    ── 404：两种可能，差得很远（2026-11）──

    一种是**地址少了 /v1**（`/chat/completions` 根本不存在）；
    另一种是**模型名不对**，而许多中转（FastAPI 那类）用 404 表达它。
    判反了会让玩家去改一个没坏的字段。
  */
  if (status === 404) {
    if (MODEL_RE.test(body)) {
      return {
        kind: 'model', retryable: false, status,
        message: serverMsg || '服务商不认识这个模型名',
        hint: '核对模型名：叙事模型与结算模型要分别核对，大小写与前后空格都不能差',
        raw,
      }
    }
    return {
      kind: 'bad_request', retryable: false, status,
      message: serverMsg || '接口路径不存在（404）',
      hint: '检查「接口地址」：OpenAI 兼容端点通常要以 /v1 结尾',
      raw,
    }
  }

  if (status === 400 || status === 422) {
    /*
      ── Gemini 系拒了 JSON 模式（2026-11）──

      必须排在下面所有分支的**最前面**：这条报错里同时出现
      `function`、`text/plain`、`not supported` 这些词，
      而它们每一项都可能被下面某条正则误吃（例如被当成"参数不被支持"的通用 400）。
      判错的后果是玩家拿到一句「请求被服务商拒绝（400）」，
      完全不知道该怎么办 —— 而这其实是**我们能自己修**的一种。

      判据只认 Vertex 的原句，收得窄一点：宁可漏判（走通用 400），
      也不要把别家的普通报错误认成它、白白多花一次请求。
    */
    if (/function[_ ]calling|response_mime_type|tool_config/i.test(body)) {
      return {
        kind: 'function_calling', retryable: false, status,
        message: '这个模型不接受 JSON 模式（Gemini 中转的 function calling 限制）',
        hint: '已自动改用纯文本模式重发。若反复出现，把「结算模型」换成非 Gemini 的模型即可。',
        raw,
      }
    }
    /*
      ── 输出上限超范围：唯一一种「报错里带着解法」的 400 ──

      玩家在「单次回复上限」里填了个大数（比如照抄模型的上下文长度
      填了 1000000），而这个模型实际只让写到 65536 —— 请求在服务商
      侧就被打回来了，一百个字都没生成。

      这条必须**排在上下文超长前面**判：两者的报错都带 token 字样，
      但处理方式完全相反 —— 上下文超长得砍历史，这条得压 max_tokens。
      判错的后果是玩家按提示砍了半天历史，问题一点没动。

      解析出上限就放进 info.outputLimit，由 `llmChat` 自动降级重发。
    */
    const outputLimit = parseOutputTokenLimit(body)
    if (outputLimit !== undefined) {
      return {
        kind: 'max_tokens', retryable: false, status,
        message: `输出额度超出服务商允许范围（这个模型最多 ${outputLimit} token）`,
        hint: `把「单次回复上限」改到 ${outputLimit} 以下即可`,
        outputLimit, raw,
      }
    }
    /*
      ── 提到了 max_tokens，但没给数字（2026-11）──

      Gemini 系现在一律给满 65536（见 `GEMINI_OUTPUT_BUDGET`），
      而中转的 400 常常只有一句 "max_tokens is too large" —— 没有任何数字。

      这种也要归到 `max_tokens` 类，`llmChat` 才会**减半重发**
      （65536 → 32768 → 16384）。归到通用 400 的后果是：
      模型一个字都没开始写，玩家却拿到一句「请求被服务商拒绝」，
      而我们明明可以自己把额度压下去。

      排在上下文超长前面判：两者报错都带 token 字样，
      但一个该压 max_tokens、一个该砍历史，判反了就白忙。
    */
    if (MAX_TOKENS_RE.test(body)) {
      return {
        kind: 'max_tokens', retryable: false, status,
        message: serverMsg || '输出额度超出服务商允许范围',
        hint: '把「单次回复上限」调小一些，或换一个接受更大额度的模型', raw,
      }
    }
    if (CONTEXT_RE.test(body)) {
      return {
        kind: 'bad_request', retryable: false, status,
        message: '对话上下文超出模型上限',
        hint: '可在「模型设置」里换用上下文更长的模型，或先返回标题开始新游戏', raw,
      }
    }
    if (MODEL_RE.test(body)) {
      return {
        kind: 'model', retryable: false, status,
        message: serverMsg || '服务商不认识这个模型名',
        hint: '核对模型名：叙事模型与结算模型要分别核对，大小写与前后空格都不能差',
        raw,
      }
    }
    return {
      kind: 'bad_request', retryable: false, status,
      message: serverMsg || '请求被服务商拒绝（400）',
      hint: '常见原因：模型名不对、参数不被支持、上下文过长', raw,
    }
  }

  if (status >= 500) {
    return {
      kind: 'server', retryable: true, status,
      message: serverErrText(status, serverMsg),
      hint: '这是服务商侧的问题，稍后会自动重试', raw,
    }
  }

  return {
    kind: 'unknown', retryable: false, status,
    message: serverMsg || `请求失败（${status}）`, raw,
  }
}

function serverErrText(status: number, serverMsg?: string): string {
  if (serverMsg) return serverMsg
  if (status === 502 || status === 503 || status === 504) return `模型服务暂时不可用（${status}）`
  return `模型服务内部错误（${status}）`
}

/** 判断任意异常是否可重试（用于统一处理） */
export function isRetryable(err: unknown): boolean {
  if (err instanceof LlmError) return err.info.retryable
  return false
}
