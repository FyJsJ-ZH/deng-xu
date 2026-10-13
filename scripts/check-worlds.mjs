/**
 * 内置世界书验收 —— 客观核对"三个整合世界"是否真的达标。
 *
 * ## 为什么需要它
 *
 * 本轮把原先 9 个内置世界整合成 3 个，每个要求 **≥5 万字**。
 * "字数够不够""字段有没有漏""id 引用有没有指向空气"这类事，
 * 靠肉眼读是核不出来的 —— 必须让脚本算，并且**把判据写死在这里**。
 *
 * 校验项：
 *   1. 世界数量与 id（必须正好 3 个，且是新 id）
 *   2. **每世界中文字符数 ≥ 50000**（worldLore ≥ 30000、rules ≥ 3000、
 *      customStyle ≥ 500、opening ≥ 1200）
 *   3. 结构完整性：必填字段齐全、数组非空
 *   4. **引用完整性**：`startingItems` 指向的物品必须真实存在；
 *      `attributeBonus` / `resourceBonus` 的 key 必须是已定义的属性/资源
 *   5. **角色卡质量**：每个角色 description ≥80 字，且**必须写清性别词**
 *      （引擎靠它推断立绘性别，写不清就会画出错的脸）
 *   6. 题材禁用词：古代世界不得出现内力/法术/系统…；
 *      地渊世界不得出现 AI/魔法/现实货币名
 *   7. 至少 3 个角色 `present: true`（否则关系面板一开局是空的）
 *
 * 退出码：0 = 全部达标，1 = 有不达标项。
 *
 * 用法：
 *   node scripts/check-worlds.mjs
 *   node scripts/check-worlds.mjs --json
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const AS_JSON = process.argv.includes('--json')

/*
  ── 打包内置世界，拿到运行时真实数据 ──

  两种拿到 bundle 的方式，**优先复用已存在的产物**：
    1. 若 `.check/worlds-check.mjs` 比所有源文件都新，直接 import 它；
    2. 否则调 esbuild 重新打包。

  ⚠️ 为什么要先看有没有现成的：
  某些受限环境下 `spawnSync` 捕获子进程输出会失败
  （**命名管道被禁** → EPERM），症状是 esbuild 明明能跑，
  经本脚本调用却报"打包失败"且 stderr 为空。
  这时先由外部把 bundle 打好（或由 `pnpm gen:worldbook` 顺带产出），
  本脚本直接复用，就不必依赖管道。
*/
/*
  ⚠️ `DX_WORLDS_BUNDLE` 环境变量可以把打包产物挪到别的路径。
  加这个口子是因为**多个世界卡可能正在被并行施工**：
  它们都要反复跑这个脚本，若共用一个 `.check/worlds-check.mjs`，
  就会互相覆盖对方的 bundle（表现为"我刚改的没生效"或 esbuild 半途报错）。
  设了这个变量的进程各用各的产物，互不干扰。
*/
const BUNDLE = process.env.DX_WORLDS_BUNDLE
  ? path.resolve(ROOT, process.env.DX_WORLDS_BUNDLE)
  : path.join(ROOT, '.check', 'worlds-check.mjs')
fs.mkdirSync(path.dirname(BUNDLE), { recursive: true })

/** bundle 是否比它的输入都新（inputs 里任一文件更新就需要重打） */
function bundleIsFresh() {
  if (!fs.existsSync(BUNDLE)) return false
  const bTime = fs.statSync(BUNDLE).mtimeMs
  const SRC = ['src/data/builtinWorlds.ts', 'src/data/worlds', 'src/types/cards.ts']
  for (const p of SRC) {
    const full = path.join(ROOT, p)
    if (!fs.existsSync(full)) continue
    const st = fs.statSync(full)
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(full)) {
        const fp = path.join(full, f)
        if (fs.statSync(fp).isFile() && fs.statSync(fp).mtimeMs > bTime) return false
      }
    } else if (st.mtimeMs > bTime) return false
  }
  return true
}

if (!bundleIsFresh()) {
  const build = spawnSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    'src/data/builtinWorlds.ts',
    '--bundle', '--platform=node', '--format=esm',
    `--outfile=${BUNDLE}`,
    '--alias:@=./src',
    '--log-level=error',
  ], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' })
  if (build.status !== 0) {
    // stdio:'inherit' 时 stderr 不经过管道，错误已直接打在终端上
    console.error('\n✗ 打包 builtinWorlds 失败。')
    console.error('  若上面看不到编译错误，可能是本环境禁止子进程管道（EPERM）。')
    console.error('  绕过办法：先手动打好 bundle，再重跑本脚本 ——')
    console.error('    node node_modules/esbuild/bin/esbuild src/data/builtinWorlds.ts \\')
    console.error(`      --bundle --platform=node --format=esm --outfile=${path.relative(ROOT, BUNDLE)} --alias:@=./src`)
    process.exit(1)
  }
}
const mod = await import('file://' + BUNDLE.replace(/\\/g, '/'))
const WORLDS = mod.BUILTIN_WORLDS

const problems = []
const report = []
const fail = (world, kind, detail) => problems.push({ world, kind, detail })

/** 统计中文字符数 */
const cjk = s => (String(s || '').match(/[\u4e00-\u9fff]/g) || []).length
/** 总字符数（含标点、数字、西文） */
const total = s => String(s || '').length

