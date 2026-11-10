/**
 * 世界卡 / 角色卡 / 玩家卡
 *
 * 设计目标：把原项目里硬编码的「1900 年代伦敦 + 防剿局 + 八种性相」
 * 全部外置成用户可编辑的数据。字段命名尽量贴近 SillyTavern V2 角色卡规范，
 * 以便直接导入现成的酒馆卡。
 */

import type { StoryEvent } from './story';
import type { WorldTone } from '@/utils/worldTone';

/** 数值属性（原 AspectState：灯/铸/刃/冬/心/杯/蛾/启） */
export interface AttributeDef {
  /** 稳定 id，AI 结算时用它，形如 `lantern` / `strength` */
  id: string;
  /** 显示名，如「灯」「力量」 */
  name: string;
  /** 说明，注入提示词，告诉 AI 这个属性代表什么 */
  description?: string;
  /** UI 强调色，十六进制 */
  color?: string;

  /**
   * **性相的两个面**（2026-11，学《密教模拟器》的做法）。
   *
   * `description` 回答"这是什么"——知识，给玩家看的、也给 AI 定标用的。
   * 这两个字段回答的是**"这个人会怎么活着"**：
   *
   * - `traits`：三四个词的价值取向。例：`['理性', '残酷', '揭示']`
   * - `behaviors`：这个人下意识会做的动作。例：`['用冷漠的目光审视', '强迫自己直视恐惧']`
   *
   * ## 为什么值得单独存在
   *
   * 光有数值和一段解释，属性就只是一个"加多少点"的旋钮 ——
   * 玩家选它是因为强，而不是因为**想成为这种人**。
   *
   * 原项目（苍白卷宗）的八个性相每个都带这两栏，于是「选灯」不是选一个
   * 加成的方向，是选一双看世界的眼睛。这一层才是"性相"和"属性"的区别。
   *
   * 注入提示词时，`behaviors` 是给叙事 AI 的**具体动作库** ——
   * 比"他很有灯相"这种抽象要求管用得多。
   */
  traits?: string[];
  behaviors?: string[];
}

/** 资源条（原 resources：资金/健康/理智） */
export interface ResourceDef {
  id: string;
  name: string;
  description?: string;
  /** 初始值 */
  initial: number;
  /** 上限；留空 = 无上限（如金钱） */
  max?: number;
  color?: string;
  /** 归零时是否做为「失败/结局」信号提示 AI */
  critical?: boolean;
}

/** 开局背景选项（原 ORIGINS / CHILDHOODS / TRAITS） */
export interface BackgroundOption {
  id: string;
  title: string;
  description?: string;
  /** 属性加成 */
  attributeBonus?: Record<string, number>;
  /** 资源加成 */
  resourceBonus?: Record<string, number>;
  /** 开局携带物品 id 列表 */
  startingItems?: string[];
  /**
   * **「我自己写」项**：选中它以后，选角页会展开一个文本框，
   * 玩家自己写下他在这个世界里的位置、来路或立场。
   *
   * ## 为什么必须有这个东西（2026-10，玩家第三次打回）
   *
   * 玩家原话：
   * > 「现在的背景槽位**依旧过于具体，限制住了剧情的开展**」
   *
   * 他说得对，而且这是**结构问题**，不是文案问题：
   * 无论我把预设选项写得多宽，它终究是一个**封闭清单** ——
   * 玩家想演「一个在四号线沿线卖热食的寡妇」，而清单里只有「合闸派 / 归地派 / 配额派」，
   * 他只能挑一个最接近的，然后 AI 就照着那个**具体的派别**写下去，他想要的那个角色永远出不来。
   *
   * 每个槽位配一个本项，等于给封闭清单开一道门：
   * 预设负责"给不知道想演什么的玩家一个具体钩子"，本项负责"给知道想演什么的玩家让路"。
   * 两者的文本走**完全同一条链路**进入提示词（见 `describeBackgroundChoices`），
   * 区别只在来源。
   *
   * ⚠️ 数值加成请填**该槽位所有预设项的中位值** —— 不要填 0
   * （自定义就变成纯亏，玩家会觉得自己被罚了），也不要填满值（那就成了最优解）。
   */
  custom?: boolean;
}

