/**
 * 长期记忆的分层模型（A1）
 *
 * ## 为什么要把记忆拆成三层
 *
 * 在这之前，引擎的记忆只有 `summary` 一个字符串（见 buildSummaryPrompt）。
 * 它是**一整块被反复改写的散文**，于是玩到二十轮以后会出现一个必然的衰减：
 *
 *  - **人物关系最先丢**。摘要的容量是固定的 300 字，新剧情不断挤进来，
 *    挤掉的往往是最早那几轮里"谁欠了他、他得罪了谁"。而这几条恰恰是
 *    后续所有对话的前提 —— 模型不知道对方欠过他人情，就会把他当陌生人写。
 *  - **悬而未决的线索会凭空消失**。承诺、债务、威胁这类东西在"发生了什么"的
 *    叙述里毫不起眼，可它们是玩家心里记着的事。摘要压缩一次就没了。
 *  - **时间线会被压成没有轮次的印象**。玩家问"我们之前干过什么"时，
 *    模型只能给出模糊的氛围概括，说不出第几轮发生过什么。
 *
 * 三层的**衰减速度完全不同**，这才是它们必须分开维护的理由：
 *
 *  | 层 | 语义 | 衰减方式 |
 *  |---|---|---|
 *  | `bonds` | 关系**现状** | 只保留最新状态（谁欠谁），旧的覆盖新的 |
 *  | `threads` | 悬而未决 | 只有"了结"才移除，否则一直留着 |
 *  | `timeline` | 按轮次的事实 | 最近的逐条保留，更早的折成一句话 |
 *
 * 混在一段散文里时，三者会按同一个速度衰减 —— 于是最不能丢的那层
 * （关系）反而最先被挤掉。
 *
 * ## 字数上限
 *
 * 三层全部注入提示词，所以必须有一道硬上限：见 `MEMORY_BUDGET`。
 * 超限时**只压缩时间线**（折进 earlierSummary），
 * 因为关系与线索是"丢了就伤"的层 —— 宁可少记几轮发生过什么，
 * 也不能让模型忘记玩家和谁是什么关系。
 */

/** 主角与某个关键角色的关系现状 */
export interface Bond {
  /** 谁（人名或称呼；模型给的原文，不强行归一化） */
  who: string
  /** 关系状态：欠人情 / 敌意 / 盟友 / 猜疑… */
  state: string
}

/** 未结线索：谜题、承诺、债务、威胁 */
export interface Thread {
  id: string
  text: string
}

/** 时间线的一拍：某一轮发生了什么（一句话） */
export interface TimelineBeat {
  turn: number
  text: string
}

/**
 * 好感**双轨**：他心里怎么想，和他当面怎么表现。
 *
 * ## 为什么必须两档（2026-11）
 *
 * 单轨表达不了「嘴硬」—— 而「心里亲近、嘴上冷淡」恰恰是最好写的一种戏。
 * 单轨的模型只能二选一：要么把人写成熟人，要么写成陌生人，
 * 于是玩家看到的是"好感度一到就突然熟起来"的跳变。
 *
 * ## 五档（内外同一套，便于比较）
 *
 * `亲` 当你是自己人 / `近` 有好感 / `平` 无感 / `疏` 不放心 / `敌` 恨
 *
 * 内外**不一致**时最要紧，所以 `note` 要写清依据：
 * 「内心近 · 外表疏：他替你挡过一次话，但当着人从不叫你名字」。
 */
export interface Affinity {
  who: string
  /** 内心：亲 / 近 / 平 / 疏 / 敌；判不出就写「未知」 */
  inner: string
  /** 外在：同一套五档（他表现出来的） */
  outer: string
  /** 一句话依据：凭什么这么判 / 内外为什么不一致 */
  note?: string
}

/**
 * 地点树的一个节点。
 *
 * 原先只有一个 `location` 字符串，切三次场景之后就记不住谁在哪、
 * 哪两个地方是同一片街区。树结构解决的是「由大到小」这件事：
 * 柳关 → 南市 → 牌墙。
 *
 * ⚠️ 用**名字**串起父子，不用 id：模型写名字比写 id 可靠得多，
 * 而重名在同一世界里本来就少见（真撞了，后写的覆盖）。
 */
export interface PlaceNode {
  name: string
  /** 上级地点名；空 = 顶层 */
  parent?: string
}

/**
 * 主角手上有、或者知道放在哪的东西。
 *
 * ⚠️ 与 `WorldCard.items` 是**两回事**：那是「世界上这种东西长什么样」的模板，
 * 这是「他手上这一件现在在哪」。模型混用的时候，玩家的东西会凭空消失又出现。
 */
export interface HeldItem {
  name: string
  /** 在哪：随身 / 寄存在和通号 / 落在醉仙楼二楼 */
  where: string
  note?: string
}

/**
 * 三层记忆的完整形态。
 *
 * `summary` 仍然保留：它承载"这一路的经过"的连贯叙述，
 * 是三层结构化记忆**替代不了**的东西（模型读散文比读条目更容易接住语气）。
 * 三层解决的是"要点丢失"，不是"叙述丢失"。
 */
export interface StoryMemory {
  /** 第一层：人物关系现状 */
  bonds: Bond[]
  /** 第二层：未结线索 */
  threads: Thread[]
  /** 第三层：按轮次索引的事件 */
  timeline: TimelineBeat[]
  /**
   * 已被折叠的早期时间线（一句话）。
   *
   * 每次折叠都会把被丢掉的那些拍**压进这里**，所以时间线是有界的，
   * 而"更早发生过什么"这件事仍然有一句可读的交代。
   */
  earlierSummary: string
  /** 最近一次更新的轮次；0 表示还没更新过 */
  updatedAtTurn: number

