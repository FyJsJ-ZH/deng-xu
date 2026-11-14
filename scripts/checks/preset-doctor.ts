/**
 * 预设体检器（2026-11）。
 *
 * ## 为什么要有它
 *
 * 玩家原话：「我现在在用这个预设，但预设效果（比如格式，破甲）仍然时有时无，找出问题」。
 *
 * 「时有时无」是最难查的一类症状 —— 它不在界面上，不在报错里，只在
 * **这一轮实际发出去的提示词**里。这个脚本把那份提示词拆开，逐项报：
 *
 *  1. 每条条目落在哪一档、多少字、勾没勾；
 *  2. 贴尾段拼起来多少字、有没有超预算、**哪几条被整条跳过**；
 *  3. 还有没有酒馆脚本的注册语法（`<<<|catgodml|...>>>`）没剥掉 ——
 *     那是"格式时有时无"最常见的原因；
 *  4. 有没有互斥档位同时勾着（作者用「选一」「|」标出来的那些）；
 *  5. 最终贴尾段的全文。
 *
 * ## 用法
 *
 * ```bash
 * node .check/preset-doctor.mjs <预设文件.json>
 * # 或者
 * node .check/preset-doctor.mjs            # 读 PRESET_PATH 环境变量
 * ```
 *
 * 认三种输入：灯叙导出包（`format: deng-xu-narrative-presets`）、
 * SillyTavern 预设（`prompts` + `prompt_order`）、单条预设对象。
 */
import { readFileSync } from 'node:fs'
import {
  renderPresetTailDetail,
  presetEntryStats,
  hasScriptNoise,
  stripScriptNoise,
  slimTailEntries,
  JAILBREAK_CONTENT_RE,
  TAIL_CONTENT_MAX,
  TAIL_FORMAT_HINT_RE,
  TAIL_NAME_JAIL_RE,
  TAIL_NAME_FORMAT_RE,
} from '@/utils/narrativePreset'
import { stPresetToNarrativePreset, isSillyTavernPreset } from '@/utils/stPreset'
import type { NarrativePreset, PresetEntry } from '@/types/cards'

const path = process.argv[2] || process.env.PRESET_PATH
if (!path) {
  console.error('用法：node .check/preset-doctor.mjs <预设文件.json>')
  process.exit(1)
}

const raw = JSON.parse(readFileSync(path, 'utf8'))

/** 把三种输入统一成一份或多份 `NarrativePreset` */
function loadPresets(): { name: string; preset: NarrativePreset }[] {
  const asPack = raw as { format?: string; presets?: unknown }
  if (asPack?.format === 'deng-xu-narrative-presets' && Array.isArray(asPack.presets)) {
    return (asPack.presets as NarrativePreset[])
      .filter(p => p && typeof p.name === 'string')
      .map(p => ({ name: p.name, preset: p }))
  }
  if (isSillyTavernPreset(raw)) {
    const p = stPresetToNarrativePreset(raw, path.split(/[\\/]/).pop() || 'preset.json')
    return p ? [{ name: p.name, preset: p }] : []
  }
  const single = raw as NarrativePreset
  if (Array.isArray(single.entries)) return [{ name: single.name || '（未命名）', preset: single }]
  return []
}

/** 作者用这些写法标出"互斥档位" */
const EXCLUSIVE_HINT = /选一|\|/g

function checkExclusive(preset: NarrativePreset): string[] {
  const on = (preset.entries || []).filter(e => e.enabled && EXCLUSIVE_HINT.test(e.name))
  // 每重启一次 regex 的 lastIndex
  for (const e of preset.entries || []) EXCLUSIVE_HINT.lastIndex = 0
  if (on.length < 2) return []
  // 按"去掉档位后缀"的名字分组，同组超过一条就是打架
  const groups = new Map<string, string[]>()
  for (const e of on) {
    const key = e.name.replace(/[丨|].*$/, '').replace(/（选一）|\(选一\)/g, '').trim()
    const list = groups.get(key) ?? []
    list.push(e.name)
    groups.set(key, list)
  }
  const out: string[] = []
  for (const [key, list] of groups) {
    if (list.length > 1) out.push(`「${key}」这一组同时勾了 ${list.length} 条：${list.join(' / ')}`)
  }
  return out
}

const presets = loadPresets()
if (!presets.length) {
  console.error('认不出这个文件的格式（既不是灯叙导出包，也不是 ST 预设）。')
  process.exit(1)
}

let problems = 0

