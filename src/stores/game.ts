import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { StoryState } from '@/types/story'
import type { AttributeDef, ResourceDef, SpriteLook, WorldCard } from '@/types/cards'
import { appendTimelineBeat, emptyMemory, mergeMemory, type MemoryPatch, type StoryMemory } from '@/utils/memory'

/**
 * 运行时存档
 *
 * 原版的 aspects / resources 是写死的字段（8 种性相 + 资金/健康/理智）。
 * 现在改成由世界卡定义的动态字典，key 就是定义里的 id。
 */
export type AspectState = Record<string, number>
export type ResourceMap = Record<string, number>

export interface Item {
  id: string
  name: string
  description: string
  tags: string[]
}

export interface Lore {
  id: string
  name: string
  description: string
  principle: string
  level: number
}

export interface Rite {
  id: string
  name: string
  description: string
  requirements: string[]
}

export interface Language {
  id: string
  name: string
  description: string
  script: string
}

export interface Character {
  id: string
  name: string
  description: string
  relationship: string
  status: string
  location?: string
  stats?: Partial<AspectState>
  /** 角色卡的完整提示词资料，注入叙事 AI 用 */
  prompt?: string
  /** 头像（data URL 或 URL）：角色卡自带，优先级最高 */
  avatar?: string
  /**
   * 素材库头像 id。AI 在角色登场时从清单里挑一个，
   * 由 resolveAvatar() 解析成实际图片；avatar 存在时不使用。
   */
  avatarId?: string
  /**
   * 部件级显式外观（立绘用，来自世界卡或角色卡的 `look`）。
   *
   * ⚠️ 这个字段是**外观那边先写进 UI**、由本文件补上的类型定义：
   * `PortraitPanel` / `RelationshipPanel` 直接读 `char.look`，
   * 而运行时角色对象由本 store 定义 —— 少了它，`tsc` 会报
   * 「Property 'look' does not exist on type 'Character'」，
   * 整个项目的类型检查红着（与本源改动无关，但会被算成构建失败）。
   *
   * 它是**可选**的、纯数据字段：不填就由 resolveAvatar / recipeFor 按 id 兜底，
   * 不影响任何既有逻辑。改这个字段名之前请先搜一遍 components/**。
   */
  look?: SpriteLook
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: number
}

export interface GameTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

export interface Fact {
  id: string
  name: string
  description: string
}

export interface LocationInfo {
  id: string
  name: string
  description: string
  isUnlocked: boolean
}

/**
 * 一次 LLM 调用的用量（C9）
 *
 * `estimated` 是**必须**有的字段：很多 OpenAI 兼容端点（尤其是第三方中转与
 * 本地 ollama）在流式响应里根本不回 usage，而"看不到花了多少"正是这一项
 * 要解决的问题 —— 拿不到就按字符数估，但必须**诚实标出来是估算**，
 * 不能让玩家把估算值当成账单。
 */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** true = 接口没回 usage，数字是按字符数估的 */
  estimated: boolean
}

/**
 * 一轮结束时玩家能感知到的状态快照（B8 回溯用）
 *
 * ## 取舍一：为什么**只**存这几项，而不是整份 store
 *
 * 回滚需要历史快照，最直白的做法是每轮存一份 "整个 store 的深拷贝"。
 * 那不可行：`history` 每轮都在增长，第 N 轮存一次就等于把前面所有叙事
 * 再复制一份 —— 总占用是 O(轮数²)，几十轮就能把 localStorage 的 5MB 撑爆，
 * 而**写爆配额是静默的**（persist 中间件吞掉 QuotaExceededError），
 * 表现为"存档突然不再保存"。用存档损坏去换一个方便功能，代价太大。
 *
 * 所以这里只存**玩家能感知、且会被 AI 改写的那几项**：
 * 摘要、三层记忆、数值（属性/资源/物品/关系/时间/地点/剧情）。
 * 不存的：世界卡定义（`attributeDefs`/`resourceDefs`，只由世界卡决定，
 * 回滚时不需要动）、角色卡的完整提示词资料 `character.prompt`
 * （属于配置不属于进度，带上只会让每份快照白白变大一截）。
 *
 * ## 取舍二：历史存**增量**，不存副本
 *
 * 就算排除掉上面那些，`history` 本身仍然是最大的一块，而它每轮只**追加**几条。
 * 于是这里不再每轮深拷贝整个 history，只存这一轮新增的那几条
 * （`historyDelta`）与当时的**绝对长度**（`historyLength`）：
 *
 *  - 占用从 O(轮数²) 降到 O(总消息数) —— 与"只存一份当前历史"同量级；
 *  - 回滚时**无损重放**：从最早的那份增量开始依次拼接，
 *    得到的就是那一轮的完整历史（历史只追加、从不插改，这是本项目的不变量）。
 *
 * 代价是回滚要做一次 O(N) 的拼接，并且**依赖"历史只追加"这个前提**。
 * 所以 `rewindTo` 会在重放后校验长度，对不上就如实返回 false ——
 * 宁可告诉玩家"这一轮回不去"，也不要拿一段错位的历史去冒充那个时刻。
 *
 * ## 取舍三：回溯不清归档
 *
 * 超出热数据的历史已经被归档进 IndexedDB（见 utils/historyArchive.ts）。
 * 回滚到第 N 轮时，快照里的历史是那一轮的热数据；归档里可能既有**更早的、
 * 仍然有效**的叙事，也可能有**被回滚掉的那几轮**（归档是定时发生的，
 * 无法精确定位切割点）。这里选择：回溯后**清空归档**
 * （见 useGameEngine.rewindToTurn）。代价是更早的旧叙事正文会丢
 * （要点仍在 summary 与 memory 里），换来的是不把"玩家已经取消的未来"
 * 重新读回上下文 —— 后者会直接写坏故事。
 */