  /**
   * **每个角色知道主角的什么**（角色名 → 已确认的事实条目）。
   *
   * ## 这一层解决的是「NPC 全知」（2026-11）
   *
   * 在这之前，任何 NPC 一登场就知道玩家的一切 —— 因为 `formatCharacter()`
   * 把整张角色卡（description / personality / scenario）原样塞进提示词，
   * 模型读到的是"设定"，却把它当成了"这个人的认知"。
   *
   * 这和我们之前修过的「不要替玩家认亲」是同一类病：
   * **模型把作者知道的事，当成了角色知道的事。**
   *
   * 判据很硬：一个人只知道
   *   ① 你当面告诉过他的；
   *   ② 他亲眼看见的；
   *   ③ 他查到的、或者别人转告他的。
   * 除此之外他一无所知 —— 他不知道你的身世、来历、秘密、真名，
   * 也不知道你没说出口的事。想让他知道，得先有来源。
   *
   * ## 两条与其他层不同的规则
   *
   * - **只增不减**：`bonds` 是「现状」（新状态覆盖旧的），而"他知道的事"不会
   *   因为时间流逝而忘掉。只有剧情里明确「这件事被澄清/揭穿」才该改写，
   *   而那属于覆盖——所以合并时是**并集**，不是替换。
   * - **不进主记忆预算**：它按在场角色分开渲染（见 `renderKnownByForPrompt`），
   *   和 bonds/threads 抢同一个 900 字预算会把主线记忆挤掉。
   */
  knownBy: Record<string, string[]>

  /**
   * **角色卷宗**：这个人身上已经发生过、且确定的事（角色名 → 事实条目）。
   *
   * ## 这一层解决的是「人物失忆」（2026-11 第十一轮）
   *
   * 玩家报的原话是「推进剧情后人物重复出现」+「线索里全是人物的事」。
   * 两个症状，同一个根：**这个人的经历没有一个属于他的位置**。
   *
   * 于是它被迫去了两个都不该去的地方：
   *   ① 变成 `ADD_FACT` 的线索（「小满的住处」「小满拜师」），
   *      和真正的悬案（「怀表盖内侧的刻字」）混在一张表里；
   *   ② 变成 `bonds` 的一条状态（「认伦纳德作师父」），
   *      而 bonds 是**关系现值**，会被下一轮覆盖 —— 覆盖完，他的来历就没了。
   *
   * 结果就是：模型手里没有"这个人经历过什么"，只能照角色卡重写一遍，
   * 写出来的人自然是**第一次见面**的样子。
   *
   * ## 两条与 knownBy 不同的规则
   *
   * - **方向相反**：knownBy 是「他→你」，这里是「你与他之间」的既成事实。
   * - **有人名归属**：它按角色名分组，渲染时**只给在场的那几个人**，
   *   所以不会变成一份"全世界人物小传"。
   *
   * 与 knownBy 相同的两条：**只增不减**（并集），**不进主记忆预算**。
   */
  dossiers: Record<string, string[]>

  /** 好感双轨（内心 / 外在），见 `Affinity` */
  affinity: Affinity[]
  /** 去过的与正在的地方（由大到小的树），见 `PlaceNode` */
  places: PlaceNode[]
  /** 主角手上的东西与它们在哪，见 `HeldItem` */
  inventory: HeldItem[]
}

/** 数据 AI 给出的增量补丁（prompt 里也按这个名字叫） */
export interface MemoryPatch {
  bonds?: Bond[]
  threads?: Thread[]
  timeline?: TimelineBeat[]
  earlierSummary?: string
  /** 角色名 → 他这一轮新知道的事（只增不减，见 `StoryMemory.knownBy`） */
  knownBy?: Record<string, string[]>
  /**
   * 角色名 → 这个人这一轮新暴露出来的既成事实（只增不减，见 `StoryMemory.dossiers`）。
   * 与 `knownBy` 方向相反：那是"他知道主角什么"，这是"这个人身上发生过什么"。
   */
  dossiers?: Record<string, string[]>
  /** 好感双轨的增量（同一个人只留最新一条） */
  affinity?: Affinity[]
  /** 新去到的地点（并集，按名字去重） */
  places?: PlaceNode[]
  /** 手上东西的变化（同名覆盖「在哪」） */
  inventory?: HeldItem[]
}

/**
 * 三层写入提示词的**硬上限**（字符数）。
 *
 * 为什么是字符数而不是 token：估算 token 需要分词器，而三种中文分词结果
 * 相差不大（中文大致 1 字 ≈ 1 token），字符数是**不需要依赖**的稳定近似。
 * 取 900 —— 加上"前情摘要"（300 字）后整块记忆约 1200 字，
 * 相对每轮几千字的叙事正文是可以接受的固定开销。
 */
export const MEMORY_BUDGET = 900

/**
 * 时间线保留的"逐条拍数"。
 *
 * 超过就折叠最旧的一拍（压进 earlierSummary）。
 * 取值理由：玩家的指代通常是"刚才""上次""前几天"，
 * 12 拍足以覆盖这个范围；再多就要和关系、线索抢预算了。
 */
export const TIMELINE_KEEP = 12

/** 折叠进 earlierSummary 的累计上限（超出只保留最近的） */
export const EARLIER_SUMMARY_LIMIT = 200

/**
 * 「他知道你什么」的上限：每个角色最多留几条、单条多少字。
 *
 * 这一层按在场角色分开渲染，所以在场 3 个人时整块约 300 字 ——
 * 相对每轮几千字的正文可以接受。留太多会变成一份人物小传，
 * 而它要表达的其实只有一句：**他知道这些，别的不可能知道**。
 */
export const KNOWN_PER_CHARACTER = 6
export const KNOWN_FACT_CHARS = 30

/**
 * 「这个人身上发生过什么」的上限。
 *
 * ## 为什么这是**第八层**，而不是并进 knownBy
 *
 * `knownBy` 记的是「**他**知道**你**的什么」——方向是他→你，用来拦 NPC 全知。
 * 而这一层记的是「**你**和他之间已经发生过什么」——方向是局内事实本身，
 * 用来拦另一类错：**把他当成第一次见面的人**。
 *
 * 这两类错在正文里长得完全不一样：
 *  - 全知：他说出了他从没可能知道的事；
 *  - 失忆：他问了一句「你是谁」，而他上一轮刚认你作师父。
 *
 * 后者更常见，也更伤 —— 玩家会觉得"这几轮白玩了"。
 * 而它恰好是**摘要与 bonds 都盖不住**的：bonds 记的是关系状态（"认他作师父"），
 * 不是**这个人本身**的经历（"爷爷上月死了、临终把表给他、他住在秤钩巷后头"）。
 *
 * 一个人 8 条、单条 40 字，是在场 3 人时约 240 字的代价 ——
 * 和 `knownBy` 同量级，同样**不进主记忆预算**。
 */
