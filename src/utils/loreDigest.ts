/**
 * 世界书章节的**按需注入**。
 *
 * ## 为什么需要它
 *
 * 内置世界的 `worldLore` 是 3~7 万汉字，而它原先**整段**塞进叙事的 system prompt，
 * 每一轮都发。实测大晟的叙事 prompt 是 **66027 汉字 ≈ 4.4 万 token**，
 * 其中 worldLore 独占 57074 字 —— 约八成的内容是这一轮根本用不到的设定。
 *
 * 但**贵还不是最要紧的**：超长上下文里模型对中段内容的注意力会明显下降，
 * 于是"写了五万字"的效果反而不如"把这一轮真用得上的八千字摆在他眼前"。
 * 所以这件事同时省 token 与提质量。
 *
 * ## 怎么挑（刻意做得便宜、可解释、可测）
 *
 * 1. `worldLore` 里每个**行首独占一行**的 `**标题**` 算一节；
 *    第一个标题之前的内容是**总纲**，**常驻** —— 它通常是纪年、基本法则这类底子。
 * 2. 把本轮情境（玩家行动、当前地点、在场角色、最近一段叙事）拼成一段文本，
 *    再拿"世界里真实存在的专名"去里面找**出现了哪些**。
 *    专名清单复用 `collectWorldProperNouns` 的产物，由调用方传入
 *    （不在这里 import，避免与 `prompts.ts` 形成循环依赖）。
 * 3. 每节按"命中了几个、命中的名字有多长"打分，贪心取到预算用完。
 *    另有前两节**无条件保留**（`alwaysInclude`）—— 靠前的章节通常就是
 *    舆图与势力这类"不知道就没法开口"的底子。
 * 4. 落选的章节以**标题 + 首句**进索引：模型据此知道"世界还有这些侧面"，
 *    并被明确告知**不要凭空断言**那些侧面的细节。
 *
 * ## 一个诚实的设计边界
 *
 * 这是**关键词命中**，不是语义检索 —— 它挑不出"讲的是同一件事但用词不同"的章节。
 * 之所以仍然这么做：判据完全可解释（"因为它命中了『汴梁』和『漕渠』"），
 * 出问题时能一眼看出是专名清单缺了词、还是某一节写得太泛。
 * 换成向量检索会让"为什么这轮没注入物价那一节"变成一件查不动的事。
 */

export interface LoreSection {
  /** 章节标题（不含两侧的 `**`）；空串表示"未分章的开头"，即总纲 */
  title: string
  body: string
}

/** 章节标题：**行首独占一行**的 `**...**`（与 check-worlds.mjs 的切分判据一致） */
const HEAD_RE = /^\s*\*\*(.+?)\*\*\s*$/

/**
 * 把 `worldLore` 按章节标题切分。
 *
 * ⚠️ 只认**行首独占一行**的 `**...**`。正文里的行内加粗（`这是**重点**`）不算标题 ——
 * `check-worlds.mjs` 当初就是因为按"任意成对星号"切段而统计错字数，
 * 逼得作者把正文里的加粗全删了。这里的判据与它保持一致。
 */
export function splitLore(lore: string): LoreSection[] {
  const lines = String(lore || '').split('\n')
  const out: LoreSection[] = []
  let cur: LoreSection | null = null
  for (const ln of lines) {
    const m = ln.match(HEAD_RE)
    if (m) {
      if (cur) out.push(cur)
      cur = { title: m[1].trim(), body: '' }
    } else if (cur) {
      cur.body += (cur.body ? '\n' : '') + ln
    } else {
      // 第一个标题之前 —— 总纲
      if (!out.length) out.push({ title: '', body: '' })
      out[0].body += (out[0].body ? '\n' : '') + ln
    }
  }
  if (cur) out.push(cur)
  // 去掉空的总纲
  return out.filter(s => s.title || s.body.trim())
}

