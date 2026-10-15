import { useState } from 'react'
import { useGameStore, countTurns, type GameState, type TokenUsage } from '@/stores/game'
import { useSessionStore } from '@/stores/session'
import { useUIStore } from '@/stores/ui'
import { useMetaStore } from '@/stores/meta'
import { llmChat, extractContent, parseSseLine, type ChatMessage } from '@/api/llm'
import { parseModelJson } from '@/api/jsonRepair'
import {
  buildNarrativeSystemPrompt,
  buildDataSystemPrompt,
  buildOpeningInstruction,
  buildSummaryPrompt
} from '@/constants/prompts'
import { storySystem } from '@/systems/StorySystem'
import { pickAvatarId } from '@/utils/avatarArt'
import { resolveAiLook } from '@/utils/lookSpec'
import { isKnownSceneId } from '@/utils/sceneArt'
import { renderMemoryForPrompt } from '@/utils/memory'
import { LlmError, classifyLlmError } from '@/api/llmErrors'
import type { LLMConfig, WorldCard } from '@/types/cards'
import { detectTruncation } from '@/utils/truncation'
import {
  needsArchive,
  isHistoryPressureHigh,
  archiveOldMessages,
  clearArchive,
  type HistoryMessage,
} from '@/utils/historyArchive'

/**
 * 按需把较旧的叙事归档到 IndexedDB，让 localStorage 里的热数据保持有界。
 *
 * 触发条件有三个，任一满足就动手：
 *  - 条数超过阈值（常规滚动）
 *  - 估算**体积**已偏高（提前抢救，不等配额真的写满）
 *
 * 为什么要同时看条数和体积：
 * 只按条数会漏 —— 某些模型一次就吐两三千字，120 条热数据能有 3MB+，
 * 照样撞上 localStorage 的 5MB 配额。体积才是真正的约束，
 * 条数只是"别让数组无限长"的粗略护栏。
 */
async function maybeArchiveHistory(): Promise<void> {
  const st = useGameStore.getState()
  const history = st.history as HistoryMessage[]
  if (!history?.length) return

  const pressure = isHistoryPressureHigh(history)
  const tooMany = needsArchive(history, pressure)
  if (!pressure && !tooMany) return

  const { hot, archived, ok } = await archiveOldMessages(history, pressure)
  if (!ok) {
    console.warn('[archive] 归档写入失败，保持历史不裁剪以免丢数据')
    return
  }
  if (archived > 0) {
    useGameStore.setState({ history: hot })
    console.info(`[archive] 已归档 ${archived} 条旧叙事，热数据保留 ${hot.length} 条`)
  }
}

/**
 * 叙事被截断时，请求模型**接着写完**，再与已写的部分拼接。
 *
 * 为什么用"续写"而不是"重新生成"：
 *  重新生成会把已经写好、玩家可能已经读了一半的内容全部作废 ——
 *  对于长段落，这个代价太大。续写只补最后那一小段。
 *
 * 拼接时会做重叠去重：模型往往会把已经写过的最后一句再重复一遍，
 * 直接拼接会出现"他推开门。他推开门。"这种重复。
 *
 * 失败（网络错、返回空、也抛错）时返回 null，让调用方退回"提示玩家"的路径。
 */
async function tryContinueNarrative(
  partial: string,
  config: LLMConfig,
  world: WorldCard | null | undefined
): Promise<string | null> {
  try {
    const tail = partial.slice(-600)   // 只把结尾交给模型，避免上下文翻倍
    const res = await llmChat({
      messages: [
        {
          role: 'system',
          content: '你是一个续写助手。用户会给你一段被截断的小说正文，'
            + '请**接着最后一个字继续写完**。'
            + '要求：不要重复已写的内容；不要写任何解释、标题或标记；'
            + '不要另起一段重讲；直接输出接下来的文字，直到这一段自然结束。',
        },
        {
          role: 'user',
          content: `以下正文在结尾处被截断了，请接着写完：\n\n---\n${tail}\n---`,
        },
      ],
      config,
      model: config.narrativeModel,
      stream: false,
      temperature: 0.6,
    })

    const text: string = res?.choices?.[0]?.message?.content || ''
    const clean = String(text).trim()
    if (!clean) return null

    return mergeContinuation(partial, clean, world)
  } catch (e) {
    console.warn('[continue] 续写失败，退回提示路径', e)
    return null
  }
}

/**
 * 把续写片段拼到原文后面，并去掉模型常见的"重复已写内容"。
 *
 * 两种情况都要处理：
 *   A. 续写从整句之后接上 → 原文的结尾是续写的前缀
 *      「他推开门。」 + 「他推开门。屋里很冷。」
 *   B. 续写从半句之后接上 → 原文的结尾**被包含在**续写里
 *      「他推开门，看见」 + 「看见桌上放着一封信。」
 *
 * 第一版只做了 A 的正向 `startsWith`，B 完全没覆盖；而且把最小重叠长度
 * 写成 6，导致只有 5 个字符的「他推开门。」被直接滤掉 —— 去重反而失效。
 * 现在改成**在两侧之间找最大重叠**，长度下界 4 个字（太短会误删真实内容）。
 *
 * 实现与 `src/utils/continuation.test.ts` 里的副本保持一致（那边有测试）。
 */