export const DOSSIER_PER_CHARACTER = 8
/** **渲染**上限：写进提示词时单条截到这么长 */
export const DOSSIER_FACT_CHARS = 40
/**
 * **存储**上限（2026-11 第二十三轮）。
 *
 * 原先存储和渲染用的是同一个 40 —— 于是玩家在人物卡里看到的是
 * 「诺姆还住在爷爷留下的院子，在河边那排、门口有棵歪脖子柳。房东太太没赶他，说爷爷…」，
 * 一句话被砍在半途，而那正是他点开这张卡唯一想看的东西。
 *
 * 现在的分工：
 *  - **存**的时候留全（200 字，够放下一整段底细）；
 *  - **渲染**的时候截到 40 字 —— 提示词那边要的是"提醒"，不是原文。
 *
 * 换句话说，截断属于**呈现**，不属于**数据**。之前把它放在存储层，
 * 等于为了省 token 把玩家的档案剪掉了一角，而省下的那点 token 在
 * 每轮三万输入的账上根本看不出来。
 */
export const DOSSIER_STORE_CHARS = 200

/**
 * 新增三层的**存储上限**（不是渲染上限 —— 渲染时另有更严的截断）。
 *
 * 存储留得宽一点：一个世界跑上几十轮，地点和物件会越攒越多，
 * 太早丢掉等于让模型忘记"他住哪、东西寄在哪"，而那正是玩家会问的事。
 */
export const AFFINITY_LIMIT = 14
export const PLACE_LIMIT = 40
export const INVENTORY_LIMIT = 24

/** 渲染时每层最多输出几行（比存储上限严得多：它们要挤进 900 字预算） */
const MAX_AFFINITY_LINES = 5
const MAX_PLACE_LINES = 9
const MAX_INVENTORY_LINES = 6
/** 这三层的单行裁剪长度 */
const MAX_WORD_CHARS = 22

/** 渲染时每层最多输出几行 */
const MAX_BOND_LINES = 8
const MAX_THREAD_LINES = 8
/** 单行裁剪长度（超长关系/线索对模型没有额外价值，只吃预算） */
const MAX_BOND_CHARS = 34
const MAX_THREAD_CHARS = 30

export function emptyMemory(): StoryMemory {
  return {
    bonds: [], threads: [], timeline: [], earlierSummary: '', updatedAtTurn: 0,
    knownBy: {}, dossiers: {},
    affinity: [], places: [], inventory: [],
  }
}

/**
 * 把任意来源（旧存档、模型输出）的值收敛成合法的 StoryMemory。
 *
 * 为什么要有这一步：记忆会被写进 localStorage 并被导入导出（saveFile.ts），
 * 旧存档里没有这三个字段；而模型给的永远不能信 —— 它可能给出
 * `bonds: "张三欠我钱"`（字符串而不是数组）、`turn: "第3轮"`、
 * 缺 id 的线索。这里统一滤掉，宁可少几条，也不要让渲染层对着坏数据崩掉。
 *
 * ⚠️ **这个函数不做折叠**（时间线可能超过 TIMELINE_KEEP 条）。
 * 折叠是**有损**操作：它把最旧的几拍压进 `earlierSummary`。
 * 曾经把折叠放在这里，结果合并路径上先被归一化折掉一次、又被合并逻辑
 * 当成"已经折过了"而跳过，`earlierSummary` 直接变成空串 ——
 * 也就是最不该丢的东西丢了（memory.test.ts 里钉着这个回归）。
 * 折叠只发生在两处：`mergeMemory`（写入）与 `renderMemoryForPrompt`（渲染）。
 */
