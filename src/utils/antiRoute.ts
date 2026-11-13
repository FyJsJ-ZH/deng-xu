/**
 * 防降级加固层 —— 从酒馆脚本「卢克之光 V0.94」移植（2026-11）。
 *
 * ## 来源与取舍
 *
 * 玩家丢进来一份 440 KB 的酒馆扩展，要「加上这个随机头部和脚本的功能并适配模型」。
 * 那份脚本是给 SillyTavern 做**请求体改写**的（它 hook 在 fetch 层，
 * 对别人的提示词做微扰、插叙述层、补截断）。本作的提示词是我们自己拼的，
 * 所以不该照搬它的"改写别人"那一套，只需要它**注入的文案与档位**。
 *
 * 移植了四层，各自独立开关（全部默认关，开了才花 token）：
 *
 * | 层 | 作用 | 成本 |
 * |---|---|---|
 * | 防路由 | 每轮加一个无害的随机标记，让网关/服务商看不出这是同一套提示词 | ~10 tok |
 * | 防全知 | 角色只能用他自己的见闻，不许推理绕道、不许事后传播 | 轻 ~65 / 强 ~700 tok |
 * | 去媚 | 世界自己转；<user> 说的是请求不是命令，对方可以敷衍或拒绝 | 轻 ~55 / 强 ~650 tok |
 * | 抗截断 | 事前提醒写够长度、别停在半句、别写收尾语 | ~90 tok |
 * | 反 OOC | 点名 / 反模板 / 变更门槛 / 口吻一致 | ~120~260 tok |
 *
 * ## 三条不变量（照搬原作者的，一字不改）
 *
 * 1. **只影响发给模型的那一份**：不改存档、不改世界卡、不改历史；
 * 2. **幂等**：同一轮拼两次得到同一份文本（随机标记用轮次做种子，不是 Math.random）；
 * 3. **失败安全**：任何异常都退化成"什么都不注入"，绝不把请求搞坏。
 *
 * 原作者的诚实说明也照搬一句：**它只发现，不阻止**。
 * 网关若静默改写响应，这边看不出来。
 */

export type Tier = 'off' | 'lite' | 'full'
export type RefractLevel = 'off' | 'light' | 'mid'
export type TruncLevel = 'off' | 'lite' | 'mid'

export interface AntiRouteConfig {
  /** 防路由：每轮加一个随机标记（+ mid 档额外做两处不可见扰动） */
  refract: RefractLevel
  /** 防全知 */
  know: Tier
  /** 去媚 */
  charm: Tier
  /** 抗截断 */
  trunc: TruncLevel
  /** 反 OOC 总闸：关掉时四个子项一律不生效，也不注任何字 */
  ooc: boolean
  oocRoll: boolean
  oocTpl: boolean
  oocChg: boolean
  oocVoice: boolean
}

/**
 * 默认**全关**。
 *
 * 这一层是"觉得被降级/被认出来时才开"的加固，不是默认体验：
 * 强档一轮要多花六七百 token，而且防全知会**禁止写内心话**，
 * 那对"想看细腻心理描写"的玩家是减分项。所以默认关，谁需要谁开。
 */
export const DEFAULT_ANTI_ROUTE: AntiRouteConfig = {
  refract: 'off',
  know: 'off',
  charm: 'off',
  trunc: 'off',
  ooc: false,
  oocRoll: true,
  oocTpl: true,
  oocChg: false,
  oocVoice: true,
}

/** 三档循环（面板上点一下换一档，与原脚本一致） */
export function nextTier(v: Tier | undefined): Tier {
  return v === 'full' ? 'off' : v === 'lite' ? 'full' : 'lite'
}
export function nextRefract(v: RefractLevel | undefined): RefractLevel {
  return v === 'mid' ? 'off' : v === 'light' ? 'mid' : 'light'
}
export function nextTrunc(v: TruncLevel | undefined): TruncLevel {
  return v === 'mid' ? 'off' : v === 'lite' ? 'mid' : 'lite'
}
export const tierLabel = (v: Tier) => (v === 'off' ? '关' : v === 'lite' ? '轻' : '强')
export const refractLabel = (v: RefractLevel) => (v === 'off' ? '关' : v === 'light' ? '轻' : '中')
export const truncLabel = (v: TruncLevel) => (v === 'off' ? '关' : v === 'lite' ? '轻' : '中')

