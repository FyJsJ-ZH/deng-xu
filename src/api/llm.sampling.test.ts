import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { llmChat } from '@/api/llm'
import type { LLMConfig, PresetSampling } from '@/types/cards'

/**
 * **这一次实际发出去的报文**（2026-11）。
 *
 * ## 为什么这一组要用真 HTTP 而不是断言我的字符串
 *
 * 玩家原话：「预设的效果和破甲能力不稳定，去网上搜了看看，
 * 一模一样的预设，本项目的预设和酒馆的预设到底差在哪」。
 *
 * 差在三件**在报文里能看见**的事：
 *
 *  1. 破甲词的位置（第 0 条 system 还是最后一条 system）；
 *  2. 有没有一条空的 assistant 把模型推进"续写"状态（prefill）；
 *  3. 作者调的 `temperature` / `top_p` / `repetition_penalty` / `stop`
 *     到底有没有出现在 body 里。
 *
 * 前两件在 `prompts.tail.test.ts` 与 `useGameEngine` 的消息数组里验；
 * 这一组验第三件，以及 prefill 真的落到了 `messages` 末尾。
 *
 * 用本地假服务商而不是 mock fetch：mock 只能验证我自己的假设，
 * 而真正发出去的那个字节串才是玩家会撞上的东西。
 */

interface Captured {
  path: string
  body: Record<string, any>
}

function makeServer(respond: (body: Record<string, any>) => { status: number; body: string }) {
  const seen: Captured[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      let parsed: Record<string, any> = {}
      try { parsed = JSON.parse(raw) } catch { /* 留空，断言会看出来 */ }
      seen.push({ path: String(req.url ?? ''), body: parsed })
      const out = respond(parsed)
      res.writeHead(out.status, { 'Content-Type': 'application/json' })
      res.end(out.body)
    })
  })
  return {
    seen,
    listen: () => new Promise<number>(r =>
      server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port))),
    close: () => new Promise<void>(r => server.close(() => r())),
  }
}

const servers: ReturnType<typeof makeServer>[] = []

const OK = '{"choices":[{"message":{"content":"正文"}}],"model":"m"}'

function cfg(port: number, over: Partial<LLMConfig> = {}): LLMConfig {
  return {
    provider: 'custom' as LLMConfig['provider'],
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'k',
    narrativeModel: 'm',
    analysisModel: 'm',
    temperature: 0.7,
    showReasoning: false,
    ...over,
  }
}

async function start(over: Partial<LLMConfig> = {}) {
  const m = makeServer(() => ({ status: 200, body: OK }))
  servers.push(m)
  const port = await m.listen()
  return { m, config: cfg(port, over) }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => s.close()))
})

const last = (m: ReturnType<typeof makeServer>) => m.seen[m.seen.length - 1].body

describe('prefill：把模型推进"续写"状态', () => {
  it('★ 开了 prefill 时，messages 末尾多一条空 assistant', async () => {
    const { m, config } = await start()
    await llmChat({
      messages: [
        { role: 'system', content: '规则' },
        { role: 'user', content: '他推开门。' },
      ],
      config,
      model: 'm',
      stream: false,
      prefill: true,
    })
    const msgs = last(m).messages
    expect(msgs).toHaveLength(3)
    expect(msgs[2].role).toBe('assistant')
    // 内容必须是"几乎不可见"的：模型能看出这里有东西，正文里又不会多出字
    expect(msgs[2].content).toBe('\u3000')
  })

  it('没传 prefill 时，报文与改动之前**逐字一致**（不多一条消息）', async () => {
    const { m, config } = await start()
    await llmChat({
      messages: [
        { role: 'system', content: '规则' },
        { role: 'user', content: '他推开门。' },
      ],
      config,
      model: 'm',
      stream: false,
    })
    expect(last(m).messages).toHaveLength(2)
  })

  it('最后一条已经是 assistant 时不重复追加（部分端点会 400）', async () => {
    const { m, config } = await start()
    await llmChat({
      messages: [
        { role: 'user', content: '他推开门。' },
        { role: 'assistant', content: '门开了。' },
      ],
      config,
      model: 'm',
      stream: false,
      prefill: true,
    })
    expect(last(m).messages).toHaveLength(2)
  })
})