export interface TurnSnapshot {
  /** 这一轮结束时是第几轮（正整数；0 = 开局前） */
  turn: number
  /**
   * 这一轮**玩家输入的行动原文**（2026-10 新增）。
   *
   * ## 为什么必须单独存它
   *
   * `history` 里其实**只有两种**消息：assistant（叙事）与 system（状态变更）——
   * 玩家的输入从来没有落进历史，它只出现在**发给模型的 messages** 里。
   * 于是玩家打开回溯下拉时看到的只有「第 3 轮」「第 7 轮」这种编号，
   * 完全想不起来那一轮自己干了什么，也就无从判断该退回哪一轮。
   *
   * 存进快照而不是补进 history，是刻意的：history 每轮都要整段发给模型，
   * 往里加消息等于每轮多花 token；而这个字段只服务于**回溯界面**。
   */
  playerAction?: string
  /** 这一轮**新增**的消息（不包含之前的轮次） */
  historyDelta: ChatMessage[]
  /** 拍快照时 history 的绝对长度，回放时用它核对是否错位 */
  historyLength: number
  summary: string
  memory: StoryMemory
  resources: ResourceMap
  aspects: AspectState
  inventory: Item[]
  characters: Character[]
  lores: Lore[]
  rites: Rite[]
  languages: Language[]
  locations: LocationInfo[]
  unlockedDoors: string[]
  knownFacts: string[]
  facts: Fact[]
  readBooks: string[]
  masteredLores: string[]
  tags: string[]
  story: StoryState
  time: GameTime
  identity: string
  location: string
  sceneId?: string
  stage: string
  currentOptions: any[]
  turnsSinceLastMajorEvent: number
}

/**
 * 回溯快照最多保留多少轮。
 *
 * 超过就丢最旧的：这个功能是"退几步重来"（玩家实测通常退 1~5 轮），
 * 而不是"整局任意时间旅行"。保住最近 60 轮，既覆盖真实用法，
 * 又给 localStorage 配额留足余量（增量存法下 60 轮 ≈ 一段热历史的体积）。
 */
export const MAX_TURN_SNAPSHOTS = 60

/**
 * 从轮次升序的快照链里重放出第 `turnIndex` 轮的历史。
 *
 * @param currentHistory 当前的热历史 —— 重放**最新那一轮**时直接取它的前缀，
 *                       这是唯一不会受"最旧快照被裁掉"影响的一条路径
 *                       （见下面"两条路径"的说明）。
 *
 * ## 为什么会有两条路径
 *
 * 快照只保留最近 MAX_TURN_SNAPSHOTS 轮，而历史是**绝对**累积的：
 * 一旦最旧的快照被裁掉，链的起点就落在历史中间，前半段无从复原。
 * 于是：
 *
 *  - **回到最新一轮**（最常见的一种："刚刚那轮我不满意"）→ 直接截断当前历史。
 *    它一定是正确的：当前历史 = 那一轮的历史 + 之后追加的东西。
 *  - **回到更早的轮次** → 从链的起点把增量拼起来（基线校验保证不错位）。
 *    受保留窗口限制，能回多久就是多久，回不去的如实返回 null。
 *
 * 返回 null 一律意味着"这一轮回不去"，调用方必须原样告诉玩家，
 * 绝不能拿一段错位的历史去冒充那个时刻。
 */
