import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PlayerCard, WorldCard } from '@/types/cards'

/**
 * A1（三层记忆注入）+ C9（用量记账）的**引擎级**回归 —— 精简版。
 *
 * ## 为什么不能只测纯函数
 *
 * `utils/memory.ts` 的单测全绿，只说明"渲染出来的那段文本是对的"，
 * 而这一层历史上最容易错的地方恰恰是**引擎到底有没有把它塞进 messages**：
 * 本项目已经在这件事上错过三次（背景没传、素材被当剧本、提示词里替玩家认亲），
 * 每一次都是"纯函数测试绿着、玩家读着出戏"。
 *
 * 所以这里断言的是 `llmChat` **实际收到的 messages**。
 *
 * ## 为什么与 `useGameEngine.prompt.test.ts` 是两个文件
 *
 * 那个文件是**另一个任务**（C11，开场提示词）的领域，夹具很重；
 * 这里只关心"记忆有没有进上下文 / 用量有没有记账"，
 * 所以用最小替身：hook 换成内存槽位、store 的 hook 形式换成读快照。
 * 两边互不依赖，任何一个被改坏都不会连带另一个。
 */

const captured = vi.hoisted(() => ({ calls: [] as { stream: boolean; messages: { role: string; content: string }[] }[] }))

/**
 * Node 环境没有 localStorage，而 `stores/{game,session,ui}` 都挂了 persist ——
 * 不铺这一层的话，每次 setState 都会往 stderr 打一行
 * 「[zustand persist middleware] Unable to update item …」。
 * 断言不受影响，但几十行噪声会把真正的失败信息埋掉，也会让后来的人
 * 以为是测试环境坏了。铺一个内存实现，既消声又顺带覆盖了"落盘"这条路径。
 */
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size },
})

vi.mock('react', () => {
  const slots: unknown[] = []
  let cursor = 0
  const React = {
    useState: (init: unknown) => {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof init === 'function' ? (init as () => unknown)() : init
      return [slots[i], (next: unknown) => { slots[i] = typeof next === 'function' ? (next as (p: unknown) => unknown)(slots[i]) : next }]
    },
    useRef: (init: unknown) => {
      const i = cursor++
      if (!(i in slots)) slots[i] = { current: init }
      return slots[i]
    },
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn,
    useDebugValue: () => {},
    useSyncExternalStore: (_s: unknown, get: () => unknown) => get(),
    createElement: () => null,
    Fragment: Symbol('Fragment'),
  }
  return { default: React, ...React, __esModule: true, __reset: () => { cursor = 0; slots.length = 0 } }
})

