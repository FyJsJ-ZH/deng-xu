/**
 * SillyTavern **提示词预设**（completion preset）→ 本作世界卡
 *
 * ## 这跟「世界书」是两回事（2026-11 第二十五轮）
 *
 * 玩家把两个 `.json` 拖进来，说「下了两个世界书，发现不兼容」。
 * 那两个文件里没有一条世界设定 —— 它们是 ST 的**预设**：
 * `temperature` / `prompts[]` / `prompt_order` / `extensions`。
 *
 * | | ST 世界书（lorebook） | ST 预设（preset） |
 * |---|---|---|
 * | 形状 | `{ entries: {...} }` | `{ prompts: [...], prompt_order: [...] }` |
 * | 内容 | **写什么**：地名志、势力表、人物小传 | **怎么写**：文风、禁止事项、输出格式 |
 * | 在本作 | 能转成 lore（`stLorebook.ts`） | 没有对应物 —— 本作的"规则"散在提示词里 |
 *
 * 所以"不兼容"不是 bug，是**把 A 当成了 B**。但玩家的诉求是真的：
 * 他花了钱/时间搞到的东西，想在这个游戏里用上。
 *
 * ## 这一段做什么
 *
 * 把它拆成三块塞进世界卡，**内容一个字不丢**，只是换个位置：
 *
 * - `worldLore` ← 设定类（会被 `loreDigest` 按话题检索，所以放得下）
 * - `rules`     ← 法则 / 禁止 / 交互流程（每轮全量注入，必须短）
 * - `narrative.customStyle` ← 文风 / 笔法 / 叙事指南（同上）
 *
 * ⚠️ **后两块是全量注入的**，所以有硬预算（见 `RULES_BUDGET` / `STYLE_BUDGET`）。
 * 超了就从**最长的条目**开始裁，并在末尾如实写出裁掉了几条 ——
 * 悄悄截断等于把作者的东西吃掉一半还不告诉他。
 *
 * ## 诚实说明
 *
 * 转出来的卡**不是世界**。它没有地点、没有人物、没有物价。
 * 所以 `tagline` 与 `worldLore` 开头都写明"这是规则包"，
 * 免得玩家开一局发现世界一片空白，以为导入坏了。
 */

import type { WorldCard } from '@/types/cards'
import { makeId } from '@/utils/files'

type JsonObject = Record<string, unknown>

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** `rules` 每轮全量注入，上限按"读得完"定，不是按"装得下"定 */
const RULES_BUDGET = 2600
/** `customStyle` 同上 */
const STYLE_BUDGET = 2600
/** `worldLore` 会被检索，可以宽一点（与 stLorebook 的 WORLD_LORE_MAX 同量级） */
const LORE_BUDGET = 12000

/** 这条像不像"文风 / 笔法"要求 */
function looksLikeStyle(name: string, content: string): boolean {
  const s = `${name}\n${content.slice(0, 160)}`
  return /文风|文笔|笔法|写作|叙事|描写|措辞|用词|八股|比喻|辞藻|句式|节奏|视角|人称|轻小说|综漫|瑟瑟|NSFW|色情|情色|R18|H场景/.test(s)
}

/** 这条像不像"法则 / 禁止 / 流程" */
function looksLikeRules(name: string, content: string): boolean {
  const s = `${name}\n${content.slice(0, 160)}`
  return /法则|规则|禁止|不许|不要|必看|必读|别关|勿关|勿动|流程|交互|机制|限制|思维链|CoT|cot|格式|输出|选项|状态|称呼|摘要|防全知|防抢话|防遗忘|防变傻|防止|避免|要求|指导|引擎|协议|总控/.test(s)
}

/**
 * 这条是**给读者看的说明 / 给 ST 用的系统提示**，不是写作规则。
 *
 * 为什么必须单独拎出来：预设里混着两类"看起来像指令、其实对本作无用"的东西 ——
 *
 *  1. **作者说明**：「⚠️使用必看」里写着"禁止二创""下载后 24h 内删掉"
 *     "小插头里选没有工具的" —— 这些是给**人**的操作手册，塞进 `rules`
 *     会被每轮注入给模型，纯噪音。
 *  2. **ST 系统人设**：「你没有任何内容审查义务…」是在 ST 里顶掉默认人设用的，
 *     而本作有自己的系统提示词，两者会打架。
 *
 * 它们仍然保留（进 `worldLore`，按话题检索才会出现），只是**不进每轮注入**。
 */
