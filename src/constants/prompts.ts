/**
 * 提示词构建层
 *
 * 原版把整个世界设定（防剿局 / 性相 / 漫宿 / 1900s 伦敦）、章节指南和写作要求
 * 全部写死在这一个文件里。现在这里只保留「引擎协议」——
 * 即两段式生成（叙事 AI + 数据 AI）的通用规则，
 * 所有题材相关内容一律由 WorldCard / CharacterCard / PlayerCard 注入。
 */

import { resolveReplyLength } from '@/types/cards'
import { renderAntiRoute } from '@/utils/antiRoute'
import type { AntiRouteConfig } from '@/utils/antiRoute'
import type { AttributeDef, CharacterCard, LLMConfig, PlayerCard, ResourceDef, WorldCard } from '@/types/cards';
import { avatarCatalogPrompt } from '@/utils/avatarArt';
import { aiLookCatalogPrompt } from '@/utils/lookSpec';
import { sceneCatalogPrompt } from '@/utils/sceneArt';
import { digestLore, renderLoreDigest } from '@/utils/loreDigest';

const EMPTY = '（未填写）';

function list(items: string[], fallback = '无'): string {
  const filtered = items.map(s => s.trim()).filter(Boolean);
  return filtered.length ? filtered.join('、') : fallback;
}

function attrLine(a: AttributeDef, value?: number): string {
  const desc = a.description?.trim();
  /*
    ⚠️ 带上**当前值**。原先这里只列 id 与说明，于是数据 AI 每次结算都要
    「重新猜」主角现在是什么水平 —— 它看不到当前值，只能凭这一轮的剧情瞎估，
    结果是同一个属性在相邻两轮里被写得忽高忽低。
  */
  const val = typeof value === 'number' && Number.isFinite(value)
    ? `，当前 ${Math.round(value)}`
    : '';
  const head = `- \`${a.id}\`（${a.name}）${val}`;
  const line = desc ? `${head}：${desc}` : head;

  /*
    ── 性相的三个面（2026-11）──

    `traits` 是价值取向，`reactions` 是他遇到事会怎么想，`behaviors` 是**下意识动作**。
    后者尤其重要：叙事 AI 拿到"他灯相很高"仍然不知道该怎么下笔，
    但拿到「强迫自己直视恐惧」「用冷漠的目光审视」，它立刻有东西可写。
  */
  const extras: string[] = [];
  if (a.traits?.length) extras.push(`  倾向：${a.traits.join('、')}`);
  if (a.reactions?.length) extras.push(`  反应：${a.reactions.join('；')}`);
  if (a.behaviors?.length) extras.push(`  会做的动作：${a.behaviors.join('、')}`);
  return extras.length ? [line, ...extras].join('\n') : line;
}

function resourceLine(r: ResourceDef): string {
  const bits: string[] = [`初始 ${r.initial}`];
  if (typeof r.max === 'number') bits.push(`上限 ${r.max}`);
  else bits.push('无上限');
  if (r.critical) bits.push('归零视为致命/结局信号');
  const desc = r.description?.trim();
  return `- \`${r.id}\`（${r.name}）_(${bits.join('，')})_${desc ? `：${desc}` : ''}`;
}

/**
 * 按字符数截断一段外部输入。
 *
 * ## 这道闸的**唯一职责是挡病态数据**（2026-11 定稿）
 *
 * 玩家原话：「把所有的世界书，角色，预设，提示词什么的都恢复到不影响游玩的最佳状态」。
 *
 * 上一版为了压输入体积把这里压得很紧（角色设 700 字、情境 400 字），
 * 结果**正常写厚一点的角色卡被截了** —— 截断提示混进提示词里，
 * 模型读到"（原文 3200 字，已按篇幅截断）"这种句子，反而更容易跑偏。
 *
 * 现在的原则：**正常输入一个字节都不动，只挡十万字级的病态数据**。
 * 真嫌 token 贵，该调的是「每轮目标字数」和防降级那几档，不是偷偷切内容。
 */
function clipChars(s: string, max: number): string {
  const t = String(s || '').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}…（原文 ${t.length} 字，已按篇幅截断）`
}

/** 把角色卡拼成给叙事 AI 读的人物档案 */
export function formatCharacter(card: CharacterCard): string {
  const blocks: string[] = [];
  const head = [`### ${card.name}`];
  /*
    旧名（`aka`）写在这里，用途很具体：模型下一轮如果又把这个孩子写成
    「小满」，它能看到"小石头以前被叫过小满"——于是知道那是同一个人，
    而不是又冒出一个新角色。这是「问名字」这条链路上最便宜的一道保险。
  */
  const aka = (card as { aka?: string[] }).aka;
  if (Array.isArray(aka) && aka.length) head.push(`以前被叫过：${aka.join('、')}`);
  if (card.relationship) head.push(`关系：${card.relationship}`);
  if (card.location) head.push(`所在地点：${card.location}`);
  if (card.status) head.push(`当前状态：${card.status}`);
  if (card.playable) head.push('（由玩家扮演的角色）');
  blocks.push(head.join(' | '));

  /*
    ⚠️ 和 `formatPlayer` 一样，每个字段都要兜底（2026-11）。

    这批字段在类型上是必填，但**卡是外部输入** —— 导入的 SillyTavern 卡、
    手改过的 JSON、第三方打包的世界包都可能少写一栏。直接 `.trim()`
    会让整轮生成在第一个角色身上炸掉，而错误信息是
    `Cannot read properties of undefined (reading 'trim')`，玩家完全无从下手。

    每个字段还各自有上限（见 `clipChars`）：卡是别人写的，几千字的
    `systemPrompt` 在 ST 那边很常见，在这里却只是每轮重复付费的噪音。
  */
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  /*
    每个字段 4000 字符：**正常角色卡碰不到这条线**（实测内置卡最大的字段一千出头），
    只有真有人把一整篇设定塞进 `systemPrompt` 才会触发。见 `clipChars` 的说明。
  */
  if (s(card.description).trim()) blocks.push(`**设定**：${clipChars(card.description, 4000)}`);
  if (s(card.personality).trim()) blocks.push(`**性格**：${clipChars(card.personality, 4000)}`);
  if (s(card.scenario).trim()) blocks.push(`**相关情境**：${clipChars(card.scenario, 4000)}`);
  if (s(card.messageExamples).trim()) blocks.push(`**对话示例**（模仿其语气与用词）：\n${clipChars(card.messageExamples, 4000)}`);
  if (s(card.systemPrompt).trim()) blocks.push(`**该角色的专属指令**：${clipChars(card.systemPrompt, 4000)}`);
  if (s(card.postHistoryInstructions).trim()) blocks.push(`**附加要求**：${clipChars(card.postHistoryInstructions, 4000)}`);

  /*
    每人再兜一道总闸（12000 字符）。六个字段都写满才会碰到 —— 那不是卡，是一本书。
  */
  return clipChars(blocks.join('\n'), 12000);
}

export function formatPlayer(player: PlayerCard): string {
  /*
    ⚠️ 每个字段都要 `|| ''` 兜底（2026-11）。

    这里直接 `.trim()` 过一个可能不存在的值，会在**第一轮生成时**抛出
    `Cannot read properties of undefined (reading 'trim')` —— 一个玩家
    完全看不懂的错误，而且是在他点了「开始故事」之后才炸。

    什么时候会遇上：导入的旧存档、手改过的 JSON、卡里少写一栏的玩家卡。
    `PlayerCard` 的字段在类型上是必填，但**存档是外部输入**，
    类型保证不了运行时。提示词这一层必须是最后一道防线。
  */
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const lines: string[] = [`- 姓名：${player.name || EMPTY}`];
  if (s(player.gender).trim()) lines.push(`- 性别：${player.gender}`);
  if (s(player.age).trim()) lines.push(`- 年龄：${player.age}`);
  if (s(player.appearance).trim()) lines.push(`- 外貌：${player.appearance}`);
  if (s(player.personality).trim()) lines.push(`- 性格：${player.personality}`);
  if (s(player.background).trim()) lines.push(`- 背景：${player.background}`);
  if (s(player.extra).trim()) lines.push(`- 其他：${player.extra}`);
  return lines.join('\n');
}

function povInstruction(world: WorldCard): string {
  const { pov, tense } = world.narrative;
  const tenseText = tense === 'past' ? '过去时（「他走了过去」）' : '现在时（「他走过去」）';
  switch (pov) {
    case 'first':
      return `以**第一人称**（「我」）叙述，叙述视角锁定在主角自身。时态使用${tenseText}。`;
    case 'third':
      return `以**第三人称**（「他/她/其名」）叙述，可以描写主角看不到的场景，但仍以主角为叙事重心。时态使用${tenseText}。`;
    case 'second':
    default:
      return `以**第二人称**（「你」）叙述，把读者直接放进主角的身体里。时态使用${tenseText}。`;
  }
}

/**
 * 每轮随主角一起注入的两段简报。
 *
 * 之所以做成一个对象而不是两个独立参数：它们**必须成对地出现在
 * 「主角」那一段的紧后面** —— 那是模型读"我是谁"的位置。
 * 散在提示词各处只会让它们变成两段可读可不读的参考资料。
 */
export interface TurnBriefing {
  /** 各背景槽位选中的 option id，key 为槽位 label */
  backgroundChoices?: Record<string, string>
  /**
   * 玩家在「我自己写」背景项里填的自由文本：`{ 槽位 label → 文本 }`。
   *
   * 它不是 `backgroundChoices` 的补充，而是那一个槽位的**全部内容** ——
   * 见 `BackgroundOption.custom` 与 `describeBackgroundChoices`。
   */
  backgroundCustom?: Record<string, string>
  /** 属性当前值（id → 数值） */
  aspects?: Record<string, number>
  /**
   * 当前章节号（2026-11 冰山改造）。
   *
   * 有它才能把「这一章」注入提示词 —— 那是"明面上的结构"里最硬的一层：
   * 玩家永远知道自己站在哪一章、这一章要往哪走。
   *
   * 缺省时按 0 处理（等同于序章）。
   */
  chapter?: number
  /**
   * 本轮情境文本（玩家行动 + 当前地点 + 在场角色 + 最近一段叙事）。
   *
   * 世界书按它挑章节注入 —— 见 `buildNarrativeSystemPrompt` 里那段注释，
   * 以及 `utils/loreDigest.ts` 的完整说明。
   */
  context?: string
  /**
   * 本轮世界书正文的汉字预算。不给就用 `digestLore` 的默认值（9000）。
   * 开局那一轮值得给大一些：第一幕要立住整个世界，之后每轮再收窄。
   */
  loreBudget?: number
  /**
   * 防降级加固层（2026-11）。
   *
   * 由 `utils/antiRoute.ts` 渲染，追加在 system prompt 的**最末尾** ——
   * 那里是模型最敏感的位置，也是前缀缓存能保住的位置（见该模块的说明）。
   */
  antiRoute?: AntiRouteConfig
  /**
   * 这一轮的种子（传轮次编号）。
   *
   * 防路由的随机标记用它当种子：同一轮重发必须拿到同一份，
   * 否则"重试"本身就成了新的指纹。
   */
  turnSeed?: string
  /**
   * 预设里该**贴在生成点之前**的那几条（2026-11）。
   *
   * 由 `utils/narrativePreset.ts` 的 `renderPresetTail()` 取出来，走
   * `buildNarrativeTail()` 单独发一条 system —— 不进 system prompt 主体。
   * 理由是位置：破甲词住在酒馆的 `post_history_instructions` 那一格，
   * 离生成点 0～4 条消息；本作上一版把它拼进第 0 条 system，隔着几万字。
   */
  presetTail?: string
}


