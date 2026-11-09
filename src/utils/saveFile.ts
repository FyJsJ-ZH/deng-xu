/**
 * 存档导出 / 导入 / 容量检测
 *
 * 为什么必须做：
 *  1. 存档只在本机 localStorage。清缓存、换设备、换浏览器就全丢 ——
 *     几十轮的长局代价极高，而用户没有任何自救手段。
 *  2. localStorage 配额约 5MB，而叙事历史是全量留在里面的。
 *     玩到一定长度后**写入会静默失败**（QuotaExceededError 被中间件吞掉），
 *     表现为「存档突然不再保存」且毫无提示。这是最坏的一类 bug：
 *     用户以为还在存档，实际早就没存了。
 *
 * 所以这里做三件事：
 *  - 导出成 JSON 文件（可换设备恢复、可备份）
 *  - 导入时校验并给出人类可读的失败原因
 *  - 估算当前占用并在接近配额时明确警告（而不是静默丢数据）
 */

import { downloadFile, safeFilename, timestampSuffix } from '@/utils/files'
import { loadArchive, saveArchive, clearArchive, type ArchiveState } from '@/utils/historyArchive'
import { isOpeningSnapshot } from '@/stores/game'

/** 存档文件格式版本。将来结构变化时靠它做迁移。 */
export const SAVE_FORMAT = 'deng-xu-save'
export const SAVE_VERSION = 1

/** localStorage 里各 store 的键名（与各 store 的 persist name 对应） */
export const STORAGE_KEYS = {
  game: 'pale-notes-storage',        // stores/game.ts
  session: 'pale-notes-session',     // stores/session.ts
  ui: 'pale-notes-ui',               // stores/ui.ts
  meta: 'pale-notes-meta',           // stores/meta.ts
} as const

/**
 * 导入 `game` store 时的**一致性修补**（B8 回溯引入）。
 *
 * 为什么需要：回溯（`gameStore.rewindTo`）会把 history 截短到第 N 轮，
 * 同时把 N 轮之后的回溯快照丢掉。但存档文件是**先导出、后导入**的 ——
 * 用户手上那份 JSON 完全可能比当前状态"旧"，于是导入后出现
 * “快照轮次 > 历史轮次”这种不自洽：
 *
 *  - `memory.timeline` 里记着第 12 轮，而 history 只剩 5 轮
 *    → 模型会把玩家**已经取消的未来**当成发生过的事写进叙事；
 *  - `turnSnapshots` 停留在被回滚掉的轮次上 → 玩家再点回溯会跳到未来。
 *
 * 处理方式是**按历史的轮次上限做裁剪**，而不是把整份存档判为损坏：
 * 旧存档（完全没有这几个字段）走的也是这条路径，天然向后兼容，
 * 不需要动 `SAVE_VERSION`（动版本号会把所有旧存档挡在门外，代价太大）。
 *
 * ⚠️ 归档（IndexedDB 里的旧叙事）这里**不动**：它与 history 的对应关系
 * 无法从文件里精确还原（归档是定时发生的，没有记录切割点）。
 * 若归档比 history 更长，`loadArchive` 那边有版本护栏会给出明确报错，
 * 而不是静默拼出错误的故事 —— 宁可让用户看到"这份存档不自洽"，
 * 也不要让两段时间线悄悄混在一起。
 */
export function reconcileGameState(state: any): any {
  if (!state || typeof state !== 'object') return state

  const history: any[] = Array.isArray(state.history) ? state.history : []
  // 轮次 = assistant 消息条数（与 stores/game.ts 的 countTurns 同一口径）
  const turns = history.filter(h => h?.role === 'assistant').length

  const next: any = { ...state }

  if (Array.isArray(state.turnSnapshots)) {
    /*
      turn 0（开局锚点）**不能按轮次上限过滤**：它描述的是"第一幕生成之前"，
      和 `turns` 没有关系。原先这里一刀切 `s.turn > 0`，把所有存档的
      「回到开局」都过滤掉了 —— 老存档本来就没有它，新存档又被这一刀砍掉，
      于是这个功能对**每一份导入的存档**都是失效的。

      但也不能无条件收下：`isOpeningSnapshot` 会挡掉"用中局状态冒充开局"的
      假锚点（`historyLength > 0`）。这种快照一旦被还原，玩家会看到
      「回到开局」之后接着第 N 轮往下写。
    */
    next.turnSnapshots = state.turnSnapshots.filter((s: any) => {
      if (!s || typeof s.turn !== 'number') return false
      if (s.turn === 0) return isOpeningSnapshot(s)
      return s.turn > 0 && s.turn <= turns
    })
  } else {
    /*
      旧存档（A1/B8 之前的版本）里没有这个字段。
      这里**必须补一个空数组**而不是留着 undefined：zustand 的 persist 只覆盖
      存档里出现过的键，缺字段会原样留在 state 上，而 UI 会直接读
      `.turnSnapshots.map(...)` → 导入旧存档后整个游戏界面崩掉。
    */
    next.turnSnapshots = []
  }

  const mem = state.memory
  if (mem && typeof mem === 'object') {
    next.memory = {
      ...mem,
      // 只丢"指向未来"的时间线拍子，已经积累的关系与线索原样保留
      timeline: Array.isArray(mem.timeline)
        ? mem.timeline.filter((b: any) => !b || typeof b.turn !== 'number' || b.turn <= turns)
        : [],
    }
  } else {
    // 同上：旧存档没有记忆层，补一个结构完整的空记忆，
    // 让 renderMemoryForPrompt / normalizeMemory 拿到的东西一定是合法的
    next.memory = { bonds: [], threads: [], timeline: [], earlierSummary: '', updatedAtTurn: 0 }
  }

  if (!state.sessionUsage || typeof state.sessionUsage !== 'object') {
    next.sessionUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false }
  }

  return next
}