// ── 期望的内置世界 ──
// `required: true` 的世界缺一个就报错；其余世界是"若存在则必须达标"，
// 这样新增世界时不必改这里（加进去只为了给它配一份更精确的禁用词表）。
const EXPECTED = [
  {
    id: 'builtin_deepcore',
    label: '深核集团·地渊之下（后末日反乌托邦企业世界）',
    required: true,
    // 地渊世界禁用：魔法/AI/现实货币
    banned: ['魔法', '法术', '神明', '灵魂', '人工智能', '机器人', '美元', '人民币'],
    // 允许出现"AI"作为**被禁止的历史名词**，所以不把裸的 AI 列入
  },
  {
    id: 'builtin_greatchen',
    label: '大晟会典（中式古风王朝，无超自然力量）',
    required: true,
    banned: ['内力', '真气', '轻功', '法术', '修仙', '仙尊', '灵气', '神通', '妖', '魔', '系统', '面板', '经验值', '技能点'],
  },
  {
    id: 'builtin_westfantasy',
    label: '三邦纪年（经典西方奇幻）',
    required: true,
    banned: ['系统', '面板', '经验值', '技能点', '内力', '真气', '修仙', '科技', '公司', '数据'],
  },
  {
    id: 'builtin_veil',
    label: '帷幕纪年（维多利亚式工业都城 + 神秘学）',
    required: true,
    // 这是唯一"允许神秘学"的世界，但**不允许游戏化与科幻词汇**，
    // 也不允许用"魔法/法术"这类通俗词 —— 那会把优雅的维多利亚神秘学
    // 写成廉价奇幻。它的语汇应当是：帷幕、相、遗物、预备、开启、应答、结社。
    banned: [
      '系统', '面板', '经验值', '技能点', '内力', '真气', '修仙', '灵气',
      '电脑', '网络', '数据', '程序', '人工智能', '机器人', '塑料',
      '魔法', '法术', '咒语', '蓝条', '魔力',
    ],
  },
  /*
    ── 由艺创区素材新增的 4 个世界（2026-10）──
    都不设 required：它们在开发中先以骨架存在，写完再逐步达标，
    这样"还没写完"不会连带把已有 4 个世界的验收一起弄红。
  */
  {
    id: 'builtin_zhongdi',
    label: '中帝纪年（1905 架空东北亚，无超自然力量）',
    required: false,
    // 与《大晟会典》同一条底线：这是一个**没有异力**的世界
    banned: [
      '内力', '真气', '轻功', '法术', '修仙', '仙尊', '灵气', '神通', '妖术', '魔法',
      '系统', '面板', '经验值', '技能点',
    ],
  },
  {
    id: 'builtin_zhiming',
    label: '织命星典（工业味剑与魔法 · 黑潮帝国）',
    required: false,
    banned: [
      '系统', '面板', '经验值', '技能点', '电脑', '网络', '数据', '程序',
      '人工智能', '机器人', '手机', '塑料',
    ],
  },
  {
    id: 'builtin_ximeng',
    label: '汐梦洲风物志（渊海位面 · 魔网与符文）',
    required: false,
    banned: [
      '系统', '面板', '经验值', '技能点', '电脑', '网络', '程序',
      '人工智能', '机器人', '手机', '塑料',
    ],
  },
  {
    id: 'builtin_elysion',
    label: '埃律西昂：原欲之壤（魔素与原欲法则）',
    required: false,
    banned: [
      '系统', '面板', '经验值', '技能点', '电脑', '网络', '数据', '程序',
      '人工智能', '机器人', '手机', '塑料',
    ],
  },
]

// 篇幅门槛
const GATE = {
  worldCjk: 50000,
  worldLoreCjk: 30000,
  rulesCjk: 3000,
  customStyleCjk: 500,
  openingCjk: 1200,
  /** 配了 openerSlot 时，opening 只作兜底示例，门槛放宽到这个值 */
  openingFallbackCjk: 60,
  /* ── 沙盒改造（2026-10）追加的门槛 ── */
  // 长期目标必须是"若干宏大宽泛的可选项"，不是一句话任务书
  mainQuestCjk: 700,
  // 明确写出"这是沙盒"的规则块必须存在
  sandboxRuleCjk: 300,
  // 地理/势力/生活三类内容必须**都**在 worldLore 里真的写到一定篇幅
  geoCjk: 3000,
  factionCjk: 3000,
  lifeCjk: 3000,
  charDescCjk: 80,
  /*
    角色数门槛从 6 提到 8。
    实测三个世界各有 9 / 10 / 13 张，6 这个门槛等于没约束；
    而"关系面板一开局就有内容"是这个字段存在的理由，
    8 张是能撑起一张关系网的底线。
  */
  minChars: 8,
  minPresent: 3,
  minItems: 15,
  minLores: 8,
  /*
    ── 背景槽位多元化 + 开场随背景变（2026-10 用户反馈）──
    用户原话：「选了半天背景，发现还是一模一样的开场」
    「背景槽位也得像游戏目标一样多元化」。
    这两件事以前**完全没人校验**，所以现在钉成硬指标。

    以往门槛是 2 槽 / 每槽 3 个 —— 那等于没约束（随便点两下都能过），
    而"背景槽位是玩家投入注意力最多的地方"，值不值得点进去全看这里的多样性。

    ⚠️ 但玩家随后又提出了相反方向的诉求，两边都要顾：
      「把背景槽位的隐秘直接删除，维持身份种类多样性的同时**精简**背景槽位，将相似的合并」
      「把机制栏内的背景槽位与预置物品、知识单独拿出来做成一栏 ——
        不然在世界书内容量大的时候非常杂乱」
    所以门槛从 ≥4 放宽到 ≥3，**同时卡上限 ≤5** ——
    槽位多了本身就是要修的问题（帷幕纪年一度 8 个槽位，选角页要滚很久）。
    ⚠️ 注意区分：**槽位数要少，但每个槽位里的身份种类要多** ——
    不许靠砍选项来"精简"。
  */
  minBackgroundSlots: 3,
  maxBackgroundSlots: 5,
  minOptionsPerSlot: 8,
  /*
    ⚠️ 这里**故意是低门槛**（曾经是 100 字）。
    玩家第三次打回时说的是：
      「背景槽位太详细、太固定了，连详细的背景都有就没有自设主角什么空间了」
    背景槽位是**方向**，不是履历。写成长篇处境说明，玩家就没有自设的余地了。
    所以门槛降到"能说清一个方向即可"，**长描述不再被奖励**。
  */
  bgOptionDescCjk: 20,
  /*
    ── 开局：**素材**，不是写死的第一幕 ──
    这件事被打回过三次：
      1. 开场对所有背景都一样 → 加上背景。
      2. 改成"同一场景换视角" → 官军商江湖全挤在一间屋。
      3. 改成"每个处境一段写死的完整开场，并以它为唯一依据" →
         玩家说：「我的自设主角是**刑部正四品**，开局却固定有俩**仓部**上司」
         —— 背景槽位把玩家自己写的主角设定顶掉了。
    所以现在要求的是：每个处境一段**素材**（这类处境的典型场合、会遇到的人的类型、
    这一行的麻烦与体面），交给 AI 作附加参考；**主角自设设定优先级最高**。
    ⚠️ 素材里**不得**出现替玩家认亲的固定关系（"你的上司/上峰/同僚"）。
  */
  openingSeedCjk: 120,
  // 素材之间不得高度雷同（相似度兜底，专门防"同一段换几个词"）
  sceneMaxSimilarity: 0.72,
  /*
    ⚠️ 替玩家认亲的措辞 —— 这些短语一旦出现在素材里，就说明作者又在
    替主角安排上司与同僚了，而那正是玩家最反感的一点。
    用第二人称"你的X"来判定，避免误伤"他的上司是某某"这类**客观**叙述。
  */
  forbiddenKinPhrases: ['你的上司', '你的上峰', '你的上官', '你的同僚', '你的顶头上司', '你的直属'],
}


