/**
 * 立绘一致性审计 —— `pnpm check:sprites`
 *
 * ## 为什么需要这个脚本
 *
 * 2026-10 玩家反馈：「人物立绘与描述的匹配程度仍然堪忧，**仅仅只是靠关键词来
 * 临时构筑人物立绘的错误率高到不必多说**」。
 *
 * 根因是方法论：原先走「中文描述 →291 个正则抽特征 → 从部件池里挑部件」两步猜测，
 * 而中文表述空间无穷、正则表有限，**错误率天生下不来**。
 *
 * 修法是让角色卡直接写**部件级**的外观（`CharacterCard.look` / `PlayerCard.look`），
 * 推断退化为兜底。但显式数据带来一个新风险：**写错的部件 id 不会报错，只会被静默忽略**，
 * 于是"我明明写了束发，怎么画出来是爆炸头"这类问题会重新出现 —— 只是更难查。
 *
 * 所以这个脚本专门盯住那类**静默失效**：
 *
 *  1. `look` 里的**部件 id 是否真实存在**（对着 runtime.json 的 246 个部件查）
 *  2. **颜色键是否真实存在**（对着 palettes.json 查）
 *  3. **`look` 与 `note` 是否自相矛盾** —— 例如 note 写"女子"而 head 填了 male、
 *     note 写"光头"却填了发型、note 写"胡须"却把 beard 写成空串
 *  4. **覆盖率** —— 哪些角色还没写 `look`（那些仍走关键词猜测，是"匹配度差"的高发区）
 *
 * 用法：
 *   node scripts/check-sprites.mjs            # 全部世界
 *   node scripts/check-sprites.mjs --json     # 机器可读
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const asJson = process.argv.includes('--json')

/*
  ── 载入素材目录（部件池 + 调色板）──

  ⚠️ 这一段**必须在打包世界卡之前**。理由不是性能，是可用性：
  它只读 `src/assets/lpc/*.json`，与世界卡无关；而下面的打包会**在失败时直接退出**
  （任何一张世界卡正在写、语法暂时不完整，都会走到那条路）。
  原先这段排在打包之后，于是"参考清单过期"这件事永远修不好 ——
  而清单过期正是它要解决的问题：照着旧清单写 `look`，写出来的是不存在的部件。
*/
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'src/assets/lpc/runtime.json'), 'utf8'))
const PARTS = runtime.parts || runtime.default?.parts || []
const PART_IDS = new Set(PARTS.map(p => p.id))
const PART_KIND = new Map(PARTS.map(p => [p.id, p.kind]))

const palettes = JSON.parse(fs.readFileSync(path.join(root, 'src/assets/lpc/palettes.json'), 'utf8')).palettes
const COLOR_KEYS = Object.fromEntries(
  Object.entries(palettes).map(([mat, map]) => [mat, new Set(Object.keys(map))]),
)

/*
  顺手刷新 `.check/LPC-PARTS.md`（函数声明在下面，hoisted；它引用的 PARTS / palettes
  此刻已经初始化完毕，不存在 TDZ 问题）。放在打包之前，是为了让这份参考文件
  在任何情况下都能被修好。
*/
const partsDoc = writePartsDoc()

/*
  ── 自己打包世界数据 ──
  这个脚本要在 CI 里独立跑，不能指望"别人先跑过 check:worlds"。
  ⚠️ `stdio: 'ignore'` 是必须的：在受限环境里用管道捕获 esbuild 输出会 EPERM
  （命名管道被禁），症状是 esbuild 明明能跑却报错 —— 这个坑项目里踩过（见 check-worlds.mjs 的注释）。
*/
/*
  ⚠️ `DX_WORLDS_BUNDLE` 环境变量可以把打包产物挪到别的路径。
  加这个口子是因为**多张世界卡可能正在被并行施工**：它们都要反复跑这个脚本，
  若共用一个 `.check/worlds-check.mjs`，就会互相覆盖对方的 bundle
  （表现为"我刚改的没生效"）。与 check-worlds.mjs 用同一个变量名。
*/
const BUNDLE = process.env.DX_WORLDS_BUNDLE
  ? path.resolve(root, process.env.DX_WORLDS_BUNDLE)
  : path.join(root, '.check', 'worlds-check.mjs')
{
  fs.mkdirSync(path.dirname(BUNDLE), { recursive: true })
  const esbuild = path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild')
  const r = spawnSync(process.execPath, [
    esbuild, 'src/data/builtinWorlds.ts',
    '--bundle', '--platform=node', '--format=esm',
    `--outfile=${path.relative(root, BUNDLE)}`,
    '--alias:@=./src', '--log-level=error',
  ], { cwd: root, stdio: 'ignore' })
  if (r.status !== 0 || !fs.existsSync(BUNDLE)) {
    console.error('esbuild 打包失败 —— 世界数据可能有语法错误。请先跑 `pnpm typecheck`。')
    process.exit(1)
  }
}

