/**
 * ST 条目里的**噪音**：作者脚手架、变量系统、无意义标题。
 *
 * ## 为什么单独一个文件（2026-11 第二十六轮）
 *
 * 这三样东西在两个地方都要处理：
 *  · `stLorebook.ts` —— 游戏内导入（PNG 卡 / 世界书 JSON）
 *  · `scripts/st-card-to-world.mjs` —— 命令行批量转换
 *
 * 两边各写一份必然漂移，而漂移的后果是"我在命令行看到的是干净的，
 * 拖进游戏里又脏了"。所以规则只写一次。
 *
 * ## 每一样都来自实测
 *
 * 拿一张真实的 `chara_card_v3` 修仙卡（150 条、15.7 万字）跑出来的：
 *
 * 1. **脚手架话术**：几十条「模拟采访」的正文都以同一句开头
 *    「注意，以下是对该角色的模拟采访…」。它出现在几十个段落的开头，
 *    `loreDigest` 的关键词打分会被它反复命中 —— 一轮注入 1.6 万字里
 *    一半是这同一句话，真正该出现的角色被挤出预算。
 * 2. **变量系统**：`[initvar]` / `[mvu_update]` 是给 ST 的扩展脚本用的。
 *    本作没有变量引擎，读进来只是噪音（而且它专门占着"每次回复必须输出 diff"的位置）。
 * 3. **无意义标题**：作者批量导入时把"说明"塞进了 `name`，
 *    于是二十几条条目的标题是同一句长话。标题要能当索引用。
 */

/**
 * 作者写进正文的脚手架。删掉不影响语义 —— 后面的正文才是内容。
 *
 * 只删**这两句固定文案**，不做通用的"看起来像说明就删"：
 * 那种规则会误伤真正的设定（很多世界设定本身就在解释机制）。
 */
const BOILERPLATE: RegExp[] = [
  /注意[，,]?\s*以下是对该角色的模拟采访[^。]*。[^。]*。/g,
  /采访内容作为对[^。]*。/g,
]

/** 清掉正文里的脚手架话术 */
export function stripStBoilerplate(text: string): string {
  let out = String(text || '')
  for (const re of BOILERPLATE) out = out.replace(re, '')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 是不是**变量系统**条目。
 *
 * `[initvar]` 是初始值表，`[mvu_update]` 是"每次回复必须输出一段变量 diff"的指令。
 * 两者都由 ST 的扩展脚本执行，本作没有对应机制。
 */
export function isStVariableEntry(name: string, content: string): boolean {
  const n = String(name || '')
  if (/\[initvar\]|\[mvu_update\]|^initvar|变量初始化|变量更新/i.test(n)) return true
  // 整条都是 {{setvar}} / JSONPatch 之类的壳
  const body = String(content || '').replace(/\{\{[^}]*\}\}/g, '').trim()
  return body.length < 40 && /setvar|JSONPatch|initvar/i.test(String(content || ''))
}

/**
 * 给条目起一个**能当索引用**的标题。
 *
 * 优先 `comment` / `name`，其次是第一个触发词，最后才用正文首行。
 * 那条"标题是一整句说明"的条目会被前两条挡住 —— 这正是它该被挡住的地方。
 */
export function pickStEntryTitle(
  entry: { name?: unknown; comment?: unknown; keys?: unknown; key?: unknown },
  content: string,
  index: number,
): string {
  const raw = String(entry.name || entry.comment || '').trim()
  const keys = Array.isArray(entry.keys) ? entry.keys : (Array.isArray(entry.key) ? entry.key : [])
  const key0 = String(keys[0] || '').trim()
  const unusable = (s: string) =>
    !s || s.length > 30 || /注意，以下|模拟采访|以下是对该角色|^条目\s*\d+$/.test(s)

  if (!unusable(raw)) return raw
  if (key0 && key0.length <= 30) return key0
  const firstLine = String(content || '').split('\n').map(s => s.trim()).find(Boolean) || ''
  return firstLine.slice(0, 20) || `条目 ${index + 1}`
}