/**
 * 沙盒内容的识别正则。
 *
 * ⚠️ 两条教训（都是这个脚本自己踩出来的）：
 *
 * 1. **只按 `**标题**` 切段**，不能全文搜关键词 ——
 *    正文里出现"地图"两个字不代表真的写了地图（很可能是"没有地图"）。
 *
 * 2. **标题词表必须够宽。** 第一版只认「舆图/地图/地理/势力/日常…」这几个词，
 *    于是三个新世界明明写了大量同类内容却全部判为 0 分 ——
 *    因为它们用的是「世界的形状」「十二种人」「生活与活法」「一处地方」
 *    这类更自然的标题。**校验器的词表比作者的用词窄，就会把好内容判成没写。**
 *    宁可放宽词表（有"正文长度 ≥3000"这道兜底），也不要逼作者改标题去迁就脚本。
 */
const SANDBOX_SECTIONS = {
  geo: /舆图|地图|地理|疆域|行旅|层志|区域|方位|交通|航线|路线|坊市|城内|商路|海图|铁轨|铁路|四地方|世界|陆与岛|海峡|礁带|港口|码头|城市|乡村|别处的城|海峡|岛|海域|平原|草原|沙漠|山脉|河流|河口|航道|水路|铁路|车道|街巷|地方/,
  faction: /势力|派系|党争|阵营|家族|行会|地盘|藩镇|部族|范围|冲突|做主|握着|权力|阶层|主义|政体|信仰|教会|结社|宗族|军队|朝廷|议会|商会|同盟|联盟|组织|集团|统治|官署|衙门|世家|门派|谁控制|谁的地盘/,
  life: /日常|生活|物价|饮食|市井|民生|作息|婚|娱乐|闲暇|风俗|语言|称谓|活法|一天|一日|行当|谋生|价钱|穿|丧|礼节|忌讳|谚语|怎么活|过日子|开销|工资|薪|收入|贫穷|穷|教育|医疗|病|食|吃喝|住|穿用|婚嫁|嫁娶|节庆|节日|集市/,
}

/*
  世界清单校验。
  必须存在的世界缺一个就报错；可选世界**存在才校验**（这样新增世界不必改脚本）。
  另外：出现在 BUILTIN_WORLDS 里但没有登记进 EXPECTED 的世界也报出来，
  提醒补一份禁用词表 —— 否则新世界会「没人管」。
*/
for (const exp of EXPECTED) {
  if (exp.required && !WORLDS.some(w => w.id === exp.id)) {
    fail(exp.label, '缺失', `必须存在的世界 ${exp.id} 不在 BUILTIN_WORLDS 里`)
  }
}
{
  const known = new Set(EXPECTED.map(e => e.id))
  const unregistered = WORLDS.filter(w => !known.has(w.id)).map(w => w.id)
  if (unregistered.length) {
    fail('(整体)', '有世界未登记进校验表', `${unregistered.join(', ')} —— 请为它补一份禁用词表与门槛`)
  }
}