export function normalizeMemory(raw: unknown): StoryMemory {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Partial<StoryMemory>

  const bonds: Bond[] = []
  if (Array.isArray(m.bonds)) {
    for (const b of m.bonds) {
      if (!b || typeof b !== 'object') continue
      const who = str((b as Bond).who)
      const state = str((b as Bond).state)
      if (!who && !state) continue
      bonds.push({ who, state })
    }
  }

  const threads: Thread[] = []
  if (Array.isArray(m.threads)) {
    for (const t of m.threads) {
      if (!t || typeof t !== 'object') continue
      const text = str((t as Thread).text)
      if (!text) continue
      const id = str((t as Thread).id) || text
      threads.push({ id, text })
    }
  }

  const timeline: TimelineBeat[] = []
  if (Array.isArray(m.timeline)) {
    for (const b of m.timeline) {
      if (!b || typeof b !== 'object') continue
      const text = str((b as TimelineBeat).text)
      if (!text) continue
      const rawTurn = Number((b as TimelineBeat).turn)
      // 轮次必须是**正整数**：0 / NaN / 负数都说明模型没按协议写，
      // 与其放进时间线让回溯找不到落点，不如按 0 处理（= 未知轮次）
      const turn = Number.isFinite(rawTurn) && rawTurn > 0 ? Math.floor(rawTurn) : 0
      timeline.push({ turn, text })
    }
  }

  // 排序但不折叠：渲染与合并都按轮次读，乱序会让"最近 N 拍"取错
  timeline.sort((a, b) => a.turn - b.turn)

  /*
    knownBy 的收敛比其它三层更严格：它直接决定"这个角色能说什么"，
    错一条就会让 NPC 说出他不该知道的事（而那种错在正文里看起来
    **很正常**，只有玩家自己知道"我从来没告诉过他"）。
    所以：名字必须非空、每条必须非空、去重、按上限截断。
  */
  const knownBy: Record<string, string[]> = normalizeNameIndex(
    (m as { knownBy?: unknown }).knownBy,
    KNOWN_PER_CHARACTER,
    KNOWN_FACT_CHARS,
  )
  /*
    dossiers 与 knownBy 共用同一套收敛规则（名字非空、条目非空、去重、按上限截断），
    但**上限不同**：卷宗存的是**底细**，玩家要点开人物卡看的正是它，
    所以在存储层留全（`DOSSIER_STORE_CHARS`），裁切留给渲染那一步。
  */
  const dossiers: Record<string, string[]> = normalizeNameIndex(
    (m as { dossiers?: unknown }).dossiers,
    DOSSIER_PER_CHARACTER,
    DOSSIER_STORE_CHARS,
  )

  // ── 好感双轨：只收敛形状，不替模型判断档位 ──
  const affinity: Affinity[] = []
  if (Array.isArray(m.affinity)) {
    for (const raw of m.affinity) {
      if (!raw || typeof raw !== 'object') continue
      const a = raw as Affinity
      const who = clip(str(a.who).trim(), MAX_WORD_CHARS)
      if (!who) continue
      const rec: Affinity = {
        who,
        // 没写就当"未知"——不要替它填「平」，那会让模型以为已经判断过了
        inner: str(a.inner).trim() || '未知',
        outer: str(a.outer).trim() || '未知',
      }
      const note = clip(str(a.note).trim(), 40)
      if (note) rec.note = note
      affinity.push(rec)
    }
  }

  // ── 地点树 ──
  const places: PlaceNode[] = []
  const seenPlace = new Set<string>()
  if (Array.isArray(m.places)) {
    for (const raw of m.places) {
      if (!raw || typeof raw !== 'object') continue
      const p = raw as PlaceNode
      const name = clip(str(p.name).trim(), MAX_WORD_CHARS)
      if (!name || seenPlace.has(name)) continue
      const parent = clip(str(p.parent).trim(), MAX_WORD_CHARS)
      seenPlace.add(name)
      // 自己当自己的上级 = 一个环：**留下这个地点，丢掉那个父级**。
      // 整个丢掉更省事，但那个地方就从世界里消失了 —— 宁可当顶层。
      places.push(parent && parent !== name ? { name, parent } : { name })
    }
  }

  // ── 物品台账 ──
  const inventory: HeldItem[] = []
  const seenItem = new Set<string>()
  if (Array.isArray(m.inventory)) {
    for (const raw of m.inventory) {
      if (!raw || typeof raw !== 'object') continue
      const it = raw as HeldItem
      const name = clip(str(it.name).trim(), MAX_WORD_CHARS)
      if (!name || seenItem.has(name)) continue
      seenItem.add(name)
      const where = clip(str(it.where).trim() || '随身', MAX_WORD_CHARS)
      const rec: HeldItem = { name, where }
      const note = clip(str(it.note).trim(), 40)
      if (note) rec.note = note
      inventory.push(rec)
    }
  }

  return {
    bonds,
    threads,
    timeline,
    earlierSummary: str(m.earlierSummary).slice(0, EARLIER_SUMMARY_LIMIT),
    updatedAtTurn: Number.isFinite(Number(m.updatedAtTurn))
      ? Math.max(0, Math.floor(Number(m.updatedAtTurn)))
      : 0,
    knownBy,
    dossiers,
    affinity: affinity.slice(-AFFINITY_LIMIT),
    places: places.slice(-PLACE_LIMIT),
    inventory: inventory.slice(-INVENTORY_LIMIT),
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * 收敛「角色名 → 一串事实」这种形状（`knownBy` 与 `dossiers` 共用）。
 *
 * 两条规则的差别只在参数里：上限与单条长度。规则本身一模一样 ——
 * 名字必须非空、条目必须非空、去重、只留最近 N 条。
 *
 * ⚠️ **不合并**同名不同写法（「小满」/「小满 」）：这一步只做形状收敛，
 * 名字之间的归一化在 `mergeMemory` 里用 `key()` 做。放这里会让"哪个算同一个名字"
 * 这个判断散到两处，而它一旦不自洽，同一个人的事实就会被劈成两半。
 */
function normalizeNameIndex(
  raw: unknown,
  perName: number,
  factChars: number,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [who, facts] of Object.entries(raw as Record<string, unknown>)) {
    const name = str(who).trim()
    if (!name) continue
    const list = Array.isArray(facts)
      ? facts.map(f => clip(str(f).trim(), factChars)).filter(Boolean)
      : []
    if (!list.length) continue
    out[name] = [...new Set(list)].slice(-perName)
  }
  return out
}

/** 按显示宽度裁剪（中文按 1 计；ASCII 也不特殊处理 —— 这条路径只用于中文剧情） */
function clip(s: string, max: number): string {
  const t = (s || '').trim()
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)) + '…'
}

/** 大小写与空白不敏感的查重键：模型常把「张三」写成「张三 」或「 张三」 */
function key(s: string): string {
  return (s || '').replace(/\s+/g, '').toLowerCase()
}

/**
 * 合并模型给的记忆补丁。
 *
 * ## 为什么是"合并"而不是"替换"
 *
 * 数据 AI 每轮只看到最近的一段剧情与当前记忆（见 buildSummaryPrompt），
 * 它**看不到更早的轮次**。如果让它整体覆盖，那么任何一次输出不完整
 * （模型漏写 bonds、被 max_tokens 截断、返回半个 JSON）都会让
 * 前面积累的关系与线索**永久消失** —— 而那正是这一层存在的意义。
 *
 * 所以规则是：
 *  - 关系/线索：**并集**。同名同文的合并，谁都没提到的东西继续留着。
 *  - 时间线：同轮次覆盖（模型可能对同一拍给出更准的写法），不同轮次追加。
 *
 * 单条上限（`MAX_BOND_LINES` 等）只在**渲染**时生效，不在存储层裁 ——
 * 裁掉就再也回不来了，而渲染超限只是这一轮少显示几行。
 */