export interface BackgroundSlot {
  /** 槽位名，如「出身」「童年」「特质」 */
  label: string;
  options: BackgroundOption[];
}

/** 预置物品/线索/知识模板 */
export interface ItemTemplate {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface LoreTemplate {
  id: string;
  name: string;
  description: string;
  /** 关联的属性 id */
  attribute?: string;
  level?: number;
}

/**
 * **立绘的结构化外观** —— 部件级指定，不经任何推断。
 *
 * ## 为什么要做这件事（2026-10，玩家反馈）
 *
 * > 「人物立绘与描述的匹配程度仍然堪忧，**仅仅只是靠关键词来临时构筑人物立绘的
 * > 错误率高到不必多说**，你想想怎么彻底解决这个问题」
 *
 * 他说得对，而且问题是**方法论**上的，不是词表不够长：
 *
 *  1. 原先立绘走的是「中文描述 → 正则抽特征 → 再从部件池里挑部件」两步猜测
 *     （`appearance.ts` 953 行、291 个正则；`lpcSprite.ts` 976 行）。
 *  2. 中文描述的表述空间是**无穷的**（「黛青直裰」「玄色箭袖」「月白中衣」「一身缟素」…），
 *     而正则表是有限的 —— 于是词表永远追不上，错误率永远下不来。
 *  3. 更糟的是第二步：即使抽对了"深青色长袍"，**从 67 件衣服里挑哪一件**仍是猜的。
 *
 * 所以这里的做法不是"加更多关键词"，而是**换掉数据来源**：
 * 立绘的每一个部件都由**显式数据**决定 —— 作者（或玩家）直接写部件 id 与调色板键。
 * `inferTraits` 退化为**兜底**，只用于「导入的第三方卡」或「没填的字段」。
 *
 * ## 用法
 *
 * 只需要写**你在意的那几项**，其余留空由推断补齐：
 *
 * ```ts
 * look: {
 *   head: 'heads_human_male', skin: 'light',
 *   hair: 'hair_topknot_long', hairColor: 'black',
 *   torso: 'torso_clothes_robe', torsoColor: 'slate',
 *   legs: 'legs_pants', legsColor: 'black',
 *   feet: 'feet_shoes_basic', feetColor: 'black',
 *   beard: 'beards_mustache', beardColor: 'dark_gray',
 *   note: '青灰直裰、束发、山羊胡',   // 只用于审计与展示，不参与渲染
 * }
 * ```
 *
 * ⚠️ 部件 id 必须来自 `src/assets/lpc/runtime.json`（246 个部件），
 * 调色板键必须来自 `palettes.json` 的 `hair` / `body` / `cloth` / `eye` / `metal` / `wood`。
 * 写错的 id 不会报错，只会被静默忽略 —— 所以有 `pnpm check:sprites` 专门查这件事。
 */
export interface SpriteLook {
  /** 头部部件（决定性别与年龄感）：heads_human_male / _female / _elderly / _small / _gaunt / _plump */
  head?: string
  /** 发型部件 id（hair_*，共 67 个：hair_topknot_long / hair_long_tied / hair_buzzcut / hair_balding …）；空串 = 明确光头 */
  hair?: string
  /** 上装部件 id（torso_* 或 dress_*）；传了 dress_* 会自动去掉腿部件 */
  torso?: string
  /** 下装部件 id（legs_*）；空串 = 不要下装（裙装已覆盖） */
  legs?: string
  /** 鞋部件 id（feet_*） */
  feet?: string
  /** 帽子/头饰部件 id（hat_*，共 36 个） */
  hat?: string
  /** 胡子部件 id（beards_*，共 12 个）；空串 = 明确不要胡子 */
  beard?: string
  /** 披风（cape_solid / cape_tattered / cape_trim） */
  cape?: string
  /** 腰带等配件（belt_*） */
  belt?: string
  /** 臂部/护腕（arms_* / shoulders_* / wrists_*） */
  arms?: string
  /** 眉毛部件（eyebrows_thick / eyebrows_thin） */
  brows?: string
  /** 鼻子部件（head_nose_straight / _button / _big / _large / _elderly） */
  nose?: string