/**
 * 叙事 AI 的 system prompt —— **照搬原作《苍白卷宗》的骨架**。
 *
 * ## 为什么整个换掉（2026-11）
 *
 * 玩家：「怎么原作的提示词效果用起来，氛围也没有原作好？」→ 我给了一份诊断
 * → 玩家：「就照着原作改，原作的提示词除了必须改的部分以外原样照搬不要乱加东西。」
 *
 * 在这之前，这一节是我一路打补丁长出来的：冰山契约、在场的人不是道具、
 * 这一场是主角的场、篇幅与信息投放、写作协议五条…… 加起来 8200 汉字，
 * 其中约 4500 字是禁令。
 *
 * 原作用 **1601 个字**做同一件事，而且做得更好。差别不在字数，在**形状**：
 *
 *   · 它的禁令只有十一条，每条都配「错误 / 正确」的例句 —— 模型照着改，不用猜；
 *   · 氛围不靠形容词，靠每章顶上的「核心氛围」一行和场景块的 `[ATMOSPHERE]`；
 *   · 篇幅不靠"写到多少字"，靠场景块的 `[KEY ACTIONS]` 五条动作 ——
 *     动作给够了，字自然够；
 *   · 「该写什么」在前、「不许写什么」在后，禁令只占全文三分之一。
 *
 * 所以这一节现在逐字照搬原作，只改**四处必须改的**：
 *
 *   1. **世界观设定 1** → 世界卡（原作硬编码了 1900s 伦敦与防剿局）。
 *   2. **人物设定** → 玩家的卡。原作本来就留了 `playerState.profile.*` 占位，
 *      而我们的 user message JSON 里字段名**一模一样**，直接对接。
 *   3. **PRINCIPLE_STYLES** → 本世界的性相表。原作九相，我们也是九相，
 *      三栏（关键词 / 人物反应 / 典型行为）的文字照搬。
 *   4. **篇幅** → 加一行。原作没有字数设置，我们的界面有 `replyLength`。
 *
 * 其余一字不动。想往这里加东西之前先问一句：**原作是这么写的吗？**
 * 不是就别加 —— 我们加过的每一条，最后都变成了稀释氛围的噪音。
 */
export function buildNarrativeSystemBody(
  world: WorldCard,
  activeCharacters: CharacterCard[],
  player: PlayerCard,
  briefing: TurnBriefing = {},
): string {
  const sections: string[] = [];
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

  /*
    ⚠️ 字数纪律：这一节的目标是 **1800~2600 汉字**（原作 1601）。

    超了不一定是坏事，但每多一百字都该能说出它替代了哪一条原作的话。
  */

  sections.push(`你是由“天气工厂”风格驱动的**纯叙事生成器**，运行文字冒险游戏《${world.title}》。
你的唯一职责是**撰写沉浸式的小说片段**。你**完全不需要**关心游戏的数值、状态或逻辑判断。`);

  // ── 一 · 世界观设定（原作第 1 条 → 世界卡）──
  const mood = str(world.story?.coreMood);
  const atmo = str(world.story?.atmosphere);
  const loreText = str(world.worldLore);

  let loreBlock = '';
  if (loreText) {
    /*
      ⚠️ 短世界书**不过摘要器**（2026-11）。

      冰山三卡的 worldLore 只有三四百字 —— 那本身就是一份浓缩的氛围，
      而摘要器会把它切成"三节正文 + 一行提要 + 一段元说明"，
      最有味道的那一节正好被降级成带省略号的提要。摘要器是为五万字世界书写的。
    */
    const loreCjk = (loreText.match(/[\u4e00-\u9fff]/g) || []).length;
    if (loreCjk < 1500) {
      loreBlock = loreText;
    } else {
      const digest = digestLore(loreText, {
        context: briefing.context || '',
        // 专名清单当检索键用，放宽到 160 个（默认 48）
        nouns: collectWorldProperNouns(world, 160),
        ...(briefing.loreBudget ? { budget: briefing.loreBudget } : {}),
      });
      loreBlock = renderLoreDigest(digest, world.title);
    }
  } else {
    loreBlock = '（作者未提供详细设定，请在首次叙事时从玩家的开场设定中自然建立世界。）';
  }

  sections.push(`### 世界观设定 (World Setting)

1. **${world.title}**${mood ? `（核心氛围：${mood}）` : ''}
${atmo ? `\n${clipChars(atmo, 8000)}\n` : ''}
${loreBlock}`);

  // ── 人物设定：字段与原作 `playerState.profile.*` 一一对应 ──
  const profileLines: string[] = [
    `   - **姓名**: ${player.name || EMPTY}`,
  ];
  for (const [label, value] of [
    ['性别', str(player.gender)],
    ['年龄', str(player.age)],
    ['外貌', str(player.appearance)],
    ['性格', str(player.personality)],
    ['自述背景', str(player.background)],
    ['其他', str(player.extra)],
  ] as Array<[string, string]>) {
    if (value) profileLines.push(`   - **${label}**: ${value}`);
  }

  const bgBriefing = buildBackgroundBriefing(world, briefing.backgroundChoices, briefing.backgroundCustom);
  if (bgBriefing) profileLines.push(`   - **出身**: ${bgBriefing}`);

  profileLines.push(`   - **指令**: 请在叙事中自然地体现这些特征。例如，如果主角是女性，使用“她”或女性化的称呼（如果适用）；如果主角外貌有显著特征（如“戴着单片眼镜”），在描写动作时可以提及（如“他推了推单片眼镜”）。`);

  sections.push(`2. **人物设定 (Character Profile)**：
${profileLines.join('\n')}`);

  sections.push(`3. **人物关系 (Relationships)**：
   - 请参考输入的 \`relationships\` 数据。
   - 保持人物性格的一致性。如果 \`relationship\` 是 "Superior"，主角应保持敬畏或服从。
   - 下面这几位此刻可能在场。他们的性格是自己长出来的，不是围着主角转的：

${(() => {
    if (!activeCharacters.length) return '（暂无登记在册的关系人。）'
    /*
      ── 在场人物：数量与合计都放回"正常游玩够用"（2026-11）──

      上一版卡在 6 位 / 6000 字符，理由是"模型顾不上那么多"。
      但玩法上常常是一次出场七八个人（朝堂、酒馆、宴会），
      砍掉的那几位**在正文里就真的不存在了** —— 玩家会觉得"我明明勾了他"。

      现在 12 位 / 24000 字符：正常一局碰不到，只挡"把整本人物志塞进来"。
    */
    const shown = activeCharacters.slice(0, 12)
    let out = shown.map(formatCharacter).join('\n\n')
    if (activeCharacters.length > shown.length) {
      out += `\n\n（另有 ${activeCharacters.length - shown.length} 位在场人物未列出。）`
    }
    return clipChars(out, 24000)
  })()}`);

  sections.push(`4. **知识系统 (Knowledge System)**：
   - **动态记忆**：主角的认知应基于 \`knownFacts\`、\`readBooks\` 和 \`masteredLores\`。
     - 如果主角已阅读某本书，他应该能认出相关的符号或引用其中的内容。
     - 如果主角已掌握某项密传，他应该能理解相关的超自然现象，而不是感到困惑。
   - **阅读与研究 (Reading & Research)**：
     - **风险机制**：阅读高阶书籍或研究危险密传时，如果主角性相不足，**必须触发具体的叙事性负面事件**。
       - 不要仅仅扣除数值。
       - 描述主角看到了无法理解的幻象、听到了墙壁里的低语、或者精神恍惚误入了危险的地点。
       - 这种事件应该是一段完整的微型剧情，而不仅仅是一个结果。`);

  const rulesText = str(world.rules);
  if (rulesText) {
    /*
      ── 世界规则的上限（2026-11，改了两次）──

      这道闸的**唯一职责是挡病态数据**，不是省 token。它踩过两次坑：

      1. 取 3000 时，忘了 `world.rules` 在这里**已经不是世界卡自己那一份**：
         `withNarrativePreset()` 把「预设的 rules 段」接在后面。
         于是被切掉的是**排在最后的预设条目**（输出格式、字数要求、收尾规矩）。
      2. 抬到 8000 仍然不够 —— 玩家的预设本来就有上万字的。

      玩家原话：「我要预设完完整整的生效」。所以这里放到 40000，
      只挡"有人塞了一份十万字的东西"。正常预设一条都不会掉。
    */
    sections.push(`5. **世界规则（硬性约束）**：
   以下优先级高于一切文风偏好，必须严格遵守。

${clipChars(rulesText, 40000)}`);
  }

  // ── 核心原则 ──
  sections.push(`### 核心原则：清晰第一，风格第二
**你的首要任务是讲一个好懂的故事。**
“密教模拟器”的风格在于其**氛围**和**世界观**，而不是在于让人读不懂的病句或过度堆砌的辞藻。`);

  // ── 性相表：原作 PRINCIPLE_STYLES 的等价物（先算出来，下面两处都要看它在不在）──
  const styles = renderPrincipleStyles(world);

  // ── 动态指令优先级（照搬；只把 characterState 换成我们的字段名）──
  sections.push(`### 动态指令优先级
1. **可读性 (Readability)**：剧情必须流畅、自然。
2. **章节指南 (Chapter Guide)**：严格遵循当前章节的特殊要求。
3. **人物性相演绎 (Character Acting)**：
   - **不要改变叙事风格**：叙事者应保持客观、沉浸的“天气工厂”风格，不要因为主角性相不同而改变文风。
   - **改变主角表现**：根据主角的最高性相（参考 \`playerState.attributes\` 与 \`playerState.dominantAttribute\`），决定主角的**下意识反应、肢体语言和心理活动**。${styles ? '参考 `PRINCIPLE_STYLES` 中的“人物反应”和“典型行为”。' : ''}`);

  // ── 他此刻的性相（原作把值放在 user 数据里，我们念一遍中文名，省一次翻译）──
  const attrBriefing = buildAttributeBriefing(world, briefing.aspects);
  if (attrBriefing) sections.push(attrBriefing);

  // ── 章节（仅启用章节卡的世界）──
  const stages = world.story?.enableStages ? (world.story.stages || []) : [];
  if (stages.length) {
    const idx = typeof briefing.chapter === 'number' ? briefing.chapter : 0;
    const stage = stages.find(s => (s.chapterId ?? 0) === idx) ?? stages[Math.min(idx, stages.length - 1)];
    if (stage) {
      const guide = str(stage.principleGuide);
      sections.push(`### 当前章节（Chapter Guide）

- **章节目标**：${str(stage.title) || `第 ${idx + 1} 章`}
${stage.text}
${guide ? `- **写作要求**：${guide}` : ''}

这一章走完了（目标达成、或玩家已不可逆地越过它），就在数据结算里输出 \`{"type":"COMPLETE_EVENT","target":"${stage.id}"}\`，下一章会自动接上。**不要**替玩家宣布“你进入了下一章”。`);
    }
  }

  // ── 性相表（原作 PRINCIPLE_STYLES 的等价物，上面已经算好）──
  if (styles) sections.push(styles);

  // ── 写作协议（照搬）──
  sections.push(`### 写作协议 (Writing Protocol)
1. **纯叙事 (Pure Narrative)**：
   - **身份定义**：你是一名**小说家**，而不是游戏系统。你不知道什么是“数值”、“属性”或“物品栏”。
   - **绝对禁止**：
     - 禁止输出任何形式的系统日志（如：“状态变更：...”、“获得物品：...”、“funds -5”）。
     - 禁止在括号中解释游戏机制（如：“（理智-1）”）。
     - 禁止总结当前的资源状态。
     - **禁止输出括号内的元注释或性格分析**：绝对不要输出如“（人物反应：...）”、“（符合蛾相主导）”等括号内容。
     - **禁止直接提及性相名称**：绝对不要在叙述中使用“灯相”、“铸之力量”、“杯的诱惑”等游戏术语。
       - *错误*：“你感受到了灯相的理性。”
       - *正确*：“冰冷的逻辑如手术刀般剖开了眼前的谎言，你感到一种近乎残酷的清醒。”
       - *错误*：“铸相让你想要破坏。”
       - *正确*：“你感到血液在血管中燥热地奔流，仿佛有什么东西渴望着被重塑，或者被毁灭。”
   - **正确示范**：
     - *错误*：“你买下了这本书（funds -1），阅读它让你感到不安（sanity -1）。”
     - *正确*：“你把最后一枚银币拍在柜台上，抓起那本破旧的书。翻开第一页时，某种恶心的眩晕感击中了你。”

2. **物理事实优先 (Physics First)**：
   - 先交代清楚：**谁、在哪里、在做什么**。
   - *错误*：“光芒吞噬了理智。”
   - *正确*：“刺眼的红光充满了房间，你不得不眯起眼睛。”

3. **节奏控制 (Pacing)**：
   - **拒绝跳跃**：不要在一句话里完成复杂动作。
   - **逻辑递进**：主角的反应必须符合常理。

4. **感官细节 (Sensory Details)**：
   - 描写气味（煤烟、霉味）、声音（滴水、纸张沙沙声）、触感（寒冷、金属）。`);

  // ── 剧情控制（照搬）──
  sections.push(`### 剧情控制
1. **事件演绎 (Event Performance)**：
   - 当输入包含 \`[系统事件触发: Title]\` 时，你的任务是**详细演绎** \`storyContext\` 中提供的文本。
   - **严禁跳过**：不要概括事件，不要直接跳到事件结束后的时间点。
   - **严禁快进**：如果 Context 描写的是“在下水道发现尸体”，你就必须描写下水道、尸体和发现的过程，**绝对不能**直接写“你回家后...”。
   - **保持当下**：故事的时间点必须停留在事件发生的**那一刻**，等待玩家做出反应。
   - **响应紧迫感 (Urgency)**：如果 Context 中包含 \`[紧迫感指令]\`，你必须在叙事中体现出时间的流逝和局势的紧迫，暗示玩家必须尽快做出决定。
   - **忽略数据指令**：如果 Context 中包含 \`[给数据引擎的指令]\` 标记的区块，请**完全忽略**其中的内容，不要将其输出到故事中。这些是给数据引擎看的。

2. **引导**：如果输入包含 \`storyContext\`，必须围绕其大纲叙事。

3. **不重复**：不要重复玩家已经历过的情节；参考输入中的 \`previousSummary\` 与前情摘要。`);

  // ── 人称与时态（原作写死了第二人称，我们的界面可选 —— 必须改）──
  sections.push(`### 叙述人称与时态
${povInstruction(world)}`);

  /*
    ── 文风要求：同样是**只挡病态数据**（2026-11）──

    这一块已经被拼过两层：`withNarrativePreset` 先把预设的「文风」段接在
    卡自己的后面，再把玩家现拨的文风选择接在最后。原来取 2400，
    实际砍的是"三层之和"—— 实测把预设里排在最后的「结尾规矩」整条切掉，
    玩家报「预设的输出格式不见了」。

    现在 40000：正常预设（一两万字）一条都不会掉。
  */
  const customStyle = clipChars(str(world.narrative.customStyle), 40000);
  if (customStyle) {
    sections.push(`### 本世界的文风要求
${customStyle}`);
  }

  /*
    ── 输出格式与加固层**不在这里**（2026-11）──

    它们搬去了 `buildNarrativeTail()`，由调用方作为**最后一条 system**、
    插在历史之后、本轮动作之前。

    原因只有一个：位置。这两块都是「这一轮必须照做」的硬约束，
    而上一版把它们排在这一大段的末尾 —— 看起来在最后，其实仍在第 0 条消息里，
    后面还压着四块记忆和六条历史。同一句话，贴在生成点前面，
    和隔着三万 token，模型给它的权重差一个数量级。

    玩家原话：「预设的效果和破甲能力不稳定，一模一样的预设，
    本项目的和酒馆的到底差在哪」—— 差的就是这个。
  */
  return sections.join('\n\n');
}