export function mergeMemory(old: StoryMemory | undefined, patch: MemoryPatch | undefined): StoryMemory {
  const base = normalizeMemory(old)

  const incomingBonds = normalizeMemory({ bonds: patch?.bonds }).bonds
  const bonds = [...base.bonds]
  for (const b of incomingBonds) {
    if (key(b.who) === '') {
      // 没写"谁"的关系对模型没有指代价值，直接丢
      continue
    }
    const idx = bonds.findIndex(x => key(x.who) === key(b.who))
    if (idx >= 0) {
      /*
        同一个人只保留一条**最新状态**：关系会变（欠人情 → 结仇），
        两条并存会让模型看见互相矛盾的现状，而它通常会挑更早的那条写 ——
        那恰好是玩家已经推翻的旧关系。

        位置保留在原处（不挪到末尾）：渲染时取的是**最后 N 条**，
        让刚提到的人浮到末尾是有意义的信号（那是当下最相关的关系）。
      */
      bonds[idx] = b
    } else {
      bonds.push(b)
    }
  }

  const incomingThreads = normalizeMemory({ threads: patch?.threads }).threads
  const threads = [...base.threads]
  for (const t of incomingThreads) {
    const dup = threads.findIndex(x => key(x.id) === key(t.id) || key(x.text) === key(t.text))
    if (dup >= 0) threads[dup] = t
    else threads.push(t)
  }

  // 时间线：先并集（同轮次覆盖），再折叠超出的部分
  const byTurn = new Map<number, TimelineBeat>()
  const order: number[] = []
  const incoming = normalizeMemory({ timeline: patch?.timeline }).timeline
  for (const b of [...base.timeline, ...incoming]) {
    if (!byTurn.has(b.turn)) order.push(b.turn)
    byTurn.set(b.turn, b)
  }
  const merged = order.map(t => byTurn.get(t)!)

  const folded = foldTimeline(merged)
  /*
    被折掉的拍子必须**压进 earlierSummary**：时间线可以只留最近 N 拍，
    但"更早发生过什么"不能就此消失 —— 那正是玩家抱怨的那种遗忘。
    这里用 joinClauses 做幂等拼接（重复调用不会翻倍）。
  */
  const foldedText = folded.dropped.length ? foldBeatsIntoSummary(folded.dropped) : ''
  const extraSummary = str(patch?.earlierSummary)
  const earlierSummary = clip(
    joinClauses(joinClauses(base.earlierSummary, foldedText), extraSummary),
    EARLIER_SUMMARY_LIMIT,
  )

  const lastTurn = folded.timeline.reduce((n, b) => Math.max(n, b.turn), 0)

  /*
    knownBy 用**并集**而不是替换 —— 这是它与 bonds 唯一不同的地方。
    bonds 是"现状"，新状态盖旧的；而"他知道的事"不会随时间流逝而消失，
    只有剧情里明确「这件事被揭穿 / 澄清」才该改，那属于另一次写入。
    用替换的话，某一轮模型只报了新的一条，之前那个人的整份认知就会被清空。
  */
  const knownBy: Record<string, string[]> = { ...base.knownBy }
  const incomingKnown = normalizeMemory({ knownBy: patch?.knownBy }).knownBy
  for (const [who, facts] of Object.entries(incomingKnown)) {
    const prev = knownBy[who] || []
    knownBy[who] = [...new Set([...prev, ...facts])].slice(-KNOWN_PER_CHARACTER)
  }

  /*
    卷宗：与 knownBy 一样是**并集**，但多一道**名字归一化**。

    实测里模型会把同一个人写成「小满」和「小满 」，甚至当轮叫「小满」、
    下一轮叫「那个孩子」。knownBy 用精确名字当键，出现这种写法就会
    长出两个"小满"，而他做过的事被劈成两半 —— 两半都不足以让模型
    认出"眼前这个就是那个人"。那正是这一层要治的病，不能由它自己复发。

    归一化做的是**保守匹配**（忽略空白与大小写），不做模糊猜测：
    把两个人的事实合成一份，比分成两份更坏 —— 那会让模型把甲的来历安到乙头上。
  */
  const dossiers: Record<string, string[]> = { ...base.dossiers }
  const incomingDossiers = normalizeMemory({ dossiers: patch?.dossiers }).dossiers
  for (const [who, facts] of Object.entries(incomingDossiers)) {
    const existKey = Object.keys(dossiers).find(k => key(k) === key(who))
    const target = existKey ?? who
    const prev = dossiers[target] || []
    dossiers[target] = [...new Set([...prev, ...facts])].slice(-DOSSIER_PER_CHARACTER)
  }

  /*
    好感双轨：**同一个人只留最新一条**（和 bonds 一样是"现状"）。
    内外不一致本身是有信息的，所以不拆成两条 —— 拆开之后模型会当成两个人。
  */
  const incomingAff = normalizeMemory({ affinity: patch?.affinity }).affinity
  const affinity = [...base.affinity]
  for (const a of incomingAff) {
    const idx = affinity.findIndex(x => key(x.who) === key(a.who))
    if (idx >= 0) affinity[idx] = a
    else affinity.push(a)
  }

  /*
    地点树：**并集**（去过的地方不会因为这一轮没提就消失）。
    同名节点的父级会跟着更新 —— 先以 `parent || undefined` 为准走一次。
  */
  const incomingPlaces = normalizeMemory({ places: patch?.places }).places
  const placeMap = new Map<string, PlaceNode>()
  for (const p of [...base.places, ...incomingPlaces]) placeMap.set(p.name, p)
  const places = [...placeMap.values()]

  /*
    物品台账：**同名覆盖「在哪」** —— 东西会挪位置（外套从当铺赎回来就成了随身）。
    但只增不删：模型没说"丢了"就当还在，不然玩家的东西会凭空消失。
  */
  const incomingItems = normalizeMemory({ inventory: patch?.inventory }).inventory
  const itemMap = new Map<string, HeldItem>()
  for (const it of base.inventory) itemMap.set(key(it.name), it)
  for (const it of incomingItems) itemMap.set(key(it.name), it)
  const inventory = [...itemMap.values()]

  return {
    bonds,
    threads,
    timeline: folded.timeline,
    earlierSummary,
    updatedAtTurn: Math.max(base.updatedAtTurn, lastTurn),
    knownBy,
    dossiers,
    affinity: affinity.slice(-AFFINITY_LIMIT),
    places: places.slice(-PLACE_LIMIT),
    inventory: inventory.slice(-INVENTORY_LIMIT),
  }
}