  // ── 颜色：**只有这四种材质能独立指定** ──
  // ⚠️ `RecolorSpec` 只有 hair / body / cloth / eye 四种映射表。
  // 也就是说**所有布料部件（上衣、下装、鞋、帽子、披风、腰带）共用同一个 cloth 色** ——
  // 「上衣红、裤子黑」目前做不到，要支持得改整个换色管线（按部件分别建映射表）。
  // 与其在类型里留一堆不生效的字段骗人，不如只留真实可用的这四个。
  /** 肤色键（body 材质，如 light / amber / olive / taupe / bronze / brown / black） */
  skin?: string
  /** 发色键（hair 材质，如 black / dark_brown / gray / white / blonde / raven） */
  hairColor?: string
  /** 衣色键（cloth 材质，统管所有布料部件） */
  clothColor?: string
  /** 瞳色键（eye 材质：blue / green / purple / red / orange / yellow / brown / gray） */
  eye?: string

  /**
   * 作者写的一句外观说明 —— **只用于展示与审计，不参与渲染**。
   * 有了它，`pnpm check:sprites` 才能拿它跟 `look` 做一致性检查
   * （例如 note 写"女子"而 head 填了 male 就会被抓出来）。
   */
  note?: string
}

/** 一个角色卡（NPC 或可扮演角色） */
export interface CharacterCard {
  id: string;
  name: string;
  /** 头像：data URL 或 http(s) URL */
  avatar?: string;
  /**
   * 素材库头像 id（由 AI 或用户从清单里挑）。
   * 优先级低于 avatar：卡里自带图片时用图片。
   */
  avatarId?: string;

  // —— SillyTavern V2 兼容字段 ——
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  messageExamples: string;
  creatorNotes: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  alternateGreetings: string[];
  tags: string[];
  creator: string;
  characterVersion: string;

  /** 是否在开局就登场 */
  present: boolean;
  /** 初始所处地点 */
  location?: string;
  /** 与玩家的初始关系 */
  relationship?: string;
  /** 初始状态，如「健康」「受伤」 */
  status?: string;
  /** 是否由玩家扮演（用于多主角/组队跑团） */
  playable?: boolean;

  /**
   * 立绘的结构化外观（部件级）。
   * 填了就以它为准渲染；留空的字段才走关键词推断。见 `SpriteLook` 的说明。
   */
  look?: SpriteLook;

