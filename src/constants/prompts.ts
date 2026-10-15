/**
 * 提示词构建层
 *
 * 原版把整个世界设定（防剿局 / 性相 / 漫宿 / 1900s 伦敦）、章节指南和写作要求
 * 全部写死在这一个文件里。现在这里只保留「引擎协议」——
 * 即两段式生成（叙事 AI + 数据 AI）的通用规则，
 * 所有题材相关内容一律由 WorldCard / CharacterCard / PlayerCard 注入。
 */

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
    ? `，当前 ${Math.round(value)}（${TIER_LABEL[attributeTier(value)]}）`
    : '';
  const head = `- \`${a.id}\`（${a.name}）${val}`;
  return desc ? `${head}：${desc}` : head;
}

function resourceLine(r: ResourceDef): string {
  const bits: string[] = [`初始 ${r.initial}`];
  if (typeof r.max === 'number') bits.push(`上限 ${r.max}`);
  else bits.push('无上限');
  if (r.critical) bits.push('归零视为致命/结局信号');
  const desc = r.description?.trim();
  return `- \`${r.id}\`（${r.name}）_(${bits.join('，')})_${desc ? `：${desc}` : ''}`;
}

/** 把角色卡拼成给叙事 AI 读的人物档案 */
export function formatCharacter(card: CharacterCard): string {
  const blocks: string[] = [];
  const head = [`### ${card.name}`];
  if (card.relationship) head.push(`关系：${card.relationship}`);
  if (card.location) head.push(`所在地点：${card.location}`);
  if (card.status) head.push(`当前状态：${card.status}`);
  if (card.playable) head.push('（由玩家扮演的角色）');
  blocks.push(head.join(' | '));

  if (card.description.trim()) blocks.push(`**设定**：${card.description.trim()}`);
  if (card.personality.trim()) blocks.push(`**性格**：${card.personality.trim()}`);
  if (card.scenario.trim()) blocks.push(`**相关情境**：${card.scenario.trim()}`);
  if (card.messageExamples.trim()) blocks.push(`**对话示例**（模仿其语气与用词）：\n${card.messageExamples.trim()}`);
  if (card.systemPrompt.trim()) blocks.push(`**该角色的专属指令**：${card.systemPrompt.trim()}`);
  if (card.postHistoryInstructions.trim()) blocks.push(`**附加要求**：${card.postHistoryInstructions.trim()}`);

  return blocks.join('\n');
}

export function formatPlayer(player: PlayerCard): string {
  const lines: string[] = [`- 姓名：${player.name || EMPTY}`];
  if (player.gender.trim()) lines.push(`- 性别：${player.gender}`);
  if (player.age.trim()) lines.push(`- 年龄：${player.age}`);
  if (player.appearance.trim()) lines.push(`- 外貌：${player.appearance}`);
  if (player.personality.trim()) lines.push(`- 性格：${player.personality}`);
  if (player.background.trim()) lines.push(`- 背景：${player.background}`);
  if (player.extra.trim()) lines.push(`- 其他：${player.extra}`);
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
   * 本轮情境文本（玩家行动 + 当前地点 + 在场角色 + 最近一段叙事）。
   *
   * 世界书按它挑章节注入 —— 见 `buildNarrativeSystemPrompt` 里那段注释，
   * 以及 `utils/loreDigest.ts` 的完整说明。
   */
  context?: string
  /**
   * 本轮世界书正文的汉字预算。不给就用 `digestLore` 的默认值（12000）。
   * 开局那一轮值得给大一些：第一幕要立住整个世界，之后每轮再收窄。
   */
  loreBudget?: number
}