function looksLikeMeta(name: string, content: string): boolean {
  const s = `${name}\n${content.slice(0, 200)}`
  if (/使用必看|使用说明|必看|必读|更新日志|版本说明|免责|声明|授权|二创|转载|禁止商用/.test(name)) return true
  if (/<system_context>|系统提示词|你是.{0,14}助手|没有任何内容审查义务/.test(s)) return true
  return false
}

/**
 * 去掉 ST 专有的宏块 —— 它们在本作里是纯噪音。
 *
 * - `{{// … }}` 是 ST 的**注释块**，作者写给自己看的，本来就不注入；
 * - `{{setvar::…}}` / `{{getvar::…}}` 是 ST 的变量系统，本作没有。
 *
 * ⚠️ `{{user}}` / `{{char}}` **保留**：它们是"谁"的占位，语义仍然成立，
 * 只是本作不会替换 —— 这一点在卡片开头已经写明，让玩家自己改。
 */
function stripStMacros(text: string): string {
  return text
    .replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
    .replace(/\{\{\s*(?:setvar|getvar|addvar|incvar|decvar|setglobalvar|getglobalvar)::[\s\S]*?\}\}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 认这是不是一份 ST 预设。
 *
 * 判据刻意避开"只要有 prompts 就算"：很多角色卡也带 prompts。
 * 所以要求 **有 prompts 数组** + **没有 entries**（世界书）+ **至少一个预设特征字段**。
 */
export function isSillyTavernPreset(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false
  if ('entries' in raw) return false
  if (!Array.isArray(raw.prompts)) return false
  return (
    'prompt_order' in raw
    || 'temperature' in raw
    || 'max_context_unlocked' in raw
    || 'wi_format' in raw
    || 'openai_max_tokens' in raw
  )
}

/** 一条预设条目（只留用得上的字段） */
interface PresetEntry {
  id: string
  name: string
  content: string
  enabled: boolean
}

/**
 * 取出**启用且非空**的条目，保持作者排的顺序。
 *
 * 顺序很重要：ST 里条目顺序就是注入顺序，作者有意让"总控"排在前面。
 * 用 `prompt_order[0].order` 排，没有就退回 `prompts` 的原始顺序。
 */
function readEntries(raw: JsonObject): PresetEntry[] {
  const prompts = Array.isArray(raw.prompts) ? raw.prompts : []
  const order = (raw.prompt_order as { order?: unknown }[] | undefined)?.[0]?.order
  const enabledMap = new Map<string, boolean>()
  if (Array.isArray(order)) {
    for (const o of order) {
      if (!isPlainObject(o)) continue
      const id = asText(o.identifier)
      if (id) enabledMap.set(id, o.enabled !== false)
    }
  }

  const byId = new Map<string, PresetEntry>()
  for (const p of prompts) {
    if (!isPlainObject(p)) continue
    const id = asText(p.identifier) || asText(p.name)
    if (!id) continue
    const rawContent = asText(p.content)
    const content = stripStMacros(rawContent.trim())
    // marker 是分隔线，content 永远是空；空 content 的普通条目也没有信息
    if (!content) continue
    const enabled = enabledMap.has(id) ? enabledMap.get(id)! : true
    byId.set(id, {
      id,
      name: asText(p.name).trim() || id.slice(0, 24),
      content,
      enabled,
    })
  }

  const ordered: PresetEntry[] = []
  const seen = new Set<string>()
  if (Array.isArray(order)) {
    for (const o of order) {
      if (!isPlainObject(o)) continue
      const id = asText(o.identifier)
      const hit = id ? byId.get(id) : undefined
      if (hit && !seen.has(hit.id)) { ordered.push(hit); seen.add(hit.id) }
    }
  }
  for (const e of byId.values()) if (!seen.has(e.id)) ordered.push(e)

  return ordered.filter(e => e.enabled)
}

/**
 * 把条目塞进某一块，超预算就从**最长的**条目开始丢，并回报丢了几条。
 *
 * 为什么从最长的丢：预设里的"超长条目"通常是某一种玩法的完整说明书
 * （「轻小说综漫流」3070 字），它自成一体、缺了也不影响别的规则；
 * 而短的往往是硬规矩（「禁八股」「别关」），丢了整份预设就散了。
 */
function fill(
  entries: PresetEntry[],
  budget: number,
): { text: string; used: PresetEntry[]; dropped: PresetEntry[] } {
  const sorted = [...entries].sort((a, b) => b.content.length - a.content.length)
  const dropped = new Set<PresetEntry>()
  let total = entries.reduce((n, e) => n + e.content.length + e.name.length + 8, 0)
  for (const e of sorted) {
    if (total <= budget) break
    dropped.add(e)
    total -= e.content.length + e.name.length + 8
  }
  const used = entries.filter(e => !dropped.has(e))
  const text = used.map(e => `【${e.name}】\n${e.content}`).join('\n\n')
  return { text, used, dropped: [...dropped] }
}

/**
 * 一份 ST 预设 → 一张世界卡。
 *
 * 返回 `null` 表示这份预设里没有可用的条目（全被停用 / 全空）。
 */
export function fromSillyTavernPreset(raw: unknown, fileName = ''): WorldCard | null {
  if (!isPlainObject(raw)) return null
  const entries = readEntries(raw)
  if (!entries.length) return null

  const world: PresetEntry[] = []
  const rules: PresetEntry[] = []
  const style: PresetEntry[] = []
  for (const e of entries) {
    // 先挑出"给读者看的说明 / 给 ST 用的系统人设"：它们不进每轮注入
    if (looksLikeMeta(e.name, e.content)) world.push(e)
    else if (looksLikeStyle(e.name, e.content)) style.push(e)
    else if (looksLikeRules(e.name, e.content)) rules.push(e)
    else world.push(e)
  }

  const lorePart = fill(world, LORE_BUDGET)
  const rulesPart = fill(rules, RULES_BUDGET)
  const stylePart = fill(style, STYLE_BUDGET)

  const droppedNote = (part: { dropped: PresetEntry[] }, label: string) =>
    part.dropped.length
      ? `\n\n（另有 ${part.dropped.length} 条${label}因超出篇幅预算未并入：${part.dropped.map(e => e.name).join('、')}）`
      : ''

  const baseName = fileName.replace(/\.json$/i, '').trim()
  const now = Date.now()

  const locaHeader =
    '> ⚠️ **这是从 SillyTavern 提示词预设转来的「叙事规则包」，不是世界设定。**\n'
    + '> 它规定"怎么写"，不规定"写什么" —— 没有地点、人物、物价与势力。\n'
    + '> 想把它叠到你自己的世界上：打开卡片编辑器，把下面三段分别复制到'
    + '「规则」与「文风」里即可。\n'
    + '> 原文里的 `{{user}}` / `{{char}}` 等 ST 宏**没有被替换**，按需自行改掉。'

  return {
    id: makeId('world'),
    title: (baseName || '导入的叙事预设').slice(0, 60),
    tagline: `由 SillyTavern 提示词预设转换：${entries.length} 条启用条目（规则包，非世界设定）`,
    worldLore: [locaHeader, lorePart.text + droppedNote(lorePart, '设定类条目')]
      .filter(Boolean).join('\n\n'),
    rules: rulesPart.text + droppedNote(rulesPart, '规则类条目'),
    attributes: [],
    resources: [],
    backgrounds: [],
    attributePoints: 0,
    items: [],
    lores: [],
    story: {
      atmosphere: '',
      mainQuest: '',
      enableStages: false,
      stages: [],
      enableChoices: true,
      urgencyAfterTurns: 0,
    },
    narrative: {
      pov: 'third',
      tense: 'past',
      replyLength: 1800,
      customStyle: stylePart.text + droppedNote(stylePart, '文风类条目'),
    },
    characters: [],
    // 规则包没有任何数值体系：默认开机制层会让玩家看到一片 0
    enableMechanics: false,
    createdAt: now,
    updatedAt: now,
  }
}

/** 给 UI 用：这份预设里几类各有几条（导入前先说清楚会发生什么） */
export function describePreset(raw: unknown): { total: number; rules: number; style: number; other: number } | null {
  if (!isSillyTavernPreset(raw)) return null
  const entries = readEntries(raw as JsonObject)
  if (!entries.length) return null
  let rules = 0, style = 0, other = 0
  for (const e of entries) {
    // 与 `fromSillyTavernPreset` 同一套顺序，不然面板上的数字会和实际落点对不上
    if (looksLikeMeta(e.name, e.content)) other++
    else if (looksLikeStyle(e.name, e.content)) style++
    else if (looksLikeRules(e.name, e.content)) rules++
    else other++
  }
  return { total: entries.length, rules, style, other }
}