  /** 原卡里未识别的字段，原样保留以免导入导出丢数据 */
  extensions?: Record<string, unknown>;
}

export type NarrativePov = 'second' | 'first' | 'third';
export type NarrativeTense = 'past' | 'present';

export interface NarrativeStyle {
  /** 人称：第二人称「你」/ 第一人称「我」/ 第三人称 */
  pov: NarrativePov;
  /** 时态 */
  tense: NarrativeTense;
  /** 单次回复目标字数 */
  replyLength: number;
  /** 自由补充的文风要求 */
  customStyle: string;
}

export interface StorySettings {
  /**
   * 世界的**氛围与质感**（不是剧本，也不是"开场文本"）。
   *
   * ⚠️ **字段名从 `opening` 改成了 `atmosphere`**（2026-10）。
   * 它被我改过三次语义（唯一开场 → 兜底示例 → 世界氛围参考），
   * 旧名字早就不准确了；而"名字骗人"正是当初我误用它写死第一幕的原因之一。
   * 现在它只有一个职责：告诉 AI 这个世界的时间感、地标、气味、物价与规矩。
   * 真正的第一幕由 AI **现场创作**（见 `openingSeeds`）。
   *
   * ⚠️ 注意别与 `WorldTone`（`utils/worldTone.ts`）混淆 ——
   * 那个是**场景配色的色调**（ink / neon / holo / parchment），管的是画面颜色，
   * 与本字段（管叙事氛围）是两件事。我最初想叫 `worldTone`，正因撞名才改成现在这个名字。
   */
  atmosphere: string;
  /**
   * **这一局的核心氛围** —— 一行，十几个字，像一句咒。
   *
   * ## 为什么单独有这个字段（2026-11）
   *
   * 玩家问：「怎么原作的提示词效果用起来，氛围也没有原作好？」
   *
   * 查下来的第一因是：我们每轮真正喂给模型的**氛围素材**几乎是零。
   * 而原作每一章顶上都有这么一行：
   *
   *   > **核心氛围**：迷茫、恐惧、被迫的选择、冰冷的秩序。
   *
   * 那一行不是装饰。模型读完就知道该往哪个方向写；
   * 没有它，模型只能用**它自己的默认审美**去写 —— 那就是"AI 味"的来源。
   *
   * `atmosphere` 写的是"这个地方摸上去什么样"（长，具体，给素材）；
   * 本字段写的是"这一局的情绪底色"（短，抽象，定调）。
   * 两者都要，各司其职：`coreMood` 决定往哪走，`atmosphere` 决定踩在什么上。
   *
   * ⚠️ 别写成一串形容词的堆砌（"压抑、沉重、悲凉、肃杀"）——
   * 要写**互相矛盾或互相咬合**的两三样，比如原作那句里
   * "恐惧"和"冰冷的秩序"是拧着的，正因为拧着才有张力。
   */
  coreMood?: string;
  /**
   * @deprecated 旧字段名，仅用于兼容**导入的旧世界包**。
   * 加载/导入时 `normalizeWorldCard()` 会把它搬到 `atmosphere`，之后不再使用。
   */
  opening?: string;
  /**
   * **开局处境槽位**：哪个背景槽位描述"主角此刻大致处在什么场合、什么层级"。
   *
   * ## 这里我改错过两次，两次都是"把主角钉死"
   *
   * 第一版：开场对所有背景都一样，玩家说"选了半天背景，开场一模一样"。
   * 第二版：我让每个选项带一段**完整写死的开场**，并以它为第一幕的**唯一依据**，
   *   还明令"场景已定死，别的背景不许挪动它"。结果玩家说：
   *   「我的自设主角是**刑部正四品**，开局却固定有俩**仓部**上司，这不是很影响代入感吗？」
   *   —— 我用背景槽位**顶掉了玩家自己写的主角设定**。这是本末倒置。
   *
   * ## 现在的规则（优先级从高到低）
   *
   *  1. **主角自设设定**（`PlayerCard`：姓名/性别/年龄/外貌/性格/**自述背景**）——
   *     最高优先级。他写了自己是刑部正四品，第一幕里他就必须是刑部正四品。
   *  2. **开局处境**（本字段指向的槽位）—— **附加参考**：这一场合通常是什么样、
   *     和什么人打交道、会遇到哪类麻烦。**只是素材，不是剧本。**
   *  3. **其余背景槽位** —— 附加参考：来路、立场、志向、随身物。
   *
   * 所以背景槽位的选项**不得预设具体官职、部门、上司与专名**：
   * 写「在朝中当权」而不是「朝中一部的仓部郎中」；
   * 写「帝国行省的军政副手」而不是「副总督」。
   * 玩家自己填的官职才是官职的唯一来源。
   *
   * 值填槽位的 `label`。
   */
  openerSlot?: string;
  /**
   * 逐选项的**开场素材**：`{ 选项id → 文本 }`。
   *
   * ⚠️ 这是**素材**，不是写死的第一幕。每段应当写给 AI 的"这类处境长什么样"：
   * 典型场合、会碰到的人的类型、这一行当特有的麻烦与体面、这个层级的便利与掣肘。
   *
   * **必须避免**：
   *  · 具体官职、具体衙门、具体品级（那是玩家自设背景的事）；
   *  · 「你的上司 / 你的上峰 / 你的同僚」这类**替玩家认亲**的关系；
   *  · 有名字的 NPC 被写成"你的谁"（NPC 在世界卡里只记客观立场）；
   *  · 把时间地点写到"某日某时某间屋"这种分镜级精度 —— 那是 AI 的工作。
   *
   * ⚠️ **已扁平化**（2026-10）：原先按槽位再套一层
   * （`Record<槽位label, Record<选项id, 文本>>`），但只有 `openerSlot`
   * 那一个槽位在用，多出来的一层既没用、又让作者容易写错键。
   * 现在直接 `选项id → 素材`（选项 id 在同世界内本就要求唯一）。
   */
  openingSeeds?: Record<string, string>;
  /** 主线目标，可为空 = 纯沙盒 */
  mainQuest: string;
  /** 是否启用章节卡（原 prologue / chapter_1 那套脚本事件） */
  enableStages: boolean;
  /** 章节卡 */
  stages: StoryEvent[];
  /** 是否启用「选项呈现」模式（关闭后只剩自由输入） */
  enableChoices: boolean;
  /**
   * 防轨道化：连续多少回合未推进关键节点就催促 AI。
   * 0 = 关闭。原版写死为 4/5。
   */
  urgencyAfterTurns: number;
}

/** 世界卡 —— 一个完整的可玩设定 */
export interface WorldCard {
  id: string;
  /** 世界/剧本名 */
  title: string;
  /** 一句话简介 */
  tagline: string;
  /** 封面图：data URL 或 URL */
  cover?: string;