/**
 * 贴在**生成点之前**的那一段（2026-11）。
 *
 * ## 它是什么
 *
 * 本函数对应酒馆预设里的 `post_history_instructions` 那一格：
 * 发在聊天历史**之后**、模型开始写之前。破甲串、输出格式、字数要求、
 * 收尾规矩全部住在这里 —— 它们共同的特点不是"重要"，而是**每轮都必须照做**。
 *
 * ## 为什么顺序是「系统格式 → 预设 → 玩家开关」
 *
 * 越靠后越强。
 *
 *  - 系统自己的「仅输出纯文本剧情」放最前：它是默认值；
 *  - 预设（作者写的那套）压在它上面：玩家特意导入的东西该盖过默认；
 *  - `antiRoute`（玩家此刻在面板上拨的开关）最后：刚点的那一下才是他现在想要的。
 *
 * ## 空段不占位
 *
 * 三段都空时返回空串 —— 调用方据此决定**要不要多发一条消息**。
 * 多发一条空 system 会让某些端点直接 400。
 */
/**
 * **格式优先**的声明 —— 贴在 tail 的最后（2026-11）。
 *
 * ## 为什么需要它
 *
 * 玩家原话：「开了防降级加固的一些功能后，正文出来了，但我预设的首尾格式
 * （比如有一个预设带总结）不见了，只有正文」。
 *
 * 查下来是位置和措辞两头夹出来的：
 *
 *  1. tail 里排在最前的是本作自己的 `### 输出格式`，其中一条写着
 *     「不要输出任何元数据」—— 预设要求的状态栏 / 小结块被读成了元数据；
 *  2. 排在最后的是加固层（权重最高），里面的抗截断层写着「不做归纳」
 *     「写完就停，不用汇报」—— 预设的结尾总结被读成了汇报。
 *
 * 光改加固层的措辞不够：`### 输出格式` 那一条同样在挡。所以这里明确划一次界，
 * 并且**放在整条 tail 的末尾** —— 模型读到的最后一句，才压得住前面那一堆禁令。
 *
 * ## 为什么说"格式优先"而不是"预设优先"
 *
 * 冲突不只是"预设 vs 本作"这一种。玩家自己在世界卡里定的开场语、版面、
 * 分隔线，和预设里写的是同一类东西。它们该被同一句话保护，
 * 而"格式"是它们唯一共同的性质。
 */
const FORMAT_GUARD =
  '【格式优先】以上这些要求管的是笔法与边界，不改变输出格式。'
  + '本作或你启用的预设若规定了开头、结尾或分段的写法（标题、小结、状态栏、分隔线、固定开场语等），'
  + '照常写出来 —— 它们不是"元数据"，不是"收尾语"，也不是"汇报"。'
  + '两者冲突时，格式优先。'

export function buildNarrativeTail(
  world: WorldCard,
  activeCharacters: CharacterCard[],
  player: PlayerCard,
  briefing: TurnBriefing = {},
): string {
  const parts: string[] = []

  parts.push(`### 输出格式
- 仅输出纯文本剧情。
- 不要输出任何 JSON。
- 不要解释自己在做什么，也不要复述这几条要求。
- 篇幅：这一段正文约 ${resolveReplyLength(world.narrative)} 字，上下浮动不超过 200 字。`)

  const presetTail = (briefing.presetTail || '').trim()
  if (presetTail) parts.push(presetTail)

  /*
    加固层的渲染失败时返回空串（见 `utils/antiRoute.ts` 的 try/catch）——
    一个字都不会多出来，也不会把提示词弄坏。
  */
  const anti = renderAntiRoute(briefing.antiRoute, {
    userName: player.name,
    cast: activeCharacters.map(c => c.name),
    replyLength: resolveReplyLength(world.narrative),
    seed: briefing.turnSeed || '',
  })
  if (anti) parts.push(anti)

  /*
    ── 格式优先，放在最后（2026-11）──

    只在**加固层真的开着**时才加：没有加固层的时候，前面没有任何东西会
    跟格式打架，说这句话反而让模型以为存在冲突。

    放末尾而不是开头，是因为它的作用正是"压住前面那一串禁令" ——
    离生成点最远的位置说不响。
  */
  if (anti) parts.push(FORMAT_GUARD)

  return parts.join('\n\n')
}

/**
 * 一次拿全两段 —— 叙事调用该用这个。
 *
 * `system` 进消息数组的第 0 条；`tail` 进**最后一条 system**。
 * 拆开是为了让位置可控，不是为了省事。
 */
