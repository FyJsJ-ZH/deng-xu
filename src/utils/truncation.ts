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
  if (String(finishReason || '').toLowerCase() === 'length') {
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