  /** 世界观设定正文 —— 替代原来的硬编码世界设定 */
  worldLore: string;
  /** 额外规则：世界运作法则、禁止事项、称呼规范等 */
  rules: string;

  /** 可自由定义的属性维度（原为写死的八种性相） */
  attributes: AttributeDef[];
  /** 可自由定义的资源条（原为写死的资金/健康/理智） */
  resources: ResourceDef[];
  /** 背景槽位（原为写死的出身/童年/特质） */
  backgrounds: BackgroundSlot[];
  /** 开局点数，用于属性分配 */
  attributePoints: number;

  /** 预置物品与知识模板 */
  items: ItemTemplate[];
  lores: LoreTemplate[];

  /** 剧情设置 */
  story: StorySettings;

  /** 叙事风格 */
  narrative: NarrativeStyle;

  /** 角色卡名册 */
  characters: CharacterCard[];

  /** 是否启用机制层（属性/资源/物品/线索结算） */
  enableMechanics: boolean;

  /**
   * **战斗向世界**：让「篇幅与信息投放」一节改用动作节拍。
   *
   * ## 为什么需要这个开关（2026-10，做《刀口账》时发现）
   *
   * `buildLengthSection()` 里对「过程」那一块的原文是：
   *
   * > 交涉、试探、动手、等待。写**来回**，写**不顺手的地方**，写**对方不配合的地方**。
   *
   * 这在生活流世界（雾都、大晟、汐梦洲）里是完全正确的 —— 摩擦产生真实感。
   * 但在战斗爽世界里它**是毒药**：它会让叙事 AI 每一轮都写成
   * 「你这一刀没砍中，对方退开半步，你重新调整」，而爽感恰恰要求
   * 「动作连着走完一串，写到分出上风为止」。
   *
   * 同一节的「一轮只出一件新事」也会掐断打斗：刚交上手就要停下来问玩家要不要继续。
   *
   * ## 为什么不能只在世界卡的 `rules` 里写例外
   *
   * 我试过。`rules` 注入在提示词**第三位**，而篇幅节在**第九位**。
   * 这个文件（`prompts.ts`）里对「沙盒优先」那一段的注释已经写明：
   * 靠后的段落更容易被模型当成**更近的指令**。
   * 所以 `rules` 里的"战斗例外"会被篇幅节压过去 —— 必须开引擎开关。
   *
   * 不填 = `false`，九张内置世界的行为**一个字都不变**。
   */
  combatPacing?: boolean;

  /**
   * **世界色调**。决定本世界的像素场景背景用哪套 16 色限色板。
   *
   * 注意：它**不影响人物立绘** —— 立绘是 LPC 像素素材，配色由 LPC 自己的
   * 调色板决定（见 lpcSprite.ts）。这个字段原本叫 avatarStyle 并用于几何头像，
   * 但那条渲染路径已退化为"角色卡没自带图片时的极小兜底"，
   * 因此这里保留旧字段名以免破坏已保存的卡片，语义已改为场景色调。
   */
  avatarStyle?: WorldTone;
  /** 场景点缀色；留空则用色调自带色 */
  avatarTone?: string;

  createdAt: number;
  updatedAt: number;
  /** 内置示例卡标记 */
  builtin?: boolean;