export function mergeContinuation(original: string, continuation: string, _world?: unknown): string {
  const a = original.replace(/\s+$/, '')
  const b = continuation.trim()
  if (!b) return a
  if (a.endsWith(b)) return a

  const max = Math.min(a.length, b.length)
  for (let len = max; len >= 4; len--) {
    const tail = a.slice(a.length - len)
    const head = b.slice(0, len)
    if (tail === head) return a + b.slice(len)
  }

  const needSpace = /[A-Za-z0-9,.;:'"]$/.test(a) && /^[A-Za-z0-9]/.test(b)
  return a + (needSpace ? ' ' : '') + b
}

/**
 * 把引擎里抛出的任何错误转成**玩家能看懂的一句话**。
 *
 * 之前直接把 error.message 显示出来，于是界面上出现的是
 * 「429 Too Many Requests - {"error":{"message":"Rate limit reached..."}}」
 * 这种原始串 —— 玩家分不清是余额不足、Key 写错还是被限流，
 * 而这三者的处理方式完全不同。
 */
function formatEngineError(error: unknown): string {
  if (error instanceof LlmError) {
    const { message, hint } = error.info
    return hint ? `${message}（${hint}）` : message
  }
  // 非 LLM 错误（例如我们自己抛的"模型返回了空内容"）保留原文，
  // 那些句子本来就是写给玩家看的
  const raw = (error as Error)?.message
  if (raw) return raw
  const info = classifyLlmError(undefined, '', error)
  return info.message
}
import { useLibraryStore } from '@/stores/library'

/**
 * 估算一次调用的 token 数（C9）。
 *
 * 为什么需要估算：只有一部分 OpenAI 兼容端点会在响应里回 `usage`
 * （流式响应里尤其少见 —— 多数服务商只在最后一个 chunk 才带，很多干脆不带）。
 * 而"看不到花了多少"正是这一项要解决的问题，所以拿不到时按字符数估。
 *
 * 系数取 1/1.5：中文大约 1 字 ≈ 0.7~1 token（各家分词器有别），
 * ASCII 更省。用 1.5 做除数略微**偏保守**（估出来的数偏小），
 * 免得让玩家把估算值当成比实际更贵的账单。
 *
 * ⚠️ 估算值一律带上 `estimated: true`，界面上必须与真实 usage 区分显示。
 */
export function estimateTokens(text: string): number {
  const n = (text || '').length
  return n === 0 ? 0 : Math.max(1, Math.round(n / 1.5))
}

/**
 * 从一次 LLM 响应里取出用量。
 *
 * @param response 原始响应（非流式为解析后的 JSON；流式由调用方另行提供 usage）
 * @param promptMessages 本次请求的输入消息（用于估算 prompt 部分）
 * @param output 本次产出的文本（用于估算 completion 部分）
 */
export function usageFromResponse(
  response: any,
  promptMessages: ChatMessage[],
  output: string,
): TokenUsage {
  const u = response?.usage
  const promptTokens = Number(u?.prompt_tokens)
  const completionTokens = Number(u?.completion_tokens)

  if (Number.isFinite(promptTokens) || Number.isFinite(completionTokens)) {
    const p = Number.isFinite(promptTokens) ? promptTokens : estimateTokens(promptMessages.map(m => m.content).join(''))
    const c = Number.isFinite(completionTokens) ? completionTokens : estimateTokens(output)
    return {
      promptTokens: p,
      completionTokens: c,
      // total 自己算，不信服务商给的 total_tokens：有些端点会把它漏掉或算错
      totalTokens: p + c,
      estimated: false,
    }
  }

  const p = estimateTokens(promptMessages.map(m => m.content).join(''))
  const c = estimateTokens(output)
  return { promptTokens: p, completionTokens: c, totalTokens: p + c, estimated: true }
}

/**
 * 把叙事历史渲染成**带轮次编号**的文本。
 *
 * 轮次是记忆分层的骨架：摘要 AI 要靠它产出 `timeline[].turn`，
 * 而 B8 的回溯也以同一套编号定位。没有编号，模型只能写
 * "他们先去了码头，后来去了酒馆" —— 那种时间线既撑不起回溯，
 * 也让玩家问不出"我们之前干过什么"。
 *
 * 轮次的定义：**每一条 assistant 消息算一轮**（与 gameStore.countTurns 同一口径）。
 * 这里传入的已经是切片后的窗口，所以要带上起始偏移 `firstTurn`。
 */
export function formatHistoryWithTurns(
  history: { role: string; content: string }[],
  firstTurn: number,
): string {
  let turn = firstTurn
  const out: string[] = []
  for (const h of history) {
    if (h.role === 'assistant') {
      out.push(`[第${turn}轮 · 叙事] ${h.content}`)
      turn += 1
    } else if (h.role === 'user') {
      out.push(`[第${turn}轮 · 玩家行动] ${h.content}`)
    }
  }
  return out.join('\n')
}

/**
 * 从一行 SSE 原始数据里抠出 `usage`。
 *
 * 为什么要单独做：流式响应里服务商通常**只在最后一个 chunk**附带 usage
 * （有的干脆不带）。`parseSseLine` 只关心正文与推理增量，看不到它 ——
 * 而"这一轮花了多少 token"正是 C9 要显示的东西。拿不到就退回估算，
 * 但**能拿到就该拿到**：真实 token 数与估算值能差 20% 以上。
 */
export function parseSseUsage(line: string): TokenUsage | null {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try {
    const json = JSON.parse(payload)
    const u = json?.usage
    if (!u) return null
    const p = Number(u.prompt_tokens)
    const c = Number(u.completion_tokens)
    if (!Number.isFinite(p) && !Number.isFinite(c)) return null
    const promptTokens = Number.isFinite(p) ? p : 0
    const completionTokens = Number.isFinite(c) ? c : 0
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimated: false,
    }
  } catch {
    return null
  }
}

/** 流式响应关闭后，正文已经完整拿到 —— 用来把"没回 usage"的那一半补成估算 */
export function estimateMissingCompletion(usage: TokenUsage, output: string): TokenUsage {
  if (usage.estimated || usage.completionTokens > 0) return usage
  const c = estimateTokens(output)
  return { ...usage, completionTokens: c, totalTokens: usage.promptTokens + c }
}

/** 回溯下拉里的一项 */
export interface RewindOption {
  turn: number
  /** 那一轮玩家行动的**摘要**（下拉选项里显示，已截断） */
  action: string
  /** 完整原文（回溯是破坏性操作，确认时要把原文给玩家看） */
  full: string
}

/**
 * 把玩家行动压成一行摘要。
 *
 * 回溯下拉的宽度很窄，塞不下一条完整的自由输入；但**截得太狠也没用**
 * —— 玩家要能一眼认出"哦，这是我去码头那次"。所以留 18 个字，
 * 并在下面 `App.tsx` 的确认框里给出完整原文。
 */
function summarizeAction(text: string, max = 18): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return '（无输入）'
  return t.length > max ? `${t.slice(0, max)}…` : t
}

interface GameEngineReturn {
  handleAction: (actionId: string, actionText: string) => Promise<void>
  retryLastAction: () => Promise<void>
  isProcessing: boolean
  isAnalyzingData: boolean
  lastError: string | null
  /** 疑似截断的提示（非错误，可关闭） */
  truncationWarning: string | null
  clearTruncationWarning: () => void
  currentOptions: any[]
  streamingContent: string | null
  streamingReasoning: string | null
  debugDataInput: string | null
  debugDataOutput: string | null
  isInputAllowed: boolean
  /** 当前是第几轮（= 已完成的叙事段数），供回溯 UI 定位 */
  turnCount: number
  /** 可回溯到的轮次列表（升序）；空数组表示还没攒下快照 */
  rewindTurns: number[]
  /**
   * 回溯下拉的选项：轮次 + **那一轮玩家干了什么**。
   *
   * 为什么要有它：`history` 里只有 assistant 与 system 两种消息，
   * 玩家的输入从来没进过历史（见 `TurnSnapshot.playerAction` 的注释）。
   * 于是玩家面对「第 3 轮」「第 7 轮」这种编号时完全想不起来当时做过什么，
   * 也就无从判断该退回哪一轮。
   */
  rewindOptions: RewindOption[]
  /**
   * 回到第 N 轮结束时（B8）。
   *
   * 返回是否真的回滚了：快照不存在（例如超过 MAX_TURN_SNAPSHOTS）时返回 false，
   * 由 UI 明确告诉玩家"这一轮回不去了"，而不是假装成功。
   */
  rewindToTurn: (turnIndex: number) => boolean
}

