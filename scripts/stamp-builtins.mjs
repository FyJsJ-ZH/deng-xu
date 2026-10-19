/**
 * 给内置世界卡盖一个**内容指纹**，生成 `src/data/builtinStamp.ts`。
 *
 * ## 为什么需要这个东西（2026-10 第十一轮，玩家第三次说「改了没生效」）
 *
 * 玩家的原话：
 * > 「我打开网页用起来输出的字数没变化，世界书设定内的叙事参数……依然是 800 字」
 *
 * 查下来**不是构建的问题，也不是缓存的问题** —— 是 `stores/library.ts` 里那条：
 *
 *     const missing = missingBuiltinIds(已有 id, 删过的 id)
 *     if (firstRun || missing.length) { 补卡 }
 *
 * 它只补「**缺 id**」的卡。而老玩家库里 `builtin_london1905` 这个 id 一直都在，
 * 于是这张卡**永远停在第一次播种时的样子**：我在源码里把 `replyLength` 改成 1800、
 * 线上 bundle 里也确实写着 1800，可他浏览器 IndexedDB 里那张卡还是 800。
 *
 * 修法是给内置卡一个**内容指纹**：指纹变了就整批刷新（保留玩家删过的那几张、
 * 保留他自己建的卡）。指纹必须**由内容算出来**，不能靠人手记得去改一个版本号 ——
 * 手动的版本号迟早会忘，而忘了的表现正是"改了没生效"，跟没改一样。
 *
 * ## 用法
 *
 *   node scripts/stamp-builtins.mjs          # 按当前九张卡重算并写入
 *
 * `package.json` 的 `dev` 与 `build` 都会先跑它，所以正常开发不用手动执行；
 * 只有在**改了 `src/data/worlds/*` 之后想立刻看到 stamp 文件变化**时才需要单独跑。
 * `src/data/builtinWorldIds.test.ts` 有一条断言盯着"stamp 必须等于内容指纹"，
 * 忘了跑也不会静默漂移。
 */

import { build } from 'esbuild'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const tmpDir = path.join(root, '.check')
const tmpBundle = path.join(tmpDir, 'stamp-worlds.mjs')
const outFile = path.join(root, 'src', 'data', 'builtinStamp.ts')

/**
 * 与测试里共用同一套算法：整张卡序列化后取 sha256 前 12 位。
 * （测试里没有 import 这个文件 —— 它顶层就会执行打包。那边重写了同样的两行，
 *  一旦两边算法漂开，stamp 断言会立刻红，比"两处都能改、改漏一处"安全。）
 */
function fingerprintOf(worlds) {
  const h = crypto.createHash('sha256')
  h.update(JSON.stringify(worlds))
  return h.digest('hex').slice(0, 12)
}

fs.mkdirSync(tmpDir, { recursive: true })

await build({
  entryPoints: [path.join(root, 'src', 'data', 'builtinWorlds.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: tmpBundle,
  alias: { '@': path.join(root, 'src') },
  logLevel: 'error',
})

const mod = await import(pathToFileURL(tmpBundle).href)
const worlds = mod.BUILTIN_WORLDS
if (!Array.isArray(worlds) || !worlds.length) {
  console.error('× 没能从 builtinWorlds.ts 里读到 BUILTIN_WORLDS')
  process.exit(1)
}

const fp = fingerprintOf(worlds)

const next = `/**
 * 内置世界卡的**内容指纹** —— 由 \`scripts/stamp-builtins.mjs\` 生成，**不要手改**。
 *
 * 用途：\`stores/library.ts\` 拿它跟 IndexedDB 里存的那份比对。
 * 不一致就说明「内置卡在源码里改过了」，于是把已有的内置卡整批换成新的 ——
 * 没有这一步，老玩家的库里那张卡会永远停在第一次播种时的样子
 * （2026-10 的一轮里，\`replyLength\` 从 800 改成 1800，线上 bundle 是新的、
 * 玩家看到的却还是 800，就是这个原因）。
 *
 * 它只覆盖**内置卡**：玩家自建的卡不动，玩家主动删过的内置卡也不会因为换戳而复活。
 *
 * 重新生成：\`node scripts/stamp-builtins.mjs\`（\`dev\` / \`build\` 会自动跑）。
 */
export const BUILTIN_STAMP = '${fp}'
`

const prev = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
if (prev === next) {
  console.log(`= 内置卡指纹未变：${fp}`)
} else {
  fs.writeFileSync(outFile, next, 'utf8')
  console.log(`✓ 内置卡指纹已更新：${fp}（${worlds.length} 张卡）`)
}