  /**
   * **玩家亲手动过这张内置卡** —— 从此它不再自动更新。
   *
   * 由 `library.ts` 的 `updateWorld` 写入时自动打上（不需要编辑器配合）。
   *
   * ## 为什么需要它（2026-11）
   *
   * 内置卡靠内容指纹整批刷新（§4.6j）。那个机制默认「内置卡 = 作者的东西，
   * 玩家不该改」，但玩家确实会在编辑器里调措辞 —— 而下次指纹一变
   * （比如我改了九张卡的篇幅），刷新就把它盖回去了。
   * **他不会知道是自己的改动没了，只会觉得"我明明改过"。**
   *
   * 代价说清楚：这张卡以后停在玩家改的那一版，不再跟官方更新。
   * 想跟更新就 duplicate 一份去改（副本 `builtin === false`，本来就不受影响）。
   */
  editedByUser?: boolean;
}

/** 玩家卡 —— 玩家自己扮演的角色（原 playerName / playerGender / playerAppearance） */
export interface PlayerCard {
  name: string;
  /** 自由文本，不再是 'male' | 'female' | 'other' */
  gender: string;
  age: string;
  appearance: string;
  personality: string;
  background: string;
  /** 其他自定义字段 */
  extra: string;
  /** 头像 */
  avatar?: string;
  /**
   * 立绘的结构化外观（部件级）。
   *
   * ⚠️ 主角的立绘**必须**走这条路：玩家的 `appearance` 是自由文本
   * （「瘦削，眉骨高，惯穿青灰直裰」），拿它去猜部件命中率很低，
   * 而"我自己设的主角画得不像"是最伤代入感的一件事。
   * 选角页给了可视化选择器，产出就是这个字段。
   */
  look?: SpriteLook;
}

/** 一次开局前的完整配置 */
export interface StartConfig {
  worldId: string;
  player: PlayerCard;
  /** 各背景槽位选中的 option id，key 为槽位 label */
  backgroundChoices: Record<string, string>;
  /**
   * 玩家在「我自己写」选项里填的自由文本：`{ 槽位 label → 文本 }`。
   *
   * 只有选中的是 `custom: true` 的选项时才有意义。
   * ⚠️ 它与预设选项走同一条提示词链路，**不是**补充说明、更不是备注 ——
   * 它是这个槽位的全部内容。见 `BackgroundOption.custom` 的说明。
   */
  backgroundCustom?: Record<string, string>;
  /** 玩家分配的属性点 */
  attributeAllocation: Record<string, number>;
  /** 参战/在场的角色卡 id */
  activeCharacterIds: string[];
  /** 开场覆写，留空则用 world.story.opening */
  openingOverride?: string;
}

export interface LLMConfig {
  /** 预设服务商标识，'custom' 表示手填 baseUrl */
  provider: 'deepseek' | 'openai' | 'siliconflow' | 'openrouter' | 'ollama' | 'custom';
  baseUrl: string;
  apiKey: string;
  /** 叙事模型（建议用擅长写作的模型） */
  narrativeModel: string;
  /** 数据结算模型（需要稳定 JSON 输出，可用更便宜/更快的模型） */
  analysisModel: string;
  temperature: number;
  /** 为支持思维链的模型开启，用于渲染「思维链」折叠区 */
  showReasoning: boolean;

  /**
   * **思考模式**（`thinking` 参数，2026-11）。
   *
   * | 值 | 发出去的请求体 | 什么时候用 |
   * |---|---|---|
   * | `'auto'`（默认） | **什么都不发**，由服务商决定 | 绝大多数情况。行为与没有这个字段时完全一致 |
   * | `'on'` | `{"thinking": {"type": "enabled"}}` | 想让模型先想再写（叙事质量稳，但慢、贵） |
   * | `'off'` | `{"thinking": {"type": "disabled"}}` | 只想快、省；或者觉得思维链在拖字数 |
   *
   * ## 为什么默认是 `'auto'` 而不是 `'on'` / `'off'`
   *
   * 发不发这个字段，风险完全不对称：
   *  - `'auto'` 的报文和以前一模一样，**零风险**；
   *  - 主动发出去时，只有认这个字段的端点（DeepSeek 官方那一套）能正确理解，
   *    其余 OpenAI 兼容实现大多会忽略未知字段，但严格的会直接 400。
   *
   * 所以默认不表态，让玩家按需选 —— 选的时候界面会提示这一点。
   *
   * ## 它和 `showReasoning` 不是一回事
   *
   * `showReasoning` 管**要不要把想的过程显示给你看**，不影响模型想不想；
   * 这个管**模型到底想不想**。两个都要看，缺一个就会出现
   * 「关掉了思考，界面上却还在提示你换模型」这种自相矛盾。
   */
  thinking?: 'auto' | 'on' | 'off';