/**
 * 时间线有界化：超出 `TIMELINE_KEEP` 时，返回被折掉的拍子（由调用方写进摘要）。
 *
 * 返回 `dropped` 而不是直接丢弃，是这一层唯一容易被写错的地方：
 * 折叠**必须留下痕迹**，否则"更早发生过什么"会凭空断掉。
 */
function foldTimeline(beats: TimelineBeat[]): { timeline: TimelineBeat[]; dropped: TimelineBeat[] } {
  // 先按轮次排序：模型可能乱序给出，而"最近 N 拍"必须按轮次算
  const sorted = [...beats].sort((a, b) => (a.turn || 0) - (b.turn || 0))
  if (sorted.length <= TIMELINE_KEEP) {
    return { timeline: sorted, dropped: [] }
  }
  const cut = sorted.length - TIMELINE_KEEP
  return { timeline: sorted.slice(cut), dropped: sorted.slice(0, cut) }
}

/** 用「；」把两段话接起来，并去掉完全重复的前缀 */
function joinClauses(a: string, b: string): string {
  const x = (a || '').trim()
  const y = (b || '').trim()
  if (!x) return y
  if (!y) return x
  if (x.includes(y)) return x
  if (y.includes(x)) return y
  return `${x}；${y}`
}

/**
 * 把某拍时间线压成一句可读的短语（用于折叠进 earlierSummary）。
 *
 * 之所以要单独一个函数：折叠几乎是唯一会让玩家觉得"AI 又忘了"的路径，
 * 所以它的行为要有测试钉住（见 memory.test.ts）。
 */
export function foldBeatsIntoSummary(beats: TimelineBeat[], limit = EARLIER_SUMMARY_LIMIT): string {
  const text = beats
    .map(b => (b.turn ? `第${b.turn}轮：${b.text}` : b.text))
    .join('；')
  return clip(text, limit)
}

/**
 * 记录"这一轮发生了什么"。
 *
 * 这是**不需要 LLM 参与**的机械记账：摘要更新每 6 轮才跑一次
 * （token 成本太高），而时间线必须是每轮都有的 ——
 * 否则第 5 轮玩家点回溯时会发现时间线上根本没有第 3 轮。
 *
 * 模型之后可以在摘要阶段把同一拍改写得更好（同轮次覆盖），
 * 但在那之前这里已经保证时间线是完整的。
 */
export function appendTimelineBeat(
  memory: StoryMemory | undefined,
  turn: number,
  text: string,
): StoryMemory {
  const t = str(text)
  if (!t) return normalizeMemory(memory)
  const beat: TimelineBeat = { turn: Math.max(1, Math.floor(turn) || 1), text: clip(t, 80) }
  return mergeMemory(memory, { timeline: [beat] })
}

/**
 * 把三层记忆渲染成注入提示词的文本。
 *
 * 返回空串表示三层都是空的（开局前几轮）—— 调用方据此**完全不注入**，
 * 不要给模型塞一个只有标题、没有内容的空区块，那只会浪费 token
 * 并让它以为记忆丢了。
 *
 * 裁剪顺序是**有意**的：先裁时间线，再裁线索，最后才动关系行数。
 * 理由是三层"丢了有多伤"不同（关系 > 线索 > 时间线），
 * 而 `MEMORY_SOFT_LIMIT` 只在极端情况下才会逼到最后一步。
 */
export function renderMemoryForPrompt(memory: StoryMemory | undefined): string {
  const raw = normalizeMemory(memory)
  // 渲染是只读的：这里折叠不影响存储，但能让提示词里的时间线有界
  const folded = foldTimeline(raw.timeline)
  const earlierSummary = folded.dropped.length
    ? joinClauses(raw.earlierSummary, foldBeatsIntoSummary(folded.dropped))
    : raw.earlierSummary
  const m = { ...raw, timeline: folded.timeline, earlierSummary }

  const hasAnything = m.bonds.length || m.threads.length || m.timeline.length || m.earlierSummary
    || m.affinity.length || m.places.length || m.inventory.length
  if (!hasAnything) return ''

  const lines: string[] = []

  if (m.bonds.length) {
    lines.push('### 人物关系（当前状态，不是历史）')
    for (const b of m.bonds.slice(-MAX_BOND_LINES)) {
      lines.push(`- ${clip(b.who, MAX_BOND_CHARS)}：${clip(b.state, MAX_BOND_CHARS)}`)
    }
  }

  /*
    好感双轨紧跟在关系之后：读的人（模型）刚看完"谁欠谁"，
    接着看到"他心里怎么想、脸上怎么表现"，这两块是同一个话题的两层。
  */
  if (m.affinity.length) {
    lines.push('### 好感（**内心**与**外表**分两档，不要把外表当成内心）')
    for (const a of m.affinity.slice(-MAX_AFFINITY_LINES)) {
      const head = `- ${clip(a.who, MAX_WORD_CHARS)}：内心 ${a.inner} · 外表 ${a.outer}`
      lines.push(a.note ? `${head} —— ${clip(a.note, 40)}` : head)
    }
  }

  if (m.threads.length) {
    lines.push('### 未结线索（谜题 / 承诺 / 债务 / 威胁）')
    for (const t of m.threads.slice(-MAX_THREAD_LINES)) {
      lines.push(`- ${clip(t.text, MAX_THREAD_CHARS)}`)
    }
  }

  if (m.inventory.length) {
    lines.push('### 他手上有什么、放在哪（**不要让他丢掉、也不要凭空多出**）')
    for (const it of m.inventory.slice(-MAX_INVENTORY_LINES)) {
      const note = it.note ? `（${clip(it.note, 30)}）` : ''
      lines.push(`- ${clip(it.name, MAX_WORD_CHARS)}：${clip(it.where, MAX_WORD_CHARS)}${note}`)
    }
  }

  if (m.places.length) {
    lines.push('### 去过的与在的地方（由大到小）')
    lines.push(...renderPlaceTree(m.places, MAX_PLACE_LINES))
  }

  if (m.earlierSummary || m.timeline.length) {
    lines.push('### 事件时间线（按轮次）')
    if (m.earlierSummary) {
      // 更早的轮次已经被折叠成一句话：明确标出来，避免模型把它当成刚发生的事
      lines.push(`- 更早的经过：${m.earlierSummary}`)
    }
    for (const b of m.timeline) {
      lines.push(`- 第${b.turn}轮：${b.text}`)
    }
  }

  return enforceBudget(lines)
}