for (const exp of EXPECTED) {
  const w = WORLDS.find(x => x.id === exp.id)
  // 可选世界不存在就跳过（不算失败）
  if (!w) continue

  const allText = [
    w.title, w.tagline, w.worldLore, w.rules,
    // ⚠️ `opening` 已改名 `atmosphere`（2026-10）；这里两个都算，兼容旧卡
    w.narrative?.customStyle, w.story?.atmosphere, w.story?.opening, w.story?.mainQuest,
    ...(w.items || []).map(i => i.name + i.description),
    ...(w.lores || []).map(l => l.name + l.description),
    ...(w.backgrounds || []).flatMap(b => b.options.map(o => o.title + (o.description || ''))),
    // 处境素材也是实打实的内容，计入全卡字数（openingSeeds 已扁平化：选项 id → 素材）
    ...Object.values(w.story?.openingSeeds || {}),
    ...(w.characters || []).map(c => c.name + c.description + c.personality + c.relationship),
  ].join('\n')

  const cjkTotal = cjk(allText)
  const loreCjk = cjk(w.worldLore)
  const rulesCjk = cjk(w.rules)
  const styleCjk = cjk(w.narrative?.customStyle)
  const openingCjk = cjk(w.story?.atmosphere || w.story?.opening)

  const row = {
    id: w.id, title: w.title,
    cjkTotal, loreCjk, rulesCjk, styleCjk, openingCjk,
    chars: w.characters?.length || 0,
    present: (w.characters || []).filter(c => c.present).length,
    items: w.items?.length || 0,
    lores: w.lores?.length || 0,
    bgSlots: w.backgrounds?.length || 0,
    attrs: w.attributes?.length || 0,
    res: w.resources?.length || 0,
  }
  report.push(row)

  // ① 篇幅
  if (cjkTotal < GATE.worldCjk) fail(exp.label, '篇幅不足', `中文字符 ${cjkTotal} < ${GATE.worldCjk}`)
  if (loreCjk < GATE.worldLoreCjk) fail(exp.label, 'worldLore 不足', `${loreCjk} < ${GATE.worldLoreCjk}`)
  if (rulesCjk < GATE.rulesCjk) fail(exp.label, 'rules 不足', `${rulesCjk} < ${GATE.rulesCjk}`)
  if (styleCjk < GATE.customStyleCjk) fail(exp.label, 'customStyle 不足', `${styleCjk} < ${GATE.customStyleCjk}`)

  /*
    ⚠️ `story.opening` 的长度门槛**必须分情况**。
    旧语义里 opening 就是第一幕本体，所以要求 ≥1200 字是对的；
    但新语义下开场由 `openerSlot` + `openingSeeds` 决定，opening 只是**兜底示例**——
    这时再要求 1200 字就是自相矛盾：它逼作者往"兜底"里灌水，
    而三个世界（大晟 48 字 / 三邦 84 字）确实因为写对了（写短）而被判不达标。
    **门槛与设计打架时，错的是门槛。**
    所以：配了 openerSlot 的世界只要求一段像样的兜底（≥60 字）；
    没配的仍然按 ≥1200 字要求（那时它真的是唯一开场）。
  */
  const openingGate = w.story?.openerSlot ? GATE.openingFallbackCjk : GATE.openingCjk
  row.openingGate = openingGate
  if (openingCjk < openingGate) {
    fail(exp.label, 'opening 不足',
      `${openingCjk} < ${openingGate}` +
      (w.story?.openerSlot
        ? `（已配 openerSlot「${w.story.openerSlot}」，opening 只作兜底示例，门槛已放宽）`
        : '（未配 openerSlot，opening 是唯一开场，须写足）'))
  }

  // ② 结构
  if (!w.attributes?.length) fail(exp.label, '结构', 'attributes 为空')
  if (!w.resources?.length) fail(exp.label, '结构', 'resources 为空')
  if ((w.characters?.length || 0) < GATE.minChars) fail(exp.label, '角色太少', `${w.characters?.length || 0} < ${GATE.minChars}`)
  if (row.present < GATE.minPresent) fail(exp.label, '开局登场角色太少', `${row.present} < ${GATE.minPresent}`)
  if ((w.items?.length || 0) < GATE.minItems) fail(exp.label, '物品太少', `${w.items?.length || 0} < ${GATE.minItems}`)
  if ((w.lores?.length || 0) < GATE.minLores) fail(exp.label, 'lore 太少', `${w.lores?.length || 0} < ${GATE.minLores}`)
  if ((w.backgrounds?.length || 0) < GATE.minBackgroundSlots) fail(exp.label, '背景槽太少', `${w.backgrounds?.length || 0} < ${GATE.minBackgroundSlots}`)
  for (const slot of w.backgrounds || []) {
    if (slot.options.length < GATE.minOptionsPerSlot) {
      fail(exp.label, '背景选项太少', `「${slot.label}」只有 ${slot.options.length} 个选项`)
    }
  }

  /*
    ②.5 沙盒要求（2026-10 用户反馈："要像等待探索的沙盒，不要太拘泥于详细目标"）
    这三项都是"声称做了"和"真的做了"很容易混淆的地方，所以逐项量化：
      · 地理 / 势力 / 生活 三类内容必须各有**足够篇幅**（按命中标题下的正文算）
      · 长期目标必须是"若干宽泛选项"（字数下限），而不是一句话任务书
      · rules 里必须有明确的"这是沙盒"条款
  */
  {
    /*
      ⚠️ 只把**行首的** `**第X章 标题**` 当成章节标题。
      第一版我按"任意成对星号"切段 —— 于是正文里任何
      **加粗强调**都会被当成一个"标题"，章节索引整体错位，
      统计出来的三类内容字数全是错的（地理 260 / 势力 210 / 生活 340）。
      作者为了迁就这个 bug，被迫把 worldLore 正文里的加粗**全部删掉** ——
      **校验器的缺陷反过来破坏了内容质量**，这是最不该发生的一类问题。
      现在改成逐行扫描、只认行首的章节标题。
    */
    const lines = String(w.worldLore).split('\n')
    const HEAD_RE = /^\s*\*\*(.+?)\*\*\s*$/
    /** 收集所有 (标题, 标题下正文) 段 */
    const segs = []
    let cur = null
    for (const ln of lines) {
      const m = ln.match(HEAD_RE)
      if (m) {
        cur = { title: m[1], body: [] }
        segs.push(cur)
      } else if (cur) {
        cur.body.push(ln)
      }
    }
    const sectionCjk = (re) => {
      let n = 0, hits = 0
      for (const s of segs) {
        if (!re.test(s.title)) continue
        hits++
        n += cjk(s.body.join('\n'))
      }
      return { n, hits }
    }
    const geo = sectionCjk(SANDBOX_SECTIONS.geo)
    const fac = sectionCjk(SANDBOX_SECTIONS.faction)
    const life = sectionCjk(SANDBOX_SECTIONS.life)
    row.geo = geo.n; row.faction = fac.n; row.life = life.n; row.sections = segs.length
    if (geo.n < GATE.geoCjk) fail(exp.label, '地理/地图内容不足', `命中标题下共 ${geo.n} 字（${geo.hits} 节）< ${GATE.geoCjk}`)
    if (fac.n < GATE.factionCjk) fail(exp.label, '势力范围内容不足', `命中标题下共 ${fac.n} 字（${fac.hits} 节）< ${GATE.factionCjk}`)
    if (life.n < GATE.lifeCjk) fail(exp.label, '生活气息内容不足', `命中标题下共 ${life.n} 字（${life.hits} 节）< ${GATE.lifeCjk}`)

    const mqCjk = cjk(w.story?.mainQuest)
    row.mqCjk = mqCjk
    if (mqCjk < GATE.mainQuestCjk) {
      fail(exp.label, '长期目标太窄', `mainQuest ${mqCjk} 字 < ${GATE.mainQuestCjk}（沙盒里应是"几个宽泛的可选方向"）`)
    }
    // 目标里不该出现硬期限/命令式措辞
    const mq = String(w.story?.mainQuest || '')
    for (const bad of [/硬期限/, /\d+\s*天[内之]/, /必须完成/, /任务书/]) {
      if (bad.test(mq)) fail(exp.label, '长期目标写得像任务书', `匹配到 ${bad}`)
    }

    // rules 里必须有一**条**明确的沙盒定性（这是让 AI 不把沙盒玩成单线的关键约束）。
    // 不能只搜关键词 —— "探索"这种词本来就会散落在别处，那样等于没检查。
    // 所以要求：某一条（按编号/换行切分）同时提到"沙盒/可选/不是任务"这类定性
    // 与"不要催/没有必须"这类行为约束，且有一定长度。
    const ruleBlocks = String(w.rules || '')
      .split(/\n(?=\s*(?:\d+[.、]|[一二三四五六七八九十]+[、.]))/)
      .map(s => s.trim())
    const sandboxClause = ruleBlocks.find(b =>
      /沙盒|不是任务|可选/.test(b) && /不要催|没有必须|不必|不要强行|自由/.test(b) && cjk(b) >= GATE.sandboxRuleCjk
    )
    if (!sandboxClause) {
      fail(exp.label, 'rules 缺少沙盒条款',
        `需要一条独立规则（≥${GATE.sandboxRuleCjk} 字）同时说明"这是沙盒/目标可选"与"不要催进度/没有必须做的事"`)
    } else {
      row.sandboxRule = cjk(sandboxClause)
    }

    /*
      ②.6 背景槽位与开场（2026-10 用户反馈，打回过两次）
      ────────────────────────────────────────
      第一次：「选了半天背景，发现开场一模一样」—— 背景根本没进开场提示词。
      第二次：「我要的是同一个世界观里，**各不相同的开场为各不相同的背景服务**，
        而不是一样的开场因不一样的背景而略有改变。三六九等的人却在干
        同一个枯燥的工作，完全背离了沙盒。」
      所以现在验三层：
        · 槽位与选项的**数量**、选项描述的**长度**；
        · 必须有 `openerSlot`，且它的每个选项都有一段**完整开场场景**；
        · 这些场景**彼此不能雷同**（相似度兜底，专治"同一段换几个词"）。
    */
    {
      const slots = w.backgrounds || []
      row.bgSlots = slots.length
      row.bgOptions = slots.reduce((n, s) => n + s.options.length, 0)

      /*
        ⚠️ 槽位 label 必须唯一。
        `backgroundChoices` 与 `openingSeeds` 都是**按 label 做 key 的对象**，
        两个槽位同名就会互相覆盖 —— 不报错，只是其中一个槽位的选择与开场场景
        永远取不到（静默失效）。
      */
      const labels = slots.map(s => s.label)
      const dupLabels = labels.filter((l, i) => labels.indexOf(l) !== i)
      if (dupLabels.length) {
        fail(exp.label, '背景槽位 label 重复', `${[...new Set(dupLabels)].join('、')} —— 会互相覆盖`)
      }
      // 选项 id 在同世界内必须唯一，否则选中哪一个都会命中同一个 map 条目
      const optIds = slots.flatMap(s => s.options.map(o => o.id))
      const dupOpts = optIds.filter((l, i) => optIds.indexOf(l) !== i)
      if (dupOpts.length) {
        fail(exp.label, '背景选项 id 重复', `${[...new Set(dupOpts)].join('、')}`)
      }

      if (slots.length < GATE.minBackgroundSlots) {
        fail(exp.label, '背景槽位太少',
          `${slots.length} 槽 < ${GATE.minBackgroundSlots}（用户要求"像游戏目标一样多元"）`)
      }
      /*
        ⚠️ 上限同样是硬指标。玩家反馈：
          「把机制栏内的背景槽位与预置物品、知识单独拿出来做成一栏，
            不然在世界书内容量大的时候非常杂乱」
        槽位多 → 选角页长 → 世界书预览更长。所以多了要合并，不是留着。
      */
      if (slots.length > GATE.maxBackgroundSlots) {
        fail(exp.label, '背景槽位太多（该合并了）',
          `${slots.length} 槽 > ${GATE.maxBackgroundSlots} —— ` +
          `把语义相近的槽位合并（例如"出身"与"入仕之途"→"来路"、"立场"与"志向"→"立场与野心"），` +
          `但**不要靠删选项来变短**：身份种类必须留住`)
      }
      for (const slot of slots) {
        if (slot.options.length < GATE.minOptionsPerSlot) {
          fail(exp.label, '背景槽选项太少',
            `「${slot.label}」只有 ${slot.options.length} 个 < ${GATE.minOptionsPerSlot}`)
        }
        for (const o of slot.options) {
          const n = cjk(o.description)
          if (n < GATE.bgOptionDescCjk) {
            fail(exp.label, '背景选项描述太短', `「${slot.label}／${o.title}」${n} < ${GATE.bgOptionDescCjk} 字`)
          }
          /*
            ⚠️ 反向门槛：选项描述**写得太长**会挤掉玩家的自设空间。
            玩家原话：「背景槽位太详细、太固定了……就没有自设主角什么空间了」。
            这不是硬错，但值得提醒 —— 用 warn 而不是 fail，
            因为个别选项确实可能需要多两句话。
          */
          if (n > 90) row.longDesc = (row.longDesc || 0) + 1
        }
      }

      /*
        ── 开局处境素材（本次的核心验收）──
        要验四件事：
          1. 世界卡指定了 `openerSlot`，且这个槽位真实存在；
          2. 该槽位的**每一个**选项都有一段素材（长度够）；
          3. 这些素材**彼此确实不同**（二元组相似度兜底）；
          4. ⚠️ **素材里不得替玩家认亲** —— 不得出现"你的上司/上峰/同僚"。
             玩家第三次打回就是因为这个：自设"刑部正四品"，
             开局却固定有"俩仓部上司"。
      */
      const openerLabel = w.story?.openerSlot
      const openerSlot = slots.find(s => s.label === openerLabel)
      const seedMap = w.story?.openingSeeds

      if (!openerLabel) {
        fail(exp.label, '没指定处境槽位（openerSlot）',
          '必须有一个背景槽位描述"主角大致处在什么场合、什么层级"，否则 AI 无从取材')
      } else if (!openerSlot) {
        fail(exp.label, 'openerSlot 指向了不存在的槽位',
          `story.openerSlot="${openerLabel}"，但 backgrounds 里没有这个 label`)
      } else {
        const missing = []
        const tooShort = []
        const seeds = []
        for (const o of openerSlot.options) {
          const text = (seedMap?.[o.id] ?? seedMap?.[o.title] ?? '').trim()
          if (!text) { missing.push(o.title); continue }
          const n = cjk(text)
          if (n < GATE.openingSeedCjk) tooShort.push(`${o.title}(${n})`)
          seeds.push({ title: o.title, text })
        }
        row.opener = openerLabel
        row.seeds = seeds.length

        if (missing.length) {
          fail(exp.label, '开局素材没覆盖全部处境',
            `${seeds.length}/${openerSlot.options.length} 已写；缺 ${missing.length} 个：` +
            missing.slice(0, 8).join('、') + (missing.length > 8 ? ' …' : ''))
        }
        if (tooShort.length) {
          fail(exp.label, '开局素材太短',
            `每条需 ≥${GATE.openingSeedCjk} 汉字（要能说清这类处境的场合、人与麻烦）：` +
            tooShort.slice(0, 8).join('、'))
        }

        /*
          ④ 替玩家认亲 —— 这是玩家最反感的一点，直接 fail。
          只扫 openerSlot 的素材与**全部**背景选项，
          因为这些正是"替主角安排关系"的高发区。
        */
        const kinHits = []
        const scanKin = (where, text) => {
          for (const ph of GATE.forbiddenKinPhrases) {
            if (String(text || '').includes(ph)) kinHits.push(`${where} → 「${ph}」`)
          }
        }
        for (const s of seeds) scanKin(`处境素材「${s.title}」`, s.text)
        for (const slot of slots) {
          scanKin(`槽位「${slot.label}」描述`, slot.description)
          for (const o of slot.options) scanKin(`选项「${o.title}」`, o.description)
        }
        if (kinHits.length) {
          fail(exp.label, '素材替玩家认了亲',
            '不得出现"你的上司/上峰/同僚"这类固定关系 —— 玩家自设的主角身份优先，' +
            '关系应由开场现场生成：' + kinHits.slice(0, 6).join('；') +
            (kinHits.length > 6 ? ` …共 ${kinHits.length} 处` : ''))
        }

        /*
          相似度兜底：把每段场景切成 2 字组，算 Jaccard 相似度。
          中文没有词边界，二元组是够用的近似 —— 目的是抓"同一段换几个词"，
          不是做精确的文本比对。
        */
        const bigrams = s => {
          const t = s.replace(/[\s，。、；：！？「」『』（）—…·"'*#-]/g, '')
          const out = new Set()
          for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2))
          return out
        }
        const sim = (a, b) => {
          if (!a.size || !b.size) return 0
          let inter = 0
          for (const g of a) if (b.has(g)) inter++
          return inter / (a.size + b.size - inter)
        }
        const sets = seeds.map(s => ({ title: s.title, set: bigrams(s.text) }))
        const tooSimilar = []
        for (let i = 0; i < sets.length; i++) {
          for (let j = i + 1; j < sets.length; j++) {
            const v = sim(sets[i].set, sets[j].set)
            if (v >= GATE.sceneMaxSimilarity) {
              tooSimilar.push(`${sets[i].title} ↔ ${sets[j].title}（相似 ${(v * 100).toFixed(0)}%）`)
            }
          }
        }
        if (tooSimilar.length) {
          fail(exp.label, '开局素材彼此太像（就是"同一段换几个词"）',
            tooSimilar.slice(0, 6).join('；') + (tooSimilar.length > 6 ? ` …共 ${tooSimilar.length} 对` : ''))
        }
      }
    }
  }

  // ③ 引用完整性 —— 这类错误**不报错、只静默失效**
  const itemIds = new Set((w.items || []).map(i => i.id))
  const attrIds = new Set((w.attributes || []).map(a => a.id))
  const resIds = new Set((w.resources || []).map(r => r.id))
  for (const slot of w.backgrounds || []) {
    for (const o of slot.options) {
      for (const it of o.startingItems || []) {
        if (!itemIds.has(it)) fail(exp.label, 'startingItems 指向不存在的物品', `「${o.title}」→ ${it}`)
      }
      for (const k of Object.keys(o.attributeBonus || {})) {
        if (!attrIds.has(k)) fail(exp.label, 'attributeBonus 用了未定义的属性', `「${o.title}」→ ${k}`)
      }
      for (const k of Object.keys(o.resourceBonus || {})) {
        if (!resIds.has(k)) fail(exp.label, 'resourceBonus 用了未定义的资源', `「${o.title}」→ ${k}`)
      }
    }
  }
  for (const l of w.lores || []) {
    if (l.attribute && !attrIds.has(l.attribute)) {
      fail(exp.label, 'lore 关联了未定义的属性', `${l.name} → ${l.attribute}`)
    }
  }

  // ④ 角色卡：描述要够长，且**必须能推断出性别**（否则立绘会画错脸）
  const FEMALE = /少女|姑娘|女孩|女生|女子|女士|女性|妇人|妇女|女人|夫人|太太|主母|小姐|妻子|寡妇|遗孀|女儿|侄女|姐姐|妹妹|母亲|妈妈|婆婆|女官|女仆|侍女|接生婆|巫女/
  const MALE = /少年|男子|男人|男性|先生|男士|少爷|公子|老汉|老头|老者|父亲|爸爸|哥哥|弟弟|儿子|修士|僧人|农夫/
  for (const c of w.characters || []) {
    const n = cjk(c.description)
    if (n < GATE.charDescCjk) fail(exp.label, '角色描述过短', `${c.name} ${n} < ${GATE.charDescCjk} 字`)
    if (!FEMALE.test(c.description) && !MALE.test(c.description) && !/男|女/.test(c.description)) {
      fail(exp.label, '角色描述缺性别线索', `${c.name} —— 立绘会随机长脸`)
    }
    if (!c.name || !c.id) fail(exp.label, '角色缺 id/name', JSON.stringify(c).slice(0, 60))
  }
  const charIds = (w.characters || []).map(c => c.id)
  if (new Set(charIds).size !== charIds.length) fail(exp.label, '角色 id 重复', charIds.join(','))

  // ⑤ 禁用词
  /*
    ⚠️ 必须先剪掉「禁令清单」本身。
    每个世界的 rules 里都有一条"绝对禁止出现的词汇：系统/面板/数据/公司…"，
    那是**规则书在列举哪些词不许用**，不是内容违规。
    第一版直接全文搜，于是每一条禁令都被自己举报了一次
    （三邦纪年就被误报「出现禁用词『公司』」）。
    判据：凡是同一行里出现"不得出现/绝对禁止/不要出现/禁用"这类措辞的行，
    整行从扫描范围里剔除 —— 那是在**定义**禁词，不是在**使用**禁词。
    只扫 worldLore：rules 的职责就是写禁令，天然会提到这些词。
  */
  const BAN_MARK = /不得出现|绝对禁止|不要出现|禁止出现|禁用|不得引入|不得使用|不得有/
  const prose = String(w.worldLore)
    .split('\n')
    .filter(ln => !BAN_MARK.test(ln))
    .join('\n')

  /*
    ⚠️ 还要放过**描述"这个东西不存在"的句子**。
    世界书里"技术边界"这类章节天生要写「没有马镫」「没有纸币」——
    那是在**交代世界缺什么**，是负责任的写法，不是违规。
    第一版把这个也判成违规（青铜纪年因「马镫」被误报），
    等于惩罚"把边界写清楚"的作者。
    判据：命中处前后 ±40 字内出现否定词，就跳过这一处。
    注意这是**逐处**判断，不是整段豁免 ——
    同一段里若另有非否定的用法，仍然会被抓出来。
  */
  const NEG = /没有|无|不存在|尚不|还没有|未出现|不会有|不设|缺乏|缺少|买不到|不许|不能|尚未|从未/
  for (const bad of exp.banned) {
    const re = new RegExp(bad, 'g')
    const real = []
    let m
    while ((m = re.exec(prose))) {
      const around = prose.slice(Math.max(0, m.index - 40), m.index + 40)
      if (NEG.test(around)) continue      // 这是在说"没有它"
      real.push(m.index)
    }
    if (real.length) {
      const at = real[0]
      fail(exp.label, `出现禁用词「${bad}」`,
        `${real.length} 处（已排除"描述其不存在"的用法）；上下文：…${prose.slice(Math.max(0, at - 50), at + 50).replace(/\n/g, ' ')}…`)
    }
  }
}

