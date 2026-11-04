import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { llmChat, DEFAULT_LLM_CONFIG } from '@/api/llm'
import type { LLMConfig } from '@/types/cards'

/**
 * 思维链（`ChatMessage.reasoning`）的**边界**。
 *
 * ## 背景（2026-11）
 *
 * 玩家原话：「现在看不到模型的思维链」。
 *
 * 查下来两件事：
 *  1. 流式时它确实显示出来了，但回复一完成 `setStreamingReasoning(null)` ——
 *     思考就地蒸发，读完之后翻不回去；
 *  2. `LLMConfig.showReasoning` 那个开关**从来没有任何地方读它**，是个摆设。
 *
 * 修法是把它存进 `history`（跟着那条回复一起），开关控制存不存。
 *
 * ## 这一组测试盯的是**相反方向**的风险
 *
 * 存下来之后，`ChatMessage` 就从「两个字段」变成了「三个字段」，
 * 而每一轮都会把最近 12 条 history 拼进请求。**如果`reasoning` 跟着上送了**，
 * 会有两个后果：
 *  - 上下文体积凭空翻倍（思维链往往比正文长）；
 *  - 部分服务商对回传思考直接 400。
 *
 * 所以判据放在**请求体**上，而不是调用方的自觉：
 * 哪怕调用方原样把带 reasoning 的消息递进来，`buildBody` 也必须剥掉。
 */

function makeRecorder() {
  const bodies: Record<string, unknown>[] = []
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

function cfg(port: number): LLMConfig {
  return {
    provider: 'custom', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k',
    narrativeModel: 'm', analysisModel: 'm', temperature: 0.7, showReasoning: true,
  }
}

async function start() {
  const m = makeRecorder()
  servers.push(m)
  const port = await m.listen()
  return { m, config: cfg(port) }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => s.close()))
})

describe('思维链 · 开关默认开', () => {
  it('★ 默认配置里 showReasoning 必须是 true', () => {
    /*
      ## 这条断言防的是一次真实事故（2026-11）
      这个字段以前**从来没被任何代码读过** —— 它在类型里躺着、设置页也能拨，
      但流式思维链是无条件显示的。等它终于接上逻辑时，默认值是 false，
      一下子把原本能看到的思维链藏了起来。玩家报「现在看不到思维链了」，
      看到的其实是我把门关上了。

      从这里起：默认开。想关的人自己关。
    */
    expect(DEFAULT_LLM_CONFIG.showReasoning).toBe(true)
  })

  it('默认叙事模型不是推理模型（所以默认情况下本来就看不到思维链）', () => {
    /*
      这条不是"要求"，是**记录事实**：`deepseek-chat` 不返回 `reasoning_content`。
      参考项目（luyu14039/pale-notes）有思维链，是因为它用 DeepSeek R1 驱动。
      玩家想看到思维链，得把叙事模型换成 `deepseek-reasoner` 这类。

      把它写成断言，是为了让下一个人（包括我）不在这件事上再绕一圈。
    */
    expect(/reasoner|(^|[-_/])r1($|[-_/])|o1|o3|thinking/i.test(DEFAULT_LLM_CONFIG.narrativeModel)).toBe(false)
  })
})

describe('思维链 · 不许跟着请求上送', () => {
  it('★ 消息里带着 reasoning，请求体里也必须没有', async () => {
    const { m, config } = await start()
    await llmChat({
      messages: [
        { role: 'system', content: '你是叙事者' },
        { role: 'assistant', content: '正文', reasoning: '我当时的思考过程' },
        { role: 'user', content: '继续' },
      ],
      config, model: 'm', stream: false,
    })

    const sent = JSON.stringify(m.bodies[0])
    expect(sent).not.toContain('我当时的思考过程')
    expect(sent).not.toContain('reasoning')
  })

  it('★ role 与 content 原样保留（剥字段不能顺手改内容）', async () => {
    const { m, config } = await start()
    await llmChat({
      messages: [
        { role: 'assistant', content: '正文', reasoning: '思考' },
        { role: 'user', content: '继续' },
      ],
      config, model: 'm', stream: false,
    })

    const msgs = (m.bodies[0] as { messages: { role: string; content: string }[] }).messages
    expect(msgs).toEqual([
      { role: 'assistant', content: '正文' },
      { role: 'user', content: '继续' },
    ])
  })

  it('不带 reasoning 的消息不受影响（没有字段就不会凭空多出来）', async () => {
    const { m, config } = await start()
    await llmChat({
      messages: [{ role: 'user', content: 'hi' }],
      config, model: 'm', stream: false,
    })
    const msgs = (m.bodies[0] as { messages: unknown[] }).messages
    expect(msgs).toEqual([{ role: 'user', content: 'hi' }])
  })
})