export function buildNarrativePromptParts(
  world: WorldCard,
  activeCharacters: CharacterCard[],
  player: PlayerCard,
  briefing: TurnBriefing = {},
): { system: string; tail: string } {
  return {
    system: buildNarrativeSystemBody(world, activeCharacters, player, briefing),
    tail: buildNarrativeTail(world, activeCharacters, player, briefing),
  }
}

/**
 * 两段拼成一段 —— **只为向后兼容存在**。
 *
 * 老调用方（以及大量单测）拿到的是一个字符串，断言 `toContain('输出格式')`。
 * 真跑游戏时用的是 `buildNarrativePromptParts`：它把 tail 单独拿出来，
 * 放到历史之后 —— 那才是这一整轮改动要的东西。
 *
 * 如果你在写新代码：**别用这个**，用 parts。
 */
export function buildNarrativeSystemPrompt(
  world: WorldCard,
  activeCharacters: CharacterCard[],
  player: PlayerCard,
  briefing: TurnBriefing = {},
): string {
  const { system, tail } = buildNarrativePromptParts(world, activeCharacters, player, briefing)
  return tail ? `${system}\n\n${tail}` : system
}

/**
 * 九相表 —— 原作 `PRINCIPLE_STYLES` 的等价物。
 *
 * 原作把这张表整份放进 system prompt，然后用一句话调用它：
 * 「根据主角的最高性相，决定主角的下意识反应、肢体语言和心理活动。」
 * 我们照做，三栏文字照搬（见 `src/data/worlds/_shared.ts` 的 `PHASES`）。
 *
 * 旧世界卡的属性没有这三栏时，用 `description` 当关键词兜底 ——
 * 宁可给少一栏，也不要给一相空白。
 */
function renderPrincipleStyles(world: WorldCard): string {
  const attrs = world.enableMechanics ? (world.attributes || []) : [];
  if (!attrs.length) return '';

  const blocks = attrs.map(a => {
    const keys = (a.traits || []).filter(Boolean).join('、') || String(a.description || '').trim();
    const reactions = (a.reactions || []).filter(Boolean).join('；');
    const actions = (a.behaviors || []).filter(Boolean).map(b => `"${b}"`).join('、');
    const lines = [`### ${a.name}（${a.id}）`];
    if (keys) lines.push(`- **关键词**: ${keys}。`);
    if (reactions) lines.push(`    - **人物反应**: ${reactions}。`);
    if (actions) lines.push(`    - **典型行为**: ${actions}。`);
    return lines.join('\n');
  });

  return `## 性相（PRINCIPLE_STYLES）

每一相三栏：**关键词**（本质）、**人物反应**（会怎么想）、**典型行为**（会做什么）。

${blocks.join('\n\n')}`;
}