// ── 输出 ──
if (AS_JSON) {
  console.log(JSON.stringify({ report, problems, gate: GATE }, null, 2))
  process.exit(problems.length ? 1 : 0)
}

console.log('\n=== 内置世界书验收 ===\n')
console.log(`  世界数量：${WORLDS.length}\n`)
// 用真实的问题清单判断每一行的 ✓/✗，而不是另算一套近似判据
// （否则"这一行显示 ✓ 但问题清单里有它"这种自相矛盾会出现）
const problemWorlds = new Set(problems.map(p => p.world))
const rowOk = r => !problems.some(p => p.world.includes(r.title) || (p.detail || '').includes(r.title))
console.log('  ' + '世界'.padEnd(30) + '中文字数'.padStart(9) + 'worldLore'.padStart(10)
  + 'rules'.padStart(7) + '角色'.padStart(5) + '物品'.padStart(5) + 'lore'.padStart(5))
for (const r of report) {
  const ok = rowOk(r)
  console.log('  ' + (ok ? '✓ ' : '✗ ') + r.title.padEnd(28)
    + String(r.cjkTotal).padStart(9) + String(r.loreCjk).padStart(10)
    + String(r.rulesCjk).padStart(7) + String(r.chars).padStart(5)
    + String(r.items).padStart(5) + String(r.lores).padStart(5))
}
void problemWorlds

