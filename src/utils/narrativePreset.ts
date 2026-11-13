/**
 * 叙事预设 → 叠加到当前世界卡上。
 *
 * ## 为什么用「叠加」而不是「替换」
 *
 * 预设管的是**怎么写**（文风、句式禁令、对白规范），世界卡管的是**写什么**
 * （地名、势力、物价）以及这个题材自己的硬约束（比如「本作不写露骨细节」）。
 * 玩家换上别人的预设，不该把世界卡作者定的规矩一起冲掉 ——
 * 那样的话，一份从网上下载的 NSFW 预设会把每一张内置卡都变成限制级。
 *
 * 所以两段都是**拼接**：世界卡在前，预设在後，并且给预设加一行小标题，
 * 让模型知道"这后面的一段是另一份来源"。
 *
 * ## 为什么只在构建提示词时叠加，不改写库里的卡
 *
 * 与 `withNarrativePreset` 的调用点有关：它每次构建提示词时现算，
 * 世界卡本身**一个字节都不动**。这样：
 *
 *  - 换预设＝换一个函数入参，立刻生效，不必重开一局、不必改卡；
 *  - 玩家在编辑器里看到的世界卡还是他自己的内容，不会莫名其妙多出一段别人的话。
 */

import type { NarrativePreset, PresetEntry, WorldCard } from '@/types/cards'
import { chosenStyleIds, styleById, type StyleChoice } from '@/data/narrativeStyles'

/**
 * 预设两段各自的上限（字符）。
 *
 * ## 为什么从 4000 抬到 20000（2026-11）
 *
 * 玩家原话：「我要预设完完整整的生效」。
 *
 * 4000 这道闸当初是防"手动粘贴超长"，但它实际做的是**静默截断已勾选的条目** ——
 * 面板上五条都打着勾，注入到提示词里的却是被切掉尾巴的一大段。
 * 这比"预算不够时默认不勾"更糟：后者至少界面上看得出来。
 *
 * 现在抬到 20000，只挡病态数据（真有人塞十万字）。与 `stPreset.ts` 的
 * `RULES_BUDGET` / `STYLE_BUDGET` 保持同一量级。
 */
const PRESET_RULES_MAX = 20000
const PRESET_STYLE_MAX = 20000

/**
 * 贴尾段的上限 —— **故意比另两段紧得多**（2026-11）。
 *
 * 这一段的力量不在内容多，在**离得近**。它贴在生成点之前，靠注意力权重吃饭；
 * 一旦自己也膨胀成上万字，就退化成了第二个 system，等于没搬。
 *
 * 4000 字足够装下任何一份破甲串 + 输出格式 + 字数要求 + 收尾规矩
 * （实测主流中文预设这几条合计 1200～3000 字）。
 * 与 `stPreset.ts` 的 `TAIL_BUDGET` 同量级。
 */
const PRESET_TAIL_MAX = 4000

/** 段与段之间留一行空，模型才不会读成同一句 */
function joinBlock(base: string, extra: string): string {
  const a = base.trim()
  const b = extra.trim()
  if (!a) return b
  if (!b) return a
  return `${a}\n\n${b}`
}

/**
 * 把某一类**已勾选**的条目拼回一段正文。
 *
 * ## 格式与导入时完全一致
 *
 * `【条目名】\n正文`，条目之间空一行 —— 与 `stPreset.ts` 的 `fill()` 一模一样。
 * 这不是巧合：勾选全部打开时，拼出来的必须与改之前**逐字相同**，
 * 否则"我什么也没动，文风却变了"。测试里钉着这件事。
 *
 * ## 为什么这里要按 `order` 再排一次（2026-11）
 *
 * 数组顺序本来就已经是作者 `prompt_order` 的顺序了，但**玩家会编辑、会新增**，
 * 也可能从别处导入一份没有 `order` 的旧数据。显式排一次，
 * 让"注入顺序 = 作者写的顺序"这件事不依赖任何隐含约定。
 */
export function renderPresetEntries(preset: NarrativePreset, kind: PresetEntry['kind']): string {
  const list = (preset.entries || [])
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.enabled && e.kind === kind && e.content.trim())
    .sort((a, b) => (a.e.order ?? a.i) - (b.e.order ?? b.i))
    .map(({ e }) => e)
  if (!list.length) return ''
  return list.map(e => `【${e.name}】\n${e.content}`).join('\n\n')
}