/**
 * 注意：`stores/library.ts`（世界卡 / 角色卡库）**没有用 persist** ——
 * 它的持久化走 IndexedDB（见 utils/idb.ts），因为卡片里的头像与封面是 base64，
 * localStorage 的 5MB 配额顶不住。
 *
 * 所以导出存档只覆盖上面四个 localStorage store。
 * IndexedDB 里的卡片库**不在本文件范围内** —— 这也是为什么卡片库本身
 * 一直有独立于存档的导出/导入（见 CardEditor 的「导出」按钮）。
 */

export interface SaveFile {
  format: typeof SAVE_FORMAT
  version: number
  exportedAt: string
  /** 便于用户辨认：世界名 / 主角名 / 轮数 */
  meta: {
    worldTitle?: string
    playerName?: string
    messageCount?: number
    /** 最后一次游玩时间（若存档里有） */
    savedAt?: string
  }
  /** 原始 store 数据，键为 STORAGE_KEYS 里的名字 */
  data: Record<string, unknown>
  /**
   * 已归档的旧叙事（存在 IndexedDB 里，不在 localStorage）。
   *
   * 必须一起导出：长局会把大部分历史归档出去，只备份 localStorage
   * 等于备份了一个缺了前 200 轮的故事。导入时也要一并还原。
   */
  archive?: ArchiveState
}

// ============================================================================
// 导出
// ============================================================================

function readStore(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return undefined
    const parsed = JSON.parse(raw)
    // zustand persist 的结构是 { state: {...}, version: n }
    return parsed
  } catch {
    return undefined
  }
}

/** 收集当前存档（缺失的 store 不写入，避免导入时把好的覆盖成空的） */
export async function collectSave(): Promise<SaveFile> {
  const data: Record<string, unknown> = {}
  for (const key of Object.values(STORAGE_KEYS)) {
    const v = readStore(key)
    if (v !== undefined) data[key] = v
  }

  // 归档也要带上（长局的历史大部分在这里）
  let archive: ArchiveState | undefined
  try {
    const a = await loadArchive()
    if (a.messages.length) archive = a
  } catch { /* 读不到就不带，不影响主流程 */ }

  // 尽量抽出可读的元信息，方便用户在一堆文件里认出是哪一局
  let worldTitle: string | undefined
  let playerName: string | undefined
  let messageCount: number | undefined
  let savedAt: string | undefined
  try {
    const g = (data[STORAGE_KEYS.game] as any)?.state
    playerName = g?.playerName || undefined
    // 字段名是 history（不是 narrativeMessages —— 我在第一版里猜错了，
    // 结果元信息里的条数一直是 undefined，导出的文件名也少了这个线索）
    const hot = Array.isArray(g?.history) ? g.history.length : 0
    messageCount = hot + (archive?.messages.length || 0)
    savedAt = g?.lastPlayedAt || g?.savedAt || undefined
    const s = (data[STORAGE_KEYS.session] as any)?.state
    worldTitle = s?.world?.title || undefined
  } catch { /* 元信息只是锦上添花，失败不影响导出 */ }

  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    exportedAt: new Date().toISOString(),
    meta: { worldTitle, playerName, messageCount, savedAt },
    data,
    ...(archive ? { archive } : {}),
  }
}

/** 导出为文件 */
export async function exportSave(): Promise<{ bytes: number; filename: string }> {
  const save = await collectSave()
  const json = JSON.stringify(save, null, 2)
  const bytes = new Blob([json]).size
  const base = [save.meta.worldTitle, save.meta.playerName].filter(Boolean).join('-') || '存档'
  const filename = `${safeFilename(base)}-${timestampSuffix()}.dengxu.json`
  downloadFile(filename, save)
  return { bytes, filename }
}

// ============================================================================
// 导入
// ============================================================================

export interface ImportResult {
  ok: boolean
  /** 人类可读的失败原因 */
  error?: string
  meta?: SaveFile['meta']
  /** 写入了哪些 store */
  restored?: string[]
  /** 附带提示（例如归档写入失败） */
  note?: string
}