console.log('\n  —— 沙盒内容（用户要求：地图 / 势力范围 / 生活气息 / 可选目标）——')
console.log('  ' + '世界'.padEnd(30) + '地理'.padStart(8) + '势力'.padStart(8)
  + '生活'.padStart(8) + '长期目标'.padStart(10) + '沙盒条款'.padStart(10))
for (const r of report) {
  const ok = (r.geo || 0) >= GATE.geoCjk && (r.faction || 0) >= GATE.factionCjk
    && (r.life || 0) >= GATE.lifeCjk && (r.mqCjk || 0) >= GATE.mainQuestCjk
  console.log('  ' + (ok ? '✓ ' : '✗ ') + r.title.padEnd(28)
    + String(r.geo ?? '-').padStart(8) + String(r.faction ?? '-').padStart(8)
    + String(r.life ?? '-').padStart(8) + String(r.mqCjk ?? '-').padStart(10)
    + String(r.sandboxRule ?? '缺失').padStart(10))
}

if (problems.length) {
  console.log(`\n=== 不达标 ${problems.length} 项 ===`)
  const byKind = new Map()
  for (const p of problems) {
    const k = `${p.world} ｜ ${p.kind}`
    if (!byKind.has(k)) byKind.set(k, [])
    byKind.get(k).push(p.detail)
  }
  for (const [k, list] of byKind) {
    console.log(`\n  ✗ ${k}`)
    for (const d of list.slice(0, 12)) console.log(`      ${d}`)
    if (list.length > 12) console.log(`      … 另有 ${list.length - 12} 条`)
  }
} else {
  console.log(`\n  ✓ 全部 ${report.length} 个世界达标（每个 ≥${GATE.worldCjk} 中文字，worldLore ≥${GATE.worldLoreCjk}），沙盒四类内容齐备`)
}