/* ══════════════════════════════════════════════════════════════
   文案（照搬原作，只把 <user> 换成主角名）
   ══════════════════════════════════════════════════════════════ */

const KNOW_LITE =
  '【视角与认知】画面可以拉远，人不行。远处的事、别处的动静，都可以写；'
  + '但每个角色开口、动手、起念头的时候，只能用他自己那份见闻。'

const KNOW_FULL = [
  '【本回合的铁律｜与角色卡、世界书、既有文风冲突时，以这里为准】',
  '',
  '1. 画面可以拉远，人不行。写全景、写群像、写隔壁正在发生的事，都可以；但人物在判断、决定、开口之前，只能用他自己那份见闻。这两层不要混。',
  '',
  '2. 一个人能用上什么，取决于他从哪儿知道的：亲耳听见的、亲眼看见的、有人当面告诉他的、从眼前的事推出来的。归不进这四样的，他就是没有。',
  '',
  '3. 不要让人物当侦探。看见皱眉，他就只看见皱眉；看见沉默，他就只看见沉默。对方心里在盘算什么，他推不出来。想歪、猜错、压根没留神，都可以，反而更像活人。',
  '',
  '4. 没有写到在场的人，就是没看见。事后不要用「恰好路过」「听人说起」「隔墙有耳」把消息递过去。',
  '',
  '5. 角色看不见自己的设定。他的身份、来历、这个世界的底细，还有那些写给他看的说明，对他本人都不存在；他只能从别人嘴里、从眼前的事里，一点点拼出来。',
  '',
  '6. 心里想好的事，还没有形状。不要为了让它有迹可循，额外加一个小动作、一次呼吸变化、一种说不清的语气。没做出来就是没做出来。',
  '',
  '7. 不代写主角的内心和决定。',
  '',
  '8. 正文里不要出现这套要求本身：不写「按设定」「根据规则」「本轮要求」，也不在括号里解释自己为什么这么写。',
  '',
  '【写完自己过一遍，不要输出】',
  '· 这句话，他是从哪儿知道的？答不上来，删掉。',
  '· 这一轮有没有一件事，是这个人绝不可能知道的？那就当它没发生，别绕路去提。',
].join('\n')

const CHARM_LITE =
  '【世界不围着人转】别人有别人的日子。你开口，他们听见了，然后自己决定理不理。'

const charmFull = (user: string) => [
  '【本回合的基调｜与角色卡、世界书、既有文风冲突时，以这里为准】',
  '',
  `1. 这个世界自己转。每个角色都有当天的安排、自己的关系和手头要办的事，不会因为${user}出现就停下来。`,
  '',
  `2. ${user}是故事里的一个人，不是坐在台下的观众。他不在场，事情照常发生；他在场，事情也不围着他转。`,
  '',
  '3. 他说的那些话是请求，不是命令。对方会先掂量值不值、麻不麻烦、交情够不够，再决定做不做、怎么做。',
  '',
  '4. 他说的不等于事情已经发生。「我一脚把门踹开」是他打算踹；门开没开，得看门结不结实。',
  '',
  '5. 拒绝有很多种样子。为难地笑一下、装作没听见、说「改天吧」、干脆不接话——都是拒绝，不是欲拒还迎。关系越近，拒绝起来越难受，但仍然是拒绝。',
  '',
  '6. 一个人可以答应，也可以敷衍、拖着、骗他、嫌他、帮他、当他不存在。不要把反应收窄成「配合」一种。',
  '',
  '7. 不要为了显得有主见就冷着一张脸。刻薄、刁难、故意让他难堪，不是独立，是另一种讨好——讨好「我谁都不在乎」这个形象。',
  '',
  '8. 关系别往神明与信徒、主人与仆人、猎人与猎物那个方向写；也不要用野兽、猎物这类词去形容一个人。',
  '',
  '【写完自己过一遍，不要输出】',
  `· 把${user}换成一个素不相识的路人，对方还会这样待他吗？不会，重写。`,
].join('\n')