/** 叙事 AI 的 system prompt */
export function buildNarrativeSystemPrompt(
  world: WorldCard,
  activeCharacters: CharacterCard[],
  player: PlayerCard,
  briefing: TurnBriefing = {},
): string {
  const sections: string[] = [];

  sections.push(`你是文字角色扮演游戏《${world.title}》的**叙事者**。
你的唯一职责是写出沉浸式的小说片段。你**不是**游戏系统，不需要关心数值、状态或任何规则判定——那些由另一个引擎处理。`);

  /*
    ── 世界观设定：**按需注入**，不再整段塞 ──

    改之前这里是一行 `world.worldLore.trim()` —— 把三到七万汉字整份发出去，
    每一轮都发。实测大晟的叙事 prompt 因此是 **66027 汉字 ≈ 4.4 万 token**，
    其中 worldLore 独占 57074 字，约八成是这一轮用不到的设定。

    贵还不是最要紧的：超长上下文里模型对中段内容的注意力会明显下降，
    于是"写了五万字"的效果反而不如"把这一轮真用得上的八千字摆在他眼前"。

    现在按本轮情境（玩家行动、当前地点、在场角色、最近一段叙事）挑章节，
    落选章节只给标题 + 一句话提要。完整推理见 `utils/loreDigest.ts`。
  */
  const loreText = String(world.worldLore || '').trim();
  if (loreText) {
    const digest = digestLore(loreText, {
      context: briefing.context || '',
      /*
        ⚠️ 专名清单放宽到 160 个（默认 48）。它在这里的用途不是"给开场提示词列名字"，
        而是**当检索键**：清单越全，越多章节能被正确命中。
        漏掉一个地名，讲那一带的章节就永远挑不出来。
      */
      nouns: collectWorldProperNouns(world, 160),
      ...(briefing.loreBudget ? { budget: briefing.loreBudget } : {}),
    });
    sections.push(`## 世界观设定

${renderLoreDigest(digest, world.title)}`);
  } else {
    sections.push(`## 世界观设定

（作者未提供详细设定，请在首次叙事时从玩家的开场设定中自然建立世界。）`);
  }

  if (world.rules.trim()) {
    sections.push(`## 世界规则与硬性约束

${world.rules.trim()}

以上约束优先级高于一切文风偏好，必须严格遵守。`);
  }

  /*
    ── 沙盒优先 ──
    这一节是**故意放在"主线目标"之前**的。
    内置世界都是"等待探索的沙盒"，不是任务关卡；玩家可以整局都不碰任何长期目标。
    而提示词里靠后的段落更容易被模型当成"更近的指令"，
    所以把"以玩家兴趣为准"写在目标之前，让它先立住。

    为什么需要显式写：模型在没有明确约束时，默认倾向是**尽快推动一个剧情**——
    拿到一个目标就一路推向高潮。那正好把沙盒玩成了单线剧情。
  */
  sections.push(`## 这是沙盒，不是任务关卡

这个世界是**拿来探索**的，不是拿来通关的。请遵守：

- **没有必须完成的主线。** 玩家可以一直做自己的事，永远不碰任何宏大目标，这**不是**玩错了。
- **以玩家的兴趣为准。** 玩家往哪走，世界就在哪一侧变厚：他问街市你就写街市，他打听某个人你就让那个人有来历、有立场、有不愿意说的事。
- **不要替玩家总结或推进"剧情进度"。** 不要说"你意识到自己正走向……""这一切都指向……"这类旁白式收束。
- **不要催。** 除非玩家自己提到时间压力，否则不要用"期限将至""不能再拖"这类方式逼他行动。
- **世界要自己动。** 玩家不动时，世界也在发生事（隔壁的纠纷、涨价、调令、雨、收成）。这些事**不围绕玩家**发生，只是恰好被他看见或错过。
- **给可摸的东西，不要给悬念清单。** 与其铺陈神秘线索，不如把细节写实：这一顿吃什么、多少钱、谁在收钱、路怎么走、这栋楼以前是谁的。
- **允许玩家只当一个普通人。** 上工、吃饭、还债、跟人吵架、把日子过下去，都是完整的玩法。`);

  sections.push(`## 主角（玩家角色）

${formatPlayer(player)}

请在叙事中自然地体现这些特征：正确使用对应的代称，并在动作描写中呼应其外貌与性格。`);

  /*
    ── 背景与属性：**每一轮**都注入，不再只是开场的表单 ──
    这两段必须紧跟在「主角」之后：那是模型读"这个人是谁"的位置。
    放到提示词末尾会被当成参考资料，放在这里才会被当成他的定义。
    两段都可能返回空串（玩家没选背景 / 世界关掉了机制层），空则不注入。
  */
  const bgBriefing = buildBackgroundBriefing(world, briefing.backgroundChoices, briefing.backgroundCustom)
  if (bgBriefing) sections.push(bgBriefing)

  const attrBriefing = buildAttributeBriefing(world, briefing.aspects)
  if (attrBriefing) sections.push(attrBriefing)

  if (activeCharacters.length) {
    sections.push(`## 出场角色档案

以下是本场游戏中在场的角色。**必须**保持其性格、说话方式与设定一致，不要凭空改变他们的核心特质。

${activeCharacters.map(formatCharacter).join('\n\n')}`);
  }

  if (world.story.mainQuest.trim()) {
    /*
      注意这里的措辞：字段名叫 mainQuest，但对沙盒世界它是
      **"若干宏观、宽泛的长期目标"**，不是"必须推进的主线"。
      所以这一段要明确写成"可选"，否则等于在沙盒里立了一块路线牌。
    */
    sections.push(`## 长期目标（**可选**，不是主线）

下面是这个世界里**可以**追求的几件大事。它们是**方向**，不是任务：

- 玩家可以追求其中任何一件，也可以只追求一半，也可以**一件都不碰**——都不算玩错。
- 玩家只能靠自己了解到的信息去做判断。**不要**让 NPC 主动把这些目标交到玩家手上，也**不要**替玩家安排"顺理成章"的下一步。
- 玩家朝某个目标动的时候，请让**代价与阻力**真实存在（官面上的、钱上的、人情上的），不要给捷径。
- 玩家放下某件事去干别的时，**不要**把它拽回来。

${world.story.mainQuest.trim()}`);
  }

  sections.push(`## 叙事风格

${povInstruction(world)}

- **单次回复长度**：约 ${world.narrative.replyLength} 字。写得饱满，不要草草收尾。
- **感官细节**：至少调动两种感官（气味、声音、触感、光线、温度），让场景可触可感。
- **物理事实优先**：先交代清楚**谁、在哪里、在做什么**，再谈感受与隐喻。不要让抽象描写取代具体行动。
- **节奏**：不要在一句话里完成复杂动作；不要替玩家做决定或替玩家说话。
${world.narrative.customStyle.trim() ? `- **额外文风要求**：${world.narrative.customStyle.trim()}` : ''}`);

  sections.push(`## 写作协议

1. **纯叙事**：只输出小说正文。
   - 禁止输出任何系统日志（如「状态变更：…」「获得物品：…」「资金 -5」）。
   - 禁止用括号解释机制（如「（理智 -1）」）。
   - 禁止输出括号内的元注释、性格分析或选项列表。
   - 禁止直接提及属性名或数值。
2. **只演不判**：不替玩家选择行动。玩家的意图由输入给出，你负责**演绎其结果**。若玩家的行动可能失败，请描写失败的具体过程与代价，而不是含糊带过。
3. **NPC 独立意志**：NPC 有自己的目的，可以拒绝、撒谎、误解、主动行动，不要一味顺从玩家。
4. **保持当下**：把镜头停在**需要玩家做出反应的时刻**，不要快进到结果之后。
5. **绝不代替玩家发言**：不要写玩家角色的对白或内心决定。

### 剧情控制
- 当输入包含 \`[系统事件触发: 标题]\` 时，你的任务是**详细演绎** \`storyContext\` 中提供的文本。严禁概括、严禁跳过、严禁快进到事件结束之后。
- 当输入包含 \`[紧迫感指令]\` 时，必须让局势的紧迫性体现在叙事中。
- 输入中所有 \`[给数据引擎的指令]\` 区块是给另一个引擎看的，**完全忽略**，不要输出其中内容。
- 不要重复玩家已经历过的情节；参考输入中的「已完成事件」与「前情摘要」。`);

  sections.push(`## 输出格式

仅输出纯文本剧情。不要输出 JSON，不要输出元数据，不要在结尾罗列选项。`);

  return sections.join('\n\n');
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

### 属性
${attributes.length ? attributes.map(a => attrLine(a, aspects?.[a.id])).join('\n') : '（本世界未定义属性）'}

**属性是能力，不是分数。** 上面标了每个属性的**当前值与档位**，判据是这样定的：

- **内行**（4 及以上）：他做这类事应当成功，而且**看得出别人看不出的东西**。
  剧情里遇到需要这门本事的场合，可以让他凭它拿到额外信息、少走一步弯路。
- **够用**（2~3）：日常做得来；碰上真正的行家或硬场面，要给阻力。
- **不会**（0~1）：**这类行动应当失败**，或者必须借助他人与外物。
  玩家仍然可以尝试（协议里不许用 requirements 拦人），但你要如实写出失败的
  具体过程与代价，而不是照顾他一下让他蒙过去。**也不要因为他不会就不给出这类选项** ——
  明知不可为而为之，本身是一种玩法；你只负责让后果真实。
- 属性**只在剧情中明确发生了对应事件时**才变动（见下面的通则）；不要因为"他这次做得不错"
  就随手加一点，那会让档位失去意义。一次真正的成长（拜师、长期练习、吃过一次大亏）
  才配得上 +1。

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
   - 若输入中 \`userActionType\` 为 \`option\`，优先通过 \`USE_ITEM\` / \`USE_LORE\` / \`MARK_BOOK_READ\` 间接改变属性，而不是直给。
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
5. **世界状态**
   - 时间流逝 → \`MODIFY_TIME\`（单位：分钟。跨天请给足数值，如「第二天」约 1440）
   - 地点变更 → \`UNLOCK_LOCATION\`
   - 探索到新地点的情报 → \`ADD_LOCATION\`
   - 身份/头衔变化 → \`SET_IDENTITY\`
6. **人物**
   - 新角色登场 → \`ADD_CHARACTER\`（必须带完整 payload，包含 id/name/description/relationship/status/location/avatarId/appearance）
   - 已有角色的关系、状态、位置、描述变化 → \`UPDATE_CHARACTER\`（**务必沿用已有的 id**）
   - 注意：已在「出场角色档案」中的角色**不需要**重复 ADD_CHARACTER，只在状态变化时 UPDATE_CHARACTER。

## 长期记忆维护（memory）

引擎会按轮次记住"发生过什么"，并在每一轮把这份记忆交给叙事 AI。你**每轮都要**顺手更新它
—— 这是叙事 AI 在二十轮以后还记得"谁欠谁"的唯一依据。

\`\`\`json
{
  "summary": "一句话，不超过 40 字：这一轮发生了什么（供时间线使用）",
  "memory": {
    "bonds": [{ "who": "人名", "state": "两人**此刻**的关系，如：欠他一枚铜钱未还/对他有戒心" }],
    "threads": [{ "id": "英文小写下划线标识", "text": "还没了结的谜题/承诺/债务/威胁，一句话" }],
    "timeline": [{ "turn": 轮次数字, "text": "这一轮发生了什么，一句话" }]
  }
}
\`\`\`

规则（每一条都是为了别让记忆丢掉）：
- \`turn\` 用输入里的 \`currentState.turn\`；同一轮重复提交会**覆盖**（不会重复两条）。
- \`bonds\` / \`threads\` 是**增量**：这次剧情里提到谁、哪条线索有变化，就只写那几条。
  **没提到的不要重写、更不要清空** —— 你看不到更早的轮次，漏写等于让引擎丢掉它。
- 关系变了就给**新的那一条**（「欠人情」变「结仇」），不要新旧都列。
- 线索已经了结（谜题揭开、债还清、威胁解除）时，**不要**再列它。
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
 * 把玩家选定的背景槽位整理成**每一轮都注入叙事 AI** 的一段简报。
 *
 * ## 为什么必须有它（2026-10，玩家第二次打回）
 *
 * 玩家原话：
 * > 「只有开局处境对剧情有影响……**我的想法是背景、出身、主角背景、属性
 * > 全部对剧情有直接的影响**」
 *
 * 他说得对，而且原因在代码里看得很清楚：
 *
 *  - `describeBackgroundChoices` 的**唯一调用点**是 `buildOpeningInstruction`，
 *    也就是**只喂给第一幕**。第二幕起，玩家挑的出身/立场/来路就再也没进过提示词。
 *  - 每轮倒是有 `playerState.background` 那一段 JSON 进上下文，
 *    但 `buildDataSystemPrompt` 里对它的定义白纸黑字写着
 *    「物品必须与玩家的出身挂钩」—— 它被**当成发物品的依据**，
 *    而不是"这个人此刻怎么看待世界"的依据。
 *
 * 于是背景槽位变成了一个开局点一下就作废的表单。这一段把它拿回来：
 * 写清楚每一轮该怎么用（认得出什么、习惯怎么做、别人怎么待他、手上有什么），
 * 并**显式要求写出他的外行** —— 否则模型会顺手把主角写成全能。
 *
 * 返回空串表示玩家没选任何背景（或世界卡没定义槽位），此时**不注入**：
 * 一个只有标题没有内容的空区块只会浪费 token。
 */
export function buildBackgroundBriefing(
  world: WorldCard,
  choices: Record<string, string> | undefined,
  custom?: Record<string, string>,
): string {
  const picks = describeBackgroundChoices(world, choices || {}, custom)
  if (!picks.length) return ''

  const lines = picks.map(p => {
    const bits = [p.custom
      ? `- **${p.label}**（**他自己写的**，不是从预设里挑的）：${p.title}`
      : `- **${p.label}**：${p.title}`]
    if (p.description) bits.push(`  ${p.description}`)
    if (p.items.length) bits.push(`  随身：${p.items.join('、')}`)
    return bits.join('\n')
  })

  return `## 他的来路与立场（**每一轮都要用上 —— 这不是只在开场生效的表单**）

${lines.join('\n')}

上面这些是**他此刻看世界的方式**，不是一段履历、更不是自我介绍。请在**每一轮**叙事里让它们真的起作用：

- **他认得出什么**：来路决定眼力。同一件东西，他看见的是**同行才看得见的门道**
  （行省抄写人拿到一份状纸，先看纸的规格与押缝印对不对；赶驮人看一头骡子，先看蹄与牙口；
  钱庄伙计听人报数，先在心里验一遍贴现）。给出这种专业细节，而不是笼统的"你很在行"。
- **不会的地方要如实写出来**：凡是与他的来路无关的领域，他会看错、会问出蠢问题、
  会被人糊弄、会听不懂行话 —— 这才是**外行**该有的样子，也正是来路在起作用。
  **不要让他什么都懂** —— 他的本事只在他自己那一行里，出了那一行，他和你我一样要交学费。
  这一条比上一条更重要。
- **他习惯怎么做**：立场与信念决定他遇到麻烦时的第一反应 —— 是先查账、先托人、
  先动手，还是先跑。同一件事，不同来路的人会走出不同的第一步。
- **别人怎么待他**：出身决定待遇。同样一句话，换个身份去说，对方的脸色、开价、
  推托的借口都不一样；他也会因为出身而被某些门**天然地挡在外面**。
- **他手上有哪些东西**：随身物要真的被用起来（拿在手里、押在柜上、当掉、送出去），
  不是写一次就被忘掉的摆设。
- **实在不会的时候，让他求人**：他没有的那门本事，别让他凭空会了 ——
  让他花钱雇人、托人情、或者干脆绕开。这才是来路真正在起作用的样子。

### 但它的边界必须说清楚（**这一节与上面同样重要**）

上面这些是**他此刻的处境与眼光**，**不是他被钉住的位置**。请守住下面三条：

1. **它不规定他能做什么。** 他不欠这个身份任何忠诚，也不受它约束 ——
   一个替人跑腿的人可以忽然决定去揭发一件事，一个体制内的人可以辞职、可以叛、可以什么都不干。
   他往后走的路**不必**与来路相称。
2. **它不规定世界怎么对他。** 别人对他的态度来自**此刻的具体情形**（他手里有什么、
   谁在场、他刚才说了什么），不来自一个身份标签该有的"通常待遇"。
   不要写成"因为他出身某某，所以某某人必然如何"。
3. **它是起点，不是主题。** 不要让故事绕着"他的来路"转 ——
   来路只是他理解眼前这件事的**工具**，眼前这件事才是故事。`
}

/**
 * 属性分档。
 *
 * ## 为什么是这三档，而不是一条公式
 *
 * 四个内置世界的 `attributePoints` 都是 **6 点自由分配**（见各世界卡），
 * 再叠上背景选项的 `attributeBonus`（通常 +1~+3），所以单个属性的落点
 * 大致在 **0~6**：0 = 一点没投，6 = 投满又赶上有加成的出身。
 *
 * 于是三档正好：**0~1 不会 / 2~3 够用 / 4+ 内行**。
 * 这里刻意**不做数值检定**（不掷骰、不算成功率）——
 * 项目约定「允许失败，失败后果在下一回合判定」，而叙事 AI 的职责是**演绎**而非判定。
 * 给它档位和用法，比给它一套概率更不容易把书写成战报。
 */
export type AttributeTier = 'none' | 'ok' | 'expert'

export function attributeTier(value: number): AttributeTier {
  if (!Number.isFinite(value) || value <= 1) return 'none'
  if (value <= 3) return 'ok'
  return 'expert'
}

const TIER_LABEL: Record<AttributeTier, string> = {
  none: '不会',
  ok: '够用',
  expert: '内行',
}

/**
 * 把属性当前值整理成**每一轮都注入叙事 AI** 的一段简报。
 *
 * ## 为什么必须有它
 *
 * 玩家原话：「**那些属性对游戏剧情的影响也几乎没有**」。根因是结构性的：
 *
 *  - 属性**只进数据 AI**（`buildDataSystemPrompt`），在那里也只是一张
 *    「id → 名字 → 说明」的字典，唯一用途是**加减法**；
 *  - **叙事 AI 根本收不到属性** —— `buildNarrativeSystemPrompt` 的入参里
 *    压根没有 `aspects`。所以它写下"你翻过那道墙"的时候，
 *    并不知道自己笔下的主角武艺是 0 还是 6。
 *
 * 结果是属性退化成一个只会上下跳的数字面板，玩家看不见它对故事的形状有任何影响。
 * 这一段把它变成**叙事待遇**：高就是内行、低就是外行、没有就是不会，
 * 而且是每一轮都要照着写、**写不出数字**的那种。
 *
 * 传入 `aspects` 为空或全部为 0（还没分配）时返回空串，不注入。
 */
export function buildAttributeBriefing(
  world: WorldCard,
  aspects: Record<string, number> | undefined,
): string {
  const attrs = world?.enableMechanics ? world.attributes || [] : []
  if (!attrs.length || !aspects) return ''

  const rows = attrs.map(a => ({
    def: a,
    value: Math.round(aspects[a.id] ?? 0),
  }))
  // 全 0 = 这一局还没分配过点数，简报没有意义（也免得给 AI 一堆"不会"）
  if (!rows.some(r => r.value !== 0)) return ''

  const lines = rows.map(r => {
    const tier = attributeTier(r.value)
    const desc = (r.def.description || '').trim()
    return `- **${r.def.name}** · ${TIER_LABEL[tier]}（${r.value}）${desc ? ` —— ${desc}` : ''}`
  })

  return `## 他的能力：这几样东西决定他做得到什么、做不到什么（**每一轮都要照此描写**）

${lines.join('\n')}

**这不是一组可以随手加的数字，而是他在这个世界里能做成什么事的天花板。** 每一轮都要落到具体的手感与结果上：

- **内行**的那几样：他看得出门道、下手稳、会被同行请教，也能靠它吃饭。
  写他做这类事时**要给专业细节**（术语、行话、判断依据、动作的准确度），
  而不是笼统地说一句"你很擅长"。
- **够用**的那几样：日常做得来，遇到真正的行家会被压一头。别把它写成专家。
- **不会**的那几样：**这是硬边界**。他做这类事会失败、会露怯、会被骗，
  需要求人或花钱雇人。**不要因为剧情需要就让他突然会了** —— 那等于把这个面板作废。
  他绕开它、或者为它付出代价，才是正确的演法。
- 上面**没列出**的能力，就是他不会的，不要凭空给他。
- 叙事里**一个字都不要提属性名与数字**，全部化成动作、手感与结果。`
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

这些已经作为他的**固定设定**写进了系统提示（见「他的来路与立场」一节），
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
  memory?: { bonds?: unknown; threads?: unknown; timeline?: unknown; earlierSummary?: string },
): string {
  const currentMemory = JSON.stringify({
    bonds: memory?.bonds ?? [],
    threads: memory?.threads ?? [],
    timeline: memory?.timeline ?? [],
    earlierSummary: memory?.earlierSummary ?? '',
  })

  return `你是文字冒险游戏的**剧情档案员**。你的工作是把剧情压缩成摘要，并**增量更新**三层长期记忆。

## 一、摘要（summary）
把下列剧情压缩成一段连贯的摘要，保留关键决定与后果、获得的重要情报与物品、主角当前处境与未解决的悬念；
丢弃氛围描写、重复的对话、可推断的细节。
${previousSummary ? `已有的旧摘要（请在其基础上累加，不要丢失其中仍然有效的信息）：\n${previousSummary}\n` : ''}
## 二、三层记忆（memory）
分三层维护，每一层的更新规则**不同**，请严格区分：

1. \`bonds\`（人物关系**现状**）：主角与关键角色**此刻**的关系 —— 谁欠他、他得罪过谁、谁在帮他、谁在防着他。
   - 写"现在的状态"，不要写事件经过（「欠他一枚铜钱未还」优于「他曾经借过钱」）。
   - 关系变了就给出**新的那一条**，不要把新旧两条都留着。
2. \`threads\`（未结线索）：还没了结的谜题、承诺、债务、威胁。已经了结的**不要**再列。
3. \`timeline\`（事件时间线）：每一轮一句话。**必须**带上轮次 \`turn\`，
   用输入里 \`[第N轮]\` 标出的那个 N；同一轮已有旧记录时**覆盖**它，不要重复两条。

### ⚠️ 合并规则（最重要，请先读这条）
下面是**当前已经积累的记忆**（JSON）。本次输入只包含最近一段剧情，
你**看不到**更早的轮次，所以：

- **没在这次剧情里提到的人、线索、时间线，一律原样保留，不要删。**
- 输出的 \`bonds\` / \`threads\` / \`timeline\` 是**要与旧记忆合并的增量**，不是"完整的新版本"。
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
    "earlierSummary": ""
  }
}
\`\`\`
没有变化的层给空数组 \`[]\`。字符串内不要用双引号（用「」）。

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