export function replayHistory(
  snapshots: TurnSnapshot[],
  turnIndex: number,
  currentHistory: ChatMessage[] = [],
): ChatMessage[] | null {
  const chain = snapshots
    .filter(s => s.turn <= turnIndex)
    .sort((a, b) => a.turn - b.turn)
  const target = chain.find(s => s.turn === turnIndex)
  if (!target) return null

  // —— 路径一：目标就是最新一轮 → 直接截断当前历史 ——
  /*
    这一条**故意不走校验**：当前历史是活的真相，"截断到某一轮的长度"
    在语义上永远成立，不需要快照元数据佐证。这也让"刚刚那轮不算，重来"
    这个最常用的回溯不会因为更早的快照被弄脏而失效。
  */
  const newest = snapshots.length ? snapshots[snapshots.length - 1] : null
  if (newest && newest.turn === turnIndex) {
    return currentHistory.slice(0, Math.min(newest.historyLength, currentHistory.length))
  }

  // —— 路径二：从链的起点重放增量 ——
  const start = chain[0]
  /*
    起点那份快照之前可能还有没被记录的消息（最旧的快照被裁掉之后就会这样）。
    用它的 `historyLength - delta.length` 当基线是**刻意**的：

     - 正常情况下基线为 0，等于"这份快照就是从历史开头开始的"；
     - 被裁过时基线为正，说明前面还有内容 —— 我们不假装那部分不存在，
       而是把它算进长度校验，重放结果照样对齐（窗口内的轮次依然可回滚）。
       少了这一步，一旦开始裁剪快照，**所有**回溯都会失败。
  */
  const baseline = Math.max(0, start.historyLength - (start.historyDelta?.length ?? 0))

  const history: ChatMessage[] = []
  for (const s of chain) {
    const delta = s.historyDelta ?? []
    /*
      链必须首尾相接：拼到这里应该正好是 `historyLength` 条。
      对不上说明快照链中间缺了一环（失败的一轮没拍快照、手动清过历史等）——
      重放出来的是**错位的过去**，比"回不去"危险得多，直接放弃。

      ⚠️ 这里对**最新**那份快照网开一面：它描述的是"现在"，
      而现在的历史是活的（`currentHistory`）—— 上面那条路径已经先处理了它。
      真走到这里时 newest 不在链上，所以下面校验的每一份都比它更早，可以严格。
    */
    if (baseline + history.length !== s.historyLength - delta.length) return null
    history.push(...delta)
    if (s.turn === turnIndex) break
  }

  if (baseline + history.length !== target.historyLength) return null
  return history
}

/** 从快照里重建一份完整的运行时状态（缺失字段用当前值兜底） */
function snapshotToState(snapshot: TurnSnapshot, history: ChatMessage[]) {
  return {
    history,
    summary: snapshot.summary,
    memory: snapshot.memory,
    resources: snapshot.resources,
    aspects: snapshot.aspects,
    inventory: snapshot.inventory,
    characters: snapshot.characters,
    lores: snapshot.lores,
    rites: snapshot.rites,
    languages: snapshot.languages,
    locations: snapshot.locations,
    unlockedDoors: snapshot.unlockedDoors,
    knownFacts: snapshot.knownFacts,
    facts: snapshot.facts,
    readBooks: snapshot.readBooks,
    masteredLores: snapshot.masteredLores,
    tags: snapshot.tags,
    story: snapshot.story,
    time: snapshot.time,
    identity: snapshot.identity,
    location: snapshot.location,
    sceneId: snapshot.sceneId,
    stage: snapshot.stage,
    currentOptions: snapshot.currentOptions,
    turnsSinceLastMajorEvent: snapshot.turnsSinceLastMajorEvent,
  }
}

/** 历史里有几轮叙事（= 有几条 assistant 消息）。回溯的轮次编号就以此为基准 */
export function countTurns(history: ChatMessage[]): number {
  return (history || []).filter(m => m?.role === 'assistant').length
}

/** 累计用量的起点。注意它**不是** null，而是零值 —— 界面不必处处判空 */
export const EMPTY_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimated: false,
}

/** 两次用量相加（累加时只要有一次是估算，整体就标成估算） */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    estimated: a.estimated || b.estimated,
  }
}

export interface GameState {
  // —— 世界卡定义的快照（用于渲染与结算）——
  /** 属性定义，含显示名与颜色 */
  attributeDefs: AttributeDef[]
  /** 资源定义，含显示名与上限 */
  resourceDefs: ResourceDef[]

  resources: ResourceMap
  aspects: AspectState
  inventory: Item[]
  lores: Lore[]
  rites: Rite[]
  languages: Language[]
  characters: Character[]
  locations: LocationInfo[]
  unlockedDoors: string[]
  stage: string
  location: string
  /**
   * 当前场景背景 id（来自 SCENE_CATALOG）。
   * AI 在场景明显切换时通过 SET_SCENE 更新它，叙事区据此换背景图。
   */
  sceneId?: string
  time: GameTime
  identity: string
  history: ChatMessage[]
  summary: string
  /**
   * 长期记忆的三层结构（A1）。
   *
   * 与 `summary` 并列而不是取代它：`summary` 是"这一路的经过"的连贯散文，
   * 三层是**要点**（关系现状 / 未结线索 / 按轮次的时间线）。
   * 两者解决的是不同的丢失 —— 前者丢的是语气与来龙去脉，
   * 后者丢的是"谁欠谁"这种一句话的事实。
   */
  memory: StoryMemory
  tags: string[]
  story: StoryState
  currentOptions: any[]
  isGameStarted: boolean
  knownFacts: string[]
  facts: Fact[]
  readBooks: string[]
  masteredLores: string[]

