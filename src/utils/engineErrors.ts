/**
 * 「模型给了空正文」时，到底该怎么说。
 *
 * ## 为什么单独一个函数（2026-11 玩家实测）
 *
 * 他在局内设置里填了「单次回复上限」，然后点「重新生成」，
 * 屏幕上只有一句：
 *
 * > 模型返回了空内容，请检查模型名称与接口地址。
 *
 * 而模型名和接口都没问题 —— 真正发生的是：**思考模式**先把额度吃光了。
 * DeepSeek 的 V4 系列默认开着思考，`max_tokens` 是"思维链 + 正文"的**总量**；
 * 填小了（比如 2048），思维链写到一半额度就没了，`content` 一个字都还没开始。
 *
 * 那句话在这种场景下是**误导**：它让玩家去查一个没坏的东西。
 * 而只要说得准一点，他自己两下就能改对：把上限调大，或者把思考关掉。
 *
 * 判据全部来自流里实际看到的东西（`finish_reason` + 有没有思维链），
 * 不猜。
 */

export interface EmptyNarrativeInfo {
  /** 流里最后一帧的 finish_reason；`length` = 撞到 max_tokens */
  finishReason?: string
  /** 收到的思维链全文 */
  reasoning?: string
  /** 这一次请求实际用的 max_tokens（可能来自玩家手填） */
  maxTokens?: number
  /** 是不是默认会思考的模型 */
  thinkingLikely?: boolean
}

/** 思考链 + 正文的最小可用额度：低于这个数，思考模式几乎必然把正文饿死 */
export const THINKING_MIN_MAX_TOKENS = 4096

export function describeEmptyNarrative(info: EmptyNarrativeInfo): string {
  const limit = typeof info.maxTokens === 'number' && info.maxTokens > 0
    ? `${Math.floor(info.maxTokens)} token`
    : '当前上限'
  const hasReasoning = !!info.reasoning?.trim()
  const hitLimit = info.finishReason === 'length'

  if (hitLimit && hasReasoning) {
    return `思考链把 ${limit} 的额度用完了，正文一个字都还没开始写。`
      + `把「单次回复上限」调到 ${THINKING_MIN_MAX_TOKENS} 以上（建议 5400），`
      + '或者在模型设置里把「思考模式」改成「关闭」。'
  }

  if (hitLimit) {
    return `这一轮撞到了 ${limit} 的输出上限，正文还没写出来就被切断了。`
      + '把「单次回复上限」调大一些。'
  }

  if (hasReasoning && info.thinkingLikely) {
    return '模型只回了思考过程，没有落笔。多半是额度太紧 —— '
      + `把「单次回复上限」调到 ${THINKING_MIN_MAX_TOKENS} 以上，或把「思考模式」关掉再试。`
  }

  return '模型返回了空内容，请检查模型名称与接口地址。'
}
