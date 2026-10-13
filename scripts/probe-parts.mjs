/**
 * 【工具】部件对比图 —— 同一个角色换不同的部件，并排渲染出来看。
 *
 * ## 为什么需要它
 *
 * 「描述里的某个词到底该选哪个部件」是**视觉问题**，靠读 id 名字猜必然出错。
 * 2026-10 的真实教训：某角色写「黑色**丝袍**」，作者填了 `dress_bodice_black` ——
 * 名字里带着 `dress`，看着像袍，实际是**紧身胸衣**（bodice）。
 * `check:sprites` 全绿（id 存在、类别匹配），画出来却是个只穿内衣的魔王。
 *
 * 同理，大晟七位官员的「束发戴冠」填的是 `hat_formal_crown`（**西式尖顶王冠**），
 * 而部件池里没有幞头/冕冠 —— 这类判断只有看图才能做。
 *
 * ## 用法
 *
 *   node scripts/probe-parts.mjs                                  # 用内置的三组默认对比
 *   node scripts/probe-parts.mjs --field=hat --values=a,b,c       # 换 hat 的候选
 *   node scripts/probe-parts.mjs --field=torso --values=x,y --cloth=black
 *   node scripts/probe-parts.mjs --hair=a,b --values=...          # 任意 look 字段
 *
 * 出图在 `playtest-shots/probe-parts.png`，用 `read_image` 看。
 *
 * ## 与 `check:sprites` 的分工
 *
 * `check:sprites` 查**能机检的错**（id 不存在、字段与类别不匹配、颜色键不在调色板里、
 * 固定色件导致颜色失效）；这个工具负责**机检查不出的那一类**（语义选错件）。
 * 两者都不能省。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { installDomShim, decodePng, encodePng } from './lib/canvas-shim.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const out = path.join(ROOT, '.check', 'probe-parts-bundle.mjs')

// ── 参数 ──
const argv = process.argv.slice(2)
const val = (n, d) => { const h = argv.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d }

const lpcPartsPlugin = {
  name: 'lpc-parts',
  setup(build) {
    build.onResolve({ filter: /^virtual:lpc-parts$/ }, () => ({ path: 'lpc-parts', namespace: 'lpc-parts' }))
    build.onLoad({ filter: /.*/, namespace: 'lpc-parts' }, () => {
      const dir = path.join(ROOT, 'src', 'assets', 'lpc', 'parts')
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort()
      const entries = files.map(f => `  ${JSON.stringify('./parts/' + f)}: ${JSON.stringify(path.join(dir, f))},`)
      return { contents: `export default {\n${entries.join('\n')}\n}\n`, loader: 'js' }
    })
  },
}
const globReplacePlugin = {
  name: 'replace-import-meta-glob',
  setup(build) {
    build.onLoad({ filter: /lpcSprite\.ts$/ }, args => {
      let src = fs.readFileSync(args.path, 'utf8')
      let replaced = false
      src = src.replace(/import\.meta\.glob\(\s*['"][^'"]*parts\/\*\.png['"][\s\S]*?\)/m,
        () => { replaced = true; return 'LPC_PART_URLS' })
      if (!replaced) return { contents: src, loader: 'ts' }
      return { contents: `import LPC_PART_URLS from 'virtual:lpc-parts'\n${src}`, loader: 'ts', resolveDir: path.dirname(args.path) }
    })
  },
}
await esbuild.build({
  entryPoints: [path.join(ROOT, 'scripts', 'lib', 'render-entry.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  alias: { '@': path.join(ROOT, 'src') },
  loader: { '.json': 'json', '.png': 'file' },
  plugins: [lpcPartsPlugin, globReplacePlugin], logLevel: 'error',
})
installDomShim()
const M = await import('file://' + out.replace(/\\/g, '/'))

/** 一具"中年男子"的底子，只换被测字段 */
const BASE = {
  head: 'heads_human_male', hair: 'hair_topknot_long', hairColor: 'black', skin: 'light',
  torso: 'torso_clothes_robe', clothColor: 'purple', legs: 'legs_pants',
  feet: 'feet_shoes_basic', eye: 'brown',
}

const FIELD = val('field')
const VALUES = (val('values') || '').split(',').map(s => s.trim())
const CLOTH = val('cloth')

/** 默认三组：都是这一轮真实踩过的坑 */
const ROWS = FIELD && VALUES.length
  ? [{ field: FIELD, label: `${FIELD} 候选`, values: VALUES }]
  : [
      {
        field: 'hat', label: '大晟官员的「束发戴冠」（部件池没有幞头/冕冠）',
        values: ['hat_formal_crown', 'hat_magic_celestial', 'hat_headband_thick', 'hat_headband_tied', 'hat_accessory_crest', ''],
      },
      {
        field: 'torso', label: '「黑色丝袍 / 长裙」（bodice 是胸衣，不是袍）',
        values: ['torso_clothes_robe', 'dress_bodice_black', 'dress_sash_black', 'dress_slit_black', 'torso_clothes_longsleeve2', 'torso_clothes_longsleeve_formal'],
      },
      {
        field: 'torso', label: '「轻薄纱衣」（白）',
        values: ['torso_clothes_robe', 'dress_bodice_white', 'dress_sash_white', 'dress_slit_white', 'torso_clothes_longsleeve', 'torso_clothes_sleeveless1'],
      },
    ]

const cells = []
for (const row of ROWS) {
  for (const v of row.values) {
    const look = { ...BASE, [row.field]: v }
    if (CLOTH) look.clothColor = CLOTH
    else if (row.field === 'torso') look.clothColor = row.label.includes('白') ? 'white' : 'black'
    const url = await M.spriteDataUrl(`probe-${row.field}-${v}`, '', { scale: 3, look })
    cells.push({ src: url, tag: v || '(留空)', row: row.label })
  }
}

const cols = 6
const cellW = 150, cellH = 300, gap = 6
const rows = Math.ceil(cells.length / cols)
const W = cols * cellW + (cols + 1) * gap
const H = rows * cellH + (rows + 1) * gap
const px = Buffer.alloc(W * H * 4)
for (let i = 0; i < W * H; i++) { px[i * 4] = 26; px[i * 4 + 1] = 26; px[i * 4 + 2] = 30; px[i * 4 + 3] = 255 }

cells.forEach((cell, i) => {
  const col = i % cols, row = Math.floor(i / cols)
  const ox = col * cellW + (col + 1) * gap
  const oy = row * cellH + (row + 1) * gap
  const { width, height, rgba } = decodePng(Buffer.from(cell.src.slice(cell.src.indexOf(',') + 1), 'base64'))
  const scale = Math.min(cellW / width, (cellH - 20) / height)
  const dw = Math.round(width * scale), dh = Math.round(height * scale)
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const s = (Math.min(height - 1, Math.floor(y * height / dh)) * width + Math.min(width - 1, Math.floor(x * width / dw))) * 4
      const tx = ox + Math.floor((cellW - dw) / 2) + x
      const ty = oy + y
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue
      const d = (ty * W + tx) * 4
      const a = rgba[s + 3] / 255
      px[d] = Math.round(rgba[s] * a + px[d] * (1 - a))
      px[d + 1] = Math.round(rgba[s + 1] * a + px[d + 1] * (1 - a))
      px[d + 2] = Math.round(rgba[s + 2] * a + px[d + 2] * (1 - a))
      px[d + 3] = 255
    }
  }
})

const file = path.join(ROOT, 'playtest-shots', 'probe-parts.png')
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, encodePng(W, H, px))
console.log(`\n=== 部件对比图（${cols} 列）===\n`)
cells.forEach((c, i) => {
  if (i % cols === 0) console.log(`  ${c.row}`)
  console.log(`    ${String((i % cols) + 1)}. ${c.tag}`)
})
console.log(`\n  ✓ ${file}`)
console.log(`  用 read_image 看它，判"哪个件才像描述里那件"。\n`)
