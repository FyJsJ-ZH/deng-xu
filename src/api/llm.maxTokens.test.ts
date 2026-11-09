import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { llmChat, suggestMaxTokens, isReasonerModel, isThinkingByDefault, willThink, migrateDeepSeekModelName, parseSseLine, PROVIDER_PRESETS } from '@/api/llm'
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

  /*
    ⚠️ 这一组是 2026-11 加的，起因是玩家问「官方不是已经下架 R1 和 V3 了吗，
    我们调用的到底是什么模型」。

    查下来：`deepseek-chat` / `deepseek-reasoner` 是官方日志里
    **2026-07-24 停止使用**的旧名，现行名字只有 `deepseek-flash` 与
    `deepseek-v4-pro`。而这两个新名字里**一个 reasoner 都没有**，
    可它们默认就开着思考模式 —— 只靠 `isReasonerModel` 判断的话，
    会漏掉 3 倍额度、还会白白发一个不生效的 temperature。
  */
  it('★ DeepSeek 2026 系列默认思考 → 三倍额度（名字里没有 reasoner）', () => {
    expect(suggestMaxTokens(1800, 'deepseek-flash', 'deepseek')).toBe(5400)
    expect(suggestMaxTokens(1800, 'deepseek-v4-pro', 'deepseek')).toBe(5400)
    // 同名挂在别的服务商上不算 —— 中转站很可能给的是非思考版
    expect(suggestMaxTokens(1800, 'deepseek-flash', 'siliconflow')).toBe(3600)
    expect(suggestMaxTokens(1800, 'deepseek-flash')).toBe(3600)
  })

  it('★ 已停用的模型名被迁到现行名字；现行名字与不认识的都原样返回', () => {
    for (const old of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-r1', 'deepseek-v3', 'deepseek-v4-flash']) {
      expect(migrateDeepSeekModelName(old), old).toBe('deepseek-flash')
    }
    // 大小写与空白都要认
    expect(migrateDeepSeekModelName(' DeepSeek-Chat ')).toBe('deepseek-flash')
    // 现行的不动
    expect(migrateDeepSeekModelName('deepseek-flash')).toBe('deepseek-flash')
    expect(migrateDeepSeekModelName('deepseek-v4-pro')).toBe('deepseek-v4-pro')
    // 别人的模型名不碰 —— 自定义端点 / 中转站完全可能自己叫 deepseek-chat
    expect(migrateDeepSeekModelName('gpt-4o')).toBe('gpt-4o')
    expect(migrateDeepSeekModelName('deepseek/deepseek-chat')).toBe('deepseek/deepseek-chat')
  })

  it('★ 官方候选模型只列现行名字（不再给玩家一个已停用的选项）', () => {
    const preset = PROVIDER_PRESETS.find(p => p.id === 'deepseek')!
    expect(preset.models).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(preset.models.join(',')).not.toContain('deepseek-chat')
  })
})

