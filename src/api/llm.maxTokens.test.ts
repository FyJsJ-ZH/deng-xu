import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { llmChat, suggestMaxTokens, isReasonerModel } from '@/api/llm'
import type { LLMConfig } from '@/types/cards'

/**
 * `max_tokens` 的测试。
 *
 * ## 为什么这件事必须单独测（2026-11，玩家第四次报「字数不够」）
 *
 * 前三轮的修法都落在提示词层（改 `replyLength`、刷内置卡、加战斗节拍），
 * 而提示词只表达「我希望写多长」，**真正决定长度的是 API 的 `max_tokens`**。
 *
 * 这个项目在此前**一次都没发过这个参数**。没发的时候长度由服务商默认值决定：
 * 官方 4096 够用，但大量中转站默认 2048 —— 中文约 1.5 token/字，
 * 2048 / 1.5 ≈ 1365 字，正好是玩家说的「不到 1200 字」。
 *
 * 所以下面这些断言盯的是**请求体里到底有没有这个字段**，不是提示词写了什么。
 * 用本地假服务商收请求体 —— mock fetch 只能验证我自己的假设。
 */

type Body = Record<string, unknown>

function makeRecorder() {
  const bodies: Body[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try { bodies.push(JSON.parse(raw)) } catch { bodies.push({}) }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"choices":[{"message":{"content":"ok"}}]}')
    })
  })
  return {
    bodies,
    listen: () => new Promise<number>((r) =>
      server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port))),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

const servers: ReturnType<typeof makeRecorder>[] = []

function cfg(port: number, over: Partial<LLMConfig> = {}): LLMConfig {
  return {
    provider: 'custom', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k',
    narrativeModel: 'm', analysisModel: 'm', temperature: 0.7, showReasoning: false,
    ...over,
  }
}

async function start(over: Partial<LLMConfig> = {}) {
  const m = makeRecorder()
  servers.push(m)
  const port = await m.listen()
  return { m, config: cfg(port, over) }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => s.close()))
})

describe('max_tokens · 按目标字数推算额度', () => {
  it('★ 1800 字的目标 → 3600 token（中文按 2 token/字估）', () => {
    expect(suggestMaxTokens(1800)).toBe(3600)
  })

  it('★ 推理模型给三倍 —— 思维链会和正文抢同一份额度', () => {
    expect(suggestMaxTokens(1800, 'deepseek-reasoner')).toBe(5400)
    expect(suggestMaxTokens(1800, 'deepseek-chat')).toBe(3600)
  })

  it('★ 有下限：目标字数很小时也不能低于 1024（否则一句都写不完）', () => {
    expect(suggestMaxTokens(100)).toBe(1024)
    expect(suggestMaxTokens(0)).toBe(3600)   // 0 视为没填 → 按 1800 算
    expect(suggestMaxTokens(Number.NaN)).toBe(3600)
  })

  it('★ 有上限：不超过 16384（多数服务商单次输出去到这里会被拒）', () => {
    expect(suggestMaxTokens(20000)).toBe(16384)
  })

  it('推理模型识别', () => {
    for (const n of ['deepseek-reasoner', 'qwq-thinking', 'o1-mini', 'o3', 'r1']) {
      expect(isReasonerModel(n), n).toBe(true)
    }
    for (const n of ['deepseek-chat', 'gpt-4o', 'claude-3.5-sonnet', 'qwen2.5:14b']) {
      expect(isReasonerModel(n), n).toBe(false)
    }
  })
})

describe('max_tokens · 必须真的出现在请求体里', () => {
  it('★ opts.maxTokens 被写进请求体', async () => {
    const { m, config } = await start()
    await llmChat({
      messages: [{ role: 'user', content: 'hi' }],
      config, model: 'm', stream: false, maxTokens: 3600,
    })
    expect(m.bodies[0].max_tokens).toBe(3600)
  })

  it('★ 没给 opts 时退回 config.maxTokens（玩家手填的值）', async () => {
    const { m, config } = await start({ maxTokens: 2048 })
    await llmChat({ messages: [{ role: 'user', content: 'hi' }], config, model: 'm', stream: false })
    expect(m.bodies[0].max_tokens).toBe(2048)
  })

  it('★ opts 优先于 config（单次调用可以要得更多）', async () => {
    const { m, config } = await start({ maxTokens: 2048 })
    await llmChat({
      messages: [{ role: 'user', content: 'hi' }],
      config, model: 'm', stream: false, maxTokens: 8192,
    })
    expect(m.bodies[0].max_tokens).toBe(8192)
  })

  it('两处都没填 → 不发这个字段（保持旧行为，不擅自替用户定上限）', async () => {
    const { m, config } = await start()
    await llmChat({ messages: [{ role: 'user', content: 'hi' }], config, model: 'm', stream: false })
    expect('max_tokens' in m.bodies[0]).toBe(false)
  })

  it('非法值不发（0 / 负数 / NaN）', async () => {
    const { m, config } = await start()
    for (const bad of [0, -1, Number.NaN]) {
      await llmChat({
        messages: [{ role: 'user', content: 'hi' }],
        config, model: 'm', stream: false, maxTokens: bad,
      })
    }
    for (const b of m.bodies) expect('max_tokens' in b).toBe(false)
  })

  it('小数会被取整（某些服务商拒收浮点）', async () => {
    const { m, config } = await start()
    await llmChat({
      messages: [{ role: 'user', content: 'hi' }],
      config, model: 'm', stream: false, maxTokens: 3600.7,
    })
    expect(m.bodies[0].max_tokens).toBe(3600)
    expect(Number.isInteger(m.bodies[0].max_tokens)).toBe(true)
  })
})