/** 数据 AI 的 system prompt —— JSON 结算协议 */
export function buildDataSystemPrompt(world: WorldCard, aspects?: Record<string, number>): string {
  const attributes = world.enableMechanics ? world.attributes : [];
  const resources = world.enableMechanics ? world.resources : [];

  const attrIds = attributes.length ? attributes.map(a => `"${a.id}"`).join(' | ') : 'string';
  const resIds = resources.length ? resources.map(r => `"${r.id}"`).join(' | ') : 'string';
  const styleIds = attributes.length
    ? [...attributes.map(a => `"${a.id}"`), '"neutral"'].join(' | ')
    : '"neutral"';

  const sections: string[] = [];

  sections.push(`你是一个严谨的游戏数据引擎（Game Data Engine）。
你**不写故事**。你的任务是：阅读玩家的行动、叙事 AI 产出的剧情文本、以及当前状态，输出**唯一一个 JSON 对象**，描述这次交互引起的状态变更与下一步可选行动。`);

  if (world.enableMechanics) {
    sections.push(`## 本世界的数值体系

### 性相
${attributes.length ? attributes.map(a => attrLine(a, aspects?.[a.id])).join('\n') : '（本世界未定义性相）'}

**性相决定他做成什么样，不决定他能不能做。** 上面标了每一相的**当前值**，判据是这样定的：

- **不要用性相做通过/失败判定**，也不要因为它低就少给选项（选项协议里禁止用 \`requirements\` 拦人）。
- 数值**高**的相：他下手更稳、看得更细、代价更小，别人也更容易服他那一套。
  同样的场合，写出来的应当是**这个人的手法**，而不是"他很擅长"。
- 数值**低**的相：他一样能做，但要如实写出具体的笨拙与代价 —— 那一相不是他的语言。
  **不要照顾他**，也不要因此不给出这类选项；明知不可为而为之，本身是一种玩法。
- 阅读高阶书籍、使用密传或危险物品时，性相不足是**触发负面事件**的依据
  （幻象、低语、恍惚），而不是"扣一点数值"。
- 性相**只在剧情中明确发生了对应事件时**才变动（见下面的通则）；不要因为"他这次做得不错"
  就随手加一点。一次真正的成长（拜师、长期练习、吃过一次大亏）才配得上 +1。

### 资源
${resources.length ? resources.map(resourceLine).join('\n') : '（本世界未定义资源）'}

**修改数值的通则**：
- 数值只在剧情中**明确发生**了对应事件时才变动，不要凭空加减。
- 幅度要克制：日常小事 ±1，重大事件 ±2~3，极端转折才更大。
- **不要只扣不还**。休息、治疗、进食、获得报酬、解决心结、达成目标时，必须给出正向恢复。
- 资源达到上限时不要继续加；无上限的资源（如金钱）可以自由累加。`);

    if (world.story.stages.length && world.story.enableStages) {
      sections.push(`## 章节卡事件

若 \`currentState.story.activeEventId\` 存在，且剧情表明该事件的核心冲突已经解决，**必须**输出 \`COMPLETE_EVENT\`。
若玩家行动自然导向下一个预设节点，可输出 \`TRIGGER_EVENT\` 强制推进。`);
    }
  } else {
    sections.push(`## 数值体系

本世界**关闭了机制层**。不要输出任何 MODIFY_RESOURCE / MODIFY_ASPECT / ADD_ITEM 之类的数值变更，
只输出 \`options\` 与必要的叙事性记录（ADD_FACT / ADD_CHARACTER / UPDATE_CHARACTER / ADD_LOCATION）。`);
  }

  sections.push(`## 状态管理协议

**强制检查**剧情中是否发生了以下事件，并生成对应 \`stateChanges\`：

1. **资源获取与消耗** → \`MODIFY_RESOURCE\`
2. **属性成长与损耗** → \`MODIFY_ASPECT\`
   - 仅当玩家的行动**强烈体现**该属性时才给（一般 +1）。
   - ⚠️ **选项自带的性相加成由客户端结算，你不要重复给。**
     玩家的行动如果来自你上一轮生成的选项（\`userActionType\` 为 \`option\`），
     那个选项已经标了 \`style\`，客户端会在选中时给对应属性 +1；
     你再输出一条同属性的 \`MODIFY_ASPECT\` 就成了双倍。
     这种情况只在**剧情另有其事**时才给（例如他选了"硬闯"，同时被打断了一条腿 → 那给的是资源，不是属性）。
   - 玩家自由输入（\`custom_action\`）没有标相，此时**才该**由你判断：
     他这一手强烈体现了哪个相，就给哪个 +1；都不像就不给。
3. **物品流转** → \`ADD_ITEM\`（必须带完整 payload）/ \`REMOVE_ITEM\`
   - **物品必须与玩家的出身挂钩**：输入里的 \`playerState.background\` 是玩家开局选的出身/背景，
     包含其「开局携带」物品。剧情中给出的新物品，应当是这个出身**自然会接触到**的东西
     （例：出身是「拾音人学徒」→ 拾音器配件、旧磁带、行会信物；出身是「静默教团叛徒」→ 祷文残页、教团徽记）。
   - **不要给所有背景发同一批东西**。如果你发现某个物品放进当前出身显得突兀，就换一个更贴的，
     或者干脆不给 —— 宁可不掉，也不要掉一个和出身无关的物品。
   - 物品名要具体（「缺角的铜制火漆」优于「一个道具」），并且优先复用世界观里已有的 \`items\` 模板。
4. **情报与知识** → \`ADD_FACT\`（关键线索）/ \`MARK_LORE_MASTERED\`（掌握某种知识或技艺）
   - 线索同样要贴合出身：玩家出身决定了他**认得出**什么。外行看不懂的符号，
     对口出身的人应当能一眼认出，并因此获得额外线索。
   - ⚠️ **人物自己的事不是线索。** 「小满住在秤钩巷后头」「他爷爷上月去世了」
     「他认我作师父」这类**已经定下来的事**，写进 \`dossiers\`（见下），
     **不要**发成 \`ADD_FACT\` —— 那会把它塞进玩家的线索列表，和真正的悬案混在一起，
     而它其实不是待办，是这个人的底细。
     判据只有一条：**这件东西会改变玩家的下一个动作吗？**
     会（纸角露出的半个红印、一笔对不上的数、一句不该出现在那里的话）→ 线索；
     不会、只是"这个人是这么个情况"→ 人物卷宗。
5. **世界状态**
   - 时间流逝 → \`MODIFY_TIME\`（单位：分钟。跨天请给足数值，如「第二天」约 1440）
   - 地点变更 → \`UNLOCK_LOCATION\`
   - 探索到新地点的情报 → \`ADD_LOCATION\`
   - 身份/头衔变化 → \`SET_IDENTITY\`
6. **人物**
   - 新角色登场 → \`ADD_CHARACTER\`（必须带完整 payload，包含 id/name/description/relationship/status/location/avatarId/appearance）
   - 已有角色的关系、状态、位置、描述变化 → \`UPDATE_CHARACTER\`（**务必沿用已有的 id**）

   ⚠️ **名字是身份，不是描述。** 这一条比上面两条都重要，反复出错的就是它：

   - **档案里的人，永远不许再 ADD 一次。** 哪怕这一轮你换了种叫法
     （「那个孩子」「当表的孩子」「炉边的女人」「他」），
     只要他还是同一个人，就只能是 \`UPDATE_CHARACTER\`。
   - **他刚刚说出自己的名字** → \`UPDATE_CHARACTER { id: 原来那个 id, name: "新名字" }\`。
     这**不是**新角色登场。问名字、自报家门、被人叫出真名、别人提起他的本名 ——
     全属于这一类。\`ADD_CHARACTER\` 会多造一个"新人"，而玩家会在人物栏里
     看到同一个孩子戴着两个名字、各记一半经历。
   - **不许拿称呼当名字。** \`name\` 只放人名、姓氏、稳定的外号
     （「小满」「阿什沃斯勋爵」「独眼杰克」）。
     「当表的孩子」「那个穿旧罩衫的男孩」是**描述** —— 写进 \`description\`，别写进 \`name\`。
   - **拿不准是不是同一个人** → 对照 \`currentState.characters\` 里的 \`description\`：
     同一件衣服、同一个地方、同一段身世，就是同一个人，**只能 UPDATE**。
   - 判据一句话：**这个人已经在档案里了吗？** 在 → 只能 UPDATE；不在 → 才 ADD。

## 长期记忆维护（memory）

引擎会按轮次记住"发生过什么"，并在每一轮把这份记忆交给叙事 AI。你**每轮都要**顺手更新它
—— 这是叙事 AI 在二十轮以后还记得"谁欠谁"的唯一依据。

\`\`\`json
{
  "summary": "一句话，不超过 40 字：这一轮发生了什么（供时间线使用）",
  "memory": {
    "bonds": [{ "who": "人名", "state": "两人**此刻**的关系，如：欠他一枚铜钱未还/对他有戒心" }],
    "threads": [{ "id": "英文小写下划线标识", "text": "还没了结的谜题/承诺/债务/威胁，一句话" }],
    "timeline": [{ "turn": 轮次数字, "text": "这一轮发生了什么，一句话" }],
    "dossiers": { "角色名": ["这个人身上已经确定的一件事"] }
  }
}
\`\`\`

规则（每一条都是为了别让记忆丢掉）：
- \`turn\` 用输入里的 \`currentState.turn\`；同一轮重复提交会**覆盖**（不会重复两条）。
- \`bonds\` / \`threads\` 是**增量**：这次剧情里提到谁、哪条线索有变化，就只写那几条。
  **没提到的不要重写、更不要清空** —— 你看不到更早的轮次，漏写等于让引擎丢掉它。
- 关系变了就给**新的那一条**（「欠人情」变「结仇」），不要新旧都列。
- 线索已经了结（谜题揭开、债还清、威胁解除）时，**不要**再列它。
- \`dossiers\` 是**只增不减**的卷宗：这个人做过的、身上发生过的、已经定下来的事，
  一句话一条（不超过 40 字）。
  - **不要写外貌设定**（「这是一个七八岁的男孩」）—— 那是角色卡的事，卷宗只记**发生过的**。
  - 写**因果与处境**：「爷爷上月去世，临终把怀表给了他，说能换一顿饭」优于「他有块怀表」。
  - 引擎会合并去重，你只报这一轮**新出现**的就行；同一个人名字要和之前写法一致。
  - ⚠️ 这一层是下一轮"不把他当陌生人"的唯一依据。漏了它，
    那个人就会在下一轮重新问一句「你是谁」—— 而你们上一轮刚认过师徒。
- 本世界关闭了机制层时，这一段**仍然要写**：它不涉及数值，只是记录发生了什么。

## 角色头像分配（avatarId）

新角色登场时，请从下面的头像素材库里挑一个最贴合该角色气质的 id，填进 \`ADD_CHARACTER.payload.avatarId\`。

${avatarCatalogPrompt()}

挑选规则：
- 按剧情里对这个角色的描写来选（性别气质、年龄感、职业、是否遮脸、是否有伤疤等）。
- **同一个 id 不要重复使用**。请在输入里的 \`currentState.characters\` 中查看已经用过的 avatarId，避开它们。
- 如果没有任何一个贴合，就**省略 avatarId 字段**，不要硬凑、不要编造清单外的 id。
- 只在 \`ADD_CHARACTER\` 时给出；\`UPDATE_CHARACTER\` 不要改 avatarId。

## 角色外观登记（appearance）—— **这一步决定了他画出来像不像**

游戏会给每个登场的角色**画一张像素立绘**。画什么，**完全由你在这里登记的
\`appearance\` 决定**；你不登记，引擎就只能从 \`description\` 里猜 ——
而"猜"的错误率很高，而且症状很刺眼：「银叶精灵、浅金色长发」画成金色卷发配皮甲、
「黑色燕尾服、乌黑长发」画成白头发的老脸，都是真实发生过的。

所以**新角色登场时，请把 \`appearance\` 一起填进 \`ADD_CHARACTER.payload\`**。
每个字段的取值只能从下面这张表里挑，**清单外的值一律无效**：

\`\`\`
${aiLookCatalogPrompt()}
\`\`\`

规则（**第二条比第一条更重要**）：

- **取值一律用上面表里的英文词，不要翻译成中文。**
  引擎是按字面匹配的，\`"hair": "长发"\` 会**整条被丢弃**（当作你没填）——
  这一条写在最前面，因为把它翻成中文是最容易犯的错，而且症状很隐蔽：
  立绘看起来"还是老样子"，没人会想到是语言问题。
- **\`sex\` 尽量填。** 它是观感里最要紧的一项（历史上出过"男性角色拿到女性的脸"的 bug），
  只要你的描写能让读者判断出性别，就填上。
- ⚠️ **只填你在 \`description\` 里确实写到的项。** 描写里没提发色、没提帽子、
  没提穿什么，就**整个省略那个字段** —— 引擎有自己的补全逻辑，比你随手填一个更贴。
  **不要为了把表填满而编造。** 宁可少填，不要填错：
  填错的代价是立绘与你的描写**直接矛盾**，而不填只是让引擎照着描写去猜，
  后者至少还有对的可能。
- 示例：
  · 描写"约莫四十岁的男人，短须，穿深色布袍，袖口磨得发亮"
    → \`"appearance": { "sex": "male", "age": "adult", "beard": "stubble", "cloth": "robe", "clothColor": "charcoal" }\`
  · 描写"一个年轻女子，浅色长发松松挽着，穿一条旧裙子"
    → \`"appearance": { "sex": "female", "age": "youth", "hairColor": "blonde", "hair": "half_up", "cloth": "dress", "clothColor": "white" }\`
  · 描写"一个壮实的汉子，光头，满脸横肉"
    → \`"appearance": { "sex": "male", "age": "adult", "build": "heavy", "hair": "bald" }\`
- 只在 \`ADD_CHARACTER\` 时给出；\`UPDATE_CHARACTER\` **不要**改 \`appearance\` ——
  一个人的长相不该随剧情变化。

## 场景背景切换（SET_SCENE）

游戏界面会在叙事区上方显示一张场景背景图。你负责在**场景明显改变**时切换它。

可选场景：
${sceneCatalogPrompt()}

切换规则：
- **只在场景真的换了才发**（换地点、从室内到室外、从白天到夜晚、下到地下、升上高空等）。
  **不要**每一轮都发 —— 那会让背景不停闪。
- 与 \`currentState.sceneId\` 相同时不要重复发。
- 参考输入里 \`currentState.location\` 与剧情描写判断该用哪个。
- 拿不准时**省略 SET_SCENE**：保留当前背景比换错更好。

## 选项生成协议

${world.story.enableChoices ? `生成 3~4 个下一步行动选项。
- **严禁只给 1 个选项**（除非那是【死亡】【结局】或【章节切换】）。
- **只剩一条路的时候，补「风味选项」。** 如果剧情确实只通向一个去处（门就在那儿，只有它开着），
  **必须**额外给 1~2 个**不推进剧情**的选项：观察环境、整理思绪、检查随身的东西、听门后的动静、
  把灯挪近些。它们的作用是让玩家觉得"我还能先做点别的" —— 没有这个余地，场景就变成"点继续"。
  原作《苍白卷宗》就是这么干的，它连"整理思绪"这种选项都留在面板上。
- **每个选项都必须标 \`style\`，且要标得准。** 这是这个游戏的支柱之一：
  玩家看到的选项会按那个性相的颜色显示，**选中它，那个性相就 +1**。
  所以 \`style\` 不是装饰，是你替玩家标出的"这条路口通往哪种人"。
  · 标错 = 玩家想当冷静的人，点了一个"冷静分析"的选项，涨的却是刃。
  · 判据：**这个动作本身**最像哪个相，就标哪个。看动作，不看动机。
  · 四个选项不要标成同一个相——那不是多样性，是你没在区分。
  · 实在只是一句过渡（"等天亮"、"跟他走"）就标 \`"neutral"\`，不硬凑。
- **多样性**：不要所有选项都偏向同一个属性。同时给出激进、谨慎、观察、社交等不同取向的行动。
- **宽松限制**：不要在 JSON 里写 \`requirements\` 来阻挡玩家尝试。允许失败，失败后果在下一回合判定。
- **简洁**：选项文本要短促有力（如「推开那扇门」「先观察四周」）。
- **逻辑一致**：只生成与当前地点、当前在场角色、当前剧情阶段相符的选项。不要重复已经做过的互动。` : `本世界关闭了选项呈现。请 **始终输出空数组** \`"options": []\`。`}`);

  sections.push(`## JSON Schema

\`\`\`json
{
  "stateChanges": [
    { "type": "MODIFY_RESOURCE", "target": ${resIds}, "value": number },
    { "type": "MODIFY_ASPECT", "target": ${attrIds}, "value": number },
    { "type": "ADD_TAG", "target": "string" },
    { "type": "UNLOCK_LOCATION", "target": "string" },
    { "type": "ADD_ITEM", "payload": { "id": "string", "name": "string", "description": "string", "tags": ["string"] } },
    { "type": "REMOVE_ITEM", "target": "string" },
    { "type": "ADD_FACT", "payload": { "id": "string", "name": "string", "description": "string" } },
    { "type": "MARK_BOOK_READ", "target": "string" },
    { "type": "MARK_LORE_MASTERED", "payload": { "id": "string", "name": "string", "description": "string", "aspect": ${attrIds} } },
    { "type": "USE_ITEM", "target": "string" },
    { "type": "USE_LORE", "target": "string" },
    { "type": "ADD_CHARACTER", "payload": { "id": "string", "name": "string", "description": "string", "relationship": "string", "status": "string", "location": "string", "avatarId": "素材库 id，可选；不确定就省略" } },
    { "type": "UPDATE_CHARACTER", "payload": { "id": "string", "updates": { "relationship": "string", "status": "string", "location": "string", "description": "string" } } },
    { "type": "ADD_LOCATION", "payload": { "id": "string", "name": "string", "description": "string", "isUnlocked": boolean } },
    { "type": "MODIFY_TIME", "value": number },
    { "type": "SET_SCENE", "target": "场景 id，可选；只在场景真的改变时给" },
    { "type": "SET_IDENTITY", "target": "string" },
    { "type": "COMPLETE_EVENT", "target": "string" },
    { "type": "TRIGGER_EVENT", "target": "string" }
  ],
  "options": [
    {
      "id": "string",
      "text": "string",
      "style": ${styleIds}
    }
  ],
  "summary": "string：这一轮发生了什么，不超过 40 字，供时间线使用",
  "memory": {
    "bonds": [{ "who": "string", "state": "string" }],
    "threads": [{ "id": "string", "text": "string" }],
    "timeline": [{ "turn": number, "text": "string" }]
  }
}
\`\`\`

没有变更时 \`stateChanges\` 用空数组。**必须**始终包含 \`options\` 字段。
\`summary\` 每轮都要给；\`memory\` 的三层没有变化时给空数组 \`[]\`。`);

  sections.push(`## JSON 格式化硬性规则

1. **不要尾逗号**：数组或对象的最后一项后不能有逗号。
2. **字符串内不要用双引号**：用单引号 \`'\` 或中文引号 \`「」\`。
   - 错误：\`"description": "他说 "你好"。"\`
   - 正确：\`"description": "他说 「你好」。"\`
3. 输出必须是 \`JSON.parse()\` 能直接解析的**纯 JSON**，不要包裹解释文字，不要用 markdown 代码块。
4. **本地化**：\`name\` 与 \`description\` 使用**与世界观一致的自然语言**（默认中文），要有氛围感；\`id\` 保持英文小写下划线格式。`);

  return sections.join('\n\n');
}