// ── 素材目录已在文件顶部载入（见那里的注释：必须早于打包）──

/** `look` 的每个字段应当指向哪一类部件（用于查"头发字段填了裤子 id"这种错） */
const FIELD_KIND = {
  head: 'head',
  hair: 'hair',
  torso: null,          // 上装可以是 clothes / armour / apron
  legs: 'legs',
  feet: 'shoes',
  hat: 'hat',
  beard: 'beard',
  cape: 'cape',
  arms: 'arms',
  brows: 'eyebrows',
  nose: 'nose',
  belt: null,           // accessory（belt_*）
}
/**
 * 会跟着 `look.hairColor` 换色的发型件（`recolors === 'hair'`）。
 *
 * ⚠️ 与衣服同一类陷阱，而且**更隐蔽**：`runtime.json` 的 67 个发型件里
 * 只有两个是固定色（`hair_long_tied` 与 `hair_pigtails`，颜色画死成**亮橙色**）——
 * 偏偏它们是最常用的两个通用发型。作者给角色写「黑发束成低马尾」
 * 并填 `hairColor: 'black'`，画出来是一头**橙色**。
 * 这类错不报错、不崩，只是人物凭空染了一头橘发。
 */
const HAIR_RECOLORABLE = new Set(PARTS.filter(p => p.recolors === 'hair').map(p => p.id))

/** 颜色字段 → 材质 */
const FIELD_MATERIAL = { skin: 'body', hairColor: 'hair', clothColor: 'cloth', eye: 'eye' }

/**
 * 会跟着 `look.clothColor` 换色的部件 id 集合（即 `runtime.json` 里 `recolors === 'cloth'`）。
 *
 * ## 为什么必须知道这件事
 *
 * 上游部件分成两类，而**只有一类会换色**：
 *   · `recolors: "cloth"` —— 运行时按调色板换色（`torso_clothes_longsleeve2` 等）
 *   · `recolors: null`    —— **颜色画死在 PNG 里**：
 *       `dress_*`（每种颜色一个文件，靠 id 后缀区分）、
 *       `torso_clothes_robe`（固定**棕色**）、`torso_jacket_*`、`legs_widepants`…
 *
 * 这个区分是 `lpcSprite.ts` 刻意利用的（固定色部件能天然形成内外层次：
 * 黑外套里露出白衬衫）。但对**作者**来说它是个陷阱：
 * 给 `torso_clothes_robe` 写 `clothColor: 'black'` 完全合理，
 * 却什么都不会发生 —— 玩家看到的是棕色袍，描述里写的是玄色。
 *
 * 这类错**不报错、不崩、机检也全绿**，只让立绘与描述对不上。
 * 所以在这里显式查出来。
 */
const CLOTH_RECOLORABLE = new Set(PARTS.filter(p => p.recolors === 'cloth').map(p => p.id))
/** 参与 `clothColor` 的字段（布料部件所在的槽位） */
const CLOTH_FIELDS = ['torso', 'legs', 'feet', 'hat', 'cape', 'belt', 'arms']

