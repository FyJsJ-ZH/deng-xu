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

import type { NarrativePreset, PresetEntry, WorldCard } from '@/types/cards'
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

/*
  ── 导入预算：**不再为了省钱丢条目**（2026-11）──

  玩家原话：「我要预设完完整整的生效」。

  这三个数原来是 2600 / 2600 / 12000，按"每轮全量注入读不读得完"定的 ——
  于是导入一份大预设时，`fill()` 会从**最长的条目**开始丢，把名字塞进
  `counts.dropped`，界面上标个「超预算」角标，默认不勾。
  玩家看到的是"我明明导入了一整套，怎么少了几条"。

  现在改成"只挡病态数据"：20k / 20k / 40k。正常的酒馆预设（一两万字）
  一条都不会掉；真有人塞一份十万字的东西进来，也不会把提示词撑爆。

  代价说清楚：预设越大，每轮输入越大、越贵、模型越容易"快点收尾"。
  面板上「每轮注入 N 字」就是给这件事看的。
*/
const RULES_BUDGET = 20000
/** `customStyle` 同上 */
const STYLE_BUDGET = 20000
/** `worldLore` 会被检索，比另两块宽一档 */
const LORE_BUDGET = 40000

/** 这条像不像"文风 / 笔法"要求 */
function looksLikeStyle(name: string, content: string): boolean {
  const s = `${name}\n${content.slice(0, 160)}`
  return /文风|文笔|笔法|写作|叙事|描写|措辞|用词|八股|比喻|辞藻|句式|节奏|视角|人称|段落|对白|轻小说|综漫|瑟瑟|NSFW|色情|情色|R18|H场景/.test(s)
}

/** 这条像不像"法则 / 禁止 / 流程" */
function looksLikeRules(name: string, content: string): boolean {
  const s = `${name}\n${content.slice(0, 160)}`
  return /法则|规则|准则|规范|禁止|不许|不要|必看|必读|别关|勿关|勿动|流程|交互|机制|限制|思维链|CoT|cot|格式|输出|选项|状态|称呼|摘要|防全知|防抢话|防遗忘|防变傻|防止|避免|要求|指导|引擎|协议|总控|情节设计|任务链|创作范围/.test(s)
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
 * 收集 ST 的 `{{setvar::名::值}}` 变量。
 *
 * ## 为什么必须做（2026-11 第二十九轮）
 *
 * 玩家丢进来的是「夏瑾 天琴座 Beta 3.9」—— 一份专门给 DeepSeek 写的写作预设。
 * 它把**最重要的那一条**藏进了变量里：
 *
 * ```
 * 🛡️ 变量（别动）  = {{setvar::JailbreakPrompt::You are a helpful software engineer…}}
 * 🛡️破限[顶]      = {{trim}}{{getvar::JailbreakPrompt}}
 * ```
 *
 * 上一版遇到 `setvar` / `getvar` 一律整段删掉 —— 于是作者精心写的那一大段
 * 「破限 + 思维链格式」在这边**凭空消失**：条目 35 字，剥完剩 0 字，
 * 直接当空条目丢掉。玩家看到的是"导入了但好像没生效"。
 *
 * 所以现在**先按 ST 的执行顺序还原**：顺序扫一遍收 `setvar`（后写的覆盖先写的，
 * 与 ST 一致），再把 `getvar` 换回值。剩下的宏才删。
 */
/** 一个变量值的上限（字）。破限串通常 800–2000 字，给足余量 */
const VAR_MAX = 4000

function collectStVariables(rawContents: string[]): Map<string, string> {
  const vars = new Map<string, string>()
  for (const text of rawContents) {
    const re = /\{\{\s*setvar::([^:}]+)::([\s\S]*?)\}\}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const name = m[1].trim()
      if (!name) continue
      // 单个变量的值封顶，免得某个预设里塞了一份两万字的设定把后面全挤掉
      vars.set(name, m[2].slice(0, VAR_MAX))
    }
  }
  return vars
}