/**
 * 把玩家在选角页选定的背景槽位，解析成**可以直接写进提示词的一段话**。
 *
 * 为什么要有这个函数：`opening` 原先是一段写死的场景，而玩家花时间挑的
 * 出身/际遇/秘密**完全没有进入开场提示词** —— 不管选哪个背景，第一幕都一样。
 * 这里把选择还原成"分类：选项名 —— 说明"，并带上开局携带物，
 * 让 AI 有具体的东西可写。
 *
 * ## 自定义项（2026-10 玩家第三次打回后加）
 *
 * 玩家原话是「背景槽位**依旧过于具体，限制住了剧情的开展**」。
 * 所以每个槽位都有一个 `custom: true` 的项：选中它，玩家自己写的那段文本
 * **原样取代**该槽位的 title 与 description，走同一条链路进提示词。
 *
 * ⚠️ 这里刻意**不**把自定义文本降级成"补充说明"或"备注"——
 * 它就是这个槽位的全部内容。否则玩家费劲写的字会被预设压住，
 * 等于那道门白开了。
 *
 * 返回空数组表示玩家没有选任何背景（例如世界卡里没定义槽位）。
 */
export function describeBackgroundChoices(
  world: WorldCard,
  choices: Record<string, string>,
  custom?: Record<string, string>,
): { label: string; id: string; title: string; description: string; items: string[]; custom: boolean }[] {
  if (!world?.backgrounds?.length) return []
  const out: { label: string; id: string; title: string; description: string; items: string[]; custom: boolean }[] = []
  for (const slot of world.backgrounds) {
    const opt = slot.options.find(o => o.id === choices?.[slot.label])
    if (!opt) continue
    const own = (custom?.[slot.label] || '').trim()
    /*
      ⚠️ 选了「我自己写」却一个字没写 ⇒ **当作没选这个槽位**。

      退回预设标题（"我自己写"）看着更"容错"，其实更糟：提示词里会出现
      `- **来路**：我自己写` 这种句子，AI 读到的是"他自己写的是『我自己写』"，
      既没有信息又让它困惑。少一个槽位比多一句废话强。
      （UI 那边也会提示玩家补上，正常路径走不到这里。）
    */
    if (opt.custom && !own) continue
    const isCustom = !!opt.custom && !!own
    out.push({
      label: slot.label,
      id: opt.id,
      // 自定义项：玩家写的原话就是他的身份。
      title: isCustom ? own : opt.title,
      description: isCustom ? '' : (opt.description || ''),
      // 开局携带物是"背景影响开场"最硬的抓手：手上有撬棍的人
      // 和一个手上有账本的人，进同一扇门的方式必然不同
      items: (opt.startingItems || [])
        .map(id => world.items?.find(i => i.id === id)?.name)
        .filter((x): x is string => !!x),
      custom: isCustom,
    })
  }
  return out
}

/**
 * 玩家在选角页挑的「来路」—— **一行**，跟着「人物设定」每一轮注入。
 *
 * ## 为什么砍到一行（2026-11）
 *
 * 它原先是一大段（认得出什么 / 不会的地方要如实写出来 / 但它的边界必须说清楚…
 * 共 700 字，还带着三重「⚠️」）。删的理由和别处一样：
 * 原作的人物设定只有姓名 / 性别 / 外貌三行 + 一句「请在叙事中自然地体现这些特征」。
 * 它把"这个人是谁"交给玩家的卡，把"这个人会怎么做"交给 `PRINCIPLE_STYLES`。
 *
 * 来路只剩一件事值得说：**他认得什么，别人怎么待他**。其余交给性相。
 */
export function buildBackgroundBriefing(
  world: WorldCard,
  choices: Record<string, string> | undefined,
  custom?: Record<string, string>,
): string {
  const picks = describeBackgroundChoices(world, choices || {}, custom);
  if (!picks.length) return '';

  return picks
    .map(p => {
      const note = p.description ? `（${p.description}）` : '';
      const item = p.items.length ? `（随身：${p.items.join('、')}）` : '';
      return `${p.label}：${p.title}${note}${item}`;
    })
    .join('；');
}


/**
 * 性相当前值 —— 跟着「动态指令优先级」注入。
 *
 * ## 为什么它还在（原作没有这一节）
 *
 * 原作把性相值放在 user message 的 `characterState` 里，system prompt 只用一句话引用它。
 * 我们照做了：`playerState.attributes` 与 `playerState.dominantAttribute` 都在输入的 JSON 里。
 *
 * 但那份 JSON 的 key 是英文 id（`lantern` / `edge` …），而性相表里的名字是中文
 * （灯 / 刃）。多拐一道翻译，模型就有一次翻错的机会，而翻了错不会报错，
 * 只会悄悄写偏。所以这里直接用中文把值念一遍 —— 三行，替掉原来 700 字的
 * 「内行 / 够用 / 不会」能力面板。
 *
 * 能力面板确实删了：原作的性相**不是技能**，它不做检定，也不决定成败；
 * 它决定的是"这件事他做成什么样"。能力那套留在数据引擎里做结算就够了。
 */
export function buildAttributeBriefing(
  world: WorldCard,
  aspects: Record<string, number> | undefined,
): string {
  const attrs = world?.enableMechanics ? world.attributes || [] : [];
  if (!attrs.length || !aspects) return '';

  const rows = attrs.map(a => ({ def: a, value: Math.round(aspects[a.id] ?? 0) }));
  // 全 0 = 这一局还没分配过点数，念一遍全是 0 没有意义
  if (!rows.some(r => r.value !== 0)) return '';

  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const top = sorted[0];

  return `### 他此刻的性相
${sorted.map(r => `${r.def.name} ${r.value}`).join('、')}

最高的是「${top.def.name}」。
性相不是技能，不做能力检定 —— 它决定的是**他成为哪一种人**，不是他能不能办成这件事。`;
}


/**
 * 解析玩家选定的「开局处境」素材。
 *
 * ## 这里我改错过两次
 *
 * 第一版：开场对所有背景都一样（玩家："选了半天背景，开场一模一样"）。
 * 第二版：每个选项带一段**写死的完整开场**，并作为第一幕的**唯一依据**，
 *   还明令"场景已定死、别的背景不许挪动它"。结果玩家说：
 *   「我的自设主角是**刑部正四品**，开局却固定有俩**仓部**上司」
 *   —— 我用背景槽位顶掉了玩家自己写的主角设定。
 *
 * 所以现在它只解析出**素材**（这类处境长什么样），交给 AI 作附加参考；
 * 主角自设设定才是主要依据。见 `buildOpeningInstruction`。
 */
export function resolveOpeningSeed(
  world: WorldCard,
  choices: Record<string, string>,
  custom?: Record<string, string>,
): { slot: string; id: string; title: string; seed: string; custom: boolean } | null {
  const slotLabel = world?.story?.openerSlot
  if (!slotLabel) return null
  const slot = world.backgrounds?.find(s => s.label === slotLabel)
  if (!slot) return null
  const chosenId = choices?.[slotLabel]
  const opt = slot.options.find(o => o.id === chosenId)
  if (!opt) return null

  /*
    自定义项：玩家自己写的处境**就是处境本身**，不是"某一类环境的素材"。
    所以这里直接把它当 seed 交出去，并打上 `custom` 标记 ——
    `buildOpeningInstruction` 见到标记会换一套说法（照办，而不是"仅供参考"）。

    一个例外：他选了"我自己写"却一个字没写。此时返回 null，
    让流程退回"用世界氛围兜底"，而不是拿一个空字符串去当处境。
  */
  if (opt.custom) {
    const own = (custom?.[slotLabel] || '').trim()
    if (!own) return null
    return { slot: slotLabel, id: opt.id, title: '他自己写下的处境', seed: own, custom: true }
  }

  /*
    ⚠️ `openingSeeds` 已**扁平化**（2026-10）：直接是「选项 id → 素材」，
    不再按槽位再套一层。原先那层嵌套只有 openerSlot 一个槽位在用，
    多出来的一层既没用、又让作者容易写错键。
    仍然兼容按标题写的旧卡（`map[opt.title]`）。
  */
  const map = world.story?.openingSeeds
  const seed = (map?.[opt.id] ?? map?.[opt.title] ?? '').trim()
  if (!seed) return null
  return { slot: slotLabel, id: opt.id, title: opt.title, seed, custom: false }
}

/**
 * 从世界卡里抽一份**专名清单**（地名、机构、族群、器物…）。
 *
 * ## 为什么需要（A3）
 *
 * 开场现在是 AI **现场创作**的，这带来了一个新风险：
 * 它可能顺手编出与 `worldLore` 冲突的地名与机构名
 * （"你走进汴梁的锦衣卫衙门" —— 而这个世界的设定里没有锦衣卫）。
 * 有了这份清单，指令里就能写"优先使用这些名字"，
 * 把即兴创作约束在世界的既有词汇里。
 *
 * ## 怎么抽
 *
 * 优先取**真正是专名的地方**，按可信度从高到低：
 *  1. `worldLore` 里用 `「」` 括起来的词 —— 本项目的写作惯例是把专名括起来，
 *     这是最可靠的一路信号；
 *  2. 角色卡的名字（世界里真实存在的人）；
 *  3. lore 与物品的名字（真实存在的知识与器物）。
 *
 * 会滤掉过长/过短/明显不是专名的（纯数字、单字、超过 8 字的句子）。
 */
