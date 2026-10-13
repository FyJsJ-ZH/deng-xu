/**
 * 世界书（Worldbook）
 *
 * 解决的问题：
 *  内置世界原本是**硬编码在 TypeScript 里的对象**（现为 `src/data/worlds/*.ts`，
 *  八个深度世界合计约 2.5 MB 源码、gzip 约 640 KB）。这带来两个限制：
 *   1. 想扩充或替换内置世界必须改代码、重新构建；
 *   2. 内置世界长得像"程序的一部分"，而不是"一份可以拿走的设定集"。
 *
 * 世界书就是把这个概念显式化：**一本可以独立存在的设定集**，
 * 里面有若干世界卡、出版信息、分类标签，可以导入导出、可以随仓库分发。
 *
 * 与「世界包（worldPack）」的分工：
 *  - 世界包 = 用户自己勾选若干张卡打包，用于备份/分享
 *  - 世界书 = 一份**成套的、有署名的**设定集，通常一次性提供多个世界
 * 两者的 JSON 结构有意做得相近，所以可以直接互转 —— 见 worldbookToPack()。
 */

import type { WorldCard } from '@/types/cards'
import { isSillyTavernLorebook } from '@/utils/stLorebook'

export const WORLDBOOK_FORMAT = 'deng-xu-worldbook'
export const WORLDBOOK_VERSION = 1

export interface WorldbookChapter {
  /** 章节名，例如「冷峻三部曲」 */
  title: string
  /** 一句话说明这一章收的是什么 */
  note?: string
  /** 本章包含的世界卡 id（引用 worlds 里的 id） */
  worldIds: string[]
}

export interface Worldbook {
  format: typeof WORLDBOOK_FORMAT
  version: number
  /** 世界书标题 */
  title: string
  /** 一句话简介 */
  tagline?: string
  /** 更详细的说明（支持换行） */
  description?: string
  /** 编者/作者署名 */
  author?: string
  /** 版本号，例如 "1.0" */
  revision?: string
  /** 分类标签 */
  tags?: string[]
  /** 可选的章节划分；不填时界面直接平铺列出所有世界 */
  chapters?: WorldbookChapter[]
  /** 世界卡本体 */
  worlds: WorldCard[]
}

// ============================================================================
// 导出
// ============================================================================

export interface BuildWorldbookOptions {
  title: string
  tagline?: string
  description?: string
  author?: string
  revision?: string
  tags?: string[]
  worlds: WorldCard[]
  /** 自动按 avatarStyle 或题材分组生成章节 */
  autoChapters?: boolean
}

export function buildWorldbook(opts: BuildWorldbookOptions): Worldbook {
  const { worlds } = opts
  let chapters = undefined as WorldbookChapter[] | undefined

  if (opts.autoChapters && worlds.length > 1) {
    // 按「机制层是否开启」分两章 —— 这是这个引擎最有意义的分类维度，
    // 因为它直接决定玩法形态（数值向 vs 纯叙事向）
    const withMechanics = worlds.filter(w => w.enableMechanics)
    const narrativeOnly = worlds.filter(w => !w.enableMechanics)
    chapters = []
    if (withMechanics.length) {
      chapters.push({
        title: '机制向',
        note: '带属性、资源、物品与线索结算',
        worldIds: withMechanics.map(w => w.id),
      })
    }
    if (narrativeOnly.length) {
      chapters.push({
        title: '纯叙事向',
        note: '关闭数值系统，只做对话与关系',
        worldIds: narrativeOnly.map(w => w.id),
      })
    }
  }

  return {
    format: WORLDBOOK_FORMAT,
    version: WORLDBOOK_VERSION,
    title: opts.title,
    tagline: opts.tagline,
    description: opts.description,
    author: opts.author,
    revision: opts.revision,
    tags: opts.tags,
    chapters,
    worlds,
  }
}

// ============================================================================
// 校验
// ============================================================================

export interface WorldbookParseResult {
  ok: boolean
  error?: string
  /** 校验通过时给出一句话摘要，便于界面提示 */
  summary?: string
  book?: Worldbook
}