/**
 * 去掉 ST 专有的宏块 —— 它们在本作里是纯噪音。
 *
 * - `{{// … }}` 是 ST 的**注释块**，作者写给自己看的，本来就不注入；
 * - `{{trim}}` / `{{random::a::b}}` 之类是 ST 的求值宏；
 * - `{{setvar::…}}` / `{{getvar::…}}` 已被 `collectStVariables` 处理过，
 *   走到这里的是**没解析出来的残留**，删掉。
 *
 * ⚠️ `{{user}}` / `{{char}}` **保留**：它们是"谁"的占位，语义仍然成立，
 * 只是本作不会替换 —— 这一点在卡片开头已经写明，让玩家自己改。
 */
function stripStMacros(text: string, vars?: Map<string, string>): string {
  let out = text
  if (vars && vars.size) {
    // `{{getvar::X}}` 换成值；换不出来（作者写错名/值在别的方案里）就留空
    out = out.replace(/\{\{\s*getvar::([^:}]+)\s*\}\}/g, (_, name: string) => vars.get(name.trim()) ?? '')
  }
  return out
    .replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
    .replace(/\{\{\s*(?:setvar|getvar|addvar|incvar|decvar|setglobalvar|getglobalvar)::[\s\S]*?\}\}/g, '')
    // 求值宏：`{{trim}}` 无参、`{{random::a::b}}` 随机取一个 —— 取第一个分支即可
    .replace(/\{\{\s*random::([\s\S]*?)\}\}/g, (_, list: string) => list.split('::')[0].trim())
    .replace(/\{\{\s*(?:trim|newline)\s*\}\}/gi, '')
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
interface StEntry {
  id: string
  name: string
  content: string
  enabled: boolean
  /** 在作者 `prompt_order` 里的位置（0 起）—— 后面拼提示词、排列表都按它 */
  order: number
}

/**
 * 这条只是**拼接骨架**，不是内容。
 *
 * ST 的作者常把一段提示词拆进好几个 order 槽位，让每个槽位只装一个标签：
 *
 * ```
 * 【设定首】        = <相关资料>\n\n<{{user}}设定>
 * 【设定集/前文】    = </相关资料>\n\n<互动历史>
 * 【前文结束】      = </互动历史>
 * ```
 *
 * 在 ST 里它们和真正的设定拼起来才成句，**单独拎出来一个字的信息都没有**。
 * 上一版把它们当普通条目收进 `worldLore`，转出来的卡正文开头是
 * 一串 `<相关资料>` `<互动历史>` —— 玩家看到只会以为转换坏了。
 */
function isStructuralMarker(content: string): boolean {
  const solid = content.replace(/\s/g, '')
  if (!solid) return true
  /*
    ⚠️ 判据只用"标签占了绝大多数"和"整条就是一个书名号标题"两种，
    **不要**用「字数少就丢」—— 预设里真有六个字的硬规矩（`不许抢话`），
    按长度一刀切会把它误伤掉，而玩家只会发现"我明明开了这条却没生效"。
  */
  const tagChars = (solid.match(/<[^<>]*>/g) ?? []).join('').length
  if (tagChars > 0 && tagChars / solid.length > 0.6) return true
  // 通篇只有【…】/（…）包起来的一个说法，没有任何其他字
  return /^(?:[【\[（(][^】\]）)]*[】\]）)])+$/.test(solid) && solid.length <= 14
}