/** 这一类条目现在勾掉了几条、总几条、占多少字（给 UI 的小标题用） */
export function presetEntryStats(
  preset: NarrativePreset,
): Record<PresetEntry['kind'], { on: number; all: number; chars: number }> {
  const out: Record<PresetEntry['kind'], { on: number; all: number; chars: number }> = {
    rules: { on: 0, all: 0, chars: 0 },
    style: { on: 0, all: 0, chars: 0 },
    tail: { on: 0, all: 0, chars: 0 },
    other: { on: 0, all: 0, chars: 0 },
  }
  for (const e of preset.entries || []) {
    // 兜底：库里的旧数据来自 localStorage，`kind` 可能是个我们不认识的值
    const k = out[e.kind] ?? out.other
    k.all++
    if (e.enabled) {
      k.on++
      k.chars += e.content.length
    }
  }
  return out
}

/**
 * 取这份预设里**该贴在生成点之前**的那些条目（2026-11）。
 *
 * ## 为什么单独一个函数，而不是塞进 `withNarrativePreset`
 *
 * `withNarrativePreset` 的产物会变成 `world.rules` / `world.narrative.customStyle`，
 * 而这两块最终都拼进**第 0 条 system**。贴尾段一旦走那条路，就又跑回最前面了 ——
 * 等于白改。
 *
 * 所以它走另一条道：`useGameEngine` 把它作为**最后一条 system** 插在历史之后、
 * 本轮动作之前。这就是酒馆 `post_history_instructions` 的位置。
 *
 * 全空时返回空串 —— 调用方据此决定要不要多插一条消息。
 */
export function renderPresetTail(preset: NarrativePreset | null | undefined): string {
  if (!preset) return ''
  // 旧版导入的预设没有 entries，也就没有 tail 分档，走不到这里
  if (!preset.entries?.length) return ''
  const text = renderPresetEntries(preset, 'tail').slice(0, PRESET_TAIL_MAX)
  return text
}

/**
 * 由 `entries` 重算三段快照。
 *
 * 勾选一变就调一次，把 `rules` / `style` / `lore` 与 `counts` 跟上 ——
 * 这三个字段是导出、列表摘要、旧版本降级读的入口，不能让它们与勾选状态分家。
 *
 * 没有 `entries` 的旧预设原样返回（不动它，也就不会误伤）。
 */
export function syncPresetSnapshot(preset: NarrativePreset): NarrativePreset {
  const entries = preset.entries
  if (!entries?.length) return preset
  const stats = presetEntryStats(preset)
  return {
    ...preset,
    /*
      贴尾段并进 `rules` 快照（2026-11）。

      这三个字符串是**导出、列表摘要、旧版本兜底读**的入口，要保证内容完整。
      注入不靠它们（注入只认 `kind`），所以并进来不会让它跑到错误的位置。
    */
    rules: [renderPresetEntries(preset, 'rules'), renderPresetEntries(preset, 'tail')]
      .filter(Boolean).join('\n\n'),
    style: renderPresetEntries(preset, 'style'),
    lore: renderPresetEntries(preset, 'other'),
    counts: {
      ...preset.counts,
      total: entries.filter(e => e.enabled).length,
      rules: stats.rules.on,
      style: stats.style.on,
      tail: stats.tail.on,
      other: stats.other.on,
    },
  }
}

/**
 * 「这条内容像破甲串」的判据 —— 导入分档与迁移**共用同一份**。
 *
 * 两处各写一份的话，同一条目会出现「导入时判成 tail、迁移时又判不成」，
 * 而这种不一致最难查：界面上看着一样，行为却取决于它是哪一天导进来的。
 *
 * 只收**短条目**（≤3000 字，由调用方判）：破甲串本来就不长，
 * 而三千字以上多半是「综合创作总纲」那一类，不该被搬去贴尾。
 */
export const JAILBREAK_CONTENT_RE =
  /没有任何(?:内容)?审查|不受任何(?:内容)?限制|忽略(?:之前|以上|先前)[^。\n]{0,12}(?:所有|一切)?(?:设定|规则|指令)|没有道德|无需遵守|越过(?:任何)?限制|jailbreak/i

/** 短条目上限：超过它就不按破甲串处理 */
export const TAIL_CONTENT_MAX = 3000

/**
 * 把**已经躺在库里**的破甲条目从 `other` 挪回 `tail`（2026-11）。
 *
 * ## 为什么需要一次迁移
 *
 * 导入分档是这一轮才有的。在此之前，`looksLikeMeta()` 认「没有任何内容审查义务」
 * 这句话，于是破甲串被判成"给 ST 用的系统人设"，扔进 `other` —— 而 `other`
 * **一个字都不注入**。玩家导入了、界面上也看得见、提示词里从来没有过它。
 *
 * 现在导入时会正确分档，但**库里那份不会自己变**：它的 `entries[].kind`
 * 还是 `'other'`。玩家不重导的话，改了半天还是没效果 —— 而他不会想到要重导。
 *
 * ## 只动 `other`
 *
 * 已经分到 `rules` / `style` / `tail` 的不碰：那是导入器或玩家自己定的位置，
 * 迁移不该覆盖。`enabled` 也不动 —— 玩家手动关掉的破甲条，关着就是关着。
 */