/**
 * 重新生成 `.check/LPC-PARTS.md` —— 写 `SpriteLook` 时查阅的部件清单。
 *
 * ## 为什么由这个脚本生成，而不是仓库里留着现成的一份
 *
 * 这份清单原先由**一次性脚本**产出，那个脚本用完就删了 ——
 * 于是清单只会**过期**：上游换素材时 `runtime.json` 变了，
 * 而清单里的 id 还停在旧版本上，照着它写 `look` 就会写出不存在的部件。
 * 让守卫脚本每次运行都顺手刷新，才不会出现"参考文件比代码旧"这种事。
 *
 * ## 一个被修掉的排版 bug（值得记住）
 *
 * 上一版的列宽是写死的 `padEnd(32)`。而部件 id 有超过 32 字符的
 * （`torso_clothes_longsleeve2_cardigan` 之类），于是相邻两个 id
 * **粘成了一个**：`...cardigan` + `torso_clothes_...` → `...cardigantorso_...`。
 * 照着这份清单复制，复制到的是一个**不存在的 id** ——
 * 这是最坏的一种文档错误：它看起来像真的，而且会静默失效。
 * 现在列宽按该类最长 id 算，永远留两个空格。
 */
function writePartsDoc() {
  const byKind = new Map()
  for (const p of PARTS) {
    if (!byKind.has(p.kind)) byKind.set(p.kind, [])
    byKind.get(p.kind).push(p.id)
  }
  const FIELD_HINT = {
    belt: 'look.belt', apron: 'look.apron（罩裙）', armour: 'look.torso（盔甲也算上装）',
    arms: 'look.arms', beard: 'look.beard', body: '（固定用 body，不用手填）',
    cape: 'look.cape', clothes: 'look.torso', eyebrows: 'look.brows', feet: 'look.feet',
    hair: 'look.hair', hat: 'look.hat', head: 'look.head', legs: 'look.legs',
    nose: 'look.nose', accessory: 'look.hat / look.belt（按 id 前缀判断）',
  }

  const L = []
  L.push('# LPC 立绘部件清单（写 SpriteLook 时查阅）')
  L.push('')
  L.push('> ⚠️ **自动生成** —— 由 `node scripts/check-sprites.mjs` 每次运行时刷新，不要手改。')
  L.push('> 数据源：`src/assets/lpc/runtime.json`、`src/assets/lpc/palettes.json`。')
  L.push('')
  L.push('## 三条硬规则')
  L.push('')
  L.push('1. **部件 id 必须原样复制** —— 写错的 id 会被**静默忽略**并退回关键词推断（那条路错误率高）。')
  L.push('2. **颜色只有四种材质能独立指定**：`skin`(body) / `hairColor`(hair) / `clothColor`(cloth) / `eye`(eye)。')
  L.push('   所有布料（上衣、裤子、鞋、帽子、披风、腰带）**共用 `clothColor`** ——')
  L.push('   「上衣红、裤子黑」目前做不到，别写不存在的字段。')
  L.push('3. `note` 如实写外观要点，`check:sprites` 会拿它跟 `look` 做一致性检查。')
  L.push('')
  L.push(`## 部件 id（共 ${PARTS.length} 件）`)
  L.push('')
  for (const [kind, ids] of [...byKind.entries()].sort()) {
    const colW = Math.max(...ids.map(i => i.length)) + 2
    L.push(`### ${kind}  →  ${FIELD_HINT[kind] || '（未知类别）'}`)
    L.push('')
    L.push('```')
    for (let i = 0; i < ids.length; i += 3) {
      L.push(ids.slice(i, i + 3).map(id => id.padEnd(colW)).join('').trimEnd())
    }
    L.push('```')
    L.push('')
  }
  L.push('## 调色板键')
  L.push('')
  for (const [mat, map] of Object.entries(palettes)) {
    const keys = Object.keys(map)
    L.push(`### ${mat}（${keys.length} 个）`)
    L.push('')
    L.push('```')
    L.push(keys.join('  '))
    L.push('```')
    L.push('')
  }

  const out = path.join(root, '.check', 'LPC-PARTS.md')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, L.join('\n'), 'utf8')
  return out
}

const problems = []
const warnings = []