  /**
   * **单次回复的 token 上限**（`max_tokens`）。
   *
   * ## 为什么这个字段是必须的（2026-11，玩家第四次说「字数没变化」）
   *
   * 玩家原话：
   * > 「我实际游玩中一章实际上并没有达到 1200 字的效果，应该强化字数的输出」
   *
   * 查下来，前三轮（§4.6i 改 replyLength、§4.6j 改内置卡刷新、§4.6k 改战斗节拍）
   * 全都在**提示词层面**解决「写多长」，而这一层根本不决定长度 ——
   * **`max_tokens` 才决定**。而在此之前，整个项目**一次都没发过这个参数**
   * （`src/api/llm.ts` 的 buildBody 里没有它）。
   *
   * 于是长度完全由服务商默认值决定：
   *  - DeepSeek 官方默认 4096，够写 1800 汉字；
   *  - 但大量中转站默认 **2048**，中文约 1.5 token/字 —— **2048 / 1.5 ≈ 1365 字**。
   *    这正好是玩家说的「不到 1200 字」。
   *  - 推理模型（`*-reasoner`）更糟：思维链先吃掉几千 token，正文只剩零头。
   *
   * 所以提示词写着「约 1800 字」而实际只出 1300，不是模型不听话，
   * 是它**写到这里就被 API 切断了**。
   *
   * 留空 = 由 `suggestMaxTokens()` 按 `narrative.replyLength` 推算；
   * 只有当服务商单次上限偏低（某些中转封 4096）时才需要手动调。
   */
  maxTokens?: number;
}

export interface CardBundle {
  format: 'pale-notes-bundle';
  version: 1;
  exportedAt: string;
  world?: WorldCard;
  characters?: CharacterCard[];
  player?: PlayerCard;
}

/**
 * 从卡片编辑器直接「保存并开始」时传给开局配置界面的种子。
 *
 * 为什么需要它：编辑器里的卡在点保存之前只存在于组件内存里，卡片库中还查不到。
 * 若这时直接进开局配置、按 id 去库里查，会拿到 undefined 导致界面卡死。
 * 所以把保存后的世界卡对象本身一起传过去，不依赖库里能查到。
 */
export interface SetupSeed {
  world: WorldCard;
  player?: PlayerCard;
  /**
   * 各背景槽位选中的 option id（key 为槽位 label）。
   *
   * 用于"提前设定主角"：预设里存了上次选过的出身/际遇等，
   * 开局时直接覆盖掉默认值，玩家就不必再逐槽重选。
   *
   * ⚠️ 选项 id 是**世界相关**的 —— 换了世界就选不中，
   * 所以 SessionSetup 里必须只认「本世界确实存在的选项」，
   * 对不上的槽位退回默认值（见 SessionSetup 的初始化逻辑）。
   */
  backgroundChoices?: Record<string, string>;
  /**
   * 玩家在「我自己写」背景项里写下的文本（key 为槽位 label）。
   *
   * 与 `backgroundChoices` 一样是**世界相关**的：换世界时槽位对不上就丢弃，
   * 只保留本世界确实存在的槽位（见 SessionSetup 的 `resolveSeed`）。
   */
  backgroundCustom?: Record<string, string>;
  /** 玩家分配好的属性点（skill id → 点数），同样要按本世界的属性表过滤 */
  attributeAllocation?: Record<string, number>;
}

/**
 * 主角预设 —— 「提前设定主角」功能的核心数据结构。
 *
 * 玩家可以把一套主角档案（名字/性别/年龄/外貌/性格/出身/头像）
 * 连同常用的开局选择存下来，下次开新游戏时一键套用，
 * 不必每次重新手填。
 *
 * 与 `PlayerCard` 的关系：预设**内嵌**一张 PlayerCard，
 * 这样套用时直接把它当 pendingSetup.player 用，不需要转换。
 */
export interface HeroPreset {
  id: string;
  /** 预设名（列表里显示，如「我的惯用主角」「沈砚」） */
  label: string;
  /** 主角档案本体 */
  player: PlayerCard;
  /**
   * 记住的开局选择。分两层：
   *  · `default` —— 不分世界，任何世界都先套这一份
   *  · `byWorld` —— 按世界 id 覆盖，用来记住"在这个世界我选了哪个出身"
   *
   * 为什么分两层：背景选项 id 是每个世界自己定义的，
   * 一套"通用"选择只能对同世界可靠；分世界存才能既通用又不串味。
   */
  choices?: {
    default?: {
      backgroundChoices?: Record<string, string>;
      /**
       * 玩家在「我自己写」项里写下的文本。**要一起存** ——
       * 否则他辛苦写的一段设定存进预设、下次套用时却不见了，
       * 而这恰恰是他最不愿意重打的东西。
       */
      backgroundCustom?: Record<string, string>;
      attributeAllocation?: Record<string, number>;
    };
    byWorld?: Record<string, {
      backgroundChoices?: Record<string, string>;
      backgroundCustom?: Record<string, string>;
      attributeAllocation?: Record<string, number>;
    }>;
  };
  createdAt: number;
  updatedAt: number;
}

/**
 * 叙事预设 —— 一份可**随时切换**的「怎么写」设定。
 *
 * ## 为什么它不该是一张世界卡
 *
 * 2026-11 第二十九轮，玩家丢进来 `夏瑾 天琴座 Beta 3.9.json`（给 DeepSeek 的
 * SillyTavern 写作预设）并说：「或许可以像世界书或卡片库一样，存储预设并可切换」。
 *
 * 上一版把这类文件转成**世界卡**，问题立刻出来：
 *
 *  1. 它出现在「开始新游戏」的卡片墙里 —— 点进去开一局，世界是空的
 *     （没有地点、没有人物），玩家以为导入坏了；
 *  2. 世界卡是**一局一个**，而预设是**玩家口味**：他换世界还想用同一套文风，
 *     换一次世界就得重新找出来、复制两段文字过去；
 *  3. 想换另一套文风，只能把所有世界卡逐张改一遍。
 *
 * 所以它单独成一类：存在卡片库旁边，全局**同时只启用一份**，
 * 每次构建叙事提示词时叠加到当前世界上 —— 与具体世界无关，也不必重开一局。
 *
 * ## 三段各去哪
 *
 * | 字段 | 注入位置 | 预算 |
 * |---|---|---|
 * | `rules` | `world.rules` 之后（`## 世界规则与硬性约束` 一节内） | 每轮全量，必须短 |
 * | `style` | `narrative.customStyle` 之后（`额外文风要求`） | 每轮全量，必须短 |
 * | `lore`  | **不注入**，只存档给玩家查阅 | — |
 */
export interface NarrativePreset {
  id: string;
  /** 列表里显示的名字，默认取原文件名 */
  name: string;
  /** 原文件名，用来在多人分享时说明出处 */
  source: string;
  /** 规则 / 禁令 / 输出格式 —— 每轮注入 */
  rules: string;
  /** 文风 / 笔法 / 人称 —— 每轮注入 */
  style: string;
  /**
   * 其余条目（作者说明、越狱串、实验性玩法）。
   * **不注入**：它们要么是给人看的，要么会顶掉本作的叙事者身份。
   * 留着是为了「内容一个字不丢」，玩家想用手动复制。
   */
  lore: string;
  /** 转换时的条目统计（UI 上如实显示，别让玩家以为 144 条全进去了） */
  counts: {
    /** 作者当前方案里启用的条目总数 */
    total: number;
    rules: number;
    style: number;
    other: number;
    /** 因为超出篇幅预算没并入的条目名 */
    dropped: string[];
  };
  createdAt: number;
  updatedAt: number;
}