export function parseWorldbook(input: unknown): WorldbookParseResult {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: '文件内容不是有效的 JSON 对象' }
  }
  const b = input as Partial<Worldbook>

  if (b.format !== WORLDBOOK_FORMAT) {
    // 友好提示：如果是世界包或存档，告诉用户该走哪个入口
    const f = (b as any).format
    if (f === 'deng-xu-worldpack') {
      return { ok: false, error: '这是「世界包」，请用卡片库里的「导入世界包」。' }
    }
    if (f === 'deng-xu-save') {
      return { ok: false, error: '这是「存档」，请用标题页的「导入存档」。' }
    }
    /*
      SillyTavern 世界书也没有 `format` 字段，所以必须**在报"格式缺失"之前**认出来。
      它不该在这里被解析（映射逻辑在 `utils/stLorebook.ts`），但提示要指对路 ——
      否则用户拿到的是"不是世界书文件（format=缺失）"，而他手里明明是一本世界书。
    */
    if (isSillyTavernLorebook(input)) {
      return { ok: false, error: '这是 SillyTavern 世界书，请用「导入世界包」入口 —— 它会自动转成本作的世界卡。' }
    }
    return { ok: false, error: `不是世界书文件（format=${String(f) || '缺失'}）` }
  }
  if (typeof b.version !== 'number') return { ok: false, error: '世界书缺少版本号' }
  if (b.version > WORLDBOOK_VERSION) {
    return { ok: false, error: `世界书版本 ${b.version} 比当前程序（${WORLDBOOK_VERSION}）新，请先更新页面` }
  }
  if (typeof b.title !== 'string' || !b.title.trim()) {
    return { ok: false, error: '世界书缺少标题' }
  }
  if (!Array.isArray(b.worlds) || b.worlds.length === 0) {
    return { ok: false, error: '世界书里没有世界卡' }
  }

  // 逐张做最低限度校验：没有 id 或标题的卡在列表里无法区分
  const bad = b.worlds.find(w => !w || typeof (w as any).id !== 'string' || typeof (w as any).title !== 'string')
  if (bad) return { ok: false, error: '世界书里有损坏的世界卡（缺少 id 或标题）' }

  // 章节引用了不存在的世界 id → 不致命，但要剔除，否则界面会显示空章节
  const ids = new Set(b.worlds.map(w => w.id))
  const chapters = (b.chapters || []).map(c => ({
    ...c,
    worldIds: (c.worldIds || []).filter(id => ids.has(id)),
  })).filter(c => c.worldIds.length > 0)

  const book: Worldbook = {
    format: WORLDBOOK_FORMAT,
    version: b.version,
    title: b.title.trim(),
    tagline: b.tagline,
    description: b.description,
    author: b.author,
    revision: b.revision,
    tags: b.tags,
    chapters: chapters.length ? chapters : undefined,
    worlds: b.worlds,
  }

  const mechanics = b.worlds.filter(w => w.enableMechanics).length
  return {
    ok: true,
    book,
    summary: `《${book.title}》共 ${b.worlds.length} 个世界`
      + (mechanics ? `（${mechanics} 个机制向，${b.worlds.length - mechanics} 个纯叙事向）` : ''),
  }
}

/**
 * 把世界书转成世界包，从而复用已有的导入通道。
 *
 * 为什么不各写一套导入：世界书的导入本质上就是"把一批世界卡合并进卡片库"，
 * 而那件事 worldPack 那条路径已经做过了（含 id 冲突处理）。
 * 多写一套只会产生两份需要同步维护的逻辑。
 */
export function worldbookToPack(book: Worldbook): {
  format: string
  version: number
  exportedAt: string
  meta: { worldCount: number; characterCount: number; worldTitles: string[]; hasSave: boolean }
  worlds: WorldCard[]
  characters: never[]
} {
  const chars = book.worlds.reduce((n, w) => n + ((w.characters || []).length), 0)
  return {
    format: 'deng-xu-worldpack',
    version: 1,
    exportedAt: new Date().toISOString(),
    meta: {
      worldCount: book.worlds.length,
      characterCount: chars,
      worldTitles: book.worlds.slice(0, 3).map(w => w.title),
      hasSave: false,
    },
    worlds: book.worlds,
    characters: [],
  }
}