console.log(`\n  门槛：中文字数 ≥${GATE.worldCjk} / worldLore ≥${GATE.worldLoreCjk} / rules ≥${GATE.rulesCjk}`
  + ` / 角色 ≥${GATE.minChars}（≥${GATE.minPresent} 个开局登场）/ 物品 ≥${GATE.minItems} / lore ≥${GATE.minLores}\n`)

/*
  ── A4：专名一致性（**只警告，绝不进 problems，也就不影响退出码**）──

  要抓的现象：同一个地名/族名在世界书里被写成了两种样子
  （「汴梁」/「汴京」、「地渊」/「深渊」），玩家读着出戏，
  而这类错误不会被上面任何一条硬门槛拦到。

  为什么只 warn（这一点比判据本身更重要）：
    · 中文里一字之差的两个词**多数并不是同一个东西**（「官军」/「官兵」、
      「漕帮」/「漕运」、「偏将」/「副将」… 有的同义、有的泾渭分明）；
    · 本脚本已经栽过一次"校验器的词表比作者的用词窄，把好内容判成没写"的跟头
      （见 SANDBOX_SECTIONS 上方的注释）——**判据比内容更窄时，错的是判据**。
  所以这里只把"最可疑的几对"摆到人眼前，由人来决定要不要统一。

  判据（刻意宽松）：
    1. 从 worldLore 里抽高频专名：「」里的词（本项目写作惯例就是用「」标专名，权重更高）
       + 反复出现的 2~4 字中文词；
    2. 两词**编辑距离 ≤ 1**（一字之差），且共享首字或尾字
       （「汴梁/汴京」共享首字，「地渊/深渊」共享尾字），
       互不为子串，且都不含虚词字（否则"的时候/时候"这类会刷屏）；
    3. 取出现次数最多的几对，每个世界最多报 3 对、一行说完。

  ⚠️ `--json` 输出不含这一段：那是给下游工具读的既有结构，不动它最省事。
*/
const NOUN_STOP_CHARS = new Set(
  // 虚词字 + 中文数字：前者会造出"的时候/时候"这类噪音，
  // 后者会造出"二十/四十""一年/一份"这类根本不该报的配对
  ('的了是在有和与也就都还只不我你他她它们这那什么怎因为所以但而之其此该个把被从对向于为以如若则即很更最太又要会能可时侯些里面上中下前后来到着过给让没好大小多少长短位次种样'
    + '一二三四五六七八九十百千万亿两零').split(''),
)