/**
 * 渲染「**这几个角色**知道主角什么」。
 *
 * ## 为什么要单独一段，而不是塞进 `renderMemoryForPrompt`
 *
 * 1. 它**按在场角色过滤**：给所有角色的认知一起塞进去，等于又变回全知
 *    （模型会顺手套到眼前这个人身上）。
 * 2. 它**不占主记忆预算**：bonds / threads / timeline 共用 900 字，
 *    knownBy 再挤进去会把关系与线索挤掉，而那两层丢一条就伤。
 *
 * ## 为什么「一无所知」也要写出来
 *
 * 省略比写错更坏。不写的话，模型看到的是「这段没提这个人」，
 * 它会退回角色卡上的设定 —— 也就是又回到全知。
 * 写一句「他一无所知」，才是把边界立在那里。
 *
 * 名字匹配用「精确 → 双向包含」两级：模型很少逐字重复全名，
 * 「阿什沃斯勋爵」与「勋爵」、「巡警布兰登」与「布兰登」应当能对上。
 */
export function renderKnownByForPrompt(
  memory: StoryMemory | undefined,
  characterNames: readonly string[],
): string {
  const names = characterNames.map(n => String(n || '').trim()).filter(Boolean)
  if (!names.length) return ''

  const known = normalizeMemory(memory).knownBy
  const lines: string[] = []
  const seen = new Set<string>()

  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    const key = matchKnownKey(known, name)
    const facts = key ? known[key] : []
    if (!facts.length) {
      lines.push(`- **${name}**：一无所知（你没跟他说过，他也没看见过什么）`)
    } else {
      lines.push(`- **${name}** 知道：${facts.join('；')}`)
    }
  }

  return `## 这几个人**知道**你什么

${lines.join('\n')}

⚠️ 上表**没写**的事，他们就**不知道** —— 尤其是你的身世、来历、真实姓名、秘密，
以及你从没当面对他们说过的事。想让人说出这些，必须先有来源
（你告诉过他 / 他亲眼看见 / 他查过 / 别人转告），否则他会问、会猜，**而且会猜错**。
**不要把角色卡上的设定当成他知道的事。**`
}

/**
 * 渲染「**这几个角色**在这一局里已经是什么人」。
 *
 * ## 它和上面那段 knownBy 是**镜像**，不是同一件事
 *
 * | | 方向 | 记什么 | 治什么病 |
 * |---|---|---|---|
 * | `knownBy` | 他 → 知道**你**什么 | 主角的事 | NPC **全知** |
 * | `dossiers` | **你与他之间** | 这个人自己的经历 | NPC **失忆** |
 *
 * 两段必须一起给，而且**必须明确说出它们不是一回事**：
 * 卷宗里写着他认你作师父，但他**仍然**可能不知道你姓什么 ——
 * 模型很容易把"他知道我的事"和"我们之间发生过事"混成一团，
 * 混完之后 NPC 又变回全知。
 *
 * ## 为什么最后一段要写「不要重演一遍」
 *
 * 这一层的失败长得不像错误：模型会把卷宗里的事实**重写一遍**
 * ——"他告诉你爷爷上月去世了"、"你们第一次见面，他认你作师父"。
 * 单看每一句都没错，读起来却像故事在倒带。
 * 所以判据要给死：**表里的事已经过去了，不要重新演一次。**
 */
export function renderDossiersForPrompt(
  memory: StoryMemory | undefined,
  characterNames: readonly string[],
): string {
  const names = characterNames.map(n => String(n || '').trim()).filter(Boolean)
  if (!names.length) return ''

  const dossiers = normalizeMemory(memory).dossiers
  const blocks: string[] = []
  const seen = new Set<string>()

  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    const k = matchKnownKey(dossiers, name)
    const facts = k ? dossiers[k] : []
    // 一无所知的人**不写进来**：这段是"他已经是什么人"，
    // 没有经历的人写一行"暂无"只会占地方、并暗示模型"这个人很重要但没东西写"。
    if (!facts.length) continue
    // 渲染时截到 `DOSSIER_FACT_CHARS`：存储留全是为了面板，提示词这里要的是提醒
    blocks.push(`- **${name}**：\n${facts.map(f => `  - ${clip(f, DOSSIER_FACT_CHARS)}`).join('\n')}`)
  }

  if (!blocks.length) return ''

  return `## 这几个人**在这一局里**已经是什么人（这些事**已经发生过**）

${blocks.join('\n')}

⚠️ 他们**不是第一次见你**。动笔之前先读完上面这几条，然后：
- **不要重演**：表里的事是过去时。不要再让他们把这些话讲一遍、
  不要再写"第一次见面"、也不要让已经住进柴房的人重新无家可归。
- **不要写反**：表里写他信你，就不要写成他防着你；表里写他刚死了亲人，
  他这一场说话的底子就得是那个。
- **但他们仍然不知道你的事** —— 那只看上面「知道」那一段。
  他的卷宗里有他的来历，不代表他知道你的来历。`
}

/**
 * 在「角色名 → 一串东西」的表里找这个人对应的键（精确优先，其次双向包含）。
 *
 * `knownBy` / `dossiers` 共用；面板也要用它把 UI 上的角色卡和记忆里的键对上 ——
 * 模型写的名字常常是「阿什沃斯勋爵」，而卡片上写「勋爵」。
 */
export function matchKnownKey(known: Record<string, string[]>, name: string): string | null {
  if (known[name]) return name
  const keys = Object.keys(known)
  const loose = keys.find(k => k.length >= 2 && (name.includes(k) || k.includes(name)))
  return loose ?? null
}

