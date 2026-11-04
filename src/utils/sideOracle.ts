/**
 * **旁路 AI**（侧边神谕）：在玩的时候问剧情、修文字、查设定。
 *
 * ## 为什么需要它（2026-11，来自酒馆生态评估）
 *
 * 玩家在玩的时候常有三种疑问：
 *  1. 「她为什么这么做」（问剧情）
 *  2. 「这段写得不像人话」（改文字）
 *  3. 「这城里到底有没有当铺」（查设定）
 *
 * 前两种如果直接问主模型，**会污染上下文** —— 那条提问进了 history，
 * 就成了后续叙事的背景，剧情被带跑。所以必须开一条**只读**的旁路：
 * 读 history，但一个字都不写回去。
 *
 * ## 三条硬约束（抄自故事神谕的经验）
 *
 * 1. **只读**：这个模块不 import 任何 store，只接收纯数据。
 *    写不进去是**结构上保证**的，不是靠自觉。
 * 2. **不推进剧情**：它的回答是"戏外语"，不是叙事正文。
 * 3. **三种模式各管一件事**，不要合并成一个万能助手 ——
 *    合并之后模型会用它来续写正文，那正是要避免的。
 */
import type { ChatMessage } from '@/api/llm'
import { digestLore, renderLoreDigest } from '@/utils/loreDigest'

export type OracleMode = 'plot' | 'polish' | 'lore'

export const ORACLE_MODES: { id: OracleMode; label: string; hint: string }[] = [
  { id: 'plot', label: '问剧情', hint: '她为什么这么做 / 我们之前答应过什么' },
  { id: 'polish', label: '修文字', hint: '把最新一条回复重写一遍，去掉 AI 味' },
  { id: 'lore', label: '查设定', hint: '这城有没有当铺 / 那条规矩怎么写的' },
]

/**
 * 旁路 AI 能看到的上下文。
 *
 * ⚠️ 这些东西**全是只读快照**，由调用方从 store 里读出来递进来。
 * 这个模块不认识任何 store —— 于是它不可能改到存档。
 */
export interface OracleInput {
  worldTitle: string
  worldLore: string
  rules: string
  playerName: string
  location: string
  summary: string
  /** 最近的对话（调用方已经截断过） */
  recent: { role: string; content: string }[]
  /** 用户这一句提问（polish 模式下是"要怎么改"） */
  question: string
  /** polish 模式要改的那段正文 */
  target?: string
  /** 世界里真实存在的专名（`collectWorldProperNouns` 的产物），给检索用 */
  nouns?: readonly string[]
}

/** 最近对话的默认条数与单条截断长度（省 token，且越早的越没用） */
export const ORACLE_RECENT_TURNS = 8
export const ORACLE_RECENT_CHARS = 900

function oracleSystemPrompt(mode: OracleMode, worldTitle: string): string {
  if (mode === 'plot') {
    return `你是《${worldTitle}》的**戏外助手**。玩家在玩的时候找你问剧情，你在旁边回答。

- 你**不是叙事者**。不写正文、不续写、不替他做决定、不推动剧情。
- 你的价值是**帮他理清已经发生了什么**：谁说过什么、欠了什么、那条线索从哪来的。
- 只依据给你的「最近对话」与「前情摘要」回答。**没写到的就说没写到**，不要推测，
  更不要替世界补充设定。
- 回答要短：三到六句。像在旁边压低声音说话的朋友，不像写论文。
- 用戏外的口吻（可以说「你」「他」），不要用第二人称叙事腔。`
  }
  if (mode === 'polish') {
    return `你要重写一段小说正文，目的是**去掉 AI 味**。

【改什么】
- 删掉套话与八股：那种什么场面都能用的句子（「空气仿佛凝固了」「心中五味杂陈」「不由得」「这一刻」）。
- 把总结式的句子换成动作：不要写「他很愤怒」，写他做了什么。
- 把过度精确的数字与学术腔改回人话。
- 收掉排比与重复：同一个意思只说一遍。

【绝对不许动的】
- 情节、事件顺序、谁做了什么 —— 一个字都不许改。
- 所有专名（人名、地名、器物名）原样保留。
- 所有对白的意思与语气：可以改措辞让它更像人说的，不许改立场与信息。
- 长度大致不变：**不要压缩成梗概，也不要扩写成另一场戏**。

【输出】
只输出改写后的正文，不要解释改了什么，不要加标题，不要用代码块包起来。`
  }
  return `你要在《${worldTitle}》的世界书里**找依据**回答玩家的问题。

- 只依据给你的「世界书片段」回答。片段里没有的，直接说「世界书里没有写到」，
  **不要用常识补**，也不要编。
- 如果能找到，**把原文那句话引出来**，并说它在哪一章 —— 玩家要的是"哪里写的"，不是"大概是这样"。
- 回答短：先给结论一句，再给依据一句。`
}