/** 编辑距离（两词都在 2~4 字，直接经典 DP，不用优化） */
function editDistanceOf(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array(b.length + 1).fill(0)
    row[0] = i
    return row
  })
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[a.length][b.length]
}

/** 统计 worldLore 里的词频：「」里的词算 3 次（那是作者明确标出来的专名） */
function collectNounFreq(text) {
  const freq = new Map()
  const bump = (word, times = 1) => freq.set(word, (freq.get(word) || 0) + times)
  for (const m of String(text || '').matchAll(/「([^「」]{2,6})」/g)) {
    const t = m[1].trim()
    if (/^[\u4e00-\u9fff]+$/.test(t)) bump(t, 3)
  }
  // 只在连续中文段内滑窗，避免跨标点拼出"梁的""的秋"这类假词
  for (const seg of String(text || '').split(/[^\u4e00-\u9fff]+/)) {
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= seg.length; i++) bump(seg.slice(i, i + n))
    }
  }
  return freq
}

/** 可疑变体对：编辑距离 ≤1、共享首尾字、互不为子串 */
function suspiciousNounPairs(freq, minFreq = 24) {
  const words = [...freq.entries()]
    .filter(([w, n]) =>
      n >= minFreq
      && w.length >= 2 && w.length <= 4
      && ![...w].some(ch => NOUN_STOP_CHARS.has(ch)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 150)

  const pairs = []
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j < words.length; j++) {
      const [a, na] = words[i]
      const [b, nb] = words[j]
      if (a === b) continue
      if (a.includes(b) || b.includes(a)) continue
      if (Math.abs(a.length - b.length) > 1) continue
      if (a[0] !== b[0] && a[a.length - 1] !== b[b.length - 1]) continue
      if (editDistanceOf(a, b) > 1) continue
      pairs.push({ a, b, total: na + nb })
    }
  }
  return pairs.sort((x, y) => y.total - x.total).slice(0, 3)
}

const nounWarnings = []
for (const w of WORLDS) {
  const pairs = suspiciousNounPairs(collectNounFreq(w.worldLore))
  if (pairs.length) {
    nounWarnings.push(
      `  ⚠ ${w.title}：` + pairs.map(p => `「${p.a}」/「${p.b}」`).join('、')
      + ' —— 一字之差，疑似同一专名的两种写法（也可能确实是两个东西）',
    )
  }
}
if (nounWarnings.length) {
  console.log('\n  —— 专名一致性抽查（仅供参考，**不影响退出码**）——')
  for (const line of nounWarnings) console.log(line)
}

process.exit(problems.length ? 1 : 0)