function checkLook(worldTitle, who, look) {
  const at = `${worldTitle} ／ ${who}`
  for (const [field, value] of Object.entries(look)) {
    if (field === 'note' || value === undefined || value === null) continue

    // ① 颜色字段
    if (FIELD_MATERIAL[field]) {
      const mat = FIELD_MATERIAL[field]
      if (value === '') continue
      if (!COLOR_KEYS[mat]?.has(value)) {
        problems.push(`${at} ｜ ${field}="${value}" 不是 ${mat} 调色板里的键（见 .check/LPC-PARTS.md）`)
      }
      continue
    }

    // ② 部件字段
    if (!(field in FIELD_KIND)) {
      warnings.push(`${at} ｜ look 里有未知字段 "${field}" —— 它不会生效（是不是想写别的名字？）`)
      continue
    }
    if (value === '') continue          // 空串是"明确不要这件"，合法
    if (!PART_IDS.has(value)) {
      problems.push(`${at} ｜ ${field}="${value}" 这个部件不存在（写错的 id 会被静默忽略）`)
      continue
    }
    // ③ 字段与部件类别是否对得上
    const want = FIELD_KIND[field]
    const kind = PART_KIND.get(value)
    if (want && kind !== want) {
      problems.push(`${at} ｜ ${field}="${value}" 是 ${kind} 类部件，但这个字段要的是 ${want}`)
    }
    if (field === 'torso' && !['clothes', 'armour', 'apron', 'legs'].includes(kind)) {
      problems.push(`${at} ｜ torso="${value}" 是 ${kind}，不能当上装`)
    }
    if (field === 'belt' && !/^belt_/.test(value)) {
      warnings.push(`${at} ｜ belt="${value}" 看着不像腰带（部件池里的腰带都是 belt_*）`)
    }
  }

  // ④ look 与 note 的自相矛盾 —— 这是"描述与立绘对不上"在**数据层**的残留
  const note = String(look.note || '')
  if (note) {
    const headKind = look.head ? PART_KIND.get(look.head) : undefined
    const headIsFemale = /female/.test(String(look.head))
    const headIsElder = /elder/.test(String(look.head))
    if (/女子|女性|妇人|姑娘|少女|女人|女士/.test(note) && look.head && !headIsFemale) {
      problems.push(`${at} ｜ note 写"${note}"，但 head="${look.head}" 不是女性头部 —— 立绘会画成男的`)
    }
    if (/男子|男性|男人|汉子|青年|少年/.test(note) && headIsFemale) {
      problems.push(`${at} ｜ note 写"${note}"，但 head="${look.head}" 是女性头部`)
    }
    if (/老|年迈|花甲|白发|苍老/.test(note) && look.head && !headIsElder) {
      warnings.push(`${at} ｜ note 提到年老，但 head="${look.head}" 不是 _elderly 变体`)
    }
    if (/光头|秃/.test(note) && look.hair && !/bald|shaved/i.test(look.hair)) {
      problems.push(`${at} ｜ note 写"${note}"，但 hair="${look.hair}" 不是光头/秃顶件`)
    }
    if (/胡须|胡子|髯|络腮/.test(note) && look.beard === '') {
      problems.push(`${at} ｜ note 写有胡须，但 beard 是空串（明确不要胡子）`)
    }
    if (/无胡|没有胡|净面|不留胡/.test(note) && look.beard && look.beard !== '') {
      warnings.push(`${at} ｜ note 说没胡子，但 beard="${look.beard}"`)
    }
  }

  /*
    ⑤ `clothColor` 是不是**白写的**。
    见 `CLOTH_RECOLORABLE` 的说明：固定色部件（robe / dress_* / jacket_*）不参与换色。
    判据刻意收得很紧 —— 只在「**一个**会换色的布料部件都没有」时报错。
    因为"部分固定、部分换色"是 `lpcSprite.ts` 有意造成的层次
    （黑外套 + 里面那件固定白衬衫），那不是错。
  */
  const clothColor = look.clothColor
  if (typeof clothColor === 'string' && clothColor) {
    const clothParts = CLOTH_FIELDS
      .map(f => look[f])
      .filter(v => typeof v === 'string' && v && PART_IDS.has(v))
    if (clothParts.length && !clothParts.some(id => CLOTH_RECOLORABLE.has(id))) {
      problems.push(
        `${at} ｜ clothColor="${clothColor}" **不会生效**：选中的布料部件全是固定色` +
        `（${clothParts.slice(0, 4).join('、')}${clothParts.length > 4 ? '…' : ''}）—— ` +
        `颜色画死在 PNG 里；要么换一个接受 cloth 换色的部件，要么把这个颜色删掉`,
      )
    }
    /*
      部分失效（更常见、也更隐蔽的一种）：
      上装选了固定色部件时，`clothColor` **只染得到裤子/鞋/帽**，上装纹丝不动。
      作者几乎总是以为整身都染上了 —— 于是「玄色圆领袍」画出来是棕色袍，
      而脚本的其它检查全绿。

      这里只报**警告**而不是错误：固定色部件同时被用来做"外套里露出的白衬衫"
      那种层次（见 lpcSprite.ts 的 BASE_SHIRTS），那些是有意的。
      是不是真错，要拿描述里的颜色去对 —— 那是人的判断。
    */
    const torsoId = look.torso
    /*
      ⚠️ `dress_*` **豁免**这条警告。
      它们的颜色写在 **id 后缀**里（`dress_slit_purple` = 紫色高开叉礼服，
      LPC 为每种颜色预渲染了一个文件）—— 选了这个 id 就是选了这个颜色，
      不存在"以为染上了其实没染"的误会。
      ⚠️ 判据必须带**颜色后缀**：`dress_kimono_oversize` 这类 `dress_*` 并**不带**
      颜色后缀，它的颜色同样是画死的、`clothColor` 一样染不上 —— 早先我图省事
      用 `/^dress_/` 一刀切，正好把这一类漏掉了（芙蕾雅的粉色和服就是这么漏的）。
      代价是漏掉一种情况：作者本想要别的色、却填了 `clothColor` 去改
      （那确实改不动）。但这个代价可接受：`dress_*` 的 id 后缀是显式的，
      看一眼就知道是什么色。
      反例（**不豁免**）：`torso_armour_*`。甲的颜色同样是固定的，
      但"黑铁重甲"这种描述会让人以为 `clothColor: 'black'` 能染 ——
      提示他"染不上"是有价值的，让作者自己决定"保形状还是保颜色"。
    */
    const isPreColoredDress = /^dress_[a-z0-9_]*_(black|blue|brown|gray|green|navy|pink|purple|red|white)$/.test(torsoId)
    if (typeof torsoId === 'string' && torsoId && PART_IDS.has(torsoId)
        && !CLOTH_RECOLORABLE.has(torsoId) && !isPreColoredDress) {
      warnings.push(
        `${at} ｜ torso="${torsoId}" 是固定色部件 —— clothColor="${clothColor}" **染不到上装**` +
        `（只影响裤子/鞋/帽）。请确认描述里的衣服颜色与这个部件的固有色是否一致`,
      )
    }
  } else {
    /*
      ⑥ **没有** `clothColor`、而上装又是固定色件 —— 这时其它布料槽的颜色不受控。
      裤子 / 鞋 / 帽 / 披风会走关键词推断（推不出来就用随机种子定一个），
      于是整套配色可能与描述冲突（实测：白罩袍的角色配出蓝裤蓝鞋、
      皮夹克的角色配出紫裤）。

      ⚠️ 这条是子代理在修另一批角色时**实测**发现的：他原本按"描述的颜色与
      固有色恰好一致，那就删掉 clothColor 免得误导后来人"处理，结果一删，
      下半身的颜色立刻失控。所以"删掉那个没用的颜色"并不是安全操作。
    */
    const torsoId = look.torso
    if (typeof torsoId === 'string' && torsoId && PART_IDS.has(torsoId)
        && !CLOTH_RECOLORABLE.has(torsoId) && !/^dress_/.test(torsoId)) {
      const lower = ['legs', 'feet', 'hat', 'cape', 'belt']
        .map(f => look[f])
        .filter(v => typeof v === 'string' && v && CLOTH_RECOLORABLE.has(v))
      if (lower.length) {
        warnings.push(
          `${at} ｜ 没有 clothColor，而上装 torso="${torsoId}" 是固定色件 —— ` +
          `下半身（${lower.slice(0, 3).join('、')}）的颜色会掉进关键词推断，不受你控制。` +
          `要么给整套一个 clothColor，要么确认推断出来的颜色恰好合适`,
        )
      }
    }
  }

  /*
    ⑦ `hairColor` 是不是**白写的** —— 与 `clothColor` 完全同一类陷阱。
    发型件里只有 `hair_long_tied` / `hair_pigtails` 是固定色（画死成亮橙色），
    而它们恰好是通用件，很容易被选中。作者写「黑发」「蜜色双马尾」，
    配上 `hairColor` 以为定了色，实际渲染是一头橙发。
  */
  const hairId = look.hair
  if (typeof look.hairColor === 'string' && look.hairColor
      && typeof hairId === 'string' && hairId && PART_IDS.has(hairId)
      && !HAIR_RECOLORABLE.has(hairId)) {
    warnings.push(
      `${at} ｜ hair="${hairId}" 不接受 hair 换色（固有色画死在 PNG 里）—— ` +
      `hairColor="${look.hairColor}" **不会生效**。换一个可换色的发型件，` +
      `或在 note 里写清它实际是什么颜色`,
    )
  }
}

