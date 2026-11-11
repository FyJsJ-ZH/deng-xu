import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  llmChat, isGeminiLike, suggestMaxTokens, willThink, withThinkingReserve,
} from '@/api/llm'
import { classifyLlmError } from '@/api/llmErrors'
import type { LLMConfig } from '@/types/cards'

/**
 * Gemini 系（含第三方中转）的适配。
 *
 * ## 玩家报的原话
 *
 * > 「我最近在用 gemini 模型游玩……给本项目做点适配」
 *
 * 界面上每一轮都红一片：
 *
 * > Forced function calling (mode = ANY) is not supported when
 * > 'response_mime_type' is not set to 'text/plain'. Please set
 * > 'tool_config.function_calling_config.mode=AUTO' or set
 * > 'response_mime_type' to 'text/plain'.
 *
 * ## 实测出来的根因（同一家中转、同一个模型，只改一个字段）
 *
 * | 请求体 | 结果 |
 * |---|---|
 * | `response_format: json_object` + thinking + max_tokens + temperature | **400** |
 * | 去掉 `response_format` | 200，返回干净 JSON |
 * | 保留 json_object、只去掉 thinking | **400** —— 与 thinking 无关 |
 * | 只留 max_tokens（+temperature / 不带 temperature） | 200 |
 * | `response_format: {type:'text'}` | 200 |
 *
 * 也就是说：OpenAI 的 `json_object` 被中转翻成 Gemini 的
 * `response_mime_type: 'application/json'`，而 Vertex 在 mime 不是 text/plain 时
 * 默认 `function_calling_config.mode = ANY`（强制必须调用工具），我们没给工具 → 打回。
 *
 * 所以这里钉三件事：
 *   1. 认得出 Gemini（模型名、baseUrl 两条路）；
 *   2. 对它发 `{type:'text'}` 而不是 `json_object`；
 *   3. **认不出来时也能自救** —— 抓到那条 400 就摘掉 `response_format` 重发一次。
 */

type Body = Record<string, unknown>

/** 假服务端：按预设的响应序列回包，并记录每一次请求体 */
function makeServer(responses: Array<{ status: number; body: string }>) {
  const bodies: Body[] = []
  let i = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try { bodies.push(JSON.parse(raw)) } catch { bodies.push({}) }
      const r = responses[Math.min(i, responses.length - 1)]
      i += 1
      res.writeHead(r.status, { 'Content-Type': 'application/json' })
      res.end(r.body)
    })
  })
  return {
    bodies,
    listen: () => new Promise<number>((r) =>
      server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port))),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

const OK = { status: 200, body: '{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}' }

/** Vertex 那一句原话，一字不改 —— 判据就是它 */
const VERTEX_400 = {
  status: 400,
  body: JSON.stringify({
    error: {
      message: "Forced function calling (mode = ANY) is not supported when 'response_mime_type' is not set to 'text/plain'.Please set 'tool_config.function_calling_config.mode= AUTO' or set 'response_mime_type' to 'text/plain'. For more details, see: https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/",
      type: 'invalid_request_error',
    },
  }),
}

const servers: ReturnType<typeof makeServer>[] = []

async function start(responses = [OK], over: Partial<LLMConfig> = {}) {
  const m = makeServer(responses)
  servers.push(m)
  const port = await m.listen()
  const config: LLMConfig = {
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'k',
    narrativeModel: 'gemini-3.8-flash',
    analysisModel: 'gemini-3.8-flash',
    temperature: 0.7,
    showReasoning: false,
    ...over,
  }
  return { m, config }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => s.close()))
})