for (const { name, preset } of presets) {
  console.log('')
  console.log('═'.repeat(74))
  console.log(`《${name}》  source=${preset.source || '（无）'}`)
  console.log('═'.repeat(74))

  const entries = [...(preset.entries || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  if (!entries.length) {
    console.log('  没有逐条清单（旧版导入），只能整块注入。重新导入一次才能体检。')
    continue
  }

  const stats = presetEntryStats(preset)
  console.log('')
  console.log(`  条目 ${entries.length} 条 · 启用 ${stats.rules.on + stats.style.on + stats.tail.on + stats.other.on} 条`)
  console.log(`  规则 ${stats.rules.on} / 文风 ${stats.style.on} / 贴尾 ${stats.tail.on} / 存档 ${stats.other.on}`)

  console.log('')
  console.log('  序 | 落点  | 勾 | 字数 | 名字')
  console.log('  ' + '-'.repeat(70))
  for (const e of entries) {
    const noise = hasScriptNoise(e.content) ? ' ⚠脚本' : ''
    console.log(
      '  ' + String(e.order ?? '-').padStart(2) + ' | '
      + String(e.kind).padEnd(5) + ' | '
      + (e.enabled ? '✓' : '·') + ' | '
      + String(stripScriptNoise(e.content).length).padStart(4) + ' | '
      + e.name + noise,
    )
  }

  /* ── 贴尾段 ── */
  const tail = renderPresetTailDetail(preset)
  console.log('')
  console.log('  ── 贴尾段 ──')
  console.log(`  进了 ${tail.used.length} 条，共 ${tail.text.length} 字（预算 4000）`)
  if (tail.skipped.length) {
    problems++
    console.log(`  ✗ 超预算被**整条跳过** ${tail.skipped.length} 条：`)
    for (const e of tail.skipped) console.log(`      · ${e.name}（${e.content.length} 字）`)
    console.log('    这些内容这一轮不会到模型手上。要么取消勾选别的，要么把它们改成 rules。')
  } else {
    console.log('  ✓ 全部装下了，没有条目被跳过')
  }
  if (tail.text.length > 3600) {
    console.log(`  ⚠ 贴尾段已经 ${tail.text.length} 字。它靠"离生成点近"吃饭，不是靠内容多 ——`)
    console.log('    超过三千字就退化成第二个 system，前面那些条目会互相稀释。')
  }

  /* ── 脚本语法 ── */
  const noisy = entries.filter(e => e.enabled && hasScriptNoise(e.content))
  console.log('')
  if (noisy.length) {
    console.log(`  ⚠ 还有 ${noisy.length} 条带酒馆脚本文法（渲染时会被剥掉，但库里的原文还是脏的）：`)
    for (const e of noisy) console.log(`      · ${e.name}`)
    console.log('    已剥的那部分不会发给模型；如果这些条目在酒馆里还依赖脚本开关，')
    console.log('    那么"它们什么时候生效"在灯叙里没有对应机制 —— 一律按勾选算。')
  } else {
    console.log('  ✓ 没有脚本文法残留')
  }

  /* ── 互斥档位 ── */
  const conflicts = checkExclusive(preset)
  console.log('')
  if (conflicts.length) {
    problems++
    console.log('  ✗ 互斥档位同时开着（作者用「选一」或「|」标的那些）：')
    for (const c of conflicts) console.log(`      · ${c}`)
    console.log('    两条互相打架的指令同时注入，模型只能挑一边 —— 这就是"文风忽冷忽热"。')
  } else {
    console.log('  ✓ 没有同一组里勾了两条的情况')
  }

  /* ── 模拟：按**当前判据**重推一遍应该怎么分档 ── */
  console.log('')
  console.log('  ── 按当前判据重推（不改变库里的数据，只算给你看）──')
  const wouldBeTail = (e: PresetEntry): boolean => {
    if (!e.enabled) return false
    const body = stripScriptNoise(e.content).trim()
    if (!body) return false
    if (TAIL_NAME_JAIL_RE.test(e.name)) return true
    if (TAIL_NAME_FORMAT_RE.test(e.name)) return true
    if (body.length <= TAIL_CONTENT_MAX && JAILBREAK_CONTENT_RE.test(body)) return true
    return false
  }
  const shouldTail = entries.filter(wouldBeTail)
  const nowTail = entries.filter(e => e.enabled && e.kind === 'tail')
  const shouldId = new Set(shouldTail.map(e => e.id))
  const nowId = new Set(nowTail.map(e => e.id))
  const toRemove = nowTail.filter(e => !shouldId.has(e.id))
  const toAdd = shouldTail.filter(e => !nowId.has(e.id))
  const simLen = shouldTail.reduce((n, e) => n + stripScriptNoise(e.content).length + e.name.length + 5, 0)

  console.log(`  现在 ${nowTail.length} 条 / ${tail.text.length} 字　→　重推后 ${shouldTail.length} 条 / 约 ${simLen} 字`)
  if (toRemove.length) {
    console.log(`  该从贴尾退出去的 ${toRemove.length} 条：`)
    for (const e of toRemove) console.log(`      · ${e.name}（${stripScriptNoise(e.content).length} 字）`)
  }
  if (toAdd.length) {
    console.log(`  该补进贴尾的 ${toAdd.length} 条：`)
    for (const e of toAdd) console.log(`      · ${e.name}`)
  }
  if (!toRemove.length && !toAdd.length) console.log('  ✓ 分档已经是最优，无需重导')
  else console.log('  要让分档按新判据生效：重新导入一次原文件，或刷新页面让迁移跑一遍。')

  /* ── 贴尾段全文 ── */
  console.log('')
  console.log('  ── 贴尾段实际内容（前 1200 字）──')
  console.log('  ' + '-'.repeat(70))
  const body = tail.text.slice(0, 1200)
  for (const line of body.split('\n')) console.log('  ' + line)
  if (tail.text.length > 1200) console.log(`  …（余 ${tail.text.length - 1200} 字）`)
}

console.log('')
console.log('═'.repeat(74))
if (problems) {
  console.log(`发现 ${problems} 处需要注意的地方（上面标 ✗ 的）`)
  process.exitCode = 1
} else {
  console.log('没有发现结构性问题。')
}
