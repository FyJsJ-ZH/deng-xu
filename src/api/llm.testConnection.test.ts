import { describe, it, expect } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { testConnection, testConnectionDetailed, listModels, llmChat } from '@/api/llm'
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

/**
 * 地址本身不通（2026-11 玩家那份 `llm-settings-error.log`）。
 *
 * 他的 baseUrl 是 `https://catiecli.sukaka.top/v1`，我实测：域名解析正常
 * （38.49.38.34），但那个 IP 的 443 端口直接 RST，22 端口还开着 OpenSSH ——
 * 也就是**机器活着，服务停了**。而他看到的是「网络连接失败」，
 * 于是去查自己的网络，怎么查都是好的。
 *
 * 这一组钉住：先说地址，再提模型名。旧实现的 `/models` 那一趟把异常
 * 吞成了空数组，最早的死因就这么丢了。
 */
describe('地址根本不通', () => {
  /** 拿一个此刻没人监听的本地端口 */
  const deadPort = () => new Promise<number>((r) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port
      s.close(() => r(p))
    })
  })

  it('★ 端口没人听 → 说「接口地址不通」，且点明与模型名无关', async () => {
    const port = await deadPort()
    const err = await testConnection(cfg(port)).then(() => null, (e) => e)
    expect(err).toBeInstanceOf(LlmError)
    const info = (err as LlmError).info
    expect(info.message).toContain('接口地址不通')
    // 这句是关键：让他别再去改模型名
    expect(info.hint).toContain('与模型名')
    // 原始异常要留下来（以前这里是空的，等于不给证据）
    expect(info.raw).toMatch(/ECONNREFUSED|fetch failed/i)
  })

  it('★ 连接被拒不该说成"重试就好" —— 它是配置问题', async () => {
    const port = await deadPort()
    const err = await testConnection(cfg(port)).then(() => null, (e) => e) as LlmError
    expect(err.info.retryable).toBe(false)
  })

  it('地址通、只是 401 → 不许说成"地址不通"', async () => {
    const s = server(() => ({ status: 401, json: { error: { message: 'Invalid API key' } } }))
    const port = await s.listen()
    try {
      const err = await testConnection(cfg(port)).then(() => null, (e) => e) as LlmError
      expect(err.info.kind).toBe('auth')
      expect(err.info.message).not.toContain('接口地址不通')
    } finally { await s.close() }
  })
})

/**
 * 「想要能看到此接口地址的所有可选模型」（2026-11 玩家截图）。
 *
 * 他那家回 27 个模型，界面上只有一行：
 *   这家现在可选：pg-gemini-3-flash-preview、… 等 27 个
 * 剩下 15 个名字一个都拿不到。而这家的命名是
 *   `pg-gemini-3.5-flash-lite` / `抗截断-pg-gemini-3.5-flash-lite`
 *   / `假流式-pg-gemini-3.5-flash-lite`
 * 三种包装 × 九个基名 —— 靠猜拼不出来。
 *
 * 这一组钉两件事：完整清单要带出来（不截断），以及**测通了也要能拿到**。
 */
describe('完整模型清单', () => {
  /** 27 个，与玩家那家同量级 */
  const many = Array.from({ length: 27 }, (_, i) => `pg-gemini-3.${i}-flash-lite`)

  it('★ 模型名对不上 → info.modelCatalog 是全部 27 个，不是前 12 个', async () => {
    const s = server(() => ({ status: 200, json: { data: many.map(id => ({ id })) } }))
    const port = await s.listen()
    try {
      const err = await testConnection(cfg(port)).then(() => null, (e) => e) as LlmError
      expect(err.info.modelCatalog).toEqual(many)
      expect(err.info.modelCatalog).toHaveLength(27)
    } finally { await s.close() }
  })

  it('★ hint 里不再出现「等 N 个」—— 那句话等于什么都没给', async () => {
    const s = server(() => ({ status: 200, json: { data: many.map(id => ({ id })) } }))
    const port = await s.listen()
    try {
      const err = await testConnection(cfg(port)).then(() => null, (e) => e) as LlmError
      expect(err.info.hint).not.toMatch(/等\s*\d+\s*个/)
      expect(err.info.hint).toContain('模型清单')
    } finally { await s.close() }
  })

  it('★ 测试通过时也把清单带回去（配好了照样想换模型）', async () => {
    const ok = ['vtx-抗截断-gemini-4-Argon-high', 'vtx-抗截断-gemini-4-argon-high', 'other']
    const s = server(() => ({ status: 200, json: { data: ok.map(id => ({ id })) } }))
    const port = await s.listen()
    try {
      const r = await testConnectionDetailed(cfg(port))
      expect(r.catalog).toEqual(ok)
    } finally { await s.close() }
  })

  it('对方不实现 /models → 清单为空数组，不是 undefined', async () => {
    const s = server((h) => h.path.startsWith('/models')
      ? { status: 404, json: { detail: 'Not Found' } }
      : { status: 200, json: okChat })
    const port = await s.listen()
    try {
      const r = await testConnectionDetailed(cfg(port))
      expect(r.catalog).toEqual([])
    } finally { await s.close() }
  })
})
