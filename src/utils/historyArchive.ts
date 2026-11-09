/**
 * 叙事历史的归档与裁剪
 *
 * 问题（真实会发生，而且静默）：
 *  localStorage 配额约 5MB，而 `game` store 的 `history` 是**全量**持久化的。
 *  长局（几百轮）必然撞上限；撞上之后 `setItem` 抛 QuotaExceededError，
 *  而 zustand 的 persist 中间件**不会把它冒到界面上** ——
 *  表现为「存档突然不再更新」，玩家以为还在存，实际早就没存了。
 *
 *  上一版只加了「接近上限就警告」，那只是把问题告诉用户，没解决问题。
 *  这里做真正的处理：**把较旧的叙事归档到 IndexedDB**，localStorage 只留最近的一段。
 *
 *  为什么是"归档"而不是"删除"：
 *  玩家玩了 300 轮，前面 250 轮是这段故事的组成部分。直接丢掉等于销毁他的创作。
 *  IndexedDB 的配额按磁盘算（通常几百 MB 起），放这些文本绰绰有余。
 */

import { createKVStore } from '@/utils/idb'

/** 专用一个 KV store，避免与卡片库互相干扰 */
const archiveStore = createKVStore('deng-xu-archive', 'history')

/** 热数据保留的条数：localStorage 里只留最近这么多轮 */
export const HOT_HISTORY_LIMIT = 120

/** 单条消息超过这个长度就认为是大块叙事，算配额时按实际长度计 */
const ARCHIVE_KEY = 'history-archive'

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  /** 思维链（与 `ChatMessage.reasoning` 同源；归档时一起带走，回看才不会只剩正文） */
  reasoning?: string
  timestamp?: number
}

export interface ArchiveState {
  /** 已归档的消息（按时间升序，接在热数据之前） */
  messages: HistoryMessage[]
  /** 归档时间 */
  archivedAt: number
}

/** 读取归档（读不到就返回空，不抛错） */
export async function loadArchive(): Promise<ArchiveState> {
  try {
    const v = await archiveStore.get<ArchiveState>(ARCHIVE_KEY)
    if (v && Array.isArray(v.messages)) return v
  } catch {
    /* IndexedDB 不可用（隐私模式等）——退回空归档 */
  }
  return { messages: [], archivedAt: 0 }
}

/** 写入归档 */
export async function saveArchive(archive: ArchiveState): Promise<boolean> {
  try {
    await archiveStore.set(ARCHIVE_KEY, archive)
    return true
  } catch {
    return false
  }
}

export async function clearArchive(): Promise<void> {
  try {
    await archiveStore.set(ARCHIVE_KEY, { messages: [], archivedAt: Date.now() })
  } catch {
    /* 忽略 */
  }
}

/**
 * 判断是否需要归档。
 * @param history 当前热历史
 * @param force   体积已吃紧，直接归档（不再等到两倍阈值）
 */
export function needsArchive(history: HistoryMessage[], force = false): boolean {
  if (force) return history.length > HOT_HISTORY_LIMIT / 2
  return history.length > HOT_HISTORY_LIMIT * 2
}

/**
 * 执行归档：把超出保留量的旧消息移进归档。
 *
 * @param history 当前热历史
 * @param pressure 体积是否已经吃紧。吃紧时**只保留更少的热数据**（压到一半），
 *                 否则按体积触发却只裁掉几条，下一轮马上又触发 —— 白折腾。
 *
 * 返回新的热历史与归档结果。**不修改传入数组**（zustand 要引用变化）。
 */
export async function archiveOldMessages(
  history: HistoryMessage[],
  pressure = false
): Promise<{ hot: HistoryMessage[]; archived: number; ok: boolean }> {
  // 体积吃紧时把热数据压到一半，给后续几轮留出余量
  const keep = pressure ? Math.max(20, Math.floor(HOT_HISTORY_LIMIT / 2)) : HOT_HISTORY_LIMIT
  if (history.length <= keep) {
    return { hot: history, archived: 0, ok: true }
  }

  const cut = history.length - keep
  const toArchive = history.slice(0, cut)
  const hot = history.slice(cut)

  const prev = await loadArchive()
  const merged: ArchiveState = {
    messages: [...prev.messages, ...toArchive],
    archivedAt: Date.now(),
  }

  const ok = await saveArchive(merged)
  if (!ok) {
    // 归档失败就**不要裁剪** —— 否则等于直接销毁玩家的历史。
    // 宁可继续撑在 localStorage 里，让容量警告去提示用户导出备份。
    return { hot: history, archived: 0, ok: false }
  }

  return { hot, archived: toArchive.length, ok: true }
}

/**
 * 把归档拼回热历史前面，**去掉两者可能重叠的那一段**。
 *
 * 为什么会有重叠：归档是定时发生的，同一批消息可能在归档之后又被写进
 * 热历史（导入存档、回溯后重玩）。直接相加会出现同一段正文连着两遍。
 *
 * 去重方式：找"归档的后缀 == 热历史的前缀"的最长公共段，从热历史里切掉。
 * 只按 `content` 比 —— 时间戳在归档往返里可能被 JSON 规整过。
 */
export function mergeArchivedHistory(
  archived: HistoryMessage[],
  hot: HistoryMessage[],
): HistoryMessage[] {
  if (!archived.length) return hot
  if (!hot.length) return archived

  const max = Math.min(archived.length, hot.length)
  for (let k = max; k > 0; k--) {
    let same = true
    for (let i = 0; i < k; i++) {
      if (archived[archived.length - k + i]?.content !== hot[i]?.content) { same = false; break }
    }
    if (same) return [...archived, ...hot.slice(k)]
  }
  return [...archived, ...hot]
}

/**
 * 估算把历史写进 localStorage 的体积（UTF-16，约等于字符数 × 2）。
 * 用于在真正触发配额错误之前就先动手归档。
 */
export function estimateHistoryBytes(history: HistoryMessage[]): number {
  try {
    return JSON.stringify(history).length * 2
  } catch {
    return 0
  }
}

/** 当前存档占用是否已经危险（需要立刻归档） */
export function isHistoryPressureHigh(history: HistoryMessage[]): boolean {
  // 单 history 字段超过 2.5MB 就该动手了（总配额 5MB，还有别的 store 要写）
  return estimateHistoryBytes(history) > 2.5 * 1024 * 1024
}
