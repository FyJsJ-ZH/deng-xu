import { describe, it, expect } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { llmChat } from '@/api/llm'
import { LlmError } from '@/api/llmErrors'
import type { LLMConfig } from '@/types/cards'

/**
 * 「输出额度被服务商拒了」时的自动降级。
 *
 * ## 为什么这张网必须织两层（2026-11）
 *
 * Gemini 系（含中转）的思考量没有上限可言：同一份提示词，思考能从 3000 字
 * 跳到 10000 字，然后回一个 `finish_reason: "stop"` + `content: ""` 的空壳。
 * 唯一稳的做法是把额度给满 65536 —— 但**不是每家都真收得了这个数**。
 *
 * 于是这里有两个相反方向的失败要同时活下来：
 *
 *  1. 额度**不够** → 已在 `GEMINI_OUTPUT_BUDGET` 解决（给满）；
 *  2. 额度**太大被拒** → 就是本文件：按服务商报的数字压下去重发；
 *     报错里没带数字时减半再试（65536 → 32768 → 16384）。
 *
 * 第 2 条以前只在"报错里带数字"时生效。中转的 400 常常只有一句话，
 * 那样玩家会看到「max_tokens 超出范围」的红框，而模型连一个字都没开始写。
 */

type Body = Record<string, unknown>

/** 按脚本回应的假服务商：`reply` 决定第 n 次请求回什么 */
function makeScripted(reply: (n: number, body: Body) => { status: number; text: string }) {
  const bodies: Body[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body: Body = {}
      try { body = JSON.parse(raw) } catch { /* 保持空对象 */ }
      bodies.push(body)
      const { status, text } = reply(bodies.length, body)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(text)
    })
  })
  return {
    bodies,
    listen: () => new Promise<number>((r) =>
      server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port))),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

function cfg(port: number): LLMConfig {
  return {
    provider: 'custom', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k',
    narrativeModel: 'gemini-3.8-flash', analysisModel: 'm',
    temperature: 0.7, showReasoning: false,
  }
}

async function ask(port: number) {
  return llmChat({
    messages: [{ role: 'user', content: 'hi' }],
    config: cfg(port),
    model: 'gemini-3.8-flash',
    stream: false,
    maxTokens: 65536,
  })
}

describe('额度被拒 · 自动降级重发', () => {
  it('★ 报错里没带数字 → 减半再试（65536 → 32768）', async () => {
    const m = makeScripted((n) => n === 1
      ? { status: 400, text: '{"error":{"message":"max_tokens is too large for this model"}}' }
      : { status: 200, text: '{"choices":[{"message":{"content":"ok"}}]}' })
    const port = await m.listen()
    try {
      await ask(port)
      expect(m.bodies.length).toBe(2)
      expect(m.bodies[0].max_tokens).toBe(65536)
      expect(m.bodies[1].max_tokens).toBe(32768)
    } finally { await m.close() }
  })

  it('★ 报错里写了真实上限 → 直接压到那个数，不猜', async () => {
    const m = makeScripted((n) => n === 1
      ? { status: 400, text: '{"error":{"message":"max_tokens is too large. This model supports at most 8192 completion tokens"}}' }
      : { status: 200, text: '{"choices":[{"message":{"content":"ok"}}]}' })
    const port = await m.listen()
    try {
      await ask(port)
      expect(m.bodies.length).toBe(2)
      expect(m.bodies[1].max_tokens).toBe(8192)
    } finally { await m.close() }
  })

  it('★ 一直拒 → 最多降到 16384，然后如实报错（不会无限循环）', async () => {
    const m = makeScripted(() => ({
      status: 400,
      text: '{"error":{"message":"max_tokens is too large"}}',
    }))
    const port = await m.listen()
    try {
      await expect(ask(port)).rejects.toBeInstanceOf(LlmError)
      const seen = m.bodies.map(b => Number(b.max_tokens))
      // 前三次是降级链，之后才轮到普通的失败重试
      expect(seen.slice(0, 3)).toEqual([65536, 32768, 16384])
      expect(Math.min(...seen)).toBe(16384)
    } finally { await m.close() }
  })
})