/** 汉字数（用来卡预算 —— 与 check-worlds.mjs 用同一个量纲） */
function cjkLen(s: string): number {
  return (String(s || '').match(/[\u4e00-\u9fff]/g) || []).length
}

/** 一节的一句话提要（首句，截断） */
function gistOf(body: string, max = 42): string {
  const first = String(body || '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !/^[（(【\[]/.test(l)) || ''
  const clean = first.replace(/\*\*/g, '')
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/**
 * 从章节**标题**里抽检索键。
 *
 * 标题是人写的、最精炼，核心专名几乎都在里面：
 * 「第三十九章 汴梁城内：坊市、河桥与官署的位置关系」→ 取冒号前的「汴梁城内」，
 * 再按顿号与「与/和/及」切开，最后生成它 2~6 字的**前缀** ——
 * 于是「汴梁」这个真正会被情境提到的词就在里面了。
 *
 * 前缀法会顺带产出「舆图」「疆域」这类泛词。它们无害：
 * 情境文本里不会出现，所以永远命中不了，只是白占一点计算。
 * 反过来，**漏掉**一个真地名才是真损失（那一节永远挑不出来）。
 */
function titleKeys(title: string): string[] {
  const t = String(title || '')
    // 去掉「第X章 / 第X卷 / 第X节」前缀
    .replace(/^第\s*[〇零一二三四五六七八九十百\d]+\s*[章卷节]\s*/, '')
  const head = t.split(/[:：]/)[0]
  const out: string[] = []
  for (const seg of head.split(/[、，,／/与和及\s]+/)) {
    const s = seg.replace(/[（）()「」【】《》]/g, '').trim()
    for (let n = 2; n <= Math.min(6, s.length); n++) out.push(s.slice(0, n))
  }
  return out
}

/**
 * 正文里的**地名候选**。
 *
 * 中文没有词边界，但地名有很稳的后缀特征。抓「1~3 个汉字 + 后缀」就够用了 ——
 * 这同样是检索键而非出版物，多抓无害。
 * 前缀里带指示词/量词的（「这座城」「一个州」）要滤掉，否则每节都会命中一堆噪音。
 */
/**
 * 这些字打头的「地名候选」是噪音 —— 它们把介词/动词/量词一起吞进去了。
 * 典型：「从西门」「往州城」「这座城」。
 */
const PLACE_STOP_CHARS = '这那一座个的了是在有把被和与又就也还只更最从往出进到过经沿向朝离回'

function isStopChar(ch: string): boolean {
  return !!ch && PLACE_STOP_CHARS.includes(ch)
}

/**
 * 中文地名有很稳的后缀特征，所以**从后缀反推**：先找后缀字，再往前取 1–3 字。
 *
 * ⚠️ 这里踩过一个坑，别退回成正则前扫：
 * 原来用 `[汉字]{1,3}(?:城|门|桥…)` 去扫，「漕渠从西门进来」会**从「渠」起头**
 * 贪婪吃成 **「渠从西门」**（起点 1、取 3 字、下一字「门」正好是后缀），
 * 而玩家写「我去西门」时匹配不上 —— 「从/往/在」是中文最常见的方位词，
 * 这不是小概率事件。
 *
 * 现在的规则：
 *  1. 扫到后缀字，往前取 1、2、3 字各成一个候选；
 *  2. 候选首字是噪音字（介词/动词/量词，见 `PLACE_STOP_CHARS`）就跳过这个变体；
 *  3. **多收无害** —— 噪音候选（「中镇」）在情境里不会出现，永远命中不了，
 *     只白占一点计算；而**漏掉**一个真地名才是真损失（那一节永远挑不出来）。
 */
const PLACE_SUFFIXES = '城镇州府县道关驿坊桥渡岭谷原港村庄寺塔楼殿宫苑山河江湖海门台'
const SUFFIX_SET = new Set(PLACE_SUFFIXES.split(''))

function placeCandidates(body: string): string[] {
  const s = String(body || '')
  const out: string[] = []
  for (let i = 0; i < s.length; i++) {
    if (!SUFFIX_SET.has(s[i])) continue
    for (let n = 1; n <= 3; n++) {
      const start = i - n
      if (start < 0) break
      const w = s.slice(start, i + 1)
      if (!/^[\u4e00-\u9fff]+$/.test(w)) break
      // 「从西门」「这座城」这类：首字是噪音，跳过这个变体（但继续试更长的）
      if (w.length > 1 && isStopChar(w[0])) continue
      out.push(w)
    }
  }
  return out
}

/**
 * **泛词黑名单**：这些词当下检索键只会制造误命中。
 *
 * ## 为什么必须挡（2026-11，跑九部真实世界时看出来的）
 *
 * 检索键有两条来源，都会吐泛词：
 *  - `titleKeys` 取标题前缀 —— 「第十二章 **一件**小事」会把「一件」当键；
 *  - `placeCandidates` 认后缀 —— 「打交**道**」会吐出「交道」「打交道」，
 *    「码**头**门」会吐出「头门」「码头门」。
 *
 * 单个词看起来无害（原注释写过"多收无害"），**但它们是高频词**：
 * 情境里出现「一件」「知道」「交道」的概率远高于任何一个专名，
 * 一旦命中就把整章所有段落的分抬起来 —— 于是段级检索被一点点抵消。
 *
 * 实测：埃律西昂那一轮的命中列表里，「知道」「都知道」和「城门」并排出现，
 * 而前者是纯噪音。这就是这份表存在的理由。
 *
 * 判据很简单：**这些词在任何题材里都不可能是一个地方或一个人的名字。**
 */
const GENERIC_KEYS = new Set([
  '一个', '一件', '一些', '一样', '一种', '一边', '一半', '一般', '一层', '一段',
  '这一', '那一', '这种', '那种', '这些', '那些', '这里', '那里',
  '什么', '怎么', '为什么', '因为', '所以', '但是', '而且', '于是',
  '知道', '不知', '觉得', '以为', '时候', '地方', '东西', '事情', '问题',
  '交道', '味道', '样子', '意思', '办法', '东西', '多少', '几个', '所有',
])

/** 一节的全部检索键：标题前缀 + 正文地名候选（两边都过一遍泛词黑名单） */
function sectionKeys(section: LoreSection): string[] {
  const keys = new Set<string>()
  for (const k of titleKeys(section.title)) if (!GENERIC_KEYS.has(k)) keys.add(k)
  for (const w of placeCandidates(section.body)) if (!GENERIC_KEYS.has(w)) keys.add(w)
  return [...keys]
}

export interface LoreDigestOptions {
  /** 本轮情境文本（玩家行动 + 当前地点 + 在场角色 + 最近叙事…） */
  context: string
  /** 世界里真实存在的专名（`collectWorldProperNouns` 的产物） */
  nouns: readonly string[]
  /**
   * 展开章节的**汉字预算**。
   *
   * 默认 **9000**（2026-11 从 12000 降下来）。
   *
   * 降的理由不是省钱，是**输出被挤压**：实测一轮的输入能到 3 万 token
   * （世界书 + 12 条历史 + 记忆 + 系统提示），而目标输出只有 1800 字 ≈ 2700 token。
   * 上下文里塞的东西越多，模型越倾向于"快点收尾"—— 字数不达标有一半是这个原因。
   * 9000 汉字仍然能把"这一轮用得上的那几节"给全，只是不再顺带塞进整章。
   */
  budget?: number
  /** 无条件保留靠前几节（不含总纲）。默认 2。 */
  alwaysInclude?: number
}

/**
 * 一个**段落**级的注入单位。
 *
 * ## 为什么要细到段（2026-11）
 *
 * 原先 `picked` 是整章（`LoreSection`）。一章 1000–1500 字，
 * 只要这一章命中一个专名，**整章**就进提示词。问题不是贵，是**稀释**：
 * 一章里通常有三五段（漕运、物价、讼案、节庆），只有一段对眼前这轮有用，
 * 剩下八九百字在无关地占注意力。
 *
 * 所以拆到段：只给他真正用得上的那几段，**外加前后各一段**当上下文。
 * 见 `digestLore` 里的滑窗部分。
 */
export interface LoreChunk {
  /** 所属章的标题（渲染时同一章的段落合并成一个块，标题只出现一次） */
  title: string
  /** 这一段正文（已 trim） */
  body: string
  /** 章内序号（0 = 该章第一段） */
  paraIndex: number
  /** 章序号（不含总纲）；排序与滑窗都用它定位 */
  chapterIndex: number
}

export interface LoreDigest {
  /** 常驻的总纲（可能为空串） */
  preamble: string
  /** 本轮展开的**段落**（已按原文顺序排好） */
  picked: LoreChunk[]
  /** 其余章节的索引（仍是**章**级 —— 索引再细下去自己就膨胀了） */
  rest: { title: string; gist: string }[]
  /** 诊断用：本轮命中的专名 */
  hits: string[]
}

/**
 * 把一章正文切成段。
 *
 * ## 两级切分（第二级是必须的，别删）
 *
 * 1. **按空行切**（`\n\n`）—— 正文正常的章都走这条。
 * 2. 切出来只有一段、而且这一段够长时，**退化成按单换行切**。
 *
 * 第二级是给《中帝纪年》那种格式救的：它 20 章**整整 20 段**，
 * 每章一整块 1800 字、章内一个空行都没有（只有软换行）。
 * 不加这一级，段级检索对它就**完全无效** —— 而这件事从测试里看不出来，
 * 只有拿九部真实世界跑一遍才会暴露（`.check/lore-compare.mjs` 就是干这个的）。
 *
 * 阈值 400 字是有意的：再短就别切了，否则一首三行的诗会被切成三截。
 */
export function splitParagraphs(body: string): string[] {
  const s = String(body || '').trim()
  if (!s) return []

  const byBlank = s.split(/\n[ \t]*\n/).map(x => x.trim()).filter(Boolean)
  if (byBlank.length > 1) return byBlank

  // 只有一段：可能是整章一口气写下来。够长才试着按软换行再切。
  const only = byBlank[0] || ''
  if (cjkLen(only) < 400) return byBlank
  const byLine = only.split(/\n+/).map(x => x.trim()).filter(Boolean)
  return byLine.length > 1 ? byLine : byBlank
}

/**
 * 按本轮情境挑出该展开哪些**段落**。
 *
 * ## 打分规则
 *
 * 以「段」为单位打分，两条来源相加：
 *  1. **章标题命中** → 这一章的**每一段** +2。标题写的就是这章在讲什么，
 *     命中说明整章偏相关（比如提到「云中镇」时，军制那一章都值得看）。
 *  2. **段内命中** → 每命中一个键 +1。这一条才是真正分出高下的：
 *     同一章里，写了「雁门」的那一段比只讲粮价的段落更该被翻开。
 *
 * ## 滑窗
 *
 * 命中段选中之后，**同章的前后各一段**也补进来（不计分、只补上下文）。
 * 没有这一步就会出现「上一段的结论被截掉、下一段的转折被截掉」——
 * 而中文段落之间常常靠「所以」「至于」这类词衔接，砍掉邻段就读不通了。
 */
export function digestLore(lore: string, opts: LoreDigestOptions): LoreDigest {
  const budget = Math.max(1000, opts.budget ?? 9000)
  const always = Math.max(0, opts.alwaysInclude ?? 2)
  const sections = splitLore(lore)

  if (!sections.length) return { preamble: '', picked: [], rest: [], hits: [] }

  // 总纲可能不止一节（第一个标题之前的全部内容）
  const preambleSec = sections.find(s => !s.title)
  const chapters = sections.filter(s => s.title)
  const preamble = preambleSec?.body.trim() || ''

  // ── 所有段落，带上位置 ──
  const chunks: LoreChunk[] = []
  chapters.forEach((ch, ci) => {
    splitParagraphs(ch.body).forEach((body, pi) => {
      chunks.push({ title: ch.title, body, paraIndex: pi, chapterIndex: ci })
    })
  })

  // ── 情境里出现了哪些**外部专名**（角色名 / 物品名 / lore 名 / 「」里的词）──
  const ctx = String(opts.context || '')
  const externalHits = ctx
    ? opts.nouns.filter(n => n && n.length >= 2 && ctx.includes(n))
    : []

  /*
    ── 情境里出现了哪些**章节自带的检索键** ──

    ⚠️ 这一步不能省，而且是我第一版做错的地方。
    第一版只用外部专名（`collectWorldProperNouns` 的产物）当检索键，
    而那份清单来自「`worldLore` 里 `「」` 括起来的词 + 角色/物品/lore 名」——
    **地名几乎都不在里面**（正文里写「汴梁」不会加引号）。
    结果：无论玩家在汴梁办事还是在云中镇从军，挑出来的都是同样的前两节，
    「按需注入」退化成了「固定注入靠前的两节」（体积是省了，但没挑对）。

    现在把每节**自己的**标题前缀与正文地名也当检索键，一次性算出哪些在本轮情境里出现过。
    注意：键仍按**整章**收（`sectionKeys` 吃的是 chapter），
    因为标题属于整章；段级只影响「哪些段被翻开」，不影响「这章跟这轮有没有关系」。
  */
  const liveKeys = new Set<string>()
  if (ctx) {
    const all = new Set<string>()
    for (const ch of chapters) for (const k of sectionKeys(ch)) all.add(k)
    for (const k of all) if (ctx.includes(k)) liveKeys.add(k)
  }

  /** 标题命中了的章（chapterIndex），给该章每一段一个基础分 */
  const titleHitChapters = new Set<number>()
  // ── 打分（段级）──
  const scored = chunks.map((c, i) => {
    let score = 0
    const hits: string[] = []
    const chapterTitle = chapters[c.chapterIndex].title
    for (const k of liveKeys) {
      if (chapterTitle.includes(k)) { score += 2; titleHitChapters.add(c.chapterIndex); hits.push(k) }
      else if (c.body.includes(k)) { score += 1; hits.push(k) }
    }
    for (const n of externalHits) {
      if (chapterTitle.includes(n)) { score += 2; titleHitChapters.add(c.chapterIndex); hits.push(n) }
      else if (c.body.includes(n)) { score += 1; hits.push(n) }
    }
    return { chunk: c, index: i, score, hits }
  })

  /** 诊断用：这一轮到底命中了些什么（排查"为什么没挑中物价那段"全靠它） */
  const allHits = [...new Set(scored.flatMap(x => x.hits))]

  // 无条件保留的靠前几**章**（它们通常是舆图与势力这类"不知道就没法开口"的底子）
  const forcedChapters = new Set(
    Array.from({ length: Math.min(always, chapters.length) }, (_, i) => i),
  )
  const forced = new Set(scored.filter(x => forcedChapters.has(x.chunk.chapterIndex)).map(x => x.index))

  // 贪心：分数高的先放，预算用完就停（被 forced 的先占额度）
  const ordered = [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.chunk.chapterIndex !== b.chunk.chapterIndex) return a.chunk.chapterIndex - b.chunk.chapterIndex
    return a.chunk.paraIndex - b.chunk.paraIndex
  })

  const pickedIdx = new Set<number>()
  let used = 0

  for (const x of ordered) {
    const isForced = forced.has(x.index)
    // 非强制项：分数为 0 就不放了（放进来只会白占额度）
    if (!isForced && x.score === 0) continue
    const len = cjkLen(x.chunk.body)
    if (!isForced && used + len > budget) continue
    pickedIdx.add(x.index)
    used += len
  }

  // 保底：一段都没挑出来时（上下文里一个专名都没命中），
  // 至少给最靠前那章的段落，免得模型手里完全没有世界
  if (!pickedIdx.size) {
    for (const x of scored.filter(x => x.chunk.chapterIndex === 0)) pickedIdx.add(x.index)
    if (!pickedIdx.size) for (const x of scored.slice(0, 1)) pickedIdx.add(x.index)
  }

  /*
    ── 滑窗：命中段的**同章前后各一段**补进来 ──

    不计分、只补上下文，且要占预算。剩下的额度放不下就跳过（宁可少给一段，
    也不要为了补齐邻段把别处的正主挤出去）。
  */
  const anchorIdx = [...pickedIdx]
  for (const i of anchorIdx) {
    const c = scored[i].chunk
    for (const d of [-1, 1]) {
      const j = i + d
      const nb = scored[j]
      if (!nb || nb.chunk.chapterIndex !== c.chapterIndex) continue
      if (pickedIdx.has(j)) continue
      const len = cjkLen(nb.chunk.body)
      if (used + len > budget) continue
      pickedIdx.add(j)
      used += len
    }
  }

  // 保持**原文顺序**输出：模型读起来与世界书的结构一致
  const picked = [...pickedIdx]
    .sort((a, b) => a - b)
    .map(i => scored[i].chunk)

  const pickedChapters = new Set(picked.map(p => p.chapterIndex))
  const rest = chapters
    .filter((_, i) => !pickedChapters.has(i))
    .map(s => ({ title: s.title, gist: gistOf(s.body) }))

  return { preamble, picked, rest, hits: allHits }
}