  // —— C9：成本可见 ——
  /** 最近一轮的两次调用累计用量（叙事 + 数据） */
  lastUsage: TokenUsage | null
  /**
   * 本次会话（从开局算起）的累计用量。
   *
   * 存 token 数而不是钱：单价会变（服务商调价、用户换模型），
   * 存钱就等于把过时的汇率钉进存档；存 token 则任何时候都能重算，
   * 界面上的金额只是当下的**换算显示**。
   */
  sessionUsage: TokenUsage
  /** 累加一次调用的用量，并把结果同步到 lastUsage */
  recordUsage: (usage: TokenUsage) => void
  /** 一轮开始时清零 lastUsage（避免把上一轮的数字当成本轮） */
  clearLastUsage: () => void
  /** 清零累计（玩家开始新一局或想重新观察时用） */
  resetSessionUsage: () => void

  // Player Profile
  playerName: string
  playerGender: string
  playerAppearance: string
  /**
   * 玩家头像（data URL）。
   * 之前它只存在于 session store 里，游戏界面从来没读过 ——
   * 于是「上传了头像但游戏里看不到」。这里存一份供状态栏渲染。
   */
  playerAvatar?: string

  // Anti-Railroading
  turnsSinceLastMajorEvent: number

  // Actions
  /** 用世界卡初始化数值体系；开局前调用（会**重置**数值） */
  initFromWorld: (world: WorldCard) => void
  /**
   * 把世界卡的**定义**同步进来（属性 / 资源），**只补不改**。
   *
   * ## 为什么需要它（B5：世界状态与世界卡分离）
   *
   * `attributeDefs` / `resourceDefs` 原先只在**开局那一刻**由 `initFromWorld()`
   * 拷进来一份，之后就是一份**冻结的快照** —— 玩家在卡片编辑器里给世界加了一个属性，
   * 正在进行的这一局**看不到它**，必须重开一局才生效。
   *
   * 根子上是"世界定义"与"这一局的进度"混在了一个 store 里。现在明确：
   * **真源是世界卡**（`session.world`），下面这两个字段只是为了让渲染与结算
   * 少绕一层而留的**缓存**，世界卡一变就刷新它。
   *
   * ⚠️ 与 `initFromWorld` 的语义差别：那个是"开档，一切从头"，
   * 这个是"卡改了，把定义追上来"—— **绝不重置已有的数值**。
   */
  syncWorldDefs: (world: WorldCard) => void
  setPlayerProfile: (name: string, gender: string, appearance: string, avatar?: string) => void
  incrementTurnCounter: () => void
  resetTurnCounter: () => void

  setResources: (resources: ResourceMap) => void
  modifyResource: (key: string, amount: number) => void
  setAspects: (aspects: AspectState) => void
  addItem: (item: Item) => void
  removeItem: (itemId: string) => void
  addCharacter: (character: Character) => void
  updateCharacter: (id: string, updates: Partial<Character>) => void
  addLocationInfo: (location: LocationInfo) => void
  addRite: (rite: Rite) => void
  addLanguage: (language: Language) => void
  unlockDoor: (door: string) => void
  addTag: (tag: string) => void
  setLocation: (location: string) => void
  /** 切换场景背景；传 undefined 表示回到默认（无背景） */
  setScene: (sceneId?: string) => void
  setTime: (time: Partial<GameTime>) => void
  advanceTime: (minutes: number) => void
  setIdentity: (identity: string) => void
  addHistory: (message: ChatMessage) => void
  /** 清空对话历史（换卡重开用） */
  clearHistory: () => void
  updateSummary: (summary: string) => void
  /**
   * 用增量补丁更新三层记忆。
   *
   * 走 `mergeMemory`（并集 + 同人覆盖）而不是整体替换，理由见 utils/memory.ts ——
   * 模型漏写一层不能让那一层永久消失。
   */
  patchMemory: (patch: MemoryPatch) => void
  /** 每轮结束时机械记账：往时间线追加一条"这一轮发生了什么" */
  appendTimeline: (turn: number, text: string) => void

  // —— B8：回溯 ——
  /**
   * 每轮结束时拍一张快照。占用与取舍见 `TurnSnapshot` 的注释。
   *
   * 只在**一轮真正结束**时调用（叙事 + 结算都完成），
   * 半途失败的一轮不留快照 —— 否则回溯会退回到一个"数据结算没跑"的残缺状态。
   *
   * @param playerAction 这一轮玩家输入的行动原文（存进快照，供回溯界面显示）。
   *                     可以不传（开局那一轮就没有玩家输入）。
   */
  pushTurnSnapshot: (turn: number, playerAction?: string) => void
  /**
   * 回滚到第 `turnIndex` 轮**结束时**的状态。
   *
   * 轮次编号以"第几条 assistant 消息"为准（见 `countTurns`），
   * 因为那是玩家心里的"第几轮"：他看见的每一段叙事算一轮。
   *
   * 回滚范围 = `TurnSnapshot` 里那几项；世界卡定义（属性/资源体系）不动。
   * 找不到该轮的快照时**什么都不做**并返回 false，绝不猜一个近似状态 ——
   * 半对的回滚比不回滚更伤（玩家会以为回滚成功了）。
   */
  rewindTo: (turnIndex: number) => boolean
  startGame: () => void
  resetGame: () => void
  returnToTitle: () => void