vi.mock('@/api/llm', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/api/llm')>()
  /*
    ⚠️ 这段假叙事的**长度是要紧的**（2026-11 踩过）。

    `detectTruncation` 在字数不足目标的 70% 时会判截断，并**追加一次续写调用** ——
    于是"发了几次调用"的断言全部错位，而且第二次的 prompt 是续写指令，
    不再含原文里的「柳明远」。

    这里 25 字 × 10 = 250 字，测试世界配的是 `replyLength: 300`，安全过线。
    调这个数字之前先看那个阈值。
  */
  const NARRATIVE = '秋雨落在檐角，院里的水缸满了。你在廊下站了一会儿。'.repeat(10)
  const DATA_JSON = JSON.stringify({ stateChanges: [], options: [{ id: 'o1', text: '推门', style: 'neutral' }] })
  const sse = (text: string): Response => new Response(new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`))
      c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      c.close()
    },
  }))
  return {
    ...mod,
    llmChat: async (opts: { stream?: boolean; messages: { role: string; content: string }[] }) => {
      captured.calls.push({ stream: !!opts.stream, messages: opts.messages })
      // usage 只有非流式那条路径回（模拟非常常见的服务商行为），
      // 于是叙事那一段会走"按字符估算"的分支 —— C9 的两条路都能被覆盖到
      if (opts.stream) return sse(NARRATIVE)
      return {
        choices: [{ message: { content: DATA_JSON } }],
        usage: { prompt_tokens: 111, completion_tokens: 22 },
      }
    },
  }
})

function snapshotHook(mod: Record<string, unknown>, name: string) {
  const api = mod[name] as unknown as { getState: () => unknown } & Record<string, unknown>
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(api.getState()) : api.getState())) as unknown as Record<string, unknown>
  Object.assign(hook, api)
  return hook
}

vi.mock('@/stores/game', async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>()
  return { ...mod, useGameStore: snapshotHook(mod, 'useGameStore') }
})
vi.mock('@/stores/session', async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>()
  return { ...mod, useSessionStore: snapshotHook(mod, 'useSessionStore') }
})

const { useGameEngine } = await import('@/hooks/useGameEngine')
const { useGameStore } = await import('@/stores/game')
const { useSessionStore } = await import('@/stores/session')
const { useUIStore } = await import('@/stores/ui')

const mkWorld = (): WorldCard => ({
  id: 'w_mem', title: '记忆测试世界', tagline: '',
  worldLore: '「汴梁」是都城。', rules: '',
  attributes: [{ id: 'force', name: '武略' }],
  resources: [{ id: 'health', name: '体魄', initial: 5, max: 5 }],
  backgrounds: [], attributePoints: 0, items: [], lores: [],
  story: {
    atmosphere: '（基调）', mainQuest: '', enableStages: false, stages: [],
    enableChoices: true, urgencyAfterTurns: 0,
  },
  narrative: { pov: 'second', tense: 'present', replyLength: 300, customStyle: '' },
  characters: [], enableMechanics: true, avatarStyle: 'ink', avatarTone: '#000',
  createdAt: 0, updatedAt: 0, builtin: false,
})

const mkPlayer = (): PlayerCard => ({
  name: '沈砚', gender: '男', age: '三十', appearance: '', personality: '', background: '刑部正四品', extra: '',
})

const runTurn = async () => {
  captured.calls.length = 0
  const engine = useGameEngine()
  await engine.handleAction('init', '（开局）')
  const narrative = captured.calls.find(c => c.stream)
  const data = captured.calls.find(c => !c.stream)
  return {
    narrative: narrative?.messages ?? [],
    data: data?.messages ?? [],
    callCount: captured.calls.length,
  }
}

beforeEach(() => {
  const world = mkWorld()
  useGameStore.getState().resetGame()
  useGameStore.getState().initFromWorld(world)
  useSessionStore.getState().setSession({
    world, player: mkPlayer(), activeCharacterIds: [], backgroundChoices: {}, attributeAllocation: {},
  })
  useUIStore.getState().setLlm({
    provider: 'custom', baseUrl: 'http://localhost:1/v1', apiKey: 'k',
    narrativeModel: 'm', analysisModel: 'm', temperature: 0.8, showReasoning: false,
  })
})

describe('A1 · 三层记忆是否真的进了发给模型的 messages', () => {
  it('★ 记忆非空时注入 [长期记忆] 区块，三层内容都在', async () => {
    useGameStore.getState().patchMemory({
      bonds: [{ who: '裴无咎', state: '欠他一枚铜钱未还' }],
      threads: [{ id: 'ledger', text: '账本缺了七页' }],
      timeline: [{ turn: 3, text: '在渡口见到了裴无咎' }],
    })
    const out = await runTurn()
    const block = out.narrative.find(m => m.content.includes('[长期记忆]'))
    expect(block).toBeTruthy()
    expect(block!.content).toContain('裴无咎')
    expect(block!.content).toContain('账本缺了七页')
    expect(block!.content).toContain('第3轮')
  })

  it('★ 记忆在"前情摘要"之后、历史之前（紧挨着历史，才像一份索引）', async () => {
    useGameStore.getState().updateSummary('前情：他在汴梁落脚。')
    useGameStore.getState().patchMemory({ bonds: [{ who: '柳明远', state: '对你有戒心' }] })
    useGameStore.getState().addHistory({ role: 'assistant', content: '第一段叙事。' })

    const out = await runTurn()
    const at = (needle: string) => out.narrative.findIndex(m => m.content.includes(needle))
    expect(at('[前情摘要]')).toBeGreaterThan(-1)
    expect(at('[长期记忆]')).toBeGreaterThan(at('[前情摘要]'))
    // 记忆之后必须有历史/本轮上下文（不能是最后一条 —— 那样模型会把它当成本轮指令）
    expect(at('[长期记忆]')).toBeLessThan(out.narrative.length - 1)
  })

  it('★ 记忆为空时完全不注入（绝不塞一个只有标题的空区块）', async () => {
    const out = await runTurn()
    expect(out.narrative.some(m => m.content.includes('[长期记忆]'))).toBe(false)
  })

  it('数据 AI 也拿得到当前记忆与轮次（避免反复重新记录同一件事）', async () => {
    useGameStore.getState().patchMemory({ bonds: [{ who: '柳明远', state: '对你有戒心' }] })
    const out = await runTurn()
    const payload = out.data.find(m => m.role === 'user')?.content ?? ''
    expect(payload).toContain('柳明远')
    expect(payload).toContain('"turn"')
    expect(payload).toContain('"memory"')
  })
})

describe('C9 · 用量是否真的被记账（真实值 + 估算两条路）', () => {
  it('★ 一轮跑完后 lastUsage 与 sessionUsage 都有数，且来源标注正确', async () => {
    const out = await runTurn()
    expect(out.callCount).toBeGreaterThanOrEqual(2)

    const last = useGameStore.getState().lastUsage!
    // 数据那条回了 usage → 真实值；叙事那条没回 → 估算。两次累加后整体标为估算
    expect(last.promptTokens).toBeGreaterThanOrEqual(111)
    expect(last.completionTokens).toBeGreaterThanOrEqual(22)
    expect(last.totalTokens).toBe(last.promptTokens + last.completionTokens)
    expect(last.estimated).toBe(true)

    // 累计从 0 起，跑一轮后就等于本轮
    expect(useGameStore.getState().sessionUsage.totalTokens).toBe(last.totalTokens)
  })

  it('每一轮开始时 lastUsage 被清零（否则玩家会把上一轮的数字当成本轮）', async () => {
    await runTurn()
    expect(useGameStore.getState().lastUsage).not.toBeNull()
    useGameStore.getState().clearLastUsage()
    expect(useGameStore.getState().lastUsage).toBeNull()
    // 累计不受影响
    expect(useGameStore.getState().sessionUsage.totalTokens).toBeGreaterThan(0)
  })
})

describe('C9 · 快速模式跳过分析阶段', () => {
  it('★ 开启后只发一次调用（叙事），数值与状态不再更新', async () => {
    useUIStore.getState().setFastMode(true)
    const out = await runTurn()
    expect(out.callCount).toBe(1)
    expect(out.narrative.length).toBeGreaterThan(0)

    // 时间线仍然记了一拍：记忆属于叙事层，不该被"省一次结算"丢掉
    expect(useGameStore.getState().memory.timeline.length).toBe(1)
    // 而数值一层没动过（这就是界面上写明的那个代价）
    expect(useGameStore.getState().resources.health).toBe(5)
    expect(useGameStore.getState().currentOptions).toEqual([])
  })

  it('关闭时照常两次调用', async () => {
    useUIStore.getState().setFastMode(false)
    const out = await runTurn()
    expect(out.callCount).toBe(2)
  })
})