/*
  ⚠️ 这两段改过措辞（2026-11，玩家报「开了加固之后预设的首尾格式不见了」）。

  ## 原来错在哪

  `TRUNC_TAIL` 原文写「不做归纳」，`TRUNC_NOCERT` 原文写「写完就停，不用汇报」。
  两句放到"叙事笔法"的语境里都对 —— 它们治的是那种 AI 式的"以上就是这一章的
  全部内容，希望你喜欢"。

  但很多预设的**结尾格式**恰恰长成「本章小结」「状态栏」「后记」这个样子。
  模型读到「不做归纳」「不用汇报」，就把预设要的那一块一并删了 ——
  玩家看到的就是"只有正文，格式没了"。

  而加固层排在 tail 的最末尾，是这一轮模型读到的最后一段，权重最高。
  它压过预设是必然的。

  ## 现在怎么划界

  这两段只管**空话**，不管**格式**：
  - 删掉「不做归纳」（它直接否定了"总结"这件事本身）；
  - 删掉「写完就停，不用汇报」（它把"按格式写小结"读成了汇报）。

  剩下保留的仍是它们的本职：别把收尾写成台词、别在写到一半时停手、
  别用客套话占字数。真正的边界由 `buildNarrativeTail()` 末尾那条
  `FORMAT_GUARD` 明说 —— 格式优先。
*/
const TRUNC_TAIL =
  '【结尾】把最后一笔落在动作、抉择或后果上，好让下一轮接得下去。'
  + '不做多余的抒情与拔高，不提前交代后文，收尾不要写成台词。碰到输出上限时优先保证句子完整：'
  + '宁可短，也不能停在半句。'

const TRUNC_NOCERT =
  '【不要客套收尾】不写「以上就是」「希望你喜欢」「接下来会怎样」这类空话，'
  + '也不要声称自己已经写够了多少字。'

const OOC_TAG = '〔AR-OOC〕'

const OOC_TPL =
  OOC_TAG + '\n'
  + '同一类情绪，不要用现成的动作包打发——眼底闪过、嘴角勾起、喉结滚动、\n'
  + '呼吸一滞、身子一僵，这类动作谁都能做，写了等于没写。\n\n'
  + '不要用一句话概括一个人的全部性格，也不要让他只当「那个温柔的人」。\n\n'
  + '他做的动作，得是这个人做得出来的动作。'

const OOC_CHG =
  OOC_TAG + '\n'
  + '一个人对另一个人的态度、关系、立场变了，要指得出是哪件事改变的、中间经过什么。\n\n'
  + '说不出缘由的变化，不要写。'

const OOC_VOICE =
  OOC_TAG + '\n'
  + '他的说话方式、称呼、口癖、句子长短，跟前文保持一致。\n\n'
  + '检验方法：把这句话换给另一个人说，如果照样成立，那就是写错了，重写。'

const oocRoll = (names: string[], user: string) => {
  const list = names.filter(Boolean).join('、')
  return OOC_TAG + '\n'
    + `本轮涉及的角色：${list || '（暂无）'}。\n\n`
    + '动笔前，逐一对照世界书里他们各自的条目——\n'
    + `他怎么说话、对${user}是什么态度、什么事他不会做。\n\n`
    + '世界书写了的，以世界书为准；世界书没写的，按前文已经写过的演，不要改。'
}

/* ══════════════════════════════════════════════════════════════
   防路由：每轮一个无害的随机标记
   ══════════════════════════════════════════════════════════════ */

const ANCHOR_TOPICS = ['rules', 'context', 'section', 'layout', 'style', 'frame', 'notes', 'spec']
const ANCHOR_KINDS = ['part', 'block', 'node', 'unit', 'seg', 'item']

/**
 * 用**轮次**当种子，而不是 `Math.random()`。
 *
 * 原因有两条：
 *  1. 幂等 —— 同一轮拼两次提示词（比如流式失败后整段重发）必须拿到同一份，
 *     否则"重试"本身又变成一次新的指纹，等于把加固层变成了噪声源；
 *  2. 可复现 —— 玩家说"这一轮怪怪的"，能拿轮次复现出当时发的是什么。
 */