  // Story Actions
  setStoryState: (state: Partial<StoryState>) => void
  completeEvent: (eventId: string) => void
  setOrigin: (origin: string | null) => void
  addFact: (fact: string | Fact) => void
  markBookAsRead: (bookId: string) => void
  markLoreAsMastered: (lore: string | Lore) => void
  setCurrentOptions: (options: any[]) => void

  // Snapshot Actions
  lastStateSnapshot: any | null
  saveSnapshot: () => void
  restoreSnapshot: () => void

  /** 按轮次索引的回溯快照（B8），升序 */
  turnSnapshots: TurnSnapshot[]
}

/** 没有任何世界卡时的兜底数值体系（保证 UI 不会空掉） */
export const FALLBACK_ATTRIBUTES: AttributeDef[] = [
  { id: 'might', name: '武力', description: '体魄、搏斗与威慑', color: '#ef4444' },
  { id: 'wits', name: '智识', description: '推理、学识与观察', color: '#3b82f6' },
  { id: 'charm', name: '魅力', description: '言辞、共情与影响力', color: '#a855f7' },
]

export const FALLBACK_RESOURCES: ResourceDef[] = [
  { id: 'health', name: '生命', initial: 5, max: 5, color: '#ef4444', critical: true },
  { id: 'energy', name: '精力', initial: 5, max: 5, color: '#eab308' },
]

function emptyMap(defs: { id: string }[]): Record<string, number> {
  return defs.reduce<Record<string, number>>((acc, d) => {
    acc[d.id] = 0
    return acc
  }, {})
}

function resourceMap(defs: ResourceDef[]): ResourceMap {
  return defs.reduce<ResourceMap>((acc, d) => {
    acc[d.id] = d.initial
    return acc
  }, {})
}

const INITIAL_STATE = {
  attributeDefs: FALLBACK_ATTRIBUTES,
  resourceDefs: FALLBACK_RESOURCES,
  resources: resourceMap(FALLBACK_RESOURCES),
  aspects: emptyMap(FALLBACK_ATTRIBUTES),
  inventory: [],
  lores: [],
  rites: [],
  languages: [],
  characters: [],
  locations: [],
  unlockedDoors: [],
  stage: 'init',
  location: '',
  sceneId: undefined,
  time: {
    year: 1,
    month: 1,
    day: 1,
    hour: 9,
    minute: 0
  },
  identity: '',
  history: [],
  summary: '',
  memory: emptyMemory(),
  tags: [],
  isGameStarted: false,
  currentOptions: [],
  knownFacts: [],
  facts: [],
  readBooks: [],
  masteredLores: [],
  lastStateSnapshot: null,
  turnSnapshots: [],
  lastUsage: null,
  sessionUsage: EMPTY_USAGE,
  story: {
    currentChapter: 1,
    completedEvents: [],
    activeEventId: null,
    flags: {},
    origin: null,
    childhood: null,
    uniqueTrait: null
  },
  playerName: '',
  playerGender: '',
  playerAppearance: '',
  playerAvatar: undefined,
  turnsSinceLastMajorEvent: 0
}