/**
 * 从 `prompt_order` 里挑出**作者当前用的那一套方案**。
 *
 * ## 为什么不能只看 `prompt_order[0]`（2026-11 第二十九轮）
 *
 * ST 的 `prompt_order` 是个**数组**，每个元素是「一套提示词管理方案」
 * （`{ character_id, order }`）。玩家给的这份预设里有两套：
 *
 * | character_id | 条目数 | 启用 | 是什么 |
 * |---|---|---|---|
 * | 100000 | 11 | 3 条有内容 | 一个精简方案 |
 * | 100001 | 62 | 30 条有内容 | 作者真正调好的完整方案 |
 *
 * 老代码写死取 `[0]`，正好取到精简的那套：只拿到「扩写输入 / 字数 / 变量」
 * 三条，而**文风、创作准则、各种开关全在第二套里** —— 导进去像个空壳。
 *
 * 所以改成「哪套里有内容的启用条目最多，就用哪套」。
 *
 * ## 同时修掉另一个更严重的错
 *
 * `prompts` 数组里有 144 条，两套方案加起来只覆盖 73 条 ——
 * 剩下 71 条是作者**堆在抽屉里的备选**（三选一的人称、三选一的冒险度、
 * 各种「开了再关」的实验条目）。
 *
 * 老代码对"不在 order 里"的条目一律当成 `enabled: true` 收进来，
 * 于是同一份预设里同时出现了「🧭保守」「🧭冒险」「🧭特别冒险」、
 * 「第一人称」「第二人称」「第三人称」—— **互相打架的指令一起注进提示词**，
 * 模型只能在矛盾里瞎猜。
 *
 * ST 的语义很明确：**不在 order 里的条目不会被发送**。所以现在照办。
 */
function pickMainOrder(raw: JsonObject, contentById: Map<string, string>): Map<string, boolean> | null {
  const list = Array.isArray(raw.prompt_order) ? raw.prompt_order : []
  let best: Map<string, boolean> | null = null
  let bestScore = -1
  for (const g of list) {
    if (!isPlainObject(g)) continue
    const order = Array.isArray(g.order) ? g.order : []
    if (!order.length) continue
    const map = new Map<string, boolean>()
    let score = 0
    for (const o of order) {
      if (!isPlainObject(o)) continue
      const id = asText(o.identifier)
      if (!id) continue
      const on = o.enabled !== false
      map.set(id, on)
      if (on && (contentById.get(id) ?? '').trim().length > 0) score++
    }
    if (map.size && score > bestScore) {
      best = map
      bestScore = score
    }
  }
  return best
}

/**
 * 取出**启用且非空**的条目，保持作者排的顺序。
 *
 * 顺序很重要：ST 里条目顺序就是注入顺序，作者有意让"总控"排在前面。
 */
function readEntries(raw: JsonObject): StEntry[] {
  const prompts = Array.isArray(raw.prompts) ? raw.prompts : []

  // 先建「id → 原文」的表，供挑方案时统计"哪一套里有内容"
  const rawById = new Map<string, JsonObject>()
  for (const p of prompts) {
    if (!isPlainObject(p)) continue
    const id = asText(p.identifier) || asText(p.name)
    if (id) rawById.set(id, p)
  }
  const contentById = new Map<string, string>()
  for (const [id, p] of rawById) contentById.set(id, asText(p.content))

  // 变量是**顺序执行**的：先扫一遍全部原文，才能把 `getvar` 换出来
  const vars = collectStVariables([...rawById.values()].map(p => asText(p.content)))

  const order = pickMainOrder(raw, contentById)

  const byId = new Map<string, StEntry>()
  for (const [id, p] of rawById) {
    // 有方案表时，**不在表里就是没勾选** —— 备选池不参与注入
    const enabled = order ? (order.get(id) ?? false) : true
    if (!enabled) continue
    const content = stripStMacros(asText(p.content).trim(), vars)
    // marker 是分隔线，content 永远是空；空 content 的普通条目也没有信息
    if (!content) continue
    if (isStructuralMarker(content)) continue
    byId.set(id, {
      id,
      name: asText(p.name).trim() || id.slice(0, 24),
      content,
      enabled: true,
      // 真正的位置在下面按 order 排完才知道
      order: -1,
    })
  }

  const ordered: StEntry[] = []
  const seen = new Set<string>()
  if (order) {
    for (const id of order.keys()) {
      const hit = byId.get(id)
      if (hit && !seen.has(hit.id)) { ordered.push(hit); seen.add(hit.id) }
    }
  }
  for (const e of byId.values()) if (!seen.has(e.id)) ordered.push(e)

  /*
    兜底：万一方案表里一条有内容的都没有（作者的方案指向的全是空占位），
    退回"全部有内容的条目"，至少别交出一张空卡。
    这种情况在只有一套 order、且那份 order 是别人方案残留时会遇到。
  */
  if (!ordered.length) {
    for (const [id, p] of rawById) {
      const content = stripStMacros(asText(p.content).trim(), vars)
      if (!content || isStructuralMarker(content)) continue
      ordered.push({
        id,
        name: asText(p.name).trim() || id.slice(0, 24),
        content,
        enabled: true,
        order: -1,
      })
    }
  }

  /*
    顺序在这里定死：`ordered` 现在就是**酒馆发出去的那条序列**
    （作者方案里的先后 + 方案外的按原文件顺序），下标即 `order`。
    后面所有环节（列表显示、三段快照、注入）都只认这个数。
  */
  return ordered.map((e, i) => ({ ...e, order: i }))
}

