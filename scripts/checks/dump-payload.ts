/**
 * 把**这一轮真正发出去的请求体**摊开（2026-11）。
 *
 * ## 为什么需要它
 *
 * 破甲/格式「时有时无」这件事，查到最后总是同一句话：
 * **你看不到实际发出去的东西**。界面上只有一句"输入 3.2 万字"，
 * 而真正决定模型行为的，是那 3.2 万字里**谁在第几行**。
 *
 * 这个脚本用一份预设 + 一个示例世界卡，复刻 `useGameEngine` 的组装顺序，
 * 把完整消息数组打出来：
 *
 *   - 每条的 role / 字数 / 开头
 *   - 破甲与格式条目落在第几条、离生成点多少字符
 *   - 完整 JSON 存到 `.check/payload.json`（可以直接贴给别处分析）
 *
 * ## 用法
 *
 * ```bash
 * node .check/dump-payload.mjs <预设文件.json> [--json]
 * ```
 *
 * 预设可以是灯叙导出包，也可以是 SillyTavern 预设。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { buildNarrativePromptParts } from '@/constants/prompts'
import { renderPresetTail, renderPresetEntries, stripScriptNoise, slimTailEntries } from '@/utils/narrativePreset'
import { stPresetToNarrativePreset, isSillyTavernPreset } from '@/utils/stPreset'
import { DEFAULT_ANTI_ROUTE } from '@/utils/antiRoute'
import type { ChatMessage } from '@/api/llm'
import type { NarrativePreset, PlayerCard, WorldCard } from '@/types/cards'

const path = process.argv[2] || process.env.PRESET_PATH
const wantJson = process.argv.includes('--json')
if (!path) {
  console.error('用法：node .check/dump-payload.mjs <预设文件.json> [--json]')
  process.exit(1)
}

/* ── 读预设（两种格式都认）── */
const raw = JSON.parse(readFileSync(path, 'utf8'))
let preset: NarrativePreset | null = null
if ((raw as { format?: string }).format === 'deng-xu-narrative-presets') {
  preset = (raw as { presets: NarrativePreset[] }).presets[0] ?? null
} else if (isSillyTavernPreset(raw)) {
  preset = stPresetToNarrativePreset(raw, 'preset.json')
}

/* ── 示例世界卡：故意带一条会跟预设打架的规则 ── */
const world: WorldCard = {
  id: 'dump', title: '示例世界', tagline: '',
  worldLore: '一座靠海的镇子，冬天潮气重，墙根常年发霉。'.repeat(6),
  rules: '叙事保持冷静克制，不写露骨细节。',
  attributes: [], resources: [], backgrounds: [], attributePoints: 0,
  items: [], lores: [],
  story: {
    atmosphere: '潮湿、低哑', mainQuest: '', enableStages: false, stages: [],
    enableChoices: true, urgencyAfterTurns: 0, openerSlot: '', openingSeeds: {},
  },
  narrative: { pov: 'third', tense: 'present', replyLength: 1800, customStyle: '短句为主。' },
  characters: [], enableMechanics: false,
  avatarStyle: 'ink', avatarTone: '#000',
  createdAt: 0, updatedAt: 0,
}

const player: PlayerCard = {
  name: '沈砚', gender: '男', age: '三十',
  appearance: '左眉上有道旧疤', personality: '话少', background: '', extra: '',
}

/* ── 六轮历史：与 useGameEngine 的 .slice(-6) 一致 ── */
const history: ChatMessage[] = []
for (let i = 1; i <= 6; i++) {
  history.push({ role: 'user', content: `第 ${i} 轮：他沿着码头往回走。` })
  history.push({ role: 'assistant', content: `第 ${i} 轮正文。${'潮水一下一下拍在木桩上。'.repeat(40)}` })
}

const ACTION = '他推开那扇门。'

/* ── 复刻 useGameEngine 的组装 ── */
// 先跑一次瘦身迁移，与刷新页面后库里的真实状态一致
const slimmed = preset ? slimTailEntries([preset]).presets[0] : null
const presetTail = slimmed ? renderPresetTail(slimmed) : ''
const antiRoute = { ...DEFAULT_ANTI_ROUTE, know: 'lite' as const, charm: 'lite' as const, trunc: 'lite' as const }
const { system, tail } = buildNarrativePromptParts(world, [], player, {
  antiRoute,
  turnSeed: 't7|dump',
  presetTail,
  chapter: 0,
})

const messages: ChatMessage[] = [
  { role: 'system', content: system },
  { role: 'system', content: `[前情摘要]\n${'他在镇上住了三个月。'.repeat(30)}` },
  { role: 'system', content: `[长期记忆]\n${'老周欠他一顿酒。'.repeat(20)}` },
  ...history,
  ...(tail ? [{ role: 'system' as const, content: tail }] : []),
  { role: 'user', content: ACTION },
  { role: 'assistant', content: '\u3000' }, // prefill
]

/* ── 报表 ── */
const full = messages.map(m => m.content).join('\n')

function where(needle: string): string {
  let offset = 0
  for (let i = 0; i < messages.length; i++) {
    const at = messages[i].content.indexOf(needle)
    if (at >= 0) {
      const before = full.length - full.indexOf(needle, offset) - needle.length
      return `第 ${i} 条（${messages[i].role}）· 之后还要读 ${before} 字符`
    }
    offset += messages[i].content.length
  }
  return '（不在里面）'
}

console.log('')
console.log('═'.repeat(74))
console.log(`预设：${preset?.name ?? '（没认出来，只有本作提示词）'}`)
console.log('═'.repeat(74))
console.log('')
console.log('消息数组：')
console.log('  序 | role      | 字数  | 开头')
console.log('  ' + '-'.repeat(66))
messages.forEach((m, i) => {
  const head = m.content.replace(/\s+/g, ' ').slice(0, 38)
  const mark = m.content === tail ? '  ← 贴尾'
    : (i === messages.length - 1 && m.role === 'assistant') ? '  ← prefill'
    : ''
  console.log(
    '  ' + String(i).padStart(2) + ' | '
    + m.role.padEnd(9) + ' | '
    + String(m.content.length).padStart(5) + ' | '
    + head + mark,
  )
})

console.log('')
console.log('关键内容落在哪儿：')
const probes: Array<[string, string]> = [
  ['破甲词（召唤术）', '条条框框'],
  ['破甲词（照写不误）', '照写不误'],
  ['尺度声明', '【尺度】'],
  ['格式优先', '【格式优先】'],
  ['加固层', '【视角与认知】'],
  ['世界规则', '冷静克制'],
]
for (const [label, needle] of probes) {
  if (!needle) continue
  const clean = stripScriptNoise(needle)
  if (!clean || !full.includes(clean)) { console.log(`  ${label.padEnd(12)} （不在里面）`); continue }
  console.log(`  ${label.padEnd(12)} ${where(clean)}`)
}

console.log('')
console.log(`合计 ${messages.length} 条消息 / ${full.length} 字符 / ${new TextEncoder().encode(JSON.stringify(messages)).length} 字节`)

if (wantJson) {
  const body = {
    model: 'MODEL_HERE',
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    stream: false,
    max_tokens: 8192,
    ...(preset?.sampling ? {
      temperature: (preset.sampling as { temperature?: number }).temperature,
      top_p: (preset.sampling as { topP?: number }).topP,
      stop: (preset.sampling as { stop?: string[] }).stop,
    } : {}),
  }
  writeFileSync('.check/payload.json', JSON.stringify(body, null, 2), 'utf8')
  console.log('')
  console.log('完整请求体已写到 .check/payload.json（把 MODEL_HERE 换成模型名就能直接发）')
}