export const useGameStore = create<GameState>()(
  persist(
    (set) => ({
      ...INITIAL_STATE,

      initFromWorld: (world) => set(() => {
        const attributeDefs = world.attributes.length ? world.attributes : FALLBACK_ATTRIBUTES;
        const resourceDefs = world.resources.length ? world.resources : FALLBACK_RESOURCES;
        return {
          attributeDefs,
          resourceDefs,
          aspects: emptyMap(attributeDefs),
          resources: resourceMap(resourceDefs)
        };
      }),

      syncWorldDefs: (world) => set((state) => {
        const attributeDefs = world.attributes?.length ? world.attributes : FALLBACK_ATTRIBUTES;
        const resourceDefs = world.resources?.length ? world.resources : FALLBACK_RESOURCES;

        // 世界卡新增的属性补 0、新增的资源补初始值
        const aspects = { ...state.aspects };
        for (const d of attributeDefs) if (aspects[d.id] === undefined) aspects[d.id] = 0;
        const resources = { ...state.resources };
        for (const d of resourceDefs) if (resources[d.id] === undefined) resources[d.id] = d.initial;

        /*
          被世界卡**删掉**的属性/资源，数值原地留着不清理。
          理由：那是玩家的进度，而"定义"已经不在 `defs` 里了 ——
          渲染与结算都按 defs 走，孤儿值不会露出来；可万一玩家把属性改回来
          （编辑器里手滑删了又加），进度还在，不用从零开始。
        */
        return { attributeDefs, resourceDefs, aspects, resources };
      }),

      setPlayerProfile: (name, gender, appearance, avatar) => set({ playerName: name, playerGender: gender, playerAppearance: appearance, playerAvatar: avatar }),
      incrementTurnCounter: () => set((state) => ({ turnsSinceLastMajorEvent: state.turnsSinceLastMajorEvent + 1 })),
      resetTurnCounter: () => set({ turnsSinceLastMajorEvent: 0 }),

      setResources: (res) => set((state) => ({ resources: { ...state.resources, ...res } })),
      modifyResource: (key, amount) => set((state) => {
        const def = state.resourceDefs.find(d => d.id === key);
        let next = (state.resources[key] ?? 0) + amount;
        // 有上限的资源不允许溢出；下限统一为 0
        if (def && typeof def.max === 'number') next = Math.min(next, def.max);
        next = Math.max(0, next);
        return { resources: { ...state.resources, [key]: next } };
      }),
      setAspects: (aspects) => set((state) => ({ aspects: { ...state.aspects, ...aspects } })),

      addItem: (item) => set((state) => {
        const existingItemIndex = state.inventory.findIndex(i => i.id === item.id);
        if (existingItemIndex >= 0) {
          const newInventory = [...state.inventory];
          newInventory[existingItemIndex] = item;
          return { inventory: newInventory };
        }
        return { inventory: [...state.inventory, item] };
      }),
      removeItem: (itemId) => set((state) => ({ inventory: state.inventory.filter(i => i.id !== itemId) })),
      addCharacter: (char) => set((state) => {
        // 同一个角色可能被 AI 反复 ADD_CHARACTER，按 id 合并而不是堆重复条目
        const idx = state.characters.findIndex(c => c.id === char.id);
        if (idx >= 0) {
          const next = [...state.characters];
          next[idx] = { ...next[idx], ...char };
          return { characters: next };
        }
        return { characters: [...state.characters, char] };
      }),
      updateCharacter: (id, updates) => set((state) => ({
        characters: state.characters.map(c => c.id === id ? { ...c, ...updates } : c)
      })),
      addLocationInfo: (loc) => set((state) => {
        const existingIndex = state.locations.findIndex(l => l.id === loc.id);
        if (existingIndex >= 0) {
          const newLocations = [...state.locations];
          newLocations[existingIndex] = { ...newLocations[existingIndex], ...loc };
          return { locations: newLocations };
        }
        return { locations: [...state.locations, loc] };
      }),
      addRite: (rite) => set((state) => ({ rites: [...state.rites, rite] })),
      addLanguage: (lang) => set((state) => ({ languages: [...state.languages, lang] })),
      unlockDoor: (door) => set((state) => ({ unlockedDoors: [...state.unlockedDoors, door] })),
      addTag: (tag) => set((state) => ({
        tags: state.tags.includes(tag) ? state.tags : [...state.tags, tag]
      })),
      setLocation: (loc) => set({ location: loc }),
      setScene: (sceneId) => set({ sceneId }),
      setTime: (time) => set((state) => ({ time: { ...state.time, ...time } })),
      advanceTime: (minutes) => set((state) => {
        const newTime = { ...state.time };
        newTime.minute += minutes;
        while (newTime.minute >= 60) {
          newTime.minute -= 60;
          newTime.hour += 1;
        }
        while (newTime.minute < 0) {
          newTime.minute += 60;
          newTime.hour -= 1;
        }
        while (newTime.hour >= 24) {
          newTime.hour -= 24;
          newTime.day += 1;
        }
        while (newTime.hour < 0) {
          newTime.hour += 24;
          newTime.day -= 1;
        }
        // 简化历法：按 30 天一个月推进（世界卡可自行定义纪元，这里只保证单调递增）
        while (newTime.day > 30) {
          newTime.day -= 30;
          newTime.month += 1;
        }
        while (newTime.day < 1) {
          newTime.day += 30;
          newTime.month -= 1;
        }
        while (newTime.month > 12) {
          newTime.month -= 12;
          newTime.year += 1;
        }
        while (newTime.month < 1) {
          newTime.month += 12;
          newTime.year -= 1;
        }
        return { time: newTime };
      }),
      setIdentity: (identity) => set({ identity }),
      addHistory: (msg) => set((state) => ({ history: [...state.history, msg] })),
      clearHistory: () => set({
        history: [],
        summary: '',
        // 记忆与快照是**与历史绑定**的：清了历史却留着它们，
        // 下一局的开局会把上一局的关系与时间线当成"前情"注入
        memory: emptyMemory(),
        turnSnapshots: [],
        currentOptions: [],
      }),
      updateSummary: (summary) => set({ summary }),
      patchMemory: (patch) => set((state) => ({ memory: mergeMemory(state.memory, patch) })),
      appendTimeline: (turn, text) => set((state) => ({
        // 与 patchMemory 同一套合并规则，所以同一轮再写一次是**覆盖**而不是追加两条
        memory: appendTimelineBeat(state.memory, turn, text),
      })),
      startGame: () => set({ isGameStarted: true }),
      resetGame: () => set({ ...INITIAL_STATE }),
      returnToTitle: () => set({ isGameStarted: false }),

      setStoryState: (storyUpdate) => set((state) => ({ story: { ...state.story, ...storyUpdate } })),
      completeEvent: (eventId) => set((state) => ({
        story: {
          ...state.story,
          completedEvents: state.story.completedEvents.includes(eventId)
            ? state.story.completedEvents
            : [...state.story.completedEvents, eventId],
          activeEventId: null
        }
      })),
      setOrigin: (origin) => set((state) => ({ story: { ...state.story, origin } })),
      addFact: (fact) => set((state) => {
        const factId = typeof fact === 'string' ? fact : fact.id;
        if (state.knownFacts.includes(factId)) {
          // 已知线索但这次带来了更完整的对象 → 更新描述
          if (typeof fact !== 'string') {
            const idx = state.facts.findIndex(f => f.id === factId);
            if (idx >= 0) {
              const next = [...state.facts];
              next[idx] = { ...next[idx], ...fact };
              return { facts: next };
            }
            return { facts: [...state.facts, fact] };
          }
          return state;
        }

        const newFacts = typeof fact === 'string' ? state.facts : [...state.facts, fact];

        return {
          knownFacts: [...state.knownFacts, factId],
          facts: newFacts
        };
      }),
      markBookAsRead: (bookId) => set((state) => {
        if (state.readBooks.includes(bookId)) return state;
        return { readBooks: [...state.readBooks, bookId] };
      }),
      markLoreAsMastered: (lore) => set((state) => {
        const loreId = typeof lore === 'string' ? lore : lore.id;
        if (state.masteredLores.includes(loreId)) return state;

        const newLores = typeof lore === 'string' ? state.lores : [...state.lores, lore];

        return {
          masteredLores: [...state.masteredLores, loreId],
          lores: newLores
        };
      }),
      setCurrentOptions: (options) => set({ currentOptions: options }),

      // —— C9：成本可见 ——
      recordUsage: (usage) => set((state) => ({
        lastUsage: addUsage(state.lastUsage || EMPTY_USAGE, usage),
        sessionUsage: addUsage(state.sessionUsage || EMPTY_USAGE, usage),
      })),
      clearLastUsage: () => set({ lastUsage: null }),
      // 复制一份而不是直接写 EMPTY_USAGE：共享同一个对象引用时，
      // 任何一处误改都会污染"零值"这个全局常量
      resetSessionUsage: () => set({ sessionUsage: { ...EMPTY_USAGE }, lastUsage: null }),

      // —— B8：回溯 ——
      pushTurnSnapshot: (turn, playerAction) => set((state) => {
        const turnIndex = Math.max(1, Math.floor(turn) || 1)
        const historyLength = state.history.length
        const prev = state.turnSnapshots.length
          ? state.turnSnapshots[state.turnSnapshots.length - 1]
          : null

        /*
          上一轮那份快照声称的长度如果比现在还长，说明**历史被外部截短过**
          （手动清史、导入存档、旧版归档……）。那些旧快照描述的历史已经不存在了，
          留着它们会让重放整体错位（校验会一路失败）。
          直接丢弃整条链、从现在重新开始 —— 代价是"更早的轮回不去了"，
          而那本来就已经是事实（历史都不在了）。
        */
        const truncated = !!prev && prev.historyLength > historyLength
        const base = truncated ? [] : state.turnSnapshots

        /*
          ⚠️ 起算点用**上一轮快照记录的绝对长度**，绝不能用 `slice(-2)` 之类的写法。
          一轮里 history 到底追加几条**是不确定的**：玩家的行动 + AI 的叙事，
          再加上 handleStateChanges 写的那一条「状态变更」系统消息（0~1 条），
          有时甚至只有叙事的 1 条（开局那一轮没有玩家行动）、
          或者一条都没有（重复提交同一轮）。用固定条数去切，
          短的那一轮会把上一轮的叙事**重复计入**，重放出来的历史就多出一段。
        */
        const start = truncated ? 0 : (prev?.historyLength ?? 0)
        const historyDelta = historyLength > start ? state.history.slice(start) : []

        /*
          深拷贝仍然必要：`characters` 里的元素、`story.flags` 这类嵌套对象
          会被 AI 就地合并（UPDATE_CHARACTER），只存引用的话快照会**跟着未来一起变**，
          回溯就成了"回到现在"。JSON 往返是最省事且够用的深拷贝（全是纯 JSON 值）。
        */
        const snapshot = JSON.parse(JSON.stringify({
          turn: turnIndex,
          playerAction: typeof playerAction === 'string' && playerAction.trim() ? playerAction.trim() : undefined,
          historyDelta,
          historyLength,
          summary: state.summary,
          memory: state.memory,
          resources: state.resources,
          aspects: state.aspects,
          inventory: state.inventory,
          characters: state.characters,
          lores: state.lores,
          rites: state.rites,
          languages: state.languages,
          locations: state.locations,
          unlockedDoors: state.unlockedDoors,
          knownFacts: state.knownFacts,
          facts: state.facts,
          readBooks: state.readBooks,
          masteredLores: state.masteredLores,
          tags: state.tags,
          story: state.story,
          time: state.time,
          identity: state.identity,
          location: state.location,
          sceneId: state.sceneId,
          stage: state.stage,
          currentOptions: state.currentOptions,
          turnsSinceLastMajorEvent: state.turnsSinceLastMajorEvent,
        })) as TurnSnapshot

        const kept = base.filter(s => s.turn !== turnIndex)
        kept.push(snapshot)
        kept.sort((a, b) => a.turn - b.turn)
        return {
          // 只留最近 MAX_TURN_SNAPSHOTS 轮：这是"退几步"的功能，不是无限时间旅行
          turnSnapshots: kept.slice(-MAX_TURN_SNAPSHOTS),
        }
      }),

      rewindTo: (turnIndex) => {
        let ok = false
        /*
          用 set 回调里的 state 找快照（而不是 useGameStore.getState()）：
          后者是**在 store 自己的初始化表达式里引用 store 自身**，
          TypeScript 会因此推断出循环类型，把整个 store 的类型变成 any ——
          然后所有消费方（组件、hook）的 infer 全部塌掉（实测报了 60 多处 TS7006）。
          set 回调里的 state 就是"此刻"的状态，语义完全一样。
        */
        set((state) => {
          const target = state.turnSnapshots.find(s => s.turn === turnIndex)
          if (!target) return state

          const history = replayHistory(state.turnSnapshots, turnIndex, state.history)
          // 重放不出来的（快照链断了一环）宁可什么都不做，也不拿错位的历史冒充过去
          if (!history) return state

          ok = true
          return {
            ...snapshotToState(target, history),
            // 快照按轮次升序，切片即可丢掉"被取消的未来"
            turnSnapshots: state.turnSnapshots.filter(s => s.turn <= turnIndex),
            // 回溯后不存在"上一轮快照"这种东西了：留着它会让"重新生成"
            // 把状态还原到**回滚之前**的那一轮
            lastStateSnapshot: null,
            isGameStarted: true,
          }
        })
        return ok
      },

      saveSnapshot: () => set((state) => {
        const snapshot = {
          resources: state.resources,
          aspects: state.aspects,
          inventory: state.inventory,
          lores: state.lores,
          rites: state.rites,
          languages: state.languages,
          characters: state.characters,
          locations: state.locations,
          unlockedDoors: state.unlockedDoors,
          stage: state.stage,
          location: state.location,
          time: state.time,
          identity: state.identity,
          history: state.history,
          summary: state.summary,
          // 记忆也必须进"重新生成"的快照：否则重试时叙事退回了，
          // 而关系/时间线还留着上一次生成的内容（玩家会看到两套事实并存）
          memory: state.memory,
          tags: state.tags,
          story: state.story,
          currentOptions: state.currentOptions,
          isGameStarted: state.isGameStarted,
          knownFacts: state.knownFacts,
          facts: state.facts,
          readBooks: state.readBooks,
          masteredLores: state.masteredLores
        };
        return { lastStateSnapshot: JSON.parse(JSON.stringify(snapshot)) };
      }),

      restoreSnapshot: () => set((state) => {
        if (!state.lastStateSnapshot) return state;
        const restored = { ...state.lastStateSnapshot, lastStateSnapshot: null };
        /*
          连同快照一起把"指向未来"的轮次快照裁掉。
          "重新生成"会把 history 退回上一轮之前，而 turnSnapshots 里还留着
          那一轮的快照 —— 那份快照对应的历史已经不存在了，
          留着它会让回溯下拉里出现一个**点不动的选项**（点了什么都不发生）。
        */
        const turns = countTurns(restored.history ?? state.history)
        return {
          ...restored,
          turnSnapshots: state.turnSnapshots.filter(s => s.turn <= turns),
        };
      })
    }),
    {
      name: 'pale-notes-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => {
        // 不持久化 isGameStarted，保证刷新后总是回到标题页；世界卡配置由 session store 从 IndexedDB 恢复
        // lastUsage 只是"上一轮"的瞬时数字（刷新后没有"上一轮"了），
        // 连同 lastStateSnapshot 一起排除；sessionUsage / memory / turnSnapshots
        // 则必须落盘 —— 它们就是存档本身的一部分。
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { isGameStarted, lastStateSnapshot, lastUsage, ...rest } = state
        return rest
      }
    }
  )
)
