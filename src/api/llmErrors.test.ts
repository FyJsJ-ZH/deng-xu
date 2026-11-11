import { describe, it, expect } from 'vitest'
import { classifyLlmError, LlmError } from '@/api/llmErrors'

/**
 * 错误分类的关键在于**真实服务商返回体**能被正确识别。
 * 下面的 JSON 结构照抄 DeepSeek / OpenAI / OpenRouter 的实际返回。
 */
describe('LLM 错误分类', () => {
  const cases: [string, number, string, string, boolean][] = [
    ['Key 无效', 401, '{"error":{"message":"Authentication Fails, Your api key is invalid"}}', 'auth', false],
    ['无权限', 403, '{"error":{"message":"You do not have access"}}', 'auth', false],
    ['余额不足 402', 402, '{"error":{"message":"Insufficient Balance"}}', 'quota', false],
    ['401 里说余额', 401, '{"error":{"message":"Insufficient balance, please top up"}}', 'quota', false],
    ['限流', 429, '{"error":{"message":"Rate limit reached for requests"}}', 'rate_limit', true],
    ['429 里说额度', 429, '{"error":{"message":"You exceeded your current quota"}}', 'quota', false],
    ['500', 500, '{"error":{"message":"internal server error"}}', 'server', true],
    ['502 网关', 502, '<html>502 Bad Gateway</html>', 'server', true],
    ['上下文超长', 400, '{"error":{"message":"maximum context length is 65536 tokens"}}', 'bad_request', false],
    ['模型名错', 400, '{"error":{"message":"The model `gpt-9` does not exist"}}', 'bad_request', false],
    /*
      max_tokens 类有两种：带数字和没数字，**都要归到 max_tokens**。
      没数字的那条是 2026-11 补的 —— 中转的 400 常常只有一句
      "max_tokens is too large"，归到通用 400 就没法自动降级重发了。
    */
    ['额度超范围且有数字', 400, '{"error":{"message":"max_tokens is too large. This model supports at most 8192 completion tokens"}}', 'max_tokens', false],
    ['额度超范围但没数字', 400, '{"error":{"message":"max_tokens is too large for this model"}}', 'max_tokens', false],
  ]

  for (const [name, status, body, kind, retryable] of cases) {
    it(`${name} → ${kind} / retryable=${retryable}`, () => {
      const info = classifyLlmError(status, body)
      expect(info.kind).toBe(kind)
      expect(info.retryable).toBe(retryable)
    })
  }

  it('断网 → network 且可重试', () => {
    const info = classifyLlmError(undefined, '', new Error('Failed to fetch'))
    expect(info.kind).toBe('network')
    expect(info.retryable).toBe(true)
  })

  it('超时 → timeout 且可重试', () => {
    const info = classifyLlmError(undefined, '', new Error('request timed out'))
    expect(info.kind).toBe('timeout')
    expect(info.retryable).toBe(true)
  })

  it('用户取消 → aborted 且不重试', () => {
    const e = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const info = classifyLlmError(undefined, '', e)
    expect(info.kind).toBe('aborted')
    expect(info.retryable).toBe(false)
  })

  it('所有文案都不含原始 JSON 结构', () => {
    // 这条很重要：以前界面上直接显示 `429 ... {"error":{...}}`，
    // 玩家完全看不懂。分类后的文案必须是给玩家看的。
    for (const [, status, body] of cases) {
      const info = classifyLlmError(status, body)
      expect(info.message).not.toMatch(/[{}]|"error"/)
    }
  })

  it('可操作的错误都带中文处理建议', () => {
    for (const [, status, body] of cases) {
      const info = classifyLlmError(status, body)
      expect(info.hint, `${status} 缺 hint`).toBeTruthy()
      expect(info.hint!).toMatch(/[\u4e00-\u9fa5]/)
    }
  })

  it('LlmError 仍是 Error，可被 catch/instanceof 识别', () => {
    const e = new LlmError(classifyLlmError(429, '{"error":{"message":"rate limited"}}'))
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('LlmError')
    expect(e.info.kind).toBe('rate_limit')
  })
})
