/**
 * 叙事截断检测
 *
 * 为什么需要：
 * 模型有时会在句子中间被截断 —— 可能是 max_tokens 用尽、也可能是流被中断。
 * 返回的既不是空串（那条路径已经处理了），也不是错误，而是一段**看起来正常
 * 但停在半句**的文本。它会照原样进入历史、进入下一轮的上下文，
 * 于是故事里凭空出现一个断句，而且玩家不知道发生了什么。
 *
 * 这里做启发式判断，把可疑情况标出来让玩家决定是否重新生成。
 *
 * 设计原则：**宁可漏报，不可误报**。
 * 误报会让玩家以为正常输出有问题、反复重新生成，比漏报更烦人。
 * 所以只在证据比较明确时才判定为截断。
 */

export interface TruncationCheck {
  /** 是否疑似截断 */
  truncated: boolean
  /** 判定理由（中文，可直接显示给玩家） */
  reason?: string
  /** 置信度：high 用于强证据，low 用于弱证据（界面可以区别对待） */
  confidence?: 'high' | 'low'
}

/** 结尾出现这些符号说明句子/段落是收住的 */
const CLOSING = /[。！？…～”』」）)】》\."'\]}!?]\s*$/

/** 结尾停在这些词上，几乎可以确定是被切断 */
const DANGLING_TAIL = /(因为|所以|但是|可是|然而|不过|而且|并且|如果|虽然|即使|当|在|把|被|对|从|向|与|和|或|是|的|了|着|过|就|都|也|还|很|太|更|最|一|这|那|他|她|它|我|你|们|然后|接着|于是|此外|另外|例如|比如)\s*$/

/** 结尾是未闭合的成对符号 */
const OPEN_PAIRS: [RegExp, RegExp, string][] = [
  [/「/g, /」/g, '「」'],
  [/『/g, /』/g, '『』'],
  [/“/g, /”/g, '“”'],
  [/（/g, /）/g, '（）'],
  [/\(/g, /\)/g, '()'],
  [/【/g, /】/g, '【】'],
  [/《/g, /》/g, '《》'],
]

/** 结尾是逗号/顿号等未完待续的标点 */
const MID_PUNCT = /[，、：；,;:]\s*$/

/**
 * 检测一段叙事是否被截断。
 *
 * @param text          模型返回的叙事正文
 * @param expectedChars 该世界配置的期望字数（用于判断"明显偏短"）
 * @param finishReason  流式最后一个 chunk 的 `finish_reason`；`length` 表示撞到 token 上限
 */
/**
 * 服务商是不是明说「撞到输出上限了」。
 *
 * ## 为什么不能只认小写 `length`（2026-11，玩家连报两轮「正文回空」）
 *
 * 各家写这一句的方式不一样：
 *
 * | 服务商 | `finish_reason` |
 * |---|---|
 * | OpenAI / DeepSeek | `length` |
 * | Gemini（含它的 OpenAI 兼容层、以及各种中转） | `MAX_TOKENS` |
 * | 部分网关 | `max_output_tokens` / `max_completion_tokens` |
 *
 * 原来两处判断（`detectTruncation` 与 `describeEmptyNarrative`）都写死小写
 * `'length'`。撞上限的那一轮于是被判成"没撞"：正文一个字都没有，
 * 而归因落到兜底那句「模型返回了空内容，请检查模型名称与接口地址」——
 * 真正的原因（额度不够）被藏起来，玩家只能去查一个没坏的东西。
 */
export function isLimitFinish(reason?: string): boolean {
  return /^(length|max_tokens|max_output_tokens|max_completion_tokens|token_limit)$/i
    .test(String(reason || '').trim())
}

/**
 * **拒答检测**（2026-11）。
 *
 * ## 玩家报的事
 *
 * 「这个预填真的起作用了吗，前面已经破甲了下一轮又被拒绝了」。
 *
 * 查下来问题不在预填 —— 在于**拒答这件事根本没有被识别**。
 *
 * 模型拒答时返回的不是错误、也不是空串，而是一小段话：
 * 「我无法继续这个场景。如果你愿意，我们可以……」——
 * 它通过了所有现有检查（不是空包、不是 `finish_reason: length`），
 * 于是被当成正文：
 *
 *  1. **进历史**。下一轮模型看到"我自己刚拒绝过"，更容易接着拒 ——
 *     这就是「前一轮成了，下一轮又拒」的直接机制；
 *  2. **被当成截断去续写**。它短于目标的七成，`detectTruncation` 判它截断，
 *     系统拿"你是续写助手，接着最后一个字写完"再要一次 ——
 *     模型于是接着拒，或者把拒绝的话写得更长。
 *
 * 两种情况都比原文更糟。
 *
 * ## 判据：宁可漏报
 *
 * 叙事里的人物会说「我不能」，所以**不能只看词**。三个条件同时成立才判：
 *
 *  1. 命中拒答话术；
 *  2. 命中位置在**开头**（拒答总是先说结论再解释）；
 *  3. 整段明显短于目标（拒答不会真的铺开写一千八百字）。
 *
 * 第 3 条最关键：它把「人物在对话里说了句我不能」挡在外面。
 */
