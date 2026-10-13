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
const PLACE_RE = /[\u4e00-\u9fff]{1,3}(?:城|镇|州|府|县|道|关|驿|坊|桥|渡|岭|谷|原|港|村|庄|寺|塔|楼|殿|宫|苑|山|河|江|湖|海|门|台)/g
const PLACE_STOP = /^[这那一座个的了是在有把被和与又就也还只更最]/

/** 一节的全部检索键：标题前缀 + 正文地名候选 */
function sectionKeys(section: LoreSection): string[] {
  const keys = new Set<string>(titleKeys(section.title))
  for (const m of String(section.body).matchAll(PLACE_RE)) {
    const w = m[0]
    if (!PLACE_STOP.test(w)) keys.add(w)
  }
  return [...keys]
}

export interface LoreDigestOptions {
  /** 本轮情境文本（玩家行动 + 当前地点 + 在场角色 + 最近叙事…） */
  context: string
  /** 世界里真实存在的专名（`collectWorldProperNouns` 的产物） */
  nouns: readonly string[]
  /**
   * 展开章节的**汉字预算**。默认 12000 —— 约为大晟 worldLore 的五分之一，
   * 实测能省掉七成以上的 prompt 体积，同时把真正相关的那几节留在眼前。
   */
  budget?: number
  /** 无条件保留靠前几节（不含总纲）。默认 2。 */
  alwaysInclude?: number
}

export interface LoreDigest {
  /** 常驻的总纲（可能为空串） */
  preamble: string
  /** 本轮展开的章节 */
  picked: LoreSection[]
  /** 其余章节的索引 */
  rest: { title: string; gist: string }[]
  /** 诊断用：本轮命中的专名 */
  hits: string[]
}

/**
 * 按本轮情境挑出该展开哪些章节。
 *
 * 返回的 `picked` 里**总是**含 `alwaysInclude` 那几节（只要它们存在），
 * 其余按分数从高到低填到预算用完为止。
 */
export function digestLore(lore: string, opts: LoreDigestOptions): LoreDigest {
  const budget = Math.max(1000, opts.budget ?? 12000)
  const always = Math.max(0, opts.alwaysInclude ?? 2)
  const sections = splitLore(lore)

  if (!sections.length) return { preamble: '', picked: [], rest: [], hits: [] }

  // 总纲可能不止一节（第一个标题之前的全部内容）
  const preambleSec = sections.find(s => !s.title)
  const chapters = sections.filter(s => s.title)
  const preamble = preambleSec?.body.trim() || ''

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
    */
  const liveKeys = new Set<string>()
  if (ctx) {
    const all = new Set<string>()
    for (const s of chapters) for (const k of sectionKeys(s)) all.add(k)
    for (const k of all) if (ctx.includes(k)) liveKeys.add(k)
  }

  // ── 打分 ──
  const scored = chapters.map((s, i) => {
    let score = 0
    const hits: string[] = []
    for (const k of liveKeys) {
      // 标题里命中的权重更高：标题就是这一节在讲什么
      if (s.title.includes(k)) { score += 4; hits.push(k) }
      else if (s.body.includes(k)) { score += 1; hits.push(k) }
    }
    for (const n of externalHits) {
      if (s.title.includes(n)) { score += 4; hits.push(n) }
      else if (s.body.includes(n)) { score += 1; hits.push(n) }
    }
    return { section: s, index: i, score, hits }
  })

  /** 诊断用：这一轮到底命中了些什么（排查"为什么没挑中物价那节"全靠它） */
  const allHits = [...new Set(scored.flatMap(x => x.hits))]

  // 无条件保留的靠前几节
  const forced = new Set(scored.slice(0, always).map(x => x.index))

  // 贪心：分数高的先放，预算用完就停（被 forced 的先占额度）
  const ordered = [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.index - b.index   // 同分时靠前的章节优先
  })

  const picked: LoreSection[] = []
  const pickedIdx = new Set<number>()
  let used = 0

  for (const x of ordered) {
    const isForced = forced.has(x.index)
    // 非强制项：分数为 0 就不放了（放进来只会白占额度）
    if (!isForced && x.score === 0) continue
    const len = cjkLen(x.section.body)
    if (!isForced && used + len > budget) continue
    picked.push(x.section)
    pickedIdx.add(x.index)
    used += len
  }

  // 保底：一节都没挑出来时（上下文里一个专名都没命中），
  // 至少给最靠前的几节，免得模型手里完全没有世界
  if (!picked.length) {
    for (const x of scored.slice(0, Math.max(1, always))) {
      picked.push(x.section)
      pickedIdx.add(x.index)
    }
  }

  // 保持**原文顺序**输出：模型读起来与世界书的结构一致
  picked.sort((a, b) => chapters.indexOf(a) - chapters.indexOf(b))

  const rest = chapters
    .filter((_, i) => !pickedIdx.has(i))
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
      `> 以下章节是**按当前情境挑出来的**（这一轮用得上）。` +
      `世界书还有更多侧面，见末尾索引。`,
    )
    for (const s of digest.picked) {
      parts.push(`**${s.title}**\n\n${s.body.trim()}`)
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