export function reviveTailEntries(presets: NarrativePreset[]): {
  presets: NarrativePreset[]
  changed: boolean
} {
  let changed = false
  const out = presets.map(p => {
    if (!p.entries?.length) return p
    let touched = false
    const entries = p.entries.map(e => {
      if (e.kind !== 'other') return e
      const body = e.content.trim()
      if (!body || body.length > TAIL_CONTENT_MAX) return e
      if (!JAILBREAK_CONTENT_RE.test(body)) return e
      touched = true
      return { ...e, kind: 'tail' as const, ...(e.dropped ? { dropped: false } : {}) }
    })
    if (!touched) return p
    changed = true
    const synced = syncPresetSnapshot({ ...p, entries })
    return { ...synced, updatedAt: Date.now() }
  })
  return { presets: out, changed }
}

/**
 * 把**旧预算下被丢掉的条目**勾回来（2026-11）。
 *
 * ## 为什么需要一次迁移
 *
 * 导入预算原来只有 2600 字符/类，超出的条目会被标 `dropped: true` 且默认不勾
 * （界面上是「超预算」角标）。玩家明确要求"预设完完整整的生效"之后，
 * 预算抬到了 20000 —— 但**已经躺在库里的那份预设不会自己变**，
 * 那些条目仍然是"没勾"的状态。
 *
 * 判据只认 `dropped === true`：玩家自己手动关掉的条目没有这个标记，
 * 不该被这次迁移重新打开。
 *
 * `dropped` 标记同时清掉 —— 预算已经不是它当初被丢的理由了，
 * 留着会让界面上出现"勾着却标着超预算"的矛盾状态。
 */
export function reviveBudgetDroppedEntries(presets: NarrativePreset[]): {
  presets: NarrativePreset[]
  changed: boolean
} {
  let changed = false
  const out = presets.map(p => {
    if (!p.entries?.length) return p
    if (!p.entries.some(e => e.dropped === true && e.enabled === false)) return p
    changed = true
    const entries = p.entries.map(e => (
      e.dropped === true && e.enabled === false
        ? { ...e, enabled: true, dropped: false }
        : e
    ))
    const synced = syncPresetSnapshot({ ...p, entries })
    return {
      ...synced,
      counts: { ...synced.counts, dropped: [] },
      updatedAt: Date.now(),
    }
  })
  return { presets: out, changed }
}

/**
 * 合并**同一份文件被导入多次**留下的副本（2026-11）。
 *
 * ## 它们是怎么来的
 *
 * `saveNarrativePreset` 的"同文件覆盖"判据写错过一次（`preset.id ? undefined : …`，
 * 而导入器生成的对象总是带 id），于是每次导入都多存一份。
 * 玩家库里于是躺着「Izumi 1029 (1)」「Izumi 1029 (1) (2)」这样的东西。
 *
 * ## 为什么这份副本会造成"预设时有时无"
 *
 * `activeNarrativePresetId` 只指向**其中一份**。玩家在另一份里改字、改勾选，
 * 改的是一份没启用的预设 —— 界面上它就在同一个展开区里，看起来完全一样。
 * 他报上来的现象因此是「同一个预设，有时生效有时不生效」。
 *
 * 处理：同一个 `source` 只留 `updatedAt` 最新的那一份；
 * 若 `activeId` 指向被合并掉的那份，改指到留下的那份（而不是变成"没启用"）。
 */
export function dedupePresetsBySource(
  presets: NarrativePreset[],
  activeId: string,
): { presets: NarrativePreset[]; activeId: string; removed: number } {
  const best = new Map<string, NarrativePreset>()
  for (const p of presets) {
    const key = String(p.source || '').trim()
    if (!key) continue
    const cur = best.get(key)
    if (!cur || (p.updatedAt || 0) > (cur.updatedAt || 0)) best.set(key, p)
  }
  const kept = presets.filter(p => {
    const key = String(p.source || '').trim()
    if (!key) return true
    return best.get(key)?.id === p.id
  })
  let nextActive = activeId
  if (activeId && !kept.some(p => p.id === activeId)) {
    const dropped = presets.find(p => p.id === activeId)
    const key = String(dropped?.source || '').trim()
    nextActive = (key && best.get(key)?.id) || ''
  }
  return { presets: kept, activeId: nextActive, removed: presets.length - kept.length }
}