/** 把最近对话压成一段可读的引用（只读材料，明确标注不要续写） */
function recentBlock(recent: OracleInput['recent']): string {
  if (!recent.length) return ''
  const lines = recent
    .slice(-ORACLE_RECENT_TURNS)
    .map(m => {
      const who = m.role === 'assistant' ? '叙事' : m.role === 'user' ? '玩家' : '系统'
      const text = String(m.content || '').replace(/\s+/g, ' ').trim()
      return `【${who}】${text.length > ORACLE_RECENT_CHARS ? text.slice(0, ORACLE_RECENT_CHARS) + '…' : text}`
    })
  return `## 最近发生的（**只读材料**，不要接着写）\n\n${lines.join('\n')}`
}

/**
 * 按当前问题挑世界书片段。
 *
 * 复用 `digestLore` 而不是整段塞：世界书 3–8 万字，全塞进去既贵又稀释。
 * 查设定模式尤其需要它 —— 问「当铺」时该翻到的是讲市井那一章，不是纪年那一章。
 */
function loreBlock(input: OracleInput): string {
  const lore = String(input.worldLore || '').trim()
  if (!lore) return ''
  const digest = digestLore(lore, {
    context: [input.question, input.location, input.recent.at(-1)?.content || ''].filter(Boolean).join('\n'),
    nouns: input.nouns || [],
    // 旁路回答不需要整本世界，给少一点
    budget: 4000,
    alwaysInclude: 1,
  })
  const text = renderLoreDigest(digest, input.worldTitle)
  return text ? `## 世界书片段（按这一问挑出来的）\n\n${text}` : ''
}

/** 拼出这一轮发给旁路模型的 messages */
export function buildOracleMessages(mode: OracleMode, input: OracleInput): ChatMessage[] {
  const system = oracleSystemPrompt(mode, input.worldTitle)
  const parts: string[] = []

  if (mode === 'polish') {
    const target = String(input.target || '').trim()
    parts.push(`## 要改的正文\n\n${target || '（没有拿到正文）'}`)
    if (input.question.trim()) parts.push(`## 额外要求\n\n${input.question.trim()}`)
    return [{ role: 'system', content: system }, { role: 'user', content: parts.join('\n\n') }]
  }

  const where: string[] = []
  if (input.playerName) where.push(`主角：${input.playerName}`)
  if (input.location) where.push(`此刻在：${input.location}`)
  if (where.length) parts.push(`## 处境\n\n${where.join('\n')}`)
  if (input.summary.trim()) parts.push(`## 前情摘要\n\n${input.summary.trim()}`)

  const recent = recentBlock(input.recent)
  if (recent) parts.push(recent)

  if (mode === 'lore') {
    const lb = loreBlock(input)
    if (lb) parts.push(lb)
    // 规则里常有「术语规范」，查设定时它比正文更权威
    if (input.rules.trim()) {
      parts.push(`## 世界规则（术语与禁令，优先于正文）\n\n${input.rules.trim().slice(0, 3000)}`)
    }
  }

  parts.push(`## 我的问题\n\n${input.question.trim() || '（没有输入）'}`)

  return [{ role: 'system', content: system }, { role: 'user', content: parts.join('\n\n') }]
}

/**
 * 取「最新一条叙事回复」当修文字模式的目标。
 *
 * 从后往前找第一条 assistant 消息 —— 中间可能夹着 system（状态变更）消息。
 */
export function pickLatestNarrative(history: readonly { role: string; content: string }[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant' && String(history[i].content || '').trim()) {
      return history[i].content
    }
  }
  return ''
}

/** 修文字模式要不要发起调用：太短的不值得改（省钱，且短文本本来就好改） */
export const POLISH_MIN_CHARS = 120

export function shouldPolish(text: string): boolean {
  return String(text || '').trim().length >= POLISH_MIN_CHARS
}
