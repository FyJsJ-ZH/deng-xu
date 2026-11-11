import { describe, it, expect } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { testConnection, listModels, llmChat } from '@/api/llm'
import { LlmError } from '@/api/llmErrors'
import type { LLMConfig } from '@/types/cards'

/**
 * 「测试连接」到底测了什么（2026-11 玩家截图）。
 *
 * 他的现象：
 *   - 点「测试连接」→ 成功；
 *   - 一进游戏 → `{"detail":"未知模型: vtx-抗截断-gemini-4-Argon-high"}`。
 *
 * 两个模型名只差一个大小写（叙事写 `Argon`、结算写 `argon`），
 * 而中转大小写敏感；当时的实现只测 `analysisModel`，
 * 于是那个绿色的成功提示是个**假信号**。
 *
 * 这一组钉三件事：
 *   1. 有模型清单时**不发请求就判得出来**，而且能指出大小写差在哪；
 *   2. 两个模型都测，不只是结算那个；
 *   3. 没有清单时退回真跑一次，报错要带上是**哪个模型**。
 */

type Hit = { method: string; path: string; body: Record<string, unknown> }

function server(handler: (hit: Hit) => { status: number; json: unknown } | null) {
  const hits: Hit[] = []
  const s = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try { body = raw ? JSON.parse(raw) : {} } catch { /* 忽略 */ }
      const hit: Hit = { method: req.method || '', path: req.url || '', body }
      hits.push(hit)
      const out = handler(hit)
      if (!out) { res.writeHead(404); res.end('{}'); return }
      res.writeHead(out.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out.json))
    })
  })
  return {
    hits,
    listen: () => new Promise<number>((r) =>
      s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port))),
    close: () => new Promise<void>((r) => s.close(() => r())),
  }
}

const cfg = (port: number, over: Partial<LLMConfig> = {}): LLMConfig => ({
  provider: 'custom', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k',
  narrativeModel: 'vtx-抗截断-gemini-4-Argon-high',
  analysisModel: 'vtx-抗截断-gemini-4-argon-high',
  temperature: 0.8, showReasoning: false,
  ...over,
})

const okChat = { choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] }

describe('模型清单', () => {
  it('拿得到 `{ data: [{ id }] }` 这种标准形状', async () => {
    const s = server(() => ({ status: 200, json: { data: [{ id: 'a' }, { id: 'b' }] } }))
    const port = await s.listen()
    try {
      expect(await listModels(cfg(port))).toEqual(['a', 'b'])
    } finally { await s.close() }
  })

  it('拉不到（404）返回空数组，不该因此判失败', async () => {
    const s = server(() => ({ status: 404, json: { detail: 'Not Found' } }))
    const port = await s.listen()
    try {
      expect(await listModels(cfg(port))).toEqual([])
    } finally { await s.close() }
  })
})

describe('测试连接', () => {
  it('★ 模型名大小写不对 → 直接点破，且不发 chat 请求', async () => {
    const s = server((h) => h.path.startsWith('/models')
      ? { status: 200, json: { data: [{ id: 'vtx-抗截断-gemini-4-argon-high' }, { id: 'other' }] } }
      : { status: 200, json: okChat })
    const port = await s.listen()
    try {
      const err = await testConnection(cfg(port)).then(() => null, (e) => e)
      expect(err).toBeInstanceOf(LlmError)
      const info = (err as LlmError).info
      expect(info.kind).toBe('model')
      expect(info.message).toContain('大小写')
      expect(info.message).toContain('vtx-抗截断-gemini-4-argon-high')
      // 拉清单就够了，不必真跑一次慢请求
      expect(s.hits.some(h => h.path.includes('/chat/completions'))).toBe(false)
    } finally { await s.close() }
  })

  it('★ 两个模型都在清单里 → 通过', async () => {
    const s = server(() => ({
      status: 200,
      json: { data: [{ id: 'vtx-抗截断-gemini-4-Argon-high' }, { id: 'vtx-抗截断-gemini-4-argon-high' }] },
    }))
    const port = await s.listen()
    try {
      await expect(testConnection(cfg(port))).resolves.toBeUndefined()
    } finally { await s.close() }
  })

  it('★ 只有结算模型在、叙事模型不在 → 一定要失败（以前只测结算所以「成功」）', async () => {
    const s = server(() => ({
      status: 200,
      json: { data: [{ id: 'vtx-抗截断-gemini-4-argon-high' }] },
    }))
    const port = await s.listen()
    try {
      const err = await testConnection(cfg(port)).then(() => null, (e) => e)
      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).info.message).toContain('Argon')
    } finally { await s.close() }
  })

  it('没有清单 → 退回真跑一次；两个模型都测', async () => {
    const s = server((h) => h.path.startsWith('/models')
      ? { status: 404, json: { detail: 'Not Found' } }
      : { status: 200, json: okChat })
    const port = await s.listen()
    try {
      await expect(testConnection(cfg(port))).resolves.toBeUndefined()
      const chats = s.hits.filter(h => h.path.includes('/chat/completions'))
      expect(chats.map(c => c.body.model)).toEqual([
        'vtx-抗截断-gemini-4-Argon-high',
        'vtx-抗截断-gemini-4-argon-high',
      ])
    } finally { await s.close() }
  })

  it('★ 报错要带上是哪个模型（不然玩家不知道改哪一个）', async () => {
    const s = server((h) => h.path.startsWith('/models')
      ? { status: 404, json: { detail: 'Not Found' } }
      : h.body.model === 'vtx-抗截断-gemini-4-Argon-high'
        ? { status: 404, json: { detail: '未知模型: vtx-抗截断-gemini-4-Argon-high' } }
        : { status: 200, json: okChat })
    const port = await s.listen()
    try {
      const err = await testConnection(cfg(port)).then(() => null, (e) => e)
      expect(err).toBeInstanceOf(LlmError)
      const info = (err as LlmError).info
      expect(info.kind).toBe('model')
      expect(info.message).toContain('vtx-抗截断-gemini-4-Argon-high')
      // 不再是原始 JSON
      expect(info.message).not.toContain('{')
    } finally { await s.close() }
  })

  it('一个模型名都不填 → 直接说清楚，不发请求', async () => {
    const s = server(() => ({ status: 200, json: okChat }))
    const port = await s.listen()
    try {
      const err = await testConnection(cfg(port, { narrativeModel: '  ', analysisModel: '' }))
        .then(() => null, (e) => e)
      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).info.message).toContain('模型名')
      expect(s.hits.length).toBe(0)
    } finally { await s.close() }
  })
})

describe('模型名里的空格', () => {
  it('★ 首尾空格在发出去之前就 trim 掉（复制粘贴常带，肉眼看不出）', async () => {
    const s = server(() => ({ status: 200, json: okChat }))
    const port = await s.listen()
    try {
      await llmChat({
        messages: [{ role: 'user', content: 'hi' }],
        config: cfg(port),
        model: '  vtx-抗截断-gemini-4-Argon-high\n',
        stream: false,
      })
      expect(s.hits[0].body.model).toBe('vtx-抗截断-gemini-4-Argon-high')
    } finally { await s.close() }
  })
})