describe('isGeminiLike · 认得出 Gemini', () => {
  it('★ 模型名里带 gemini / gemma 的都算（含中转前缀）', () => {
    for (const n of [
      'gemini-3.8-flash', 'gemini-2.5-pro', 'models/gemini-1.5-flash',
      'vtx-抗截断-gemini-3.8-flash-high', 'GEMMA-2-27B',
    ]) {
      expect(isGeminiLike(n), n).toBe(true)
    }
  })

  it('★ baseUrl 指向 Google 官方端点时也算（模型名被中转改掉的情况）', () => {
    expect(isGeminiLike('m', 'https://generativelanguage.googleapis.com/v1beta')).toBe(true)
    expect(isGeminiLike('m', 'https://us-central1-aiplatform.googleapis.com/v1')).toBe(true)
  })

  it('别家的模型与端点都不算', () => {
    for (const n of ['deepseek-flash', 'gpt-4o', 'claude-3.5-sonnet', 'qwen-max', 'm']) {
      expect(isGeminiLike(n), n).toBe(false)
    }
    expect(isGeminiLike('gpt-4o', 'https://api.openai.com/v1')).toBe(false)
    expect(isGeminiLike('gpt-4o', 'https://catiecli.sukaka.top/v1')).toBe(false)
  })

  it('★ Gemini 默认就在思考 → auto 判定为 true，额度**给满**', () => {
    // 实测：请求里一个字都没提 thinking，返回照样带整屏 reasoning_content
    expect(willThink('gemini-3.8-flash', 'custom', 'auto')).toBe(true)
    /*
      16384 曾经是这里的答案，直到玩家第二次报「成功一次、重试就空」——
      抓到的回包是 `finish_reason: "stop"` + `content: ""`：
      模型一直想、想完收尾、一个字没写。这类模型的思考量没有上限可言，
      所以给满（65536 = `MAX_OUTPUT_TOKENS_CAP`），未用完不收费。
    */
    expect(suggestMaxTokens(1800, 'gemini-3.8-flash')).toBe(65536)
    expect(suggestMaxTokens(1800, 'gpt-4o')).toBe(3600)
    // 玩家明确关掉时仍然听话（能不能真关上是另一回事，见下面的说明）
    expect(willThink('gemini-3.8-flash', 'custom', 'off')).toBe(false)
  })
})

/**
 * 玩家手填的「单次回复上限」（2026-11，玩家报「用 gemini 会返回空内容」）。
 *
 * 那个数在报文里是 `max_tokens` —— 思维链 + 正文的总和。
 * Gemini 走中转实测思考吃掉 2900 左右；玩家填 4096，正文就只剩 1100 token，
 * 稍一展开整轮就空。所以对会思考的模型，他的手填值要当成"正文那头"的额度。
 */
describe('手填额度 · 思考模型要先垫一笔', () => {
  it('★ 填 4096 + Gemini → 不管填多少都顶到上限', () => {
    expect(withThinkingReserve(4096, 'gemini-3.8-flash')).toBe(65536)
    expect(withThinkingReserve(4096, 'deepseek-reasoner')).toBe(8192)
  })

  it('普通模型不动他的选择', () => {
    expect(withThinkingReserve(4096, 'gpt-4o')).toBe(4096)
    expect(withThinkingReserve(2048, 'deepseek-chat')).toBe(2048)
  })

  it('玩家明确关掉思考时不垫（那时他填的就是全部）', () => {
    expect(withThinkingReserve(4096, 'gemini-3.8-flash', '', 'off')).toBe(4096)
  })

  it('★ 玩家填 65536 也不会超出去（硬闸）；脏数据照样顶满', () => {
    expect(withThinkingReserve(999999, 'gemini-3.8-flash')).toBe(65536)
    // 填 0 / NaN / 负数 = 没填，对 Gemini 仍给满 —— 它思考量不可控，给少了就是空正文
    expect(withThinkingReserve(Number.NaN, 'gemini-3.8-flash')).toBe(65536)
    expect(withThinkingReserve(-1, 'gemini-3.8-flash')).toBe(65536)
  })
})