/**
 * 把预设与文风叠到世界上，返回**新的** world 对象（原对象不变）。
 *
 * 三层，从下到上：
 *
 *   1. 世界卡自己的 `customStyle` / `rules`（作者定的，永远在最前）
 *   2. 叙事预设（从 ST 文件转来的整套规则 + 文风）
 *   3. 文风选择（玩家在预设页里现拨的开关，**最强**，放最后）
 *
 * 为什么第三层排最后：模型对越靠后的指令越敏感，而玩家刚点的那一下
 * 才是他此刻真正想要的。世界卡作者三年前写的文风不该压过他现在的选择。
 *
 * ## 第 2 层现在按**勾选**取（2026-11 第三十七轮）
 *
 * 有 `entries` 就只拼已勾选的条目；没有（旧版导入的预设）就退回整块字符串。
 * 两条路的上限是同一个 `PRESET_RULES_MAX` —— 玩家勾得再多，也不至于把
 * 每轮提示词撑到失控。
 *
 * 全空时原样返回同一个引用 —— 调用方常把它放在生成路径上，能不新建就不新建。
 */
export function withNarrativePreset(
  world: WorldCard,
  preset: NarrativePreset | null | undefined,
  styleChoice?: StyleChoice | null,
): WorldCard {
  const useEntries = Boolean(preset?.entries?.length)
  const presetRules = preset
    ? (useEntries ? renderPresetEntries(preset, 'rules') : preset.rules.trim()).slice(0, PRESET_RULES_MAX)
    : ''
  const presetStyle = preset
    ? (useEntries ? renderPresetEntries(preset, 'style') : preset.style.trim()).slice(0, PRESET_STYLE_MAX)
    : ''
  const chosenStyle = renderStyleChoice(styleChoice).slice(0, PRESET_STYLE_MAX)

  if (!presetRules && !presetStyle && !chosenStyle) return world

  const rulesBlock = presetRules
    ? `### 叙事预设：${preset!.name}\n\n${presetRules}`
    : ''
  /*
    ⚠️ 这句的措辞改过两次，第二次是因为它**在替对手说话**（2026-11）。

    上一版写的是「与世界本身的规则冲突时，以世界为准」。本意是保住题材底线，
    实际效果是：玩家导入一份破甲预设，提示词里明着告诉模型「你输」——
    而破甲预设那些越界要求，正好撞在「本作不写露骨细节」这类世界卡规则上。
    表现就是「同一份预设，在这儿就是不灵」。

    酒馆那边冲突时主动权在预设：预设作者可以用 `{{original}}` 宏把卡的话
    缝回来；本作却写死判定。现在改成中立表述，不偏袒任何一方，让模型按
    「哪条更具体」来取舍——这是它本来就擅长的判断。
  */
  const presetStyleBlock = presetStyle
    ? `（以下文风要求来自叙事预设「${preset!.name}」；与本作规则同时生效，冲突处按更具体的这一条执行）\n\n${presetStyle}`
    : ''
  const chosenBlock = chosenStyle
    ? `（以下是玩家当前选定的文风，优先级高于以上风格描述）\n\n${chosenStyle}`
    : ''

  return {
    ...world,
    rules: joinBlock(world.rules, rulesBlock),
    narrative: {
      ...world.narrative,
      customStyle: joinBlock(
        joinBlock(world.narrative.customStyle, presetStyleBlock),
        chosenBlock,
      ),
    },
  }
}

/** 这一份预设会不会真的改变提示词（空预设不该让"已启用"三个字骗人） */
export function presetHasContent(preset: NarrativePreset | null | undefined): boolean {
  if (!preset) return false
  if (preset.entries?.length) {
    // 勾着 `other` 类不算 —— 那些本来就不注入
    return preset.entries.some(e => e.enabled && e.kind !== 'other' && e.content.trim())
  }
  return Boolean(preset.rules.trim() || preset.style.trim())
}

/**
 * 把一套文风选择拼成一段正文。
 *
 * 顺序是**核心 → 附加 → 基础 → 纠偏**：模型读到的最后一段印象最深，
 * 而纠偏器（抗升华、对白强化）最该被记住 —— 它们治的都是"读着读着就犯"的毛病。
 */
export function renderStyleChoice(choice: StyleChoice | null | undefined): string {
  if (!choice) return ''
  return chosenStyleIds(choice)
    .map(id => styleById(id))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map(s => s.text)
    .join('\n\n')
}