export function collectWorldProperNouns(world: WorldCard, limit = 48): string[] {
  const out = new Set<string>()
  const ok = (s: string) => {
    const t = s.trim()
    if (t.length < 2 || t.length > 8) return false
    if (/^[\d\s、，。·—\-]+$/.test(t)) return false
    // 排掉明显的句读片段（含逗号句号的说明性文字）
    if (/[，。；：！？]/.test(t)) return false
    return true
  }

  // ① 「」里的词 —— 出现次数越多越可能是真专名，所以统计一下频次
  const freq = new Map<string, number>()
  for (const m of String(world.worldLore || '').matchAll(/「([^「」]{2,8})」/g)) {
    const t = m[1].trim()
    if (ok(t)) freq.set(t, (freq.get(t) || 0) + 1)
  }
  // 出现 ≥2 次的优先（一次性的可能只是随手引用）
  for (const [t] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
    if (out.size >= limit) break
    out.add(t)
  }

  // ② 角色名 / ③ 知识名 / ④ 物品名 —— 这些本身就是世界里真实存在的东西
  for (const c of world.characters || []) if (out.size < limit && ok(c.name)) out.add(c.name.trim())
  for (const l of world.lores || []) if (out.size < limit && ok(l.name)) out.add(l.name.trim())
  for (const i of world.items || []) if (out.size < limit && ok(i.name)) out.add(i.name.trim())

  return [...out]
}

/**
 * 把**玩家自己填的主角设定**整理成开场提示词的第一段。
 *
 * 为什么它排在最前面：玩家为这个角色填的每一个字都是他的创作，
 * 而"自述背景"往往直接写明了他的身份与职位（"刑部正四品"）。
 * 一旦 AI 用世界卡里的背景槽位覆盖掉它，玩家立刻会觉得"这不是我设的那个人"。
 */
function describePlayerForOpening(player: PlayerCard): string {
  const lines: string[] = []
  const put = (label: string, v?: string) => {
    const t = (v || '').trim()
    if (t) lines.push(`- ${label}：${t}`)
  }
  put('姓名', player.name)
  put('性别', player.gender)
  put('年龄', player.age)
  put('外貌', player.appearance)
  put('性格', player.personality)
  put('**自述背景**', player.background)
  put('补充设定', player.extra)
  return lines.join('\n')
}

/**
 * 第一幕的额外指令。
 *
 * ## 三条铁律（改这里之前请先读）
 *
 * 1. **没有固定的开场。** 世界卡里不再有任何一段"这就是第一幕"的文本。
 *    第一幕由 AI 依据下面的材料**现场创作**。
 * 2. **主角自设设定优先级最高。** 背景槽位是**附加参考**，
 *    不得覆盖、替换或无视玩家自己写的身份、职位、来路。
 * 3. **不许替玩家认亲。** 不得凭空安插"你的上司 / 你的上峰 / 你的同僚"，
 *    也不得给主角一个他没写过的头衔 —— 玩家已经因为这件事打过回票。
 */
export function buildOpeningInstruction(
  world: WorldCard,
  player: PlayerCard,
  activeCharacters: CharacterCard[],
  backgroundChoices: Record<string, string> = {},
  backgroundCustom?: Record<string, string>,
): string {
  const parts: string[] = [];
  const picks = describeBackgroundChoices(world, backgroundChoices, backgroundCustom);
  const seed = resolveOpeningSeed(world, backgroundChoices, backgroundCustom);
  const playerCard = describePlayerForOpening(player);
  const hasOwnBackground = !!(player.background || '').trim();

  parts.push(`这是这一局的**第一幕**，由你现场创作。**没有任何预设的固定开场**，
请依据下面的材料即兴写出来。

═══ 一、主角本人（**最高优先级，第一幕必须与它吻合**）═══

${playerCard || '（玩家没有填写任何主角设定 —— 此时请让第一幕留出余地，不要替他安上具体身份。）'}

⚠️ 上面这些是**玩家亲手写的**。如果其中写了他的身份或职位
（例如"刑部正四品"、"某伯爵的次子"、"第 62 层监察科员"），
那么第一幕里他就**必须**是这个身份 ——
不要把他换成别的部门、别的官职、别的出身，也不要给他加一个他没写过的上司。`);

  if (seed) {
    /*
      自定义处境：换成"照办"的说法。
      预设选项是"某一类环境的素材"（所以那一段反复叮嘱"这不是剧本"），
      而玩家自己写的处境**就是他对自己此刻位置的规定** ——
      再对他念"这只是素材"，等于把他刚写完的东西又软化回去了，那道门就白开了。
    */
    parts.push(seed.custom
      ? `═══ 二、他自己写下的处境（**照办，这不是参考**）═══

他没有从预设里挑，而是自己写了这一段：

${seed.seed}

⚠️ 这是**他对自己此刻处境的规定**，与上面第一段（主角本人）同等优先。
请照着写：

1. 第一幕里他就是**在这里、正在做这件事**。不要把它替换成别的场合，
   也不要因为它是"自己写的"就写得比预设更含糊、更抽象。
2. 他若写了具体的人、地方或身份（"我姑母在西街开一间浆洗铺"），
   那就**照他写的来** —— 不要换成别的亲戚、别的行业、别的街。
3. 他若写得简略，空出来的部分由你补全，**往具体里补**（气味、价钱、手上的活计），
   不要往大里补（不要顺手给他加一个头衔或一段身世）。
4. 同样**不要替他认亲**：他写的人是他的人，他没写的人不是。
5. 这仍然只是**起点**：第一幕之后他想去哪、想做什么，不受这段限制。`
      : `═══ 二、他所处的那一类环境（**附加参考：这是素材，不是剧本**）═══

他选的处境是「${seed.title}」。下面这段描述的是**这一类环境长什么样**：

${seed.seed}

⚠️ 这一节最容易把第一幕写死，所以有三条硬限制：

1. **它不决定"他现在在哪、正在做什么"。** 那由上面第一段（主角本人）决定。
   这段里的衙门、行当、街市**都不是他的岗位**，只是他可能会打交道、
   会路过、会听人提起的那一类环境。
2. **不要从这段素材里替他认亲。** 里面出现的人只是"这类环境里会有的人"，
   **不是任何人**的下属、同僚或亲戚 —— 他身边的人由他自设的身份决定。
3. **它不限制他往后能去做什么。** 不要因为选了这类环境，就把第一幕之后的路
   都往这上面收；他随时可以走进完全不同的地方，那不算跑题。

用法：只取这类环境的**气味、行话、价钱与规矩**。
凡是它与主角自设设定**冲突**之处（例如素材说他在某个衙门、某个部门，
而主角写的是另一个），**一律以主角的设定为准**，素材只保留可用的氛围与人物类型。
${hasOwnBackground ? '' : '\n（主角没有自述背景，所以此时可以**参照他的来路与立场**替他安排一个合乎逻辑的开场 ——\n但只写"他此刻恰好在做的一件事"，不要写成"他被钉在这个位置上"。）'}`);
  } else {
    const tone = (world.story?.atmosphere || world.story?.opening || '').trim();
    if (tone) {
      parts.push(`═══ 二、世界开场的基调（**附加参考**）═══

本世界没有为这个处境单独写素材。下面这段是世界特有的氛围参考 ——
**取它的时间感、地标、气味与规矩即可，不要照搬其中的具体人与事**：

${tone}`);
    }
  }

  /*
    ── 其余背景槽位：只提供"他带进场景里的东西" ──
    这里绝不能再说"背景决定他为什么在这里"——
    那句话会把所有背景拉回同一个地方找理由（= 同一个工位），
    而且会盖掉玩家自设的身份。
  */
  if (picks.length) {
    const others = picks.filter(p => !seed || p.label !== seed.slot);
    if (others.length) {
      const lines = others.map(p => {
        const bits = [`【${p.label}】${p.title}`]
        if (p.description) bits.push(`　（${p.description}）`)
        if (p.items.length) bits.push(`　开局随身：${p.items.join('、')}`)
        return bits.join('')
      })
      parts.push(`═══ 三、他带进第一幕的东西（**附加参考**）═══

${lines.join('\n')}

这些已经作为他的**固定设定**写进了系统提示（见「人物设定」里的「出身」一行），
这里只提醒第一幕怎么落地：
- **手上有什么**：随身物要真的出现在第一幕里（拿在手里、揣着、藏在靴筒里），并成为他行动的依据。
- **他第一眼会注意到什么**：外行看热闹、内行看门道 —— 让他的来路决定他先看见什么。
- **他心里想要什么、怕什么**：立场决定他在这件事上的偏向，也决定他先提防谁。
- **别人怎么称呼他**：称呼要跟他的身份相称。

⚠️ 三条禁令：
1. 不要把这些写成一段自我介绍（"你出身于……"）；
2. **不要因为"他是商人"就把场景改成商号、因为"他是军人"就改成军营** ——
   他身处什么场合，**首先由第一段里他自己的身份决定**；
   这一节只是他带进场合里的东西；
3. **更不要因为它们去改主角的身份与职位** —— 那是第一段说了算的。`);
    }
  }

  if (activeCharacters.length) {
    parts.push(`═══ 四、世界里的人（可选素材）═══

本世界有这些人物：${list(activeCharacters.map(c => c.name))}。
他们各有自己的位置与立场（见角色卡）。你可以让**其中合得来的一两位**在第一幕里出场，
但要注意：
- 他们的立场是**客观**的（他是某个衙门的人、某个结社的人），**不是"你的谁"**——
  他与你是什么关系，由**你写的第一幕**来确立，而不是反过来。
- 如果这一位与主角的身份对不上（例如他是某个主角根本不会去的场合里的人），
  **宁可不让他出场**，也不要硬塞。
- 也可以一个人都不出场，另写几个合乎主角身份与处境的配角。`);
  }

  parts.push(`═══ 创作要求 ═══

- **依据上面第一段（主角本人）来定他是谁、在哪、做什么**；第二、三段只提供氛围与动机。
- 交代清楚时间、地点、以及他此刻**正在做什么**（正在做，不是刚醒）。
- 在场的人按他的身份合理设定。**不要凭空给他安上司、下属、同僚或亲戚。**
- 结尾留一个明确的、必须马上回应的钩子。
- 这是第一幕，不要信息过载，先让玩家站稳。
- 叙事里**不要出现**"开局处境""背景槽位""世界卡"这类游戏术语。`);

  /*
    ── A3：把即兴创作约束在世界既有的专名里 ──
    开场由 AI 现场创作，它可能编出与 worldLore 冲突的地名与机构
    （"汴梁的锦衣卫衙门" —— 而这个世界里没有锦衣卫）。
    给一份真实存在的名字清单，能显著降低这种跑偏。
  */
  const nouns = collectWorldProperNouns(world)
  if (nouns.length >= 6) {
    parts.push(`═══ 五、这个世界真实存在的名字（**优先使用**）═══

${nouns.join('、')}

提到地名、机构、族群、器物时，**优先从上面这个清单里取**；
清单没覆盖到的地方可以按这个世界的风格新起名，但**不要引入与世界观冲突的既有概念**
（不要把现实世界的朝代、机构、品牌塞进来）。`);
  }

  return parts.join('\n\n');
}