// ── 载入内置世界（上面已经打好包）──
const { BUILTIN_WORLDS } = await import('file://' + BUNDLE.replace(/\\/g, '/'))

const coverage = []
for (const w of BUILTIN_WORLDS) {
  const chars = w.characters || []
  let withLook = 0
  for (const c of chars) {
    if (c.look) { withLook++; checkLook(w.title, c.name, c.look) }
    else warnings.push(`${w.title} ／ ${c.name} 没有 look —— 仍走关键词猜测（匹配度最不稳的那条路）`)
  }
  coverage.push({ world: w.title, chars: chars.length, withLook })
}
if (BUILTIN_WORLDS[0]?.story && BUILTIN_WORLDS[0].story.__playerLook) {
  checkLook('(玩家)', 'player', BUILTIN_WORLDS[0].story.__playerLook)
}

if (asJson) {
  console.log(JSON.stringify({ coverage, problems, warnings, partsDoc }, null, 2))
} else {
  console.log('\n=== 立绘一致性审计（check:sprites）===\n')
  console.log('  世界                        角色   已写 look   覆盖率')
  for (const c of coverage) {
    const pct = c.chars ? Math.round((c.withLook / c.chars) * 100) : 0
    const mark = c.withLook === c.chars ? '✓' : '·'
    console.log(`  ${mark} ${c.world.padEnd(22)} ${String(c.chars).padStart(4)} ${String(c.withLook).padStart(9)}   ${String(pct).padStart(3)}%`)
  }
  const total = coverage.reduce((n, c) => n + c.chars, 0)
  const done = coverage.reduce((n, c) => n + c.withLook, 0)
  console.log(`\n  合计：${done}/${total} 张卡写了结构化外观`)
  console.log(`  部件池 ${PART_IDS.size} 件；调色板 ${Object.entries(COLOR_KEYS).map(([k, v]) => `${k}=${v.size}`).join(' ')}`)
}

if (problems.length) {
  console.log(`\n=== ✗ 硬错误 ${problems.length} 项（这些会让立绘画错或静默忽略）===`)
  for (const p of problems.slice(0, 40)) console.log('  ' + p)
  if (problems.length > 40) console.log(`  …另有 ${problems.length - 40} 项`)
}
if (warnings.length) {
  console.log(`\n=== ⚠ 提示 ${warnings.length} 项（不一定是错，但值得看一眼）===`)
  for (const w of warnings.slice(0, 20)) console.log('  ' + w)
  if (warnings.length > 20) console.log(`  …另有 ${warnings.length - 20} 项`)
}

if (!problems.length && !warnings.length) console.log('\n✓ 全部通过\n')
process.exit(problems.length ? 1 : 0)