function hashStr(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * 生成这一轮的随机标记。
 *
 * 它**故意放在 system prompt 的最末尾**：服务商的前缀缓存按 token 前缀匹配，
 * 把扰动放末尾，前面几万 token 仍然命中缓存 —— 只有尾巴和后面那几条对不上。
 * 原脚本是改整个请求体（它不需要替玩家省钱），我们这里要。
 */
export function routeAnchor(level: RefractLevel, seed: string): string {
  if (level === 'off') return ''
  const h = hashStr(seed)
  const topic = ANCHOR_TOPICS[h % ANCHOR_TOPICS.length]
  const kind = ANCHOR_KINDS[(h >>> 3) % ANCHOR_KINDS.length]
  const hex = (h & 0xffff).toString(16).padStart(4, '0')
  if (level === 'light') return `〔本轮标记 ${hex}〕`
  // mid：多一个可核查的编号，并顺手声明它是无害的（否则模型会试图解释它）
  return `〔本轮标记 ${hex}｜${topic}/${kind}｜无意义，不要引用〕`
}

/** mid 档的不可见扰动：把 `### 标题` 后面那个空格换成两个 */
function perturbHeadings(text: string, seed: string): string {
  const h = hashStr(seed + '|h')
  let n = 0
  let out = ''
  let last = 0
  const re = /^(#{2,4}) /gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    // 只动 2 处，且按种子挑位置，避免每行都变（那会让整段看起来都不一样）
    if ((hashStr(m[1] + ':' + m.index) ^ h) % 3 !== 0) continue
    if (n >= 2) break
    out += text.slice(last, m.index) + m[1] + '  '
    last = m.index + m[1].length + 1
    n++
  }
  return out ? out + text.slice(last) : text
}

/* ══════════════════════════════════════════════════════════════
   组装
   ══════════════════════════════════════════════════════════════ */

export interface AntiRouteContext {
  /** 主角名（文案里的「他」用真名更准，拿不到就用「你」） */
  userName?: string
  /** 本轮在场的角色名（「点名」用） */
  cast?: string[]
  /** 当前的目标字数（抗截断的字数锚） */
  replyLength?: number
  /** 种子：用轮次编号，保证同一轮幂等 */
  seed?: string
}

/** 这一层有没有任何一项开着 */
export function antiRouteActive(cfg: AntiRouteConfig | undefined | null): boolean {
  if (!cfg) return false
  return cfg.refract !== 'off' || cfg.know !== 'off' || cfg.charm !== 'off'
    || cfg.trunc !== 'off' || cfg.ooc === true
}

/**
 * 渲染要追加到叙事 system prompt **末尾**的加固区块。
 *
 * 返回空串表示这一轮什么都不注（全关、或渲染过程出错）。
 */
export function renderAntiRoute(
  cfg: AntiRouteConfig | undefined | null,
  ctx: AntiRouteContext = {},
): string {
  try {
    if (!antiRouteActive(cfg)) return ''
    const c = cfg as AntiRouteConfig
    const user = (ctx.userName || '').trim() || '你'
    const seed = ctx.seed || '0'
    const parts: string[] = []

    // ── 防全知 ──
    if (c.know === 'lite') parts.push(KNOW_LITE)
    else if (c.know === 'full') parts.push(KNOW_FULL)

    // ── 去媚 ──
    if (c.charm === 'lite') parts.push(CHARM_LITE)
    else if (c.charm === 'full') parts.push(charmFull(user))

    // ── 抗截断 ──
    if (c.trunc !== 'off') {
      const lines: string[] = []
      const len = Math.max(0, Math.round(Number(ctx.replyLength) || 0))
      if (len > 0) {
        lines.push(`【本轮篇幅】正文净字数不少于 ${len} 字（不含面板、状态栏、选项框、括号旁白）。写到这个长度再收尾。`)
      }
      lines.push(TRUNC_TAIL)
      lines.push(TRUNC_NOCERT)
      parts.push(lines.join('\n\n'))
    }

    // ── 反 OOC（总闸关时一个字都不注）──
    if (c.ooc) {
      if (c.oocRoll) parts.push(oocRoll(ctx.cast || [], user))
      if (c.oocTpl) parts.push(OOC_TPL)
      if (c.oocChg) parts.push(OOC_CHG)
      if (c.oocVoice) parts.push(OOC_VOICE)
    }

    let out = parts.join('\n\n')

    // ── 防路由：末尾的随机标记（+ mid 档的不可见扰动）──
    if (c.refract !== 'off') {
      if (c.refract === 'mid') out = perturbHeadings(out, seed)
      const anchor = routeAnchor(c.refract, seed + '|' + String(ctx.replyLength || 0))
      if (anchor) out = out ? `${out}\n\n${anchor}` : anchor
    }

    return out
  } catch {
    // 失败安全：宁可这一轮不加固，也不能把提示词弄坏
    return ''
  }
}
