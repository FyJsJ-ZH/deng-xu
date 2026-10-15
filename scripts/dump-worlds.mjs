/**
 * 把九张内置世界卡的**背景槽位 + customStyle** 导成一份纯文本，供人工审阅。
 *
 * ```
 * pnpm dump:worlds      # → .check/worlds-survey.md
 * ```
 *
 * ## 为什么要有它（2026-10 第九轮）
 *
 * 这两样东西的问题都只有**摊开对比**才看得出来 ——
 * 单看一张卡永远觉得"写得挺好啊"：
 *
 *  · **文风同构**：九张卡的 `customStyle` 曾经**逐字共用**同一套骨架
 *    （【文风总纲】【可执行要求】【禁止事项】【可用句式】），
 *    内容各不相同而形式一模一样，玩家一眼就看穿是"一个模子里刻出来的"。
 *    所以脚本末尾专门打一张**分节骨架对照表** —— 九行都该是「(无标记)」。
 *  · **背景槽过具体**：选项 title 里有没有世界观专名（组织/派别/职官），
 *    逐槽列出来扫一遍最快。
 *
 * ⚠️ 加新的分节标记（或让某张卡回到模板写法）会让对照表出现文字，
 * 那就是要修的信号。
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const res = await build({
  entryPoints: [path.join(root, 'src/data/builtinWorlds.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  alias: { '@': path.join(root, 'src') },
  loader: { '.json': 'json' },
  logLevel: 'error',
})
const code = res.outputFiles[0].text
const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const worlds = mod.BUILTIN_WORLDS

const han = s => (String(s || '').match(/[\u4e00-\u9fff]/g) || []).length

const out = []
out.push('# 九张世界卡 · 背景槽位与文风全貌\n')
out.push(`世界数：${worlds.length}\n`)

for (const w of worlds) {
  out.push(`\n${'='.repeat(78)}`)
  out.push(`## ${w.title}   \`${w.id}\``)
  out.push(`tagline: ${w.tagline}`)
  out.push(`pov=${w.narrative?.pov} tense=${w.narrative?.tense} 目标字数=${w.narrative?.replyLength}`)
  out.push(`openerSlot=${JSON.stringify(w.story?.openerSlot)}  seeds=${Object.keys(w.story?.openingSeeds || {}).length}`)
  out.push(`atmosphere ${han(w.story?.atmosphere)} 汉字 / worldLore ${han(w.worldLore)} / rules ${han(w.rules)} / customStyle ${han(w.narrative?.customStyle)}`)

  out.push(`\n### 背景槽位（共 ${w.backgrounds?.length || 0} 槽，${(w.backgrounds || []).reduce((a, s) => a + s.options.length, 0)} 个选项）`)
  for (const slot of w.backgrounds || []) {
    out.push(`\n【槽位】${slot.label}   （${slot.options.length} 项）`)
    for (const o of slot.options) {
      const bonus = Object.entries(o.attributeBonus || {}).filter(([, v]) => v).map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`).join(' ')
      out.push(`  · ${o.id}  「${o.title}」`)
      out.push(`      ${(o.description || '').replace(/\n\s*/g, ' ')}`)
      if (bonus) out.push(`      加成: ${bonus}`)
    }
  }

  out.push(`\n### customStyle 全文（${han(w.narrative?.customStyle)} 汉字）`)
  out.push('```')
  out.push(String(w.narrative?.customStyle || '').trim())
  out.push('```')
}

const dest = path.join(root, '.check', 'worlds-survey.md')
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.writeFileSync(dest, out.join('\n'), 'utf8')
console.log('写入', dest)
console.log('字节', fs.statSync(dest).size)

// 顺带一张"同构度"速查表：每张卡的 customStyle 里出现了哪些分节标记
console.log('\n=== customStyle 分节骨架对照 ===')
const MARKS = ['【文风总纲】', '【可执行要求】', '【禁止事项】', '【可用句式】', '文风总纲', '禁止事项', '可用句式', '可执行要求', '##', '【节奏】']
for (const w of worlds) {
  const s = w.narrative?.customStyle || ''
  const hit = MARKS.filter(m => s.includes(m))
  console.log(`${(w.title || '').padEnd(22, '　')} ${hit.join(' ') || '(无标记)'}`)
}
