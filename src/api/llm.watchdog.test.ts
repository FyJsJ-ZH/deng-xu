import { describe, it, expect } from 'vitest'
import { watchIdle, withDeadline } from '@/api/llm'
import { LlmError } from '@/api/llmErrors'

/**
 * 「半小时都跑不出来」（2026-11 玩家原话）。
 *
 * 查下来最刺眼的一条：全项目只有一个 `AbortController`，在 `listModels`
 * 里管 8 秒；`llmChat` 的 `fetch`、流式读取循环 `while (true) await
 * reader.read()`、以及结算的 `await response.json()` 一点超时都没有。
 * 中转不回数据时，浏览器就真的陪它等到 TCP 自己超时。
 *
 * 这一组钉住两件事：
 *   1. 卡死要能被发现，而且要说人话；
 *   2. **慢不能被当成死** —— 这是 `watchIdle` 用"多久没动静"而不是
 *      "一共多久"做判据的全部理由。
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('空闲看门狗', () => {
  it('★ 一直没动静 → 到点触发一次', async () => {
    let fired = 0
    const w = watchIdle(30, () => { fired++ })
    await sleep(70)
    w.stop()
    expect(fired).toBe(1)
    expect(w.tripped).toBe(true)
  })

  it('★ 慢但一直在吐 → 不触发（慢 ≠ 死，这条最要紧）', async () => {
    let fired = 0
    const w = watchIdle(40, () => { fired++ })
    // 每 20ms 踢一次，总长远超 40ms
    for (let i = 0; i < 6; i++) {
      await sleep(20)
      w.kick()
    }
    w.stop()
    expect(fired).toBe(0)
    expect(w.tripped).toBe(false)
  })

  it('stop 之后就算不动了也不会触发', async () => {
    let fired = 0
    const w = watchIdle(30, () => { fired++ })
    await sleep(10)
    w.stop()
    await sleep(50)
    expect(fired).toBe(0)
  })

  it('触发之后不再重复触发（abort 一次就够）', async () => {
    let fired = 0
    const w = watchIdle(20, () => { fired++ })
    await sleep(60)
    w.kick()
    await sleep(40)
    expect(fired).toBe(1)
  })
})

describe('整段返回的时限', () => {
  /** 一个永不自己结束、只对 abort 有反应的任务 */
  const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')))
  })

  it('★ 到点 abort，并抛一句能读懂的「超时」', async () => {
    const err = await withDeadline(hang, 40, '数据结算').then(() => null, (e) => e)
    expect(err).toBeInstanceOf(LlmError)
    const info = (err as LlmError).info
    expect(info.kind).toBe('timeout')
    // 不许自动重试 —— 同一份请求再跑十分钟也没意义
    expect(info.retryable).toBe(false)
    expect(info.message).toContain('数据结算')
    expect(info.message).toContain('超时')
  })

  it('正常返回时原样透传，不多包一层', async () => {
    const out = await withDeadline(async () => ({ ok: 1 }), 200, '叙事')
    expect(out).toEqual({ ok: 1 })
  })

  it('★ 不是超时引起的错误要原样抛出（别把 401 说成超时）', async () => {
    const boom = new LlmError({ kind: 'auth', retryable: false, message: 'API Key 无效' })
    const err = await withDeadline(async () => { throw boom }, 200, '叙事').then(() => null, (e) => e)
    expect(err).toBe(boom)
    expect((err as LlmError).info.kind).toBe('auth')
  })

  it('超时文案里带分钟数，玩家知道刚才等了多久', async () => {
    const err = await withDeadline(hang, 40, '结算').then(() => null, (e) => e) as LlmError
    expect(err.info.message).toMatch(/\d+\s*分钟/)
  })
})