export function useGameEngine(): GameEngineReturn {
  // @ts-ignore 用于触发 UI 重渲染，实际读写都走 getState()
  const store = useGameStore()

  const [isProcessing, setIsProcessing] = useState(false)
  const [isAnalyzingData, setIsAnalyzingData] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  /**
   * 截断提示。
   * 与 lastError 分开：这不是"失败"，这一轮是成功生成的，
   * 只是可能没写完 —— 用警告样式而不是错误样式，可关闭。
   */
  const [truncationWarning, setTruncationWarning] = useState<string | null>(null)
  const [streamingContent, setStreamingContent] = useState<string | null>(null)
  const [streamingReasoning, setStreamingReasoning] = useState<string | null>(null)
  /*
    ⚠️ 这里**故意没有**"本轮是第几轮"的 useState。
    轮次来自 `countTurns(history)` —— 它是唯一可信的来源：回溯会**真的截短历史**，
    任何本地计数器都必须跟着手动重置，而只要有一处忘了重置，
    摘要节流与时间线编号就会和存档对不上（且不会报错，只会慢慢地错）。
    参考上一版的教训：本地的 turnCount 与 history 各自演化，正是这类不一致的温床。
  */
  const [lastAction, setLastAction] = useState<{ id: string; text: string } | null>(null)
  const [debugDataInput, setDebugDataInput] = useState<string | null>(null)
  const [debugDataOutput, setDebugDataOutput] = useState<string | null>(null)

  const { story, turnsSinceLastMajorEvent } = store
  const world = useSessionStore(s => s.world)

  // 关键节点拖延过久时，强制玩家从事件选项里做出选择
  const urgencyAfter = world?.story.urgencyAfterTurns || 5
  let isInputAllowed = true
  if (story.activeEventId) {
    const event = storySystem.getEvent(story.activeEventId)
    if (event && event.options && event.options.length > 0 && turnsSinceLastMajorEvent >= urgencyAfter) {
      isInputAllowed = false
    }
  }

  const getDominantAspect = (aspects: Record<string, number>) => {
    let max = 0
    let dominant = 'neutral'
    for (const key in aspects) {
      if (aspects[key] > max) {
        max = aspects[key]
        dominant = key
      }
    }
    return max > 0 ? dominant : 'neutral'
  }

  /** 把当前存档投影成给模型看的 JSON 上下文 */
  const buildContext = (actionText: string, currentState: GameState, storyContext?: string) => {
    const {
      resources, aspects, inventory, location, tags, story, knownFacts, readBooks,
      masteredLores, rites, languages, characters, unlockedDoors, time, identity,
      summary, memory, playerName, playerGender, playerAppearance, turnsSinceLastMajorEvent,
      attributeDefs, resourceDefs
    } = currentState

    const attributes = Object.fromEntries(
      attributeDefs.map(d => [d.id, aspects[d.id] ?? 0])
    )
    const resourcesNamed = Object.fromEntries(
      resourceDefs.map(d => [d.id, { 名称: d.name, 当前: resources[d.id] ?? 0, 上限: d.max ?? null }])
    )

    // 把开局选定的背景（出身）解析成可读文本，交给 AI 作为"掉落与线索的依据"。
    const world = useSessionStore.getState().world
    const choices = useSessionStore.getState().backgroundChoices
    // 「我自己写」的自由文本：选了自定义项时，它取代该槽位的标题与说明。
    const customs = useSessionStore.getState().backgroundCustom
    const bgLines = world
      ? world.backgrounds
          .map(slot => {
            const opt = slot.options.find(o => o.id === choices[slot.label])
            if (!opt) return null
            const own = (customs?.[slot.label] || '').trim()
            /*
              选了「我自己写」却没写内容 ⇒ 当作没选这个槽位。
              与 `describeBackgroundChoices` 保持一致：
              否则这里会发出 `选择: "我自己写"`，数据 AI 会拿它去"挂钩物品的出身"，
              等于把一句废话当成出身用。
            */
            if (opt.custom && !own) return null
            const isCustom = !!opt.custom && !!own
            const bonusBits = [
              ...Object.entries(opt.attributeBonus || {}).map(([k, v]) => {
                const d = attributeDefs.find(a => a.id === k)
                return `${d?.name || k}${v >= 0 ? '+' : ''}${v}`
              }),
              ...Object.entries(opt.resourceBonus || {}).map(([k, v]) => {
                const d = resourceDefs.find(r => r.id === k)
                return `${d?.name || k}${v >= 0 ? '+' : ''}${v}`
              }),
            ]
            const carried = (opt.startingItems || [])
              .map(id => world.items.find(i => i.id === id)?.name)
              .filter(Boolean)
            return {
              分类: slot.label,
              选择: isCustom ? own : opt.title,
              说明: isCustom ? '（这一段是他自己写的，不是预设项 —— 按他写的来，不要替换成别的身份）' : (opt.description || ''),
              数值加成: bonusBits,
              开局携带: carried,
            }
          })
          .filter(Boolean)
      : []

    const backgroundOfPlayer = {
      title: bgLines.map((b: any) => b.选择).join(' / ') || '（未设定）',
      description: bgLines.map((b: any) => `${b.分类}：${b.说明}`).filter((s: string) => !s.endsWith('：')).join('；'),
      bonus: bgLines.flatMap((b: any) => b.数值加成),
      items: bgLines.flatMap((b: any) => b.开局携带),
    }

    return JSON.stringify({
      playerState: {
        profile: {
          name: playerName,
          gender: playerGender,
          appearance: playerAppearance
        },
        /**
         * 玩家在开局选的出身 / 背景。
         *
         * 这两项以前**完全没有传给 AI** —— 所以无论玩家选什么背景，
         * AI 发物品、给线索、写外貌时都看不到，开局拿到的东西自然千篇一律。
         * 补上之后 AI 才有依据做"与出身相关"的内容。
         */
        background: {
          标题: backgroundOfPlayer.title,
          描述: backgroundOfPlayer.description,
          数值加成: backgroundOfPlayer.bonus,
          开局携带: backgroundOfPlayer.items
        },
        attributes,
        dominantAttribute: getDominantAspect(aspects),
        resources: resourcesNamed,
        inventory: inventory.map(i => ({ id: i.id, name: i.name })),
        tags,
        story: {
          chapter: story.currentChapter,
          activeEventId: story.activeEventId
        },
        knownFacts,
        readBooks,
        masteredLores,
        rites,
        languages,
        relationships: characters,
        unlockedDoors
      },
      worldState: {
        location,
        // 当前场景背景，让 AI 知道"要不要换"（相同就不发 SET_SCENE）
        sceneId: currentState.sceneId,
        time,
        identity,
        turnsSinceLastMajorEvent
      },
      userAction: actionText,
      storyContext: storyContext || undefined,
      previousSummary: summary || undefined,
      /*
        把三层记忆也交给数据 AI，让它知道**已经记下了什么**。
        没有这一段，它会反复"重新发现"同一段关系、或者把已经了结的线索再列一遍 ——
        记忆于是越滚越长，最后撑爆 900 字预算，把真正新的信息挤出去。
      */
      currentMemory: {
        bonds: memory?.bonds ?? [],
        threads: memory?.threads ?? [],
        timeline: memory?.timeline ?? [],
      },
      /** 数据 AI 写时间线时要用它当 turn（"这一轮是第几轮"） */
      turn: countTurns(currentState.history),
    })
  }

  /**
   * 应用数据 AI 给出的状态变更
   */
  const handleStateChanges = (changes: any[]) => {
    if (!Array.isArray(changes)) return

    const {
      modifyResource, setAspects, addTag, setLocation, addItem, removeItem,
      addFact, addCharacter, updateCharacter, addRite, addLanguage,
      markBookAsRead, markLoreAsMastered, setStoryState, advanceTime, setIdentity,
      addHistory, addLocationInfo, completeEvent
    } = useGameStore.getState()

    const summaryLines: string[] = []

    changes.forEach(change => {
      if (!change || typeof change.type !== 'string') return

      switch (change.type) {
        case 'MODIFY_RESOURCE':
          modifyResource(change.target, change.value)
          summaryLines.push(`${change.target} ${change.value > 0 ? '+' : ''}${change.value}`)
          break

        case 'MODIFY_ASPECT': {
          const current = useGameStore.getState().aspects
          setAspects({ [change.target]: (current[change.target] || 0) + change.value })
          summaryLines.push(`属性 ${change.target} ${change.value > 0 ? '+' : ''}${change.value}`)
          break
        }

        case 'ADD_TAG':
          addTag(change.target)
          break

        case 'UNLOCK_LOCATION':
          setLocation(change.target)
          summaryLines.push(`地点：${change.target}`)
          break

        case 'ADD_ITEM': {
          const payload = change.payload
          if (payload && payload.name) {
            addItem({
              id: payload.id || payload.name,
              name: payload.name,
              description: payload.description || '',
              tags: Array.isArray(payload.tags) ? payload.tags : []
            })
            summaryLines.push(`获得物品：${payload.name}`)
          } else if (typeof change.target === 'string') {
            // 没有 payload 时，从世界卡的物品模板里找
            const template = useLibraryStore.getState().getWorld(useSessionStore.getState().world?.id || '')
              ?.items.find(i => i.id === change.target)
            if (template) {
              addItem({ ...template, tags: [...template.tags] })
              summaryLines.push(`获得物品：${template.name}`)
            }
          }
          break
        }

        case 'REMOVE_ITEM':
          removeItem(change.target)
          summaryLines.push(`失去物品：${change.target}`)
          break

        case 'ADD_FACT': {
          const payload = change.payload
          if (payload && payload.name) {
            addFact({
              id: payload.id || payload.name,
              name: payload.name,
              description: payload.description || ''
            })
            summaryLines.push(`获得线索：${payload.name}`)
          } else if (typeof change.target === 'string') {
            addFact(change.target)
          }
          break
        }

        case 'ADD_CHARACTER':
          if (change.payload && change.payload.name) {
            const cid = change.payload.id || change.payload.name
            addCharacter({
              id: cid,
              name: change.payload.name,
              description: change.payload.description || '',
              relationship: change.payload.relationship || '未知',
              status: change.payload.status || '正常',
              location: change.payload.location,
              // 头像 id 必须校验：模型可能给出清单外的值，也可能和别人撞车。
              // 非法或重复就丢掉，由 resolveAvatar 退回按 id 哈希生成，绝不出现裂图。
              avatarId: pickAvatarId(
                change.payload.avatarId,
                cid,
                useGameStore.getState().characters.map(c => (c.id === cid ? undefined : c.avatarId))
              ),
              /*
                部件级外观。三个来源，按优先级：
                  1. **该角色已经有 `look`** —— 世界卡作者逐部件写好的显式外观，
                     权威性最高，任何推测都不该覆盖它。
                     （`addCharacter` 那层也做了保护，这里是第二道。）
                  2. `change.payload.look` —— 世界卡透传上来的。
                  3. `resolveAiLook(appearance)` —— AI 现场造的角色。它输出的是一组
                     **受限枚举**（sex / hair / cloth …），由 lookSpec 翻成部件 id。
                     这是"局内 NPC 立绘"唯一可控的来源：在此之前 AI 造的 NPC
                     一个 look 都没有，只能靠 291 条中文正则去猜。
                  三者都没有 → undefined，立绘退回关键词推断（旧行为，不变差）。
              */
              look: useGameStore.getState().characters.find(c => c.id === cid)?.look
                ?? change.payload.look
                ?? resolveAiLook(change.payload.appearance, cid),
            })
            summaryLines.push(`登场人物：${change.payload.name}`)
          }
          break

        case 'UPDATE_CHARACTER':
          if (change.payload?.id) {
            updateCharacter(change.payload.id, change.payload.updates || {})
            summaryLines.push(`人物更新：${change.payload.id}`)
          }
          break

        case 'ADD_LOCATION':
          if (change.payload && change.payload.name) {
            addLocationInfo({
              id: change.payload.id || change.payload.name,
              name: change.payload.name,
              description: change.payload.description || '',
              isUnlocked: change.payload.isUnlocked !== false
            })
            summaryLines.push(`地点记录：${change.payload.name}`)
          }
          break

        case 'ADD_RITE':
          if (change.payload?.name) {
            addRite(change.payload)
            summaryLines.push(`习得：${change.payload.name}`)
          }
          break

        case 'ADD_LANGUAGE':
          if (change.payload?.name) {
            addLanguage(change.payload)
            summaryLines.push(`习得语言：${change.payload.name}`)
          }
          break

        case 'MARK_BOOK_READ':
          markBookAsRead(change.target)
          break

        case 'USE_LORE':
          summaryLines.push(`使用知识：${change.target}`)
          break

        case 'USE_ITEM':
          summaryLines.push(`使用物品：${change.target}`)
          break

        case 'MARK_LORE_MASTERED': {
          const payload = change.payload
          if (payload && payload.name) {
            markLoreAsMastered({
              id: payload.id || payload.name,
              name: payload.name,
              description: payload.description || '',
              principle: payload.aspect || 'neutral',
              level: payload.level || 1
            })
            summaryLines.push(`掌握知识：${payload.name}`)
          } else if (typeof change.target === 'string') {
            markLoreAsMastered(change.target)
          }
          break
        }

        case 'SET_CHAPTER': {
          const oldChapter = useGameStore.getState().story.currentChapter
          const newChapter = change.value
          setStoryState({ currentChapter: newChapter })
          useMetaStore.getState().updateMaxChapter(newChapter)
          if (oldChapter === 0 && newChapter === 1) {
            const origin = useGameStore.getState().story.origin
            if (origin) useMetaStore.getState().markOriginComplete(origin)
          }
          break
        }

        case 'MODIFY_TIME':
          if (typeof change.value === 'number') advanceTime(change.value)
          break

        case 'SET_SCENE':
          // 校验 id：模型可能编造清单外的值，非法就忽略（保留当前背景，
          // 比切到一张空图要好）。相同值也跳过，避免无谓重渲染。
          if (isKnownSceneId(change.target) && useGameStore.getState().sceneId !== change.target) {
            useGameStore.getState().setScene(change.target)
          }
          break

        case 'SET_IDENTITY':
          setIdentity(change.target)
          summaryLines.push(`身份变更：${change.target}`)
          break

        case 'COMPLETE_EVENT':
          completeEvent(change.target)
          if (useGameStore.getState().story.activeEventId === change.target) {
            setStoryState({ activeEventId: null })
          }
          break

        case 'TRIGGER_EVENT':
          setStoryState({ activeEventId: change.target })
          useMetaStore.getState().addKeyEvent(change.target)
          break
      }
    })

    // 防轨道化：单个选项视为关键节点，选完重置计数
    const options = useGameStore.getState().currentOptions
    if (options && options.length === 1) {
      useGameStore.getState().resetTurnCounter()
    } else {
      useGameStore.getState().incrementTurnCounter()
    }

    if (summaryLines.length > 0) {
      addHistory({
        role: 'system',
        content: `> **状态变更**: \n${summaryLines.join('\n')}`,
        timestamp: Date.now()
      })
    }
  }

  /**
   * 记录一次调用的用量。
   *
   * @param override 已经算好的用量（流式响应从 SSE 的 usage 字段取）；
   *                 给了它就**不要**再按字符估 —— 真实值优先。
   */
  const recordUsage = (
    response: any,
    promptMessages: ChatMessage[],
    output: string,
    override?: TokenUsage | null,
  ) => {
    // 估算需要**真实的输入消息**：只按输出估会严重低估（提示词里有世界设定、
    // 角色档案、记忆三层，往往比输出还长）
    useGameStore.getState().recordUsage(
      override || usageFromResponse(response, promptMessages, output),
    )
  }

  /**
   * 历史压缩 —— 同时增量更新三层记忆（A1）。
   *
   * 这是**唯一**会动 `summary` / `bonds` / `threads` 的地方：它本来就每 6 轮跑一次、
   * 要通读最近一段剧情，所以"顺手产出记忆"几乎不额外花 token。
   * 每轮都跑一次是不可接受的（那等于把 LLM 调用次数翻倍）。
   */
  const summarizeHistory = async () => {
    const { history, summary, memory, patchMemory, updateSummary } = useGameStore.getState()
    if (history.length < 12) return

    const olderHistory = history.slice(0, -12)
    const cleanOlder = olderHistory.filter(h => h.role !== 'system')
    if (!cleanOlder.length) return

    /*
      只把 **新的那一段** 交给模型（最后 12 条留在热历史里，不重复压缩）。
      编号从 1 开始 —— 这是"本次被压缩的这段剧情里的第几轮"，不是全局轮次。
      相对编号够用：模型同时能看到 `memory.timeline` 里已记录的真实轮次（见 buildSummaryPrompt），
      而**同一轮的覆盖**是按 turn 值相等来判定的，所以不会把第 3 轮的记录
      误写到第 9 轮的格子里；重叠的那几轮最多让模型把同一件事重写一遍。
    */
    const textToSummarize = formatHistoryWithTurns(cleanOlder, 1)
    if (!textToSummarize.trim()) return

    const config = useUIStore.getState().llm
    const prompt = buildSummaryPrompt(summary, textToSummarize, memory)
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }]

    try {
      const response = await llmChat({
        messages,
        config,
        model: config.analysisModel,
        stream: false,
        temperature: 0.3
      })
      const raw = extractContent(response)
      recordUsage(response, messages, raw)

      /*
        摘要 AI 现在返回的是 JSON（带三层记忆）。
        ⚠️ 但**不能假设它一定照做**：模型可能返回一段纯文本（旧提示词、
        被截断、或者干脆不听话）。那种情况下必须退回"把整段当成新摘要"，
        否则这一局的记忆就永远停止更新了 —— 而这正是要修的问题本身。
      */
      let parsed: any = null
      try {
        parsed = parseModelJson(raw).value as any
      } catch {
        parsed = null
      }

      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
          updateSummary(parsed.summary.trim())
        }
        const patch = parsed.memory
        if (patch && typeof patch === 'object') {
          patchMemory({
            bonds: patch.bonds,
            threads: patch.threads,
            timeline: patch.timeline,
            earlierSummary: typeof patch.earlierSummary === 'string' ? patch.earlierSummary : undefined,
          })
        }
      } else if (raw.trim()) {
        updateSummary(raw.trim())
      }
    } catch (e) {
      // 摘要失败不该打断游戏
      console.warn('Summarization failed', e)
    }
  }

  /** 一轮交互：叙事生成 → 数据结算 */
  const processTurn = async (actionText: string, actionType: 'option' | 'custom' | 'init' = 'option') => {
    const config = useUIStore.getState().llm
    const session = useSessionStore.getState()
    const activeWorld = session.world
    const player = session.player

    if (!activeWorld || !player) {
      setLastError('尚未选择世界卡，请回到标题页新建或选择一张卡。')
      return
    }
    if (!config.baseUrl) {
      setLastError('尚未配置模型接口地址。')
      return
    }
    if (!config.apiKey && config.provider !== 'ollama') {
      setLastError('尚未配置 API Key。')
      return
    }

    setIsProcessing(true)
    setLastError(null)
    setStreamingContent('')
    setStreamingReasoning('')
    // 本轮开始就把"上一轮的用量"清掉：留着它会让玩家以为本轮已经花了那么多
    useGameStore.getState().clearLastUsage()

    // 摘要节流：每 6 轮压缩一次。用"已经写完的轮数"而不是组件本地的计数器 ——
    // 本地计数器在回溯时必须手动重置，一旦忘了就会按错误的节奏跑摘要
    const completedTurns = countTurns(useGameStore.getState().history)
    if (completedTurns > 0 && completedTurns % 6 === 0) summarizeHistory()

    // 这一轮是全局第几轮 —— 时间线、快照、回溯定位都用这一个编号
    const turnNumber = completedTurns + 1

    try {
      // —— 装载章节卡，保证事件表与当前世界一致 ——
      storySystem.setEvents(
        activeWorld.story.enableStages ? activeWorld.story.stages : [],
        activeWorld.items,
        `${activeWorld.id}:${activeWorld.updatedAt}`
      )

      const activeCharacters = session.getActiveCharacters()
      const updatedStore = useGameStore.getState()

      let currentStoryContext: string | undefined
      let pendingKeyOptions: any[] = []

      // —— 章节卡事件检查 ——
      let activeEvent = null
      if (activeWorld.story.enableStages) {
        if (updatedStore.story.activeEventId) {
          activeEvent = storySystem.getEvent(updatedStore.story.activeEventId) || null
        }
        if (!activeEvent) {
          activeEvent = storySystem.findTriggeredEvent(updatedStore)
          if (activeEvent) {
            updatedStore.setStoryState({ activeEventId: activeEvent.id })
            useMetaStore.getState().addKeyEvent(activeEvent.id)
            useGameStore.getState().resetTurnCounter()
            if (activeEvent.onEnter) {
              storySystem.processEffects(activeEvent.onEnter, useGameStore.getState())
            }
          }
        }
      }

      if (activeEvent) {
        currentStoryContext = `[系统事件触发: ${activeEvent.title || activeEvent.id}]\n${activeEvent.text}`
        const currentTurns = useGameStore.getState().turnsSinceLastMajorEvent
        if (currentTurns >= activeWorld.story.urgencyAfterTurns) {
          currentStoryContext += `\n[紧迫感指令]: 玩家已在此场景逗留 ${currentTurns} 回合。必须在叙事中体现局势的紧迫与时间的流逝，暗示不可再拖延。`
        }
        if (activeEvent.options?.length) {
          pendingKeyOptions = activeEvent.options.map(opt => ({
            id: opt.id,
            text: opt.text,
            style: 'neutral'
          }))
        }
      } else {
        const completed = updatedStore.story.completedEvents
        if (completed.length > 0) {
          const titles = completed
            .map(id => storySystem.getEvent(id)?.title || id)
            .filter(Boolean)
            .join('、')
          currentStoryContext = `[已完成事件]: ${titles}。不要重复这些情节，聚焦新的探索。`
        }
      }

      // 开场第一幕
      const isOpening = actionType === 'init' || updatedStore.history.filter(h => h.role === 'assistant').length === 0
      if (isOpening && !activeEvent) {
        /*
          ⚠️ 必须把**玩家选定的背景**传进去。
          原先这里只传 (世界, 主角, 在场角色)，于是选角页挑的
          出身/际遇/秘密一个字都没进开场提示词 —— 不管选哪个背景，
          第一幕都是同一段，玩家会说"选了半天背景发现开场一模一样"。
        */
        const opening = buildOpeningInstruction(
          activeWorld,
          player,
          activeCharacters,
          useSessionStore.getState().backgroundChoices,
          useSessionStore.getState().backgroundCustom,
        )
        currentStoryContext = currentStoryContext ? `${currentStoryContext}\n\n${opening}` : opening
      }

      // —— 第一阶段：叙事 ——
      useUIStore.getState().setStatusMessage('正在生成叙事…')
      const context = buildContext(actionText, useGameStore.getState(), currentStoryContext)

      /*
        三层记忆的注入位置（A1）。
        放在"前情摘要"**之后**、历史之前，理由有两条：
         1. 它比摘要更结构化（关系/线索/按轮次的事件），模型读条目比读散文更容易照做；
         2. 紧挨着历史，模型会把它当成"读这段历史的索引"，
            而不是一段需要重新总结的旧文本。
        为空时**完全不注入**（renderMemoryForPrompt 返回空串）：
        一个只有标题没有内容的空区块只会浪费 token，并让模型以为记忆丢了。
      */
      const memoryBlock = renderMemoryForPrompt(updatedStore.memory)

      const narrativeMessages: ChatMessage[] = [
        {
          role: 'system',
          /*
            ⚠️ 背景选择与属性值**必须每轮都传**（2026-10 玩家第二次打回）。
            原先这里只有 (世界, 在场角色, 主角卡) 三个参数 ——
            于是玩家在选角页挑的出身/立场，以及他分配的所有属性点，
            从第二幕起就再也进不了叙事提示词。背景与属性双双退化成
            "开局点一下就作废"的表单。详见 `buildBackgroundBriefing` 的注释。
          */
          content: buildNarrativeSystemPrompt(activeWorld, activeCharacters, player, {
            backgroundChoices: useSessionStore.getState().backgroundChoices,
            backgroundCustom: useSessionStore.getState().backgroundCustom,
            aspects: updatedStore.aspects,
            /*
              世界书按这段文本挑章节（见 utils/loreDigest.ts），所以要拼成
              「这一轮真正出现了什么」：玩家这一轮的动作、他此刻在哪、谁在场、
              刚发生了什么。拼得越准，挑出来的章节越对题 ——
              漏掉一个地名，讲那一带的章节就可能永远挑不出来。
            */
            context: [
              actionText,
              updatedStore.location,
              updatedStore.identity,
              activeCharacters.map(c => c.name).join(' '),
              updatedStore.history
                .filter(h => h.role === 'assistant')
                .slice(-1)
                .map(h => h.content)
                .join(' ')
                .slice(0, 1200),
            ].filter(Boolean).join('\n'),
            // 开局那一轮给双倍预算：第一幕要把整个世界立住，之后才收窄
            ...(isOpening ? { loreBudget: 24000 } : {}),
          }),
        },
        ...(updatedStore.summary ? [{ role: 'system' as const, content: `[前情摘要]\n${updatedStore.summary}` }] : []),
        ...(memoryBlock
          ? [{
              role: 'system' as const,
              content: `[长期记忆]（前几轮留下的要点，请当作**已经发生的事实**，不要与之矛盾）\n${memoryBlock}`,
            }]
          : []),
        ...updatedStore.history
          .slice(-12)
          .filter(h => h.role !== 'system')
          .map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
        { role: 'user', content: context }
      ]

      const streamResponse = await llmChat({
        messages: narrativeMessages,
        config,
        model: config.narrativeModel,
        stream: true
      }) as Response

      const reader = streamResponse.body?.getReader()
      if (!reader) throw new Error('无法读取模型响应流')

      const decoder = new TextDecoder()
      let fullNarrative = ''
      let fullReasoning = ''
      let buffer = ''
      /** 服务商在流里回的 usage（通常只在最后一个 chunk 带一次） */
      let streamUsage: TokenUsage | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // 最后一行可能被截断，留到下次
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const usage = parseSseUsage(line.trim())
          if (usage) streamUsage = usage
          const chunk = parseSseLine(line.trim())
          if (!chunk) continue
          if (chunk.reasoning) {
            fullReasoning += chunk.reasoning
            setStreamingReasoning(fullReasoning)
          }
          if (chunk.content) {
            fullNarrative += chunk.content
            setStreamingContent(fullNarrative)
          }
        }
      }
      // 处理残留缓冲
      const tailLine = buffer.trim()
      const tailUsage = parseSseUsage(tailLine)
      if (tailUsage) streamUsage = tailUsage
      const tail = parseSseLine(tailLine)
      if (tail?.content) {
        fullNarrative += tail.content
        setStreamingContent(fullNarrative)
      }

      if (!fullNarrative.trim()) throw new Error('模型返回了空内容，请检查模型名称与接口地址。')

      /*
        记录第一段（叙事）的用量。
        流里没回 usage 时退回估算 —— 但**别丢掉已经拿到的 prompt 数**：
        只有 completion 缺失时补它（见 estimateMissingCompletion）。
      */
      recordUsage(
        null,
        narrativeMessages,
        fullNarrative,
        streamUsage ? estimateMissingCompletion(streamUsage, fullNarrative) : null,
      )

      /*
        截断检测。
        模型可能在句子中间被切断（max_tokens 用尽、流被中断），
        返回的既不是空串也不是错误，而是一段"看起来正常但停在半句"的文本 ——
        它会照原样进入历史与下一轮上下文，故事里凭空多一个断句，
        而玩家完全不知道为什么。这里标出来让他决定要不要重新生成。
      */
      /*
        截断检测与**自动续写**。

        模型可能在句子中间被切断（max_tokens 用尽、流被中断），
        返回的既不是空串也不是错误，而是一段"看起来正常但停在半句"的文本。

        上一版只做提示，玩家要自己点重新生成 —— 而重生成会把已经写好的
        那半段整体作废，代价太大。这里改成**自动请求补全**：
        把已写的部分作为前缀交给模型，请它接着写完，再拼起来。

        只续一次。续写也可能再次被截断，第二次就直接提示玩家 ——
        否则会陷入"无限续写"，既费 token 又永远停不下来。
      */
      let finalNarrative = fullNarrative
      let trunc = detectTruncation(finalNarrative, activeWorld?.narrative?.replyLength)
      if (trunc.truncated) {
        const continued = await tryContinueNarrative(finalNarrative, config, activeWorld)
        if (continued) {
          finalNarrative = continued
          trunc = detectTruncation(finalNarrative, activeWorld?.narrative?.replyLength)
          if (!trunc.truncated) {
            // 续写成功：明确告诉玩家发生了什么，而不是静默拼上
            useUIStore.getState().setStatusMessage('这段叙事曾被截断，已自动补全')
            setTimeout(() => useUIStore.getState().setStatusMessage(null), 2500)
          }
        }
      }

      if (trunc.truncated) {
        setTruncationWarning(trunc.reason || '这段叙事可能没有写完')
      } else {
        setTruncationWarning(null)
      }

      useGameStore.getState().addHistory({ role: 'assistant', content: finalNarrative, timestamp: Date.now() })
      setStreamingContent(null)
      setStreamingReasoning(null)

      // 归档检查放在每轮叙事之后：这是 history 唯一增长的地方，
      // 在这里查一次就能保证 localStorage 里的热数据始终有界，
      // 不会等撞到 5MB 配额、写入静默失败之后才发现。
      void maybeArchiveHistory()

      /*
        ── 第二阶段：数据结算（快速模式下跳过）──

        为什么把开关放在这里，而不是"少发一个请求"这么简单：
        分析阶段是**唯一**会更新数值、物品、关系、选项的地方。
        跳过它就以"状态不再变化"为代价换速度与钱 ——
        这个代价必须由玩家知情地选择（UI 上写明了），
        并且此时**仍然**要往时间线记一拍：记忆属于叙事层，
        不应该因为省了一次结算调用就把"这一轮发生过什么"丢掉。
      */
      const fastMode = useUIStore.getState().fastMode
      if (fastMode) {
        useGameStore.getState().appendTimeline(turnNumber, `${actionText} → ${finalNarrative}`)
        setDebugDataInput('[快速模式] 已跳过分析阶段，本轮不更新数值与状态')
        setDebugDataOutput('[快速模式] 未发起数据结算调用')
      } else {
        // —— 第二阶段：数据结算 ——
        useUIStore.getState().setStatusMessage('正在结算世界状态…')
        setIsAnalyzingData(true)

        const afterNarrative = useGameStore.getState()
        const dataAnalysisContext = JSON.stringify({
          userAction: actionText,
          userActionType: actionType,
          narrativeOutput: fullNarrative,
          storyContext: currentStoryContext,
          currentState: {
            attributes: Object.fromEntries(
              afterNarrative.attributeDefs.map(d => [d.id, afterNarrative.aspects[d.id] ?? 0])
            ),
            resources: Object.fromEntries(
              afterNarrative.resourceDefs.map(d => [
                d.id,
                { 名称: d.name, 当前: afterNarrative.resources[d.id] ?? 0, 上限: d.max ?? null }
              ])
            ),
            inventory: afterNarrative.inventory,
            facts: afterNarrative.facts,
            story: afterNarrative.story,
            characters: afterNarrative.characters,
            location: afterNarrative.location,
            sceneId: afterNarrative.sceneId,
            time: afterNarrative.time,
            /** 这一轮是第几轮 —— 数据 AI 写时间线时要抄这个数字 */
            turn: turnNumber,
            /** 已经记下的三层记忆，避免它把同一件事反复重新记录 */
            memory: {
              bonds: afterNarrative.memory?.bonds ?? [],
              threads: afterNarrative.memory?.threads ?? [],
              timeline: afterNarrative.memory?.timeline ?? [],
            }
          }
        })
        setDebugDataInput(dataAnalysisContext)

        const dataMessages: ChatMessage[] = [
          { role: 'system', content: buildDataSystemPrompt(activeWorld, useGameStore.getState().aspects) },
          { role: 'user', content: dataAnalysisContext }
        ]

        const dataResponse = await llmChat({
          messages: dataMessages,
          config,
          model: config.analysisModel,
          stream: false,
          temperature: 0.2,
          jsonMode: true
        })

        const dataContent = extractContent(dataResponse)
        setDebugDataOutput(dataContent)
        recordUsage(dataResponse, dataMessages, dataContent)

        let parsed: any = null
        try {
          parsed = parseModelJson(dataContent).value as any
          if (!parsed || typeof parsed !== 'object') {
            throw new Error('解析结果不是对象')
          }

          // 章节卡的关键选项按拖延程度注入
          if (pendingKeyOptions.length > 0) {
            const currentTurns = useGameStore.getState().turnsSinceLastMajorEvent
            if (currentTurns >= activeWorld.story.urgencyAfterTurns) {
              parsed.options = pendingKeyOptions
            } else if (currentTurns >= 2) {
              const existingIds = new Set((parsed.options || []).map((o: any) => o.id))
              parsed.options = [
                ...(parsed.options || []),
                ...pendingKeyOptions.filter(o => !existingIds.has(o.id))
              ]
            }
          }

          handleStateChanges(parsed.stateChanges)

          const options = activeWorld.story.enableChoices ? (parsed.options || []) : []
          useGameStore.getState().setCurrentOptions(options)
        } catch (e) {
          console.error('Failed to parse Data AI response', e)
          setLastError('数据结算返回的内容无法解析为 JSON（已重试截断解析）。可点开右下角调试面板查看原始输出。')
        }

        /*
          三层记忆的**每轮**更新（A1）。
          摘要 AI 每 6 轮才跑一次（那是唯一会花掉一次完整调用代价的地方），
          但时间线必须每轮都有 —— 否则第 5 轮玩家点回溯时，
          时间线上根本没有第 3 轮，而"回到第 N 轮"正是靠它给出落点的。
          这里优先用数据 AI 给的措辞（它刚读过这一段叙事，写得比机械截取准）；
          解析失败时也要补一条机械记录 —— 玩家确实看到了这段叙事，
          让它在记忆里凭空消失比记一条粗糙的更糟。
        */
        const memoryPatch = parsed?.memory && typeof parsed.memory === 'object' ? parsed.memory : null
        if (memoryPatch) {
          useGameStore.getState().patchMemory({
            bonds: memoryPatch.bonds,
            threads: memoryPatch.threads,
            timeline: memoryPatch.timeline,
          })
        }
        if (!memoryPatch?.timeline?.length) {
          const beat = typeof parsed?.summary === 'string' && parsed.summary.trim()
            ? parsed.summary.trim()
            : `${actionText} → ${finalNarrative}`
          useGameStore.getState().appendTimeline(turnNumber, beat)
        }

        setIsAnalyzingData(false)
      }

      /*
        一轮**完整走完**才拍快照（B8）。
        放在这里而不是 try 的开头：结算半途失败的那一轮不留快照，
        否则回溯会退回到一个"叙事有了、数值没结算"的残缺状态 ——
        那种不一致比不能回溯更难查。
      */
      useGameStore.getState().pushTurnSnapshot(turnNumber, actionText)
    } catch (error: any) {
      console.error('Game Engine Error:', error)
      setLastError(formatEngineError(error))
      setIsAnalyzingData(false)
    } finally {
      setIsProcessing(false)
      setStreamingContent(null)
      setStreamingReasoning(null)
      useUIStore.getState().setStatusMessage(null)
    }
  }

  const handleAction = async (actionId: string, actionText: string) => {
    const currentStore = useGameStore.getState()

    /*
      给"重新生成"留一份**可复现这一步**的状态。
      注意顺序：必须在下面"结算章节卡事件效果 / 风格标签加属性"**之前**拍 ——
      那些副作用会改数值，拍在它们之后就等于把副作用**算了两次**
      （玩家点一次重新生成，属性凭空 +2，而且只在有 style 的选项上出现，极难复现）。
    */
    currentStore.saveSnapshot()
    useUIStore.getState().setStatusMessage('处理行动中…')

    // 如果玩家点的是章节卡事件选项，先结算事件效果
    if (currentStore.story.activeEventId) {
      const event = storySystem.getEvent(currentStore.story.activeEventId)
      const selectedOption = event?.options?.find(o => o.id === actionId)
      if (selectedOption) {
        if (selectedOption.effects) {
          storySystem.processEffects(selectedOption.effects, useGameStore.getState())
        }
        useGameStore.getState().completeEvent(currentStore.story.activeEventId)
        useGameStore.getState().setStoryState({
          activeEventId: selectedOption.nextEventId || null
        })
      }
    }

    // 选项自带的风格标签 → 对应属性 +1
    const option = useGameStore.getState().currentOptions.find((o: any) => o.id === actionId)
    const world = useSessionStore.getState().world
    if (option?.style && world && world.enableMechanics) {
      const valid = world.attributes.some(a => a.id === option.style)
      if (valid) {
        const aspects = useGameStore.getState().aspects
        useGameStore.getState().setAspects({ [option.style]: (aspects[option.style] || 0) + 1 })
      }
    }

    setLastAction({ id: actionId, text: actionText })
    const actionType = actionId === 'custom_action' ? 'custom' : (actionId === 'init' ? 'init' : 'option')
    return processTurn(actionText, actionType)
  }

  /**
   * 重新生成上一轮。
   *
   * 完整顺序，缺一不可：
   *  1. `restoreSnapshot()` —— 回到"这一步开始之前"（含 history 与三层记忆）；
   *  2. 清掉 `lastAction` —— 否则 handleAction 里的 setLastAction 会拿它当新值，
   *     而更长的一串后果是：重试 N 次后"重新生成"的语义开始漂移
   *     （它可能指向更早的一次行动）；
   *  3. 再跑一次同样的行动 —— handleAction 会重新拍一份快照，
   *     于是玩家可以反复重试，每次的起点都一致。
   */
  const retryLastAction = async () => {
    if (!lastAction) return
    const { id, text } = lastAction
    const currentStore = useGameStore.getState()
    if (currentStore.lastStateSnapshot) {
      currentStore.restoreSnapshot()
    }
    setLastAction(null)
    useUIStore.getState().setStatusMessage('重新生成中…')
    return handleAction(id, text)
  }

  /**
   * 回到第 N 轮结束时（B8）。
   *
   * 为什么放在引擎层而不是让 UI 直接调 `gameStore.rewindTo`：
   * 回滚之后还有几件**引擎自己的**状态要一起复位，漏掉任何一件都会让
   * 界面和存档对不上：
   *
   *  1. `lastAction` —— 不清掉的话，"重新生成"会把玩家**回滚掉的那一轮**
   *     的行动重新执行一遍（他会发现退回第 3 轮后点重试，故事又跳回第 9 轮）。
   *  2. 流式残留与错误 —— 回滚是个突变，屏幕上不该还留着上一轮的半截文本。
   *  3. **归档** —— 见下方注释，这是最容易被忽略的一处。
   *
   * 轮次本身**不需要**在这复位：它由 `countTurns(history)` 算出来，
   * 而 history 已经被 store 真的截短了（见上一节关于本地计数器的说明）。
   */
  const rewindToTurn = (turnIndex: number): boolean => {
    const ok = useGameStore.getState().rewindTo(turnIndex)
    if (!ok) return false

    setLastAction(null)
    setStreamingContent(null)
    setStreamingReasoning(null)
    setLastError(null)
    setTruncationWarning(null)

    /*
      清空 IndexedDB 里的叙事归档。
      回溯把 history 截短了，但归档是**定时**发生的，里面可能已经收着
      "被回滚掉的那几轮"的正文；不清掉的话，`loadArchive` 读回来的旧叙事
      会重新出现在历史里 —— 玩家会看到自己已经取消的未来。
      代价：归档里那些**更早的、仍然有效**的旧叙事也一起丢了（它们的要点
      仍在 summary 与 memory 里）。这个取舍在 TurnSnapshot 的注释里写明了。
    */
    void clearArchive()

    useUIStore.getState().setStatusMessage(`已回到第 ${turnIndex} 轮`)
    setTimeout(() => useUIStore.getState().setStatusMessage(null), 2500)
    return true
  }

  return {
    handleAction,
    retryLastAction,
    isProcessing,
    isAnalyzingData,
    lastError,
    truncationWarning,
    clearTruncationWarning: () => setTruncationWarning(null),
    currentOptions: store.currentOptions,
    streamingContent,
    streamingReasoning,
    debugDataInput,
    debugDataOutput,
    isInputAllowed,
    turnCount: countTurns(store.history),
    rewindTurns: store.turnSnapshots.map(s => s.turn),
    rewindOptions: store.turnSnapshots.map(s => {
      const full = String(s.playerAction || '').trim()
      return { turn: s.turn, action: summarizeAction(full), full }
    }),
    rewindToTurn,
  }
}