/**
 * 选择里的**真冲突**（不是风格偏好，是语义打架）。
 *
 * 例：`📖 西式文学` 要"轻微翻译腔"，`✅基础文风` 明写"杜绝欧化句式"。
 * 两条同时注入，模型只能挑一边 —— 于是同一份提示词里出现自相矛盾的要求，
 * 而玩家看到的是"AI 怎么忽冷忽热"。
 *
 * 只在 UI 提示，不自动取消：那是玩家自己的选择，但得知道自己在选什么。
 */
export function styleConflicts(choice: StyleChoice | null | undefined): { a: string; b: string }[] {
  if (!choice) return []
  const ids = new Set(chosenStyleIds(choice))
  const out: { a: string; b: string }[] = []
  for (const id of ids) {
    const s = styleById(id)
    if (!s?.conflicts) continue
    for (const other of s.conflicts) {
      // 只报一次（A→B 与 B→A 不重复）
      if (!ids.has(other)) continue
      const o = styleById(other)
      if (!o) continue
      const key = [s.id, o.id].sort().join('|')
      if (out.some(x => [styleById(x.a)?.id, styleById(x.b)?.id].sort().join('|') === key)) continue
      out.push({ a: s.name, b: o.name })
    }
  }
  return out
}

/** 给 UI 用的一句话摘要 */
export function describeNarrativePreset(preset: NarrativePreset): string {
  // 有逐条清单时按**实际勾选**报，而不是报导入时那一瞬间的数字
  if (preset.entries?.length) {
    const stats = presetEntryStats(preset)
    const on = stats.rules.on + stats.style.on + stats.tail.on + stats.other.on
    const chars = stats.rules.chars + stats.style.chars + stats.tail.chars
    const tailNote = stats.tail.on ? `（其中贴尾 ${stats.tail.on} 条）` : ''
    return `${on}/${preset.entries.length} 条勾选 · 每轮注入 ${chars} 字${tailNote}`
  }
  const { counts } = preset
  const parts = [
    `${counts.total} 条启用条目`,
    `规则 ${preset.rules.replace(/\n\n（另有[\s\S]*$/, '').length} 字`,
    `文风 ${preset.style.replace(/\n\n（另有[\s\S]*$/, '').length} 字`,
  ]
  if (counts.dropped.length) parts.push(`超预算 ${counts.dropped.length} 条`)
  return parts.join(' · ')
}

/**
 * 这份预设里有没有**会跟本作打架**的东西。
 *
 * ## 为什么要主动说，而不是让玩家自己踩
 *
 * 这些预设是给 SillyTavern 写的，那边的输出管道与本作完全不同：
 *
 *  - **思维链前缀**：作者要求模型先输出 `<think>` / `<｜begin▁of▁thinking｜>`。
 *    在本作里这些标签不会被摘掉，会**原样出现在正文里** ——
 *    玩家看到的是"AI 又把思考过程漏出来了"，而那其实是预设要求的。
 *  - **状态栏 / 行动选项**：ST 靠这些面板显示数值，本作自己的界面已经有了，
 *    叠一份只会出现两套。
 *  - **`{{user}}` / `{{char}}`**：本作不替换 ST 宏，会原样发给模型。
 *
 * 全部只在**展开后提示**，不做拦截：那是作者的内容，删不删由玩家决定。
 */
export function presetWarnings(preset: NarrativePreset): string[] {
  /*
    只看**勾着的**条目：玩家已经把「思维链格式」那条关掉了，
    还弹一句"它可能污染正文"就是在骗他关错了。
  */
  const text = preset.entries?.length
    ? `${renderPresetEntries(preset, 'rules')}\n${renderPresetEntries(preset, 'style')}`
    : `${preset.rules}\n${preset.style}`
  const out: string[] = []
  if (/<think>|<thinking>|begin▁of▁thinking|思考格式/.test(text)) {
    out.push('含思维链格式要求（<think> 等）：这些标签在本作不会自动摘掉，可能漏进正文。发现正文被污染就关掉这份，或删掉那一条。')
  }
  if (/StatusBlock|状态栏|<SUOT>|行动选项|信息面板/.test(text)) {
    out.push('含状态栏 / 行动选项格式：本作界面自己会出这些，叠一份可能出现两套。')
  }
  if (/\{\{(?:user|char)\}\}/.test(text)) {
    out.push('含 {{user}} / {{char}}：本作不替换 ST 宏，会原样发给模型，需要的话自己替换成具体称呼。')
  }
  return out
}