/**
 * 把**当前所在地**机械地补进地点树。
 *
 * ## 为什么这条不交给模型
 *
 * 地点树是七层里唯一有「机械可得」信息的一层：`useGameStore.location` 每轮都准，
 * 而摘要 AI 要同时交七样东西，最容易漏的就是这一样。
 * 漏了之后玩家看到的是「你觉得这地方眼熟」—— 因为模型手里没有"你来过"这条依据。
 *
 * 所以这里补一道底：**模型漏报，程序兜住**。模型报了更好（它知道层级），
 * 没报至少不会缺。
 *
 * ## 分隔符
 *
 * `location` 可能是「伦敦·威斯敏斯特」这种带层级写法，拆成父子两级；
 * 也可能是「南市」这种单层，就当一个顶层节点。
 */
export function ensurePlace(memory: StoryMemory, location: string): StoryMemory {
  const raw = String(location || '').trim()
  if (!raw) return memory

  const parts = raw.split(/[·・/／>›]/).map(s => s.trim()).filter(Boolean)
  if (!parts.length) return memory

  const places = [...memory.places]
  let parent: string | undefined
  for (const name of parts) {
    if (!places.some(p => p.name === name)) {
      places.push(parent ? { name, parent } : { name })
    }
    parent = name
  }

  // 与 normalize 的上限保持一致：这一层是并集，跑久了会越攒越多
  return { ...memory, places: places.slice(-PLACE_LIMIT) }
}

/**
 * 把地点列表渲染成一棵缩进的树。
 *
 * ## 为什么要树，不要平铺
 *
 * 平铺的「南市 / 牌墙 / 柳关」看不出谁属于谁 —— 模型会把「牌墙」当成和
 * 「柳关」平级的另一个地方，于是玩家说"回柳关"它可能写错方向。
 * 由大到小的缩进是**唯一能表达"套着"关系**的纯文本形式。
 *
 * ## 两个防御（都来自真实会出的坏数据）
 *
 * - **环**：模型偶尔同时写 `甲→乙` 和 `乙→甲`，递归会死循环 —— 用 `seen` 挡。
 * - **孤儿**：上级地点没被写进表里（模型只报了子地点），当顶层处理，
 *   否则那个地点永远渲染不出来，等于从世界里消失了。
 */
function renderPlaceTree(places: PlaceNode[], max: number): string[] {
  const known = new Set(places.map(p => p.name))
  const byParent = new Map<string, PlaceNode[]>()
  const roots: PlaceNode[] = []

  for (const p of places) {
    if (!p.parent || !known.has(p.parent)) roots.push(p)
    else {
      const list = byParent.get(p.parent) || []
      list.push(p)
      byParent.set(p.parent, list)
    }
  }

  const out: string[] = []
  const seen = new Set<string>()
  const walk = (n: PlaceNode, depth: number) => {
    if (out.length >= max || seen.has(n.name)) return
    seen.add(n.name)
    out.push(`${'  '.repeat(Math.min(depth, 3))}- ${n.name}`)
    for (const c of byParent.get(n.name) || []) walk(c, depth + 1)
  }

  for (const r of roots) walk(r, 0)
  // 环里没走到的，平铺补上（宁可难看，也不要让它整个消失）
  for (const p of places) {
    if (out.length >= max) break
    if (seen.has(p.name)) continue
    seen.add(p.name)
    out.push(`- ${p.name}`)
  }
  return out
}

/**
 * 逐层收紧到预算内。
 *
 * 做法是"按行丢"而不是"按字符截断"：
 * 截断会产生半句话（"张三对他有戒心，因"），
 * 而模型对半句话的处理比少一条更糟 —— 它可能顺着半句编下去。
 *
 * 每层都留一个**下限**（时间线至少 2 拍、线索至少 2 条、关系至少 1 条）：
 * 把某一层清空等于告诉模型"关系/线索一概没有"，
 * 那比超一点预算坏得多。
 */
function enforceBudget(lines: string[]): string {
  const out = [...lines]
  const total = () => out.reduce((n, l) => n + l.length + 1, 0)

  let guard = out.length + 8   // 兜底，防逻辑写错时死循环
  while (total() > MEMORY_BUDGET && guard-- > 0) {
    // 从**时间线的最旧一拍**开始丢（"更早的经过"那一行更值钱，留到最后）
    const tl = linesStartingWith(out, /^- 第\d+轮：/)
    if (tl.length > 2) {
      out.splice(tl[0], 1)
      continue
    }

    /*
      丢的顺序 = **越"物"的越先丢，越"人"的越后丢**。
      地点与物品是环境与道具（少了只是不全，玩家还能问）；
      好感与关系少了，模型就会把熟人写成陌生人 —— 那才是真伤。
    */
    const places = sectionBody(out, '### 去过的与在的地方')
    if (places.length > 3) {
      out.splice(places[0], 1)
      continue
    }

    const inv = sectionBody(out, '### 他手上有什么')
    if (inv.length > 3) {
      out.splice(inv[0], 1)
      continue
    }

    const threads = sectionBody(out, '### 未结线索')
    if (threads.length > 2) {
      out.splice(threads[0], 1)
      continue
    }

    const aff = sectionBody(out, '### 好感')
    if (aff.length > 2) {
      out.splice(aff[0], 1)
      continue
    }

    const bonds = sectionBody(out, '### 人物关系')
    if (bonds.length > 1) {
      out.splice(bonds[0], 1)
      continue
    }

    break   // 全部触底：宁可略超预算，也不要把某一层清空
  }

  return out.join('\n')
}

/** 所有匹配 `re` 的行下标（升序） */
function linesStartingWith(lines: string[], re: RegExp): number[] {
  const out: number[] = []
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) out.push(i)
  return out
}

/** 某个区块（标题 → 下一个标题之前）里所有正文行的下标（升序） */
function sectionBody(lines: string[], heading: string): number[] {
  const head = lines.findIndex(l => l.startsWith(heading))
  if (head < 0) return []
  const out: number[] = []
  for (let i = head + 1; i < lines.length; i++) {
    if (lines[i].startsWith('###')) break
    if (lines[i].startsWith('- ')) out.push(i)
  }
  return out
}