/**
 * 把条目塞进某一块，超预算就从**最长的**条目开始丢，并回报丢了几条。
 *
 * 为什么从最长的丢：预设里的"超长条目"通常是某一种玩法的完整说明书
 * （「轻小说综漫流」3070 字），它自成一体、缺了也不影响别的规则；
 * 而短的往往是硬规矩（「禁八股」「别关」），丢了整份预设就散了。
 */
function fill(
  entries: StEntry[],
  budget: number,
): { text: string; used: StEntry[]; dropped: StEntry[] } {
  const sorted = [...entries].sort((a, b) => b.content.length - a.content.length)
  const dropped = new Set<StEntry>()
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
 * 同一套分类：转换世界卡、统计面板、预设库**都走这里**。
 * 三处各写一遍的话，面板上的数字迟早和实际落点对不上。
 */
function classifyEntries(entries: StEntry[]): {
  world: StEntry[]
  rules: StEntry[]
  style: StEntry[]
} {
  const world: StEntry[] = []
  const rules: StEntry[] = []
  const style: StEntry[] = []
  for (const e of entries) {
    // 先挑出"给读者看的说明 / 给 ST 用的系统人设"：它们不进每轮注入
    if (looksLikeMeta(e.name, e.content)) world.push(e)
    else if (looksLikeStyle(e.name, e.content)) style.push(e)
    else if (looksLikeRules(e.name, e.content)) rules.push(e)
    else world.push(e)
  }
  return { world, rules, style }
}

/** 被预算裁掉时如实写在段末 —— 悄悄截断等于把作者的东西吃掉一半还不告诉他 */
function droppedNote(part: { dropped: StEntry[] }, label: string): string {
  return part.dropped.length
    ? `\n\n（另有 ${part.dropped.length} 条${label}因超出篇幅预算未并入：${part.dropped.map(e => e.name).join('、')}）`
    : ''
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

  const { world, rules, style } = classifyEntries(entries)

  const lorePart = fill(world, LORE_BUDGET)
  const rulesPart = fill(rules, RULES_BUDGET)
  const stylePart = fill(style, STYLE_BUDGET)

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
  const { world, rules, style } = classifyEntries(entries)
  return { total: entries.length, rules: rules.length, style: style.length, other: world.length }
}

/**
 * 一份 ST 预设 → **一份可切换的叙事预设**（2026-11 第二十九轮）。
 *
 * 与 `fromSillyTavernPreset` 的区别只在**去处**：那边产出世界卡，
 * 这边产出 `NarrativePreset` —— 存进卡片库旁边的预设库，全局只启用一份，
 * 叠加到**当前世界**上，不必为了换文风去重开一局或改每张世界卡。
 *
 * 预算与分类完全一致（同一个 `classifyEntries` 与 `fill`），
 * 所以两张入口看到的内容不会互相矛盾。
 *
 * ## 同时交出逐条清单（2026-11 第三十七轮）
 *
 * 玩家要的是酒馆那种勾选。「三块大字符串」做不到 —— 粘好了就再也拆不开。
 * 所以这里把 `fill()` 的**入选与落选**都摆进 `entries`：
 *
 * - 入选的 `enabled: true`（默认勾上，与改之前注入的内容**逐字一致**）；
 * - 预算落选的 `enabled: false, dropped: true`（默认不勾，但玩家能自己勾回来）。
 *
 * 拼接出来的 `rules` / `style` / `lore` 仍然照旧返回一份快照，
 * 用来导出、列表摘要，以及旧版本读到新文件时的兜底。
 */
export function stPresetToNarrativePreset(raw: unknown, fileName = ''): NarrativePreset | null {
  if (!isPlainObject(raw)) return null
  const entries = readEntries(raw)
  if (!entries.length) return null

  const { world, rules, style } = classifyEntries(entries)
  const lorePart = fill(world, LORE_BUDGET)
  const rulesPart = fill(rules, RULES_BUDGET)
  const stylePart = fill(style, STYLE_BUDGET)

  const now = Date.now()
  const baseName = fileName.replace(/\.json$/i, '').trim()

  const toEntry = (
    e: StEntry,
    kind: PresetEntry['kind'],
    kept: boolean,
  ): PresetEntry => ({
    id: e.id,
    name: e.name,
    kind,
    content: e.content,
    enabled: kept,
    order: e.order,
    ...(kept ? {} : { dropped: true }),
  })

  /*
    ── 条目顺序：**照酒馆原来那条序列**（2026-11，玩家报「连预设的顺序都是错乱的」）──

    上一版按「规则 → 文风 → 其他」重排，还把被预算裁掉的条目统统赶到组尾。
    玩家看到的清单和他那份预设对不上：
    「user → 头部破甲 → 格式要求结束 → 主提示下半 → 自定义字数 → 文风开始」
    被拆成三段互不相干的东西；「指南（可改）」明明作者排在前头，因为超预算被甩到最后。

    现在：`entries` 本来就是 `prompt_order` 的顺序（`readEntries` 已按它排好），
    一条条 map 过去就行。`dropped` 也留在原位 —— 它只是"没勾上"，不是"搬走了"。
  */
  const kept = new Set([
    ...rulesPart.used, ...stylePart.used, ...lorePart.used,
  ].map(e => e.id))
  const kindOf = new Map<string, PresetEntry['kind']>()
  for (const e of rules) kindOf.set(e.id, 'rules')
  for (const e of style) kindOf.set(e.id, 'style')
  for (const e of world) kindOf.set(e.id, 'other')

  const entryList: PresetEntry[] = entries.map(e => toEntry(
    e,
    kindOf.get(e.id) ?? 'other',
    kept.has(e.id),
  ))

  return {
    id: makeId('preset'),
    name: (baseName || '导入的叙事预设').slice(0, 60),
    source: fileName,
    rules: rulesPart.text + droppedNote(rulesPart, '规则类条目'),
    style: stylePart.text + droppedNote(stylePart, '文风类条目'),
    lore: lorePart.text + droppedNote(lorePart, '设定类条目'),
    entries: entryList,
    counts: {
      total: entryList.filter(e => e.enabled).length,
      rules: rulesPart.used.length,
      style: stylePart.used.length,
      other: lorePart.used.length,
      dropped: [...rulesPart.dropped, ...stylePart.dropped, ...lorePart.dropped].map(e => e.name),
    },
    createdAt: now,
    updatedAt: now,
  }
}