describe('请求体 · 默认思考的模型不发 temperature', () => {
  it('★ deepseek-flash 走 deepseek 服务商时，temperature 不发（思考模式下不生效）', async () => {
    const { m, config } = await start({ provider: 'deepseek', narrativeModel: 'deepseek-flash' })
    await llmChat({ messages: [{ role: 'user', content: 'hi' }], config, stream: false })
    expect(m.bodies[0].temperature).toBeUndefined()
  })

  it('同样的模型名挂在 custom 服务商上 → 照常发 temperature', async () => {
    const { m, config } = await start({ provider: 'custom', narrativeModel: 'deepseek-flash' })
    await llmChat({ messages: [{ role: 'user', content: 'hi' }], config, stream: false })
    expect(m.bodies[0].temperature).toBe(0.7)
  })

  it('isThinkingByDefault 只对 deepseek 官方生效', () => {
    expect(isThinkingByDefault('deepseek', 'deepseek-flash')).toBe(true)
    expect(isThinkingByDefault('deepseek', 'deepseek-v4-pro')).toBe(true)
    expect(isThinkingByDefault('deepseek', 'deepseek-v4-flash')).toBe(true)
    expect(isThinkingByDefault('deepseek', 'deepseek-chat')).toBe(false)
    expect(isThinkingByDefault('openrouter', 'deepseek-flash')).toBe(false)
    expect(isThinkingByDefault('', 'deepseek-flash')).toBe(false)
  })

  it('★ 流式回包里的 model 被解析出来（"实际是什么模型"的唯一证据）', async () => {
    const c = parseSseLine('data: {"model":"deepseek-v4.1-flash-1017","choices":[{"delta":{"content":"好"}}]}')
    expect(c?.model).toBe('deepseek-v4.1-flash-1017')
    expect(c?.content).toBe('好')
    // 只有 model 没有内容的那一帧也要算有效 chunk，否则首帧就把它丢了
    const only = parseSseLine('data: {"model":"deepseek-flash","choices":[{"delta":{}}]}')
    expect(only?.model).toBe('deepseek-flash')
    // 没有 model 的老服务商 → 不能凭空造一个
    expect(parseSseLine('data: {"choices":[{"delta":{"content":"x"}}]}')?.model).toBeUndefined()
  })
})

/**
 * 思考模式开关（2026-11，玩家要求「把带不带思考做成配置里的选项」）。
 *
 * 三种取值对应三种报文，而 `'auto'` 必须是**一个字节都不多**的那一种 ——
 * 老玩家的每一轮都和这个功能存在之前完全一样。
 */
describe('思考模式 · 请求体里到底发不发 thinking', () => {
  it('★ auto（默认）：不发这个字段，报文与旧版一致', async () => {
    const { m, config } = await start({ provider: 'deepseek', narrativeModel: 'deepseek-flash' })
    await llmChat({ messages: [{ role: 'user', content: 'hi' }], config, stream: false })
    expect('thinking' in m.bodies[0]).toBe(false)
    // 但它默认是思考的模型，所以 temperature 照旧不发
    expect(m.bodies[0].temperature).toBeUndefined()
  })

  it('★ on：发 enabled', async () => {
    const { m, config } = await start({ provider: 'custom', narrativeModel: 'm', thinking: 'on' })
    await llmChat({ messages: [{ role: 'user', content: 'hi' }], config, stream: false })
    expect(m.bodies[0].thinking).toEqual({ type: 'enabled' })
    expect(m.bodies[0].temperature).toBeUndefined()
  })

  it('★ off：发 disabled，并且 temperature 恢复正常发送', async () => {
    const { m, config } = await start({ provider: 'custom', narrativeModel: 'm', thinking: 'off' })
    await llmChat({ messages: [{ role: 'user', content: 'hi' }], config, stream: false })
    expect(m.bodies[0].thinking).toEqual({ type: 'disabled' })
    expect(m.bodies[0].temperature).toBe(0.7)
  })

  it('off 压得住"名字像推理模型"：llm 不再按 3 倍给额度', () => {
    expect(suggestMaxTokens(1800, 'deepseek-flash', 'deepseek', 'off')).toBe(3600)
    expect(suggestMaxTokens(1800, 'deepseek-flash', 'deepseek', 'on')).toBe(5400)
    expect(suggestMaxTokens(1800, 'deepseek-flash', 'deepseek', 'auto')).toBe(5400)
    // 普通模型开着思考也要 3 倍 —— 玩家选的就是"想"
    expect(suggestMaxTokens(1800, 'gpt-4o', 'openai', 'on')).toBe(5400)
  })

  it('willThink：三档语义（auto 才去看名字）', () => {
    expect(willThink('deepseek-flash', 'deepseek', 'auto')).toBe(true)
    expect(willThink('gpt-4o', 'openai', 'auto')).toBe(false)
    expect(willThink('gpt-4o', 'openai', 'on')).toBe(true)
    expect(willThink('deepseek-flash', 'deepseek', 'off')).toBe(false)
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