const REFUSAL_STRONG = [
  /^\s*(很抱歉|抱歉|对不起)[，,。]?\s*(我|这)/,
  /^\s*我(?:无法|不能|没法|不便)(?:继续|提供|完成|满足|生成|协助|参与|写)/,
  /^\s*作为(?:一个)?\s*(?:AI|人工智能|语言模型)/i,
  /^\s*I(?:'m| am)\s+(?:sorry|unable|not able)/i,
  /^\s*I\s+(?:can't|cannot|won't|will not)/i,
]

/** 出现在前 200 字里也算，但要求配合长度判定 */
const REFUSAL_WEAK = /(无法继续|不能继续|无法提供|无法满足|无法生成|这超出了|不(?:太)?适合(?:我|这类)|违背(?:我的)?(?:原则|准则|用途)|我理解你的(?:请求|需求|想法)但)/

export interface RefusalCheck {
  refused: boolean
  /** 判定理由（中文，可直接显示给玩家） */
  reason?: string
  confidence?: 'high' | 'low'
}

/**
 * @param text          模型返回的正文
 * @param expectedChars 这一轮的目标字数（用于把"正常短场景"排除掉）
 */
export function detectRefusal(text: string, expectedChars?: number): RefusalCheck {
  const t = (text || '').trim()
  if (!t) return { refused: false }

  /*
    够长就不判拒答。

    真拒答不会有耐心写两千字 —— 它通常一百到四百字就收尾了。
    这个闸同时把「人物长篇独白里说了句我不能」挡在外面。
  */
  const cap = typeof expectedChars === 'number' && expectedChars > 0
    ? Math.max(600, expectedChars * 0.5)
    : 600
  if (t.length > cap) return { refused: false }

  const head = t.slice(0, 200)
  for (const re of REFUSAL_STRONG) {
    if (re.test(head)) {
      return { refused: true, confidence: 'high', reason: '模型回的是拒绝，不是正文' }
    }
  }
  if (REFUSAL_WEAK.test(head)) {
    return { refused: true, confidence: 'low', reason: '模型在正文里推掉了这个场景' }
  }
  return { refused: false }
}

export function detectTruncation(
  text: string,
  expectedChars?: number,
  finishReason?: string,
): TruncationCheck {
  const t = (text || '').trim()
  if (!t) return { truncated: false }   // 空串由另一条路径处理

  /*
    ── 0. 服务商自己说了 `length`（2026-11 加）──

    这是**唯一确定**的证据，比任何文本启发式都硬：接口明确告诉你"输出撞到上限了"。
    在这之前代码完全没看这个字段，只能靠"结尾有没有句号"去猜 ——
    而模型很会**把话说圆**：撞到上限时它常常刚好收在一个句号上，
    于是文本看着完整、字数又不够，两个弱判据都不成立 —— 判定为"没截断"，
    续写逻辑也就不触发。玩家看到的就是「明明要 1800 字，它给我 900」。
  */
  if (isLimitFinish(finishReason)) {
    return {
      truncated: true,
      confidence: 'high',
      reason: '模型输出撞到 token 上限被切断（接口返回 finish_reason=length）',
    }
  }

  // —— 强证据 ——

  // 1. 成对符号没闭合
  for (const [open, close, label] of OPEN_PAIRS) {
    const o = (t.match(open) || []).length
    const c = (t.match(close) || []).length
    if (o > c) {
      return {
        truncated: true,
        confidence: 'high',
        reason: `结尾的${label}没有闭合，这段叙事可能被截断了`,
      }
    }
  }

  // 2. 结尾停在明显的连接词上
  if (DANGLING_TAIL.test(t)) {
    return {
      truncated: true,
      confidence: 'high',
      reason: '结尾停在一个连接词上，这段叙事可能被截断了',
    }
  }

  // —— 弱证据 ——

  // 3. 结尾没有收束标点
  const noClosing = !CLOSING.test(t)
  // 4. 结尾是句中标点
  const midPunct = MID_PUNCT.test(t)
  /*
    5. 明显短于配置的期望长度。

    阈值演进：**0.35 → 0.55 → 0.7**（2026-11 一天内两次）。

    · 0.35（原值）：1800×0.35 = 630 字，900 字被判"够长"；
    · 0.55：990 字，实测玩家拿到的正文常在 1100 字左右 —— 还是漏过去了；
    · 0.7：1260 字。1800 字的目标下，写不到七成就是没写完。

    代价说清楚：这会**多花一次续写调用**。但另一边是"永远只拿到六成"，
    而续写只要接得上，玩家是察觉不到的（接不上会明确提示"曾自动补全"）。
  */
  const tooShort = typeof expectedChars === 'number' && expectedChars > 0
    && t.length < expectedChars * 0.7

  if (noClosing && (midPunct || tooShort)) {
    return {
      truncated: true,
      confidence: 'low',
      reason: midPunct
        ? '结尾停在逗号或冒号上，这段叙事可能没有写完'
        : `这段只有约 ${t.length} 字，明显短于设定的 ${expectedChars} 字`,
    }
  }

  /*
    6. 结尾完整、但字数差得远 —— 单独成立，不再要求"结尾没标点"。

    模型撞上限时经常刚好收在句号上（见上面那条注释），于是 `noClosing` 为假。
    这条兜住的就是那种情况：**话说圆了，事没办完**。

    ⚠️ 这一条要设 200 字的下限，而上面第 5 条**不能设**：
    第 5 条有「结尾没标点」当必要条件，短场景（一句回应）本来就会以标点收尾，
    不会被它误伤；而这一条只看长度，短场景很容易被它当成截断。
    两处共用一个 `tooShort` 会让"22 字被切断"这种明显情况判不出来。
  */
  if (tooShort && t.length >= 200) {
    return {
      truncated: true,
      confidence: 'low',
      reason: `这段只有约 ${t.length} 字，明显短于设定的 ${expectedChars} 字`,
    }
  }

  return { truncated: false }
}