describe('采样参数：预设作者调好的那组', () => {
  const sampling: PresetSampling = {
    temperature: 0.55,
    topP: 0.9,
    topK: 40,
    minP: 0.05,
    repetitionPenalty: 1.12,
    frequencyPenalty: 0.2,
    presencePenalty: 0.1,
    stop: ['\n用户：', '作为一个 AI'],
  }

  it('★ 标准字段全部透传，stop 原样（前导换行不许被吃掉）', async () => {
    const { m, config } = await start()
    await llmChat({
      messages: [{ role: 'user', content: 'hi' }],
      config,
      model: 'm',
      stream: false,
      sampling,
    })
    const b = last(m)
    expect(b.temperature).toBe(0.55)
    expect(b.top_p).toBe(0.9)
    expect(b.frequency_penalty).toBe(0.2)
    expect(b.presence_penalty).toBe(0.1)
    expect(b.stop).toEqual(['\n用户：', '作为一个 AI'])
  })

  it('★ 预设的 temperature 盖过 config 的默认值（作者的值更具体）', async () => {
    const { m, config } = await start({ temperature: 0.95 })
    await llmChat({
      messages: [{ role: 'user', content: 'hi' }], config, model: 'm', stream: false, sampling,
    })
    expect(last(m).temperature).toBe(0.55)
  })

  it('★ 单次调用的显式入参盖过预设（`opts.temperature` 最权威）', async () => {
    const { m, config } = await start()
    await llmChat({
      messages: [{ role: 'user', content: 'hi' }], config, model: 'm', stream: false,
      temperature: 1.2,
      sampling,
    })
    expect(last(m).temperature).toBe(1.2)
  })

  it('扩展字段（top_k / min_p / repetition_penalty）在自定义端点上照发', async () => {
    const { m, config } = await start()
    await llmChat({
      messages: [{ role: 'user', content: 'hi' }], config, model: 'm', stream: false, sampling,
    })
    const b = last(m)
    expect(b.top_k).toBe(40)
    expect(b.min_p).toBe(0.05)
    expect(b.repetition_penalty).toBe(1.12)
  })

  it('★ OpenAI 官方端点不发 top_k / min_p / repetition_penalty（会 400）', async () => {
    const { m, config } = await start({ provider: 'openai' })
    await llmChat({
      messages: [{ role: 'user', content: 'hi' }], config, model: 'm', stream: false, sampling,
    })
    const b = last(m)
    expect(b.top_k).toBeUndefined()
    expect(b.min_p).toBeUndefined()
    expect(b.repetition_penalty).toBeUndefined()
    // 标准字段照发
    expect(b.top_p).toBe(0.9)
  })

  it('★ 思考模式下不发 temperature / top_p（传了白传，有的端点还报错）', async () => {
    const { m, config } = await start({ provider: 'deepseek', thinking: 'on' })
    await llmChat({
      messages: [{ role: 'user', content: 'hi' }],
      config,
      model: 'deepseek-reasoner',
      stream: false,
      sampling,
    })
    const b = last(m)
    expect(b.temperature).toBeUndefined()
    expect(b.top_p).toBeUndefined()
    // stop 与思考无关，照发
    expect(b.stop).toEqual(['\n用户：', '作为一个 AI'])
  })

  it('★ 端点报「不认识这个字段」时摘掉扩展参数重发，一次就成', async () => {
    const seen: Record<string, any>[] = []
    const srv = makeServer(body => {
      seen.push(body)
      if (body.top_k !== undefined) {
        return { status: 400, body: '{"error":{"message":"unrecognized parameter: top_k"}}' }
      }
      return { status: 200, body: OK }
    })
    servers.push(srv)
    const port = await srv.listen()
    const r: any = await llmChat({
      messages: [{ role: 'user', content: 'hi' }],
      config: cfg(port),
      model: 'm',
      stream: false,
      sampling,
    })
    expect(r.choices[0].message.content).toBe('正文')
    expect(seen).toHaveLength(2)
    expect(seen[0].top_k).toBe(40)
    // 第二次摘掉了扩展字段，但标准参数还在
    expect(seen[1].top_k).toBeUndefined()
    expect(seen[1].top_p).toBe(0.9)
    expect(seen[1].stop).toEqual(['\n用户：', '作为一个 AI'])
  })

  it('没有 sampling 时，报文里一个采样字段都不多出来（与改动前一致）', async () => {
    const { m, config } = await start()
    await llmChat({ messages: [{ role: 'user', content: 'hi' }], config, model: 'm', stream: false })
    const b = last(m)
    expect(b.top_p).toBeUndefined()
    expect(b.top_k).toBeUndefined()
    expect(b.stop).toBeUndefined()
    // config.temperature 照旧
    expect(b.temperature).toBe(0.7)
  })
})

describe('破甲相关字段一起看：一次典型叙事请求的完整形状', () => {
  it('★ system 在头、tail 在历史之后、user 在尾、assistant 预填垫底', async () => {
    const { m, config } = await start()
    /*
      这是 `useGameEngine` 现在拼出来的形状（`narrativeMessages` 的等价物）：
      第 0 条 system（世界卡 + 预设主体）→ 历史 → tail（输出格式 / 破甲 / 加固）
      → 本轮动作 → prefill 的 assistant。
    */
    await llmChat({
      messages: [
        { role: 'system', content: '世界卡与预设主体' },
        { role: 'user', content: '上一轮玩家的动作' },
        { role: 'assistant', content: '上一轮正文' },
        { role: 'system', content: '【破限】贴尾的硬约束' },
        { role: 'user', content: '他推开门。' },
      ],
      config,
      model: 'm',
      stream: false,
      prefill: true,
      sampling: { temperature: 0.6 },
    })
    const msgs = last(m).messages
    expect(msgs.map((x: any) => x.role)).toEqual([
      'system', 'user', 'assistant', 'system', 'user', 'assistant',
    ])
    // 破甲词在倒数第三条 —— 离生成点只隔一条 user 加一条空 assistant
    expect(msgs[3].content).toContain('【破限】')
    expect(msgs[5].role).toBe('assistant')
  })
})