/**
 * 把挑好的章节渲染成注入提示词的一段文本。
 *
 * 落选章节的索引**必须**带上，而且要写清"不要凭空断言它们的细节"——
 * 少了这句，模型会以为"世界书里没有的东西就是不存在"，
 * 或者更糟：顺手编一个与那一节冲突的说法。
 */
export function renderLoreDigest(digest: LoreDigest, worldTitle: string): string {
  const parts: string[] = []

  if (digest.preamble) parts.push(digest.preamble)

  if (digest.picked.length) {
    /*
      ⚠️ 这段说明不能省。模型看不到"其余章节"，如果没人告诉它这是**按需挑的**，
      它会把这个残缺的世界书当成全部 —— 于是玩家问起某个没展开的侧面时，
      它要么说"这里没有"，要么现编一个与该章节冲突的答案。
    */
    parts.push(
      `> 以下章节是**按当前情境挑出来的**（这一轮用得上），` +
      `挑的是**段落**而不是整章 —— 同一章里没贴出来的部分，与本轮无关，` +
      `但它是**存在**的。世界书还有更多侧面，见末尾索引。`,
    )
    // 同一章的多段合并成一块，标题只出现一次（读起来与世界书结构一致）
    const groups: { title: string; bodies: string[] }[] = []
    for (const c of digest.picked) {
      const last = groups[groups.length - 1]
      if (last && last.title === c.title) last.bodies.push(c.body)
      else groups.push({ title: c.title, bodies: [c.body] })
    }
    for (const g of groups) {
      parts.push(`**${g.title}**\n\n${g.bodies.join('\n\n')}`)
    }
  }

  if (digest.rest.length) {
    parts.push(
      `### 世界书的其他章节（**本轮未展开**）\n\n` +
      digest.rest.map(r => `- **${r.title}**：${r.gist}`).join('\n') +
      `\n\n⚠️ 上面这些只有标题与一句话提要。**不要凭空断言**它们的具体设定` +
      `（具体数字、具体官职、具体地名）—— 需要用到时，用与《${worldTitle}》既有正文` +
      `一致的笼统说法带过，或者干脆绕开。`,
    )
  }

  return parts.join('\n\n')
}