/** 校验导入内容是否像一份合法存档 */
export function validateSave(input: unknown): ImportResult {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: '文件内容不是有效的 JSON 对象' }
  }
  const s = input as Partial<SaveFile>
  if (s.format !== SAVE_FORMAT) {
    return {
      ok: false,
      error: `这不是「灯叙」的存档文件（format=${String(s.format) || '缺失'}）`,
    }
  }
  if (typeof s.version !== 'number') {
    return { ok: false, error: '存档缺少版本号' }
  }
  if (s.version > SAVE_VERSION) {
    return {
      ok: false,
      error: `存档版本 ${s.version} 比当前程序（${SAVE_VERSION}）新，请先更新页面再导入`,
    }
  }
  if (!s.data || typeof s.data !== 'object') {
    return { ok: false, error: '存档里没有 data 字段' }
  }
  const known = Object.values(STORAGE_KEYS)
  const hasAny = known.some(k => (s.data as Record<string, unknown>)[k] !== undefined)
  if (!hasAny) {
    return { ok: false, error: '存档里没有可识别的数据（可能来自其他程序）' }
  }
  return { ok: true, meta: s.meta }
}

/**
 * 写入存档。
 *
 * 关键：**逐个 store 写入并捕获配额错误**。
 * 如果写到一半失败，把已写入的键回滚成原值 —— 否则会出现
 * “game 存进去了、session 没存进去”的撕裂状态，比不导入更糟。
 *
 * 归档（IndexedDB）在 localStorage 写成功之后再写：
 * 它的容量大得多，几乎不会失败；万一失败也只是历史不全，不影响能继续玩。
 */
export async function applySave(save: SaveFile): Promise<ImportResult> {
  const backup = new Map<string, string | null>()
  const written: string[] = []

  try {
    for (const [key, value] of Object.entries(save.data)) {
      if (!Object.values(STORAGE_KEYS).includes(key as any)) continue
      backup.set(key, localStorage.getItem(key))
      // zustand persist 的结构是 { state, version }；只修补 state，version 原样保留，
      // 否则中间的 migrate 会失效
      const patched = key === STORAGE_KEYS.game && value && typeof value === 'object' && 'state' in (value as any)
        ? { ...(value as any), state: reconcileGameState((value as any).state) }
        : value
      localStorage.setItem(key, JSON.stringify(patched))
      written.push(key)
    }
  } catch (err) {
    // 回滚
    for (const [key, old] of backup) {
      try {
        if (old === null) localStorage.removeItem(key)
        else localStorage.setItem(key, old)
      } catch { /* 回滚也失败就只能放弃这一个键 */ }
    }
    const name = (err as Error)?.name || ''
    if (name === 'QuotaExceededError' || /quota/i.test(String(err))) {
      return {
        ok: false,
        error: '本机存储空间不足，导入失败（已还原到导入前的状态）。可先导出并清理旧存档再试。',
      }
    }
    return { ok: false, error: `写入失败：${(err as Error)?.message || err}（已还原）` }
  }

  // 还原归档
  let archiveNote = ''
  if (save.archive) {
    const ok = await saveArchive(save.archive)
    if (!ok) archiveNote = '（归档历史未能写入，但存档主体已恢复）'
  } else {
    // 导入的存档没有归档 → 清掉旧的，避免把上一局的归档混进这一局
    await clearArchive()
  }

  return { ok: true, meta: save.meta, restored: written, note: archiveNote || undefined }
}

/** 从 File 读取并导入 */
export async function importSaveFile(file: File): Promise<ImportResult> {
  let text: string
  try {
    text = await file.text()
  } catch (e) {
    return { ok: false, error: `读取文件失败：${(e as Error)?.message || e}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `文件不是合法 JSON：${(e as Error)?.message || e}` }
  }
  const check = validateSave(parsed)
  if (!check.ok) return check
  return applySave(parsed as SaveFile)
}

// ============================================================================
// 容量
// ============================================================================

export interface UsageInfo {
  /** 估算占用字节 */
  bytes: number
  /** 人类可读 */
  human: string
  /** 各 store 占用（降序） */
  perStore: { key: string; bytes: number }[]
  /** 是否已接近浏览器配额（≥4MB 视为危险，多数浏览器上限 5MB） */
  nearLimit: boolean
  /** 是否已超过危险线 */
  dangerous: boolean
}

export function measureUsage(): UsageInfo {
  const perStore: { key: string; bytes: number }[] = []
  let bytes = 0
  for (const [label, key] of Object.entries(STORAGE_KEYS)) {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) continue
      // localStorage 存的是 UTF-16，实际占用约为字符数 × 2
      const b = raw.length * 2
      perStore.push({ key: label, bytes: b })
      bytes += b
    } catch { /* 读不到就跳过 */ }
  }
  perStore.sort((a, b) => b.bytes - a.bytes)
  const human = bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${Math.round(bytes / 1024)} KB`
  return {
    bytes,
    human,
    perStore,
    nearLimit: bytes >= 4 * 1024 * 1024,
    dangerous: bytes >= 4.5 * 1024 * 1024,
  }
}

/**
 * 探测 localStorage 是否还能写入。
 *
 * 为什么需要：配额耗尽后 setItem 会抛 QuotaExceededError，
 * 而 zustand 的 persist 中间件**不会把它冒到界面上**，
 * 于是存档静默停止更新。这里主动探一次，好在界面上明确警告。
 */
export function canStillWrite(): boolean {
  try {
    const probe = '__dengxu_probe__'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}
