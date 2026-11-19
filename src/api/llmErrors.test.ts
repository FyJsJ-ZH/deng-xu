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
    ['模型名错', 400, '{"error":{"message":"The model `gpt-9` does not exist"}}', 'model', false],
    /*
      max_tokens 类有两种：带数字和没数字，**都要归到 max_tokens**。
      没数字的那条是 2026-11 补的 —— 中转的 400 常常只有一句
      "max_tokens is too large"，归到通用 400 就没法自动降级重发了。
    */
    ['额度超范围且有数字', 400, '{"error":{"message":"max_tokens is too large. This model supports at most 8192 completion tokens"}}', 'max_tokens', false],
    ['额度超范围但没数字', 400, '{"error":{"message":"max_tokens is too large for this model"}}', 'max_tokens', false],
    /*
      2026-11 玩家截图里的原文。两个细节都要钉：
      1. 状态码可能是 400 也可能是 404（FastAPI 那类中转两种都用），都得认；
      2. 报错体是 `{ detail }` 而不是 `{ error: { message } }`，
         不认这个形状就会把一整串 JSON 原样甩到屏幕上。
    */
    ['FastAPI 未知模型（400）', 400, '{"detail":"未知模型: vtx-抗截断-gemini-4-Argon-high"}', 'model', false],
    ['FastAPI 未知模型（404）', 404, '{"detail":"未知模型: vtx-抗截断-gemini-4-Argon-high"}', 'model', false],
    ['404 但不像模型问题 → 地址不对', 404, '{"detail":"Not Found"}', 'bad_request', false],
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

/**
 * 网络层失败的细分（2026-11）。
 *
 * 以前 `status === undefined` 只有一个出口：「网络连接失败 / 检查网络或代理」。
 * 玩家拿这句话去查网络，而真相七种里挑一。
 *
 * 麻烦在于浏览器不给细节：Chrome 统一抛 `TypeError: Failed to fetch`。
 * 所以这里分两层测：
 *   1. 认得出来的（Node/undici 会带 cause.code、部分浏览器会漏 net::ERR_xxx）
 *      必须分对，而且 `retryable` 要跟着变 —— "重试就好"和"改配置"不是一回事；
 *   2. 认不出来的（纯 Failed to fetch）走兜底，兜底给的是**排查顺序**。
 */
describe('网络层失败细分', () => {
  /** 造一个像 undici 那样的异常：message 是 fetch failed，原因在 cause.code */
  const netErr = (code: string, message = 'fetch failed') =>
    Object.assign(new Error(message), { name: 'TypeError', cause: { code } })

  it('★ ECONNREFUSED（端口没人听）→ 地址问题，且不再劝人重试', () => {
    const info = classifyLlmError(undefined, '', netErr('ECONNREFUSED'))
    expect(info.message).toContain('拒绝连接')
    expect(info.retryable).toBe(false)
    // 原始异常必须留下来，否则日志里没有任何证据
    expect(info.raw).toContain('ECONNREFUSED')
  })

  it('★ ENOTFOUND（域名解析不了）→ 指向拼写，而不是网络', () => {
    const info = classifyLlmError(undefined, '', netErr('ENOTFOUND'))
    expect(info.message).toContain('域名')
    expect(info.retryable).toBe(false)
  })

  it('证书问题 → 别让人去改模型名', () => {
    const info = classifyLlmError(undefined, '', netErr('CERT_HAS_EXPIRED'))
    expect(info.message).toContain('证书')
    expect(info.retryable).toBe(false)
  })

  it('连接被重置 → 这条才是"换个网络再试"，可重试', () => {
    const info = classifyLlmError(undefined, '', netErr('ECONNRESET'))
    expect(info.message).toContain('掐断')
    expect(info.retryable).toBe(true)
  })

  it('超时与"连不上"必须分开 —— 一个等，一个改', () => {
    const t = classifyLlmError(undefined, '', netErr('ETIMEDOUT'))
    const r = classifyLlmError(undefined, '', netErr('ECONNREFUSED'))
    expect(t.kind).toBe('timeout')
    expect(r.kind).toBe('network')
    expect(t.message).not.toBe(r.message)
  })

  it('★ 纯 `Failed to fetch` → 兜底给三步排查顺序，不含糊', () => {
    const info = classifyLlmError(undefined, '', new TypeError('Failed to fetch'))
    expect(info.kind).toBe('network')
    expect(info.hint).toContain('地址栏')
    expect(info.hint).toContain('跨域')
  })

  it('浏览器带 net::ERR_ 时也认', () => {
    const info = classifyLlmError(undefined, '', new TypeError('net::ERR_CONNECTION_REFUSED'))
    expect(info.message).toContain('拒绝连接')
  })

  it('https 页面调 http 接口 → 直说协议问题', () => {
    const info = classifyLlmError(
      undefined, '',
      new TypeError('Mixed Content: The page at https://... was loaded over HTTPS')
    )
    expect(info.message).toContain('HTTPS')
    expect(info.hint).toContain('https://')
  })

  it('aborted 不会被当成网络失败（用户主动取消不该报红）', () => {
    const info = classifyLlmError(undefined, '', Object.assign(new Error('x'), { name: 'AbortError' }))
    expect(info.kind).toBe('aborted')
  })
})