describe('请求体 · Gemini 走纯文本模式', () => {  it('★ jsonMode + Gemini → response_format 是 text，不是 json_object', async () => {
    const { m, config } = await start()
    await llmChat({
      messages: [{ role: 'user', content: 'hi' }],
      config, stream: false, jsonMode: true, thinking: 'off',
    })
    expect(m.bodies[0].response_format).toEqual({ type: 'text' })
  })

  it('★ 同样的请求走非 Gemini → 仍是 json_object（别把别人也改坏了）', async () => {
    const { m, config } = await start([OK], { narrativeModel: 'deepseek-flash', provider: 'deepseek' })
    await llmChat({
      messages: [{ role: 'user', content: 'hi' }],
      config, stream: false, jsonMode: true, thinking: 'off',
    })
    expect(m.bodies[0].response_format).toEqual({ type: 'json_object' })
  })

  it('★ Gemini 不发 thinking 字段 —— 那是 DeepSeek 的私有字段，发了也没用', async () => {
    const { m, config } = await start([OK], { thinking: 'off' })
    await llmChat({
      messages: [{ role: 'user', content: 'hi' }],
      config, stream: false, jsonMode: true, thinking: 'off',
    })
    expect('thinking' in m.bodies[0]).toBe(false)
    // 但它确实接受 temperature，所以照发
    expect(m.bodies[0].temperature).toBe(0.7)
  })

  it('Gemini 在 auto 下不发 temperature（它在思考，temperature 白传）', async () => {
    const { m, config } = await start()
    await llmChat({ messages: [{ role: 'user', content: 'hi' }], config, stream: false })
    expect(m.bodies[0].temperature).toBeUndefined()
  })

  it('★ 没认出模型名（玩家自填 m）时先按 OpenAI 那套发 —— 不擅自改别人的报文', async () => {
    const { m, config } = await start([OK], { narrativeModel: 'm' })
    await llmChat({
      messages: [{ role: 'user', content: 'hi' }],
      config, stream: false, jsonMode: true, thinking: 'off',
    })
    expect(m.bodies[0].response_format).toEqual({ type: 'json_object' })
  })
})

describe('自动降级 · 认不出来也能自救', () => {
  it('★ 撞上 Vertex 那条 400 → 摘掉 response_format 重发一次，这一轮活下来', async () => {
    const { m, config } = await start([VERTEX_400, OK], { narrativeModel: 'm' })
    const out = await llmChat({
      messages: [{ role: 'user', content: 'hi' }],
      config, stream: false, jsonMode: true, thinking: 'off',
    })
    expect(m.bodies).toHaveLength(2)
    // 第一次带着 json_object，被打回
    expect(m.bodies[0].response_format).toEqual({ type: 'json_object' })
    // 第二次干脆不发这个字段
    expect('response_format' in m.bodies[1]).toBe(false)
    // 而且它确实拿到了回包
    expect(out).toBeTruthy()
  })

  it('降级只做一次：两次都被打回就如实报错，不无限重发', async () => {
    const { m, config } = await start([VERTEX_400, VERTEX_400, VERTEX_400], { narrativeModel: 'm' })
    await expect(llmChat({
      messages: [{ role: 'user', content: 'hi' }],
      config, stream: false, jsonMode: true, thinking: 'off',
    })).rejects.toThrow()
    // 一次原发 + 一次摘字段重发，不会更多
    expect(m.bodies.length).toBeLessThanOrEqual(2)
  })

  it('不碰无关的 400：别的坏请求不会白花一次重发', async () => {
    const { m, config } = await start([
      { status: 400, body: '{"error":{"message":"model not found"}}' },
      OK,
    ], { narrativeModel: 'm' })
    await expect(llmChat({
      messages: [{ role: 'user', content: 'hi' }],
      config, stream: false, jsonMode: true, thinking: 'off',
    })).rejects.toThrow()
    expect(m.bodies).toHaveLength(1)
  })
})

describe('错误归因 · 那条英文报错要翻成人话', () => {
  it('★ Vertex 的 function calling 报错单独成类，且给出可操作的建议', () => {
    const info = classifyLlmError(400, VERTEX_400.body)
    expect(info.kind).toBe('function_calling')
    expect(info.retryable).toBe(false)
    expect(info.message).toContain('JSON')
    expect(info.hint).toContain('纯文本')
  })

  it('★ 它排在其他 400 分支前面 —— 别被"参数不被支持"的通用分支吃掉', () => {
    // 这条报错里同时有 "not supported"，通用分支会给出一个没用的提示
    const info = classifyLlmError(400, VERTEX_400.body)
    expect(info.kind).not.toBe('bad_request')
  })

  it('输出上限超范围仍然归到 max_tokens（两条判据不打架）', () => {
    const info = classifyLlmError(400, JSON.stringify({
      error: {
        message: 'maxOutputTokens value of 1000000 but the supported range is from 1 (inclusive) to 65537 (exclusive)',
      },
    }))
    expect(info.kind).toBe('max_tokens')
    expect(info.outputLimit).toBe(65536)
  })
})
