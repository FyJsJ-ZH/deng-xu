/**
 * 世界书检索的**体量对比**：同一份世界、同一个情境，段级 vs 整章注入。
 *
 * ## 为什么需要这个工具
 *
 * 段级检索（`digestLore` 从"整章"降到"段"）改完之后，
 * **单元测试只能证明逻辑对，证明不了效果**：它不会告诉你九部真实世界
 * 到底省了多少、有没有哪一部完全没生效。
 *
 * 而它确实有一部没生效 ——《中帝纪年》20 章整整 20 段，章内一个空行都没有。
 * 那种事只有拿全部真实数据跑一遍才看得见。
 *
 * ## 跑法
 *
 * ```
 * npm run check:lore
 * ```
 *
 * 输出每个世界 × 三种情境的「章级字数 → 段级字数」，最后给合计比例。
 * 判断标准：
 *  - 合计应在 **50% 左右**（省一半是正常的）；
 *  - 某一部若接近 100%，说明它章内没有分段 —— 去查 `splitParagraphs` 的第二级切分。
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(root, '.check', 'lore-compare-entry.mjs')

await build({
  stdin: {
    contents: `
      export { BUILTIN_WORLDS } from '@/data/builtinWorlds'
      export { digestLore, splitLore, splitParagraphs } from '@/utils/loreDigest'
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { '@': path.join(root, 'src') },
  logLevel: 'warning',
})

const { BUILTIN_WORLDS, digestLore, splitLore, splitParagraphs } = await import(pathToFileURL(outfile).href)

const cjk = (s) => (String(s || '').match(/[\u4e00-\u9fff]/g) || []).length

/** 每个世界取三种情境：氛围开篇 / 第一个开局素材 / 一个几乎不命中任何专名的短句 */
function contextsOf(w) {
  const out = []
  const atmo = String(w.story?.atmosphere || '').slice(0, 260)
  if (atmo) out.push(['氛围', atmo])
  const seeds = Object.values(w.story?.openingSeeds || {})
  if (seeds[0]) out.push(['开局素材', String(seeds[0]).slice(0, 300)])
  out.push(['短句', `我在${w.title}打听消息，问了一个价钱。`])
  return out.slice(0, 3)
}

let totalOld = 0
let totalNew = 0

for (const w of BUILTIN_WORLDS) {
  const chapters = splitLore(w.worldLore).filter((s) => s.title)
  const paraCount = chapters.reduce((n, c) => n + splitParagraphs(c.body).length, 0)
  console.log(`\n=== ${w.title} ===`)
  console.log(`  章 ${chapters.length} / 段 ${paraCount} / 正文 ${cjk(w.worldLore)} 字`)

  for (const [label, ctx] of contextsOf(w)) {
    // 不给 nouns：只看章节自带的检索键（这是最坏情况）
    const d = digestLore(w.worldLore, { context: ctx, nouns: [] })

    // 新行为：picked 里的段落
    const newCjk = d.picked.reduce((n, p) => n + cjk(p.body), 0)

    // 旧行为：picked 覆盖到的那些**整章**
    const chaptersHit = new Set(d.picked.map((p) => p.chapterIndex))
    let oldCjk = 0
    chapters.forEach((c, i) => {
      if (chaptersHit.has(i)) oldCjk += cjk(c.body)
    })

    totalOld += oldCjk
    totalNew += newCjk

    const ratio = oldCjk ? Math.round((newCjk / oldCjk) * 100) : 0
    console.log(
      `  [${label}] 章级 ${String(oldCjk).padStart(6)} 字 → 段级 ${String(newCjk).padStart(5)} 字` +
      `  (${ratio}%)  段数 ${d.picked.length}  落选章 ${d.rest.length}  命中 ${d.hits.slice(0, 4).join('/') || '无'}`,
    )
  }
}

const pct = totalOld ? Math.round((totalNew / totalOld) * 100) : 0
console.log(`\n\n合计：章级 ${totalOld} 字 → 段级 ${totalNew} 字  (${pct}%)`)
if (pct >= 90) {
  console.log('⚠️ 几乎没有省下来 —— 检查是不是有你那部世界章内没有分段')
}