/**
 * 上下文压缩 prompt —— 同时产出**三层长期记忆**（A1）。
 *
 * ## 为什么把记忆三层挂在摘要这一路，而不是单独再发一次请求
 *
 * 摘要本来就要读一遍"最近这一段剧情"，顺手输出关系/线索/时间线**几乎不额外花 token**
 * （输出多几十个字）。若要单独维护记忆，就得多一次 LLM 调用 ——
 * 那正好是 C9 想解决的问题（每轮两次调用已经够贵了）。
 *
 * ## 为什么必须是"合并语义"而不是"重写"
 *
 * 这个调用**只看到最近的一段剧情和当前记忆**，看不到更早的轮次。
 * 所以提示词里反复强调"没提到的不要删"：模型天生倾向给出一个"完整的新版本"，
 * 而那样每 6 轮就会把前面攒下的关系与线索洗掉一次。
 * 合并的实际执行在 `utils/memory.ts` 的 `mergeMemory`（并集 + 同人覆盖），
 * 这里的措辞是让模型**别做多余的省略**，两道保险。
 *
 * ## 轮次怎么给
 *
 * 调用方把带轮次编号的剧情传进来（`[第N轮]`），模型把它抄进 timeline。
 * 没有轮次的时间线对玩家毫无意义（"我们之前干过什么"），也支撑不了 B8 回溯 ——
 * 所以这一条在提示词里是**硬要求**，写在最显眼的位置。
 */
export function buildSummaryPrompt(
  previousSummary: string,
  textToSummarize: string,
  memory?: { bonds?: unknown; threads?: unknown; timeline?: unknown; earlierSummary?: string; dossiers?: unknown },
): string {
  const currentMemory = JSON.stringify({
    bonds: memory?.bonds ?? [],
    threads: memory?.threads ?? [],
    timeline: memory?.timeline ?? [],
    earlierSummary: memory?.earlierSummary ?? '',
    dossiers: memory?.dossiers ?? {},
  })

  return `你是文字冒险游戏的**剧情档案员**。你的工作是把剧情压缩成摘要，并**增量更新**长期记忆。

## 一、摘要（summary）
把下列剧情压缩成一段连贯的摘要，保留关键决定与后果、获得的重要情报与物品、主角当前处境与未解决的悬念；
丢弃氛围描写、重复的对话、可推断的细节。

⚠️ **长度硬要求：整段摘要不超过 1200 字。**
这不是建议，是这一节唯一会被检查的指标。旧摘要加上新剧情，合起来往往远长于这个数，
而摘要**每一轮都要整份发给叙事模型** —— 它每多一千字，这一局往后的每一轮都要多付一次钱。

所以这是**重新压缩**，不是「在旧摘要后面接着写」：
- 已经被后面剧情确认、推翻或不了了之的猜测，删；
- 已经离开的地点、已经了结的事、用完就扔的路人，删；
- 主角的身世、性格、外貌**不用复述** —— 那是主角卡的事，这里只写他**这一局做了什么**；
- 同一个意思只留最狠的那一句，不要为了"完整"再解释一遍。

${previousSummary ? `已有的旧摘要（与下面的新剧情一起**重新压缩**，不是追加在其后）：\n${previousSummary}\n` : ''}
## 二、分层记忆（memory）
分层维护，每一层的更新规则**不同**，请严格区分：

1. \`bonds\`（人物关系**现状**）：主角与关键角色**此刻**的关系 —— 谁欠他、他得罪过谁、谁在帮他、谁在防着他。
   - 写"现在的状态"，不要写事件经过（「欠他一枚铜钱未还」优于「他曾经借过钱」）。
   - 关系变了就给出**新的那一条**，不要把新旧两条都留着。
   - ⚠️ \`who\` 必须用**之前用过的那个名字**（见下面「当前记忆」里的写法）。
     这个人这一轮可能被叫成「那个孩子」「当表的孩子」，但写进这里要用他的**名字** ——
     换了写法，引擎会把它当成另一个人，于是同一个人挂着两条关系，
     而玩家看到的是"凭空多了一条人际关系"。
2. \`threads\`（未结线索）：还没了结的谜题、承诺、债务、威胁。已经了结的**不要**再列。
3. \`timeline\`（事件时间线）：每一轮一句话。**必须**带上轮次 \`turn\`，
   用输入里 \`[第N轮]\` 标出的那个 N；同一轮已有旧记录时**覆盖**它，不要重复两条。
4. \`knownBy\`（**这个人知道主角什么**）：角色名 → 他**这一轮新知道**的关于主角的事实。

   ⚠️ **判据极严**：只有下面三种情形才算「他知道」——
   - 主角**当面告诉**了他；
   - 他**亲眼看见**了（不是推测，是有具体场景的看见）；
   - 他**查到了**，或者**别人转告**了他（要说得出是查的哪、谁说的）。

   **不算**的：他"应该猜得到"的、他"作为老江湖看得出来"的、
   主角没说但设定里写着的、你以为他懂但剧情里没交代过的。
   主角的身世、来历、真实姓名、秘密、没当面说过的事 —— **默认他一无所知**。

   写法示例：\`{ "knownBy": { "阿什沃斯勋爵": ["在成衣行做工", "从爱尔兰来"] } }\`
   一条不超过 30 字，一个人最多 6 条；这一层是**只增不减**的并集，
   你只报这一轮新增的就行。

5. \`affinity\`（**好感双轨**）：这个人**心里**怎么想主角、**当面**怎么表现。
   各用一档：\`亲\`（当自己人）/ \`近\`（有好感）/ \`平\`（无感）/ \`疏\`（不放心）/ \`敌\`（恨）；
   判不出就写 \`未知\`，**不要瞎填「平」**。
   **两档不一致时最有戏**（心里近、脸上疏 = 嘴硬）—— 这时一定要写 \`note\` 说明依据。
   **默认保持**：这一轮没有充分的新依据，**不要重报**，让它维持原样；
   客套、嘴硬、一时情绪都不算感情变化。

6. \`places\`（地点树）：这一轮**新出现**的地点，\`parent\` 写它属于哪个上级
   （「牌墙」的 parent 是「南市」）。已经报过的不要重复。

7. \`inventory\`（**他手上的东西与在哪**）：只报**这一轮变了的** —— 得到了、失去了、挪了地方。
   名字要和以前一致；\`where\` 写清是「随身」还是「寄存在某处 / 落在某处」。
   ⚠️ 这是「他手上这一件现在在哪」，不是「世界上这种东西长什么样」。

8. \`dossiers\`（**角色卷宗**）：角色名 → 这个人**在这一局里**已经确定的事。

   它和 \`knownBy\` 是**反方向**的，别混：
   - \`knownBy\` 记「**他**知道**主角**什么」（治 NPC 全知）；
   - \`dossiers\` 记「**这个人自己**身上发生过什么」（治 NPC 失忆 —— 下一轮把熟人写成陌生人）。

   写法：一句话一条，不超过 40 字，写**因果与处境**，不写外貌设定。
   - ✅「爷爷上月去世，临终把怀表给他，说能换一顿饭」
   - ✅「认主角作师父，跟着他学手艺，睡在柴房」
   - ❌「七八岁的男孩，穿大两号的旧罩衫」（这是角色卡的事，不是发生的事）

   **只增不减**：你只报这一轮新出现的，引擎会合并去重。
   同一个人名字写法要和以前一致（「小满」不要这轮写「小满」下轮写「那个孩子」）。

### ⚠️ 如果一次写不全，按这个顺序保
八层不可能每次都写得一样好。装不下时**从下往上砍**，不要每样只写一半：

1. \`summary\` —— 没有它整段记忆就断了
2. \`timeline\` —— 这一轮记不上，之后永远查不到
3. \`bonds\` —— 关系错了，后面所有对话都会错
4. \`dossiers\` —— 漏了这个人就退回"第一次见面"，下一轮他重新问你「你是谁」
5. \`knownBy\` —— 漏了只是他少说一句该说的，不会说错
6. \`affinity\` / \`places\` / \`inventory\` —— 漏了这一轮不收，下一轮还有机会

**宁可少写两层，也不要写错一层。**

### ⚠️ 合并规则（最重要，请先读这条）
下面是**当前已经积累的记忆**（JSON）。本次输入只包含最近一段剧情，
你**看不到**更早的轮次，所以：

- **没在这次剧情里提到的人、线索、时间线，一律原样保留，不要删。**
- 输出的 \`bonds\` / \`threads\` / \`timeline\` / \`knownBy\` 是**要与旧记忆合并的增量**，
  不是"完整的新版本"。
- 只有剧情明确说明某条线索已经了结、或某段关系已被取代时，才不要再写旧的那一条。
- \`earlierSummary\` 一般**留空字符串**：更早的经过由程序自动折叠，你不需要操心。

当前记忆：
${currentMemory}

## 三、输出格式
只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块：
\`\`\`json
{
  "summary": "不超过 300 字的一段话，与剧情同一种语言，不要分点",
  "memory": {
    "bonds": [{ "who": "人名", "state": "关系现状，如：欠他一枚铜钱未还/对他有戒心" }],
    "threads": [{ "id": "英文小写下划线标识", "text": "未结的线索，一句话" }],
    "timeline": [{ "turn": 7, "text": "这一轮发生了什么，一句话" }],
    "knownBy": { "角色名": ["他这一轮新知道的一件关于主角的事"] },
    "affinity": [{ "who": "人名", "inner": "近", "outer": "疏", "note": "他替你挡过一次话，但当着人从不叫你名字" }],
    "places": [{ "name": "牌墙", "parent": "南市" }],
    "inventory": [{ "name": "外套", "where": "随身", "note": "刚从和通号赎回" }],
    "dossiers": { "小满": ["爷爷上月去世，临终把怀表给了他"] },
    "earlierSummary": ""
  }
}
\`\`\`
没有变化的层给空数组 \`[]\`（\`knownBy\` 与 \`dossiers\` 给 \`{}\`）。字符串内不要用双引号（用「」）。

## 四、需要压缩的剧情
${textToSummarize}`
}

/** 首次加载时用来做连通性测试 */
export function buildPingPrompt(): string {
  return '这是连接测试，请只回复两个字：就绪';
}

export function describeLlm(config: LLMConfig): string {
  return `${config.provider} · ${config.narrativeModel}`;
}
