# 新世界卡施工规格（灯叙 / pale-notes-web）

你要为一个新世界写一张**世界卡**：`src/data/worlds/<id>.ts`。
它必须通过 `node scripts/check-worlds.mjs` 的**全部硬门槛**（脚本会逐条报错，照着修到 0 错误）。

---

## 一、文件骨架（照抄，不要改结构）

```ts
/**
 * 《XXX》世界卡
 *
 * 素材来源：D:\艺创区\素材库\...（用户本人的文字设定稿）
 */
import type { WorldCard } from '@/types/cards'
import { char, BUILTIN_TIMESTAMP } from './_shared'

export const <变量名>: WorldCard = {
  id: 'builtin_<短名>',
  title: '《……》',
  tagline: '一句话，40~70 字，要写出这个世界的核心矛盾与"你能怎么活"',
  worldLore: `…（≥30000 汉字）…`,
  rules: `…（≥3000 汉字）…`,
  attributes: [ /* 5~6 个 */ ],
  resources: [ /* 3~4 个 */ ],
  backgrounds: [ /* 3~5 个槽位，每槽 ≥8 个选项 */ ],
  attributePoints: 6,
  items: [ /* ≥15 个 */ ],
  lores: [ /* ≥8 个 */ ],
  story: { /* 见下 */ },
  narrative: { /* 见下 */ },
  characters: [ /* ≥8 张，用 char({...}) */ ],
  enableMechanics: true,
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
  builtin: true,
}
```

---

## 二、类型契约（字段名一个都不能错）

```ts
// 属性
{ id: 'wu', name: '武艺', description: '……（40~80 字，写清它管什么）', color: '#8b1a1a' }

// 资源
{ id: 'health', name: '体魄', description: '……', color: '#8b1a1a',
  initial: 6, max: 10, critical: true }   // max 省略 = 无上限；critical = 归零是结局信号

// 背景槽位
{ label: '来路', options: [
  { id: 'road_hanmen', title: '寒门科举', description: '……（20~90 汉字，超 90 会被警告）',
    attributeBonus: { li: 2, ming: 1 },      // key 必须是 attributes 里真实存在的 id
    resourceBonus: { rank: 1, qing: 2 },     // key 必须是 resources 里真实存在的 id
    startingItems: ['item_x', 'item_y'] }    // 必须是 items 里真实存在的 id
]}

// 物品
{ id: 'item_x', name: '出身文书', description: '……', tags: ['文书'] }

// 知识
{ id: 'lore_x', name: '旧管新收', description: '……', attribute: 'li', level: 1 }
//                                          ↑ 必须是真实属性 id，或整条省略

// 角色（用 char() 补全 10 个必填默认值）
char({
  id: 'char_xxx', name: '某某',
  description: '…（≥80 汉字，**必须能看出性别**：正文里出现"男/女"或"少女/男子/妇人/老者/夫人/老爷"等词）…',
  personality: '……',
  relationship: '……',      // 客观立场，**绝不能写成"你的上司/同僚"**
  location: '……',          // 可选
  status: '……',            // 可选
  present: true,            // 至少 3 张为 true
  tags: ['朝堂'],
})

// story
story: {
  openerSlot: '<某个槽位的 label，必须真实存在>',
  openingSeeds: {           // key = openerSlot 里每个选项的 id，**一个都不能漏**
    kai_x: `……（≥120 汉字）……`,
  },
  atmosphere: `……（≥60 汉字：这个世界的时辰、地标、物价与规矩）……`,
  mainQuest: `……（≥700 汉字，写成"若干宽泛的可选方向"，不是任务书）……`,
  enableStages: false,
  stages: [],
  enableChoices: true,
  urgencyAfterTurns: 5,
},

// narrative
narrative: {
  pov: 'second',            // 'second' | 'first' | 'third'
  tense: 'present',         // 'present' | 'past'
  replyLength: 800,
  customStyle: `……（≥500 汉字：文风总纲 + 必须做到的事 + 禁止事项）……`,
},
```

---

## 三、硬门槛清单（`scripts/check-worlds.mjs` 逐条检查）

| 项 | 门槛 |
|---|---|
| 全卡中文字数 | **≥ 50000** |
| `worldLore` 中文字数 | **≥ 30000** |
| `rules` 中文字数 | **≥ 3000** |
| `narrative.customStyle` | **≥ 500** |
| `story.atmosphere` | ≥ 60（配了 openerSlot 时门槛放宽） |
| `story.mainQuest` | **≥ 700**，且不得出现「必须完成」「任务书」「硬期限」「N天内」「N天之内」 |
| 地理类章节正文 | **≥ 3000** |
| 势力类章节正文 | **≥ 3000** |
| 生活类章节正文 | **≥ 3000** |
| rules 的沙盒条款 | 必须有**一条**（按 `1.` `2.` 编号切分）同时含「沙盒/不是任务/可选」与「不要催/没有必须/不必/不要强行/自由」，且 **≥ 300 字** |
| `attributes` / `resources` | 非空 |
| `characters` | **≥ 8** 张，`description` 各 **≥ 80** 汉字且**含性别线索**；`present: true` **≥ 3** 张；id 不重复 |
| `items` | **≥ 15** |
| `lores` | **≥ 8** |
| `backgrounds` | **3 ~ 5** 个槽位（超 5 = 必须合并） |
| 每个槽位选项数 | **≥ 8** |
| 每个选项 description | **20 ~ 90** 汉字 |
| 槽位 label | 不得重复；选项 id 全卡不得重复 |
| `story.openerSlot` | 必须存在，且指向真实槽位 |
| `openingSeeds` | 覆盖该槽位**全部**选项，每条 **≥ 120** 汉字 |
| 素材相似度 | 任意两条的二元组 Jaccard **< 0.72**（不能"同一段换几个词"） |
| 认亲禁语 | 素材与全部背景选项描述里不得出现：`你的上司` `你的上峰` `你的上官` `你的同僚` `你的顶头上司` `你的直属` |
| 引用完整性 | `startingItems` → 真实 item id；`attributeBonus`/`resourceBonus` → 真实属性/资源 id；`lores[].attribute` → 真实属性 id（**这类错不报错、只静默失效，所以脚本专门查**） |

### `worldLore` 的章节标题格式（**极其重要**）

地理 / 势力 / 生活三类内容**按标题统计字数**，规则是：

- 只有**行首独占一行**的 `**第X章 标题**` 才算章节标题（例：`**第三章 舆图与行旅**`）；正文里的行内 `**加粗**` 不算标题。
- 标题命中下面词表才算对应类别：

| 类别 | 标题命中词（任一即可） | 下限 |
|---|---|---|
| 地理 | 舆图 / 地图 / 地理 / 疆域 / 行旅 / 层志 / 区域 / 方位 / 交通 / 航线 / 路线 / 坊市 / 城内 / 商路 / 海图 / 铁轨 / 铁路 / 地方 / 城市 / 山脉 / 河流 / 港口 / 海域 / 平原 / 草原 / 沙漠 | ≥3000 |
| 势力 | 势力 / 派系 / 党争 / 阵营 / 家族 / 行会 / 地盘 / 藩镇 / 部族 / 范围 / 冲突 / 权力 / 阶层 / 主义 / 政体 / 信仰 / 教会 / 结社 / 宗族 / 军队 / 朝廷 / 议会 / 商会 / 同盟 / 联盟 / 组织 / 集团 / 统治 / 官署 / 衙门 / 世家 / 门派 | ≥3000 |
| 生活 | 日常 / 生活 / 物价 / 饮食 / 市井 / 民生 / 作息 / 婚 / 娱乐 / 闲暇 / 风俗 / 语言 / 称谓 / 活法 / 一天 / 一日 / 行当 / 谋生 / 价钱 / 穿 / 丧 / 礼节 / 忌讳 / 谚语 / 怎么活 / 过日子 / 开销 / 收入 / 贫穷 / 教育 / 医疗 / 病 / 食 / 吃喝 / 住 / 婚嫁 / 节庆 / 节日 / 集市 | ≥3000 |

**建议**：直接给 `worldLore` 写**至少 10 个章节**，其中地名用「舆图与行旅 / 域内形胜」、
势力用「势力与派系 / 权力格局」、生活用「市井与物价 / 日常与活法」这类明确命中的标题，
每章正文写足 800~3000 字。

### 禁用词（只扫 `worldLore`）

- 扫描时会**剔除"禁令行"**（同一行含「不得出现/绝对禁止/不要出现/禁止出现/禁用/不得引入/不得使用/不得有」）——
  所以你在 rules 里列禁词是安全的，但**不要在 worldLore 正文里用到它们**。
- 也会放过**否定语境**（命中处前后 40 字内有「没有/无/不存在/尚无/未出现/缺乏/买不到/不许/不能」）——
  所以写「这个世界没有魔法」是安全的。
- 每个世界的具体禁词表见下面「各世界专属」一节。

---

## 四、写作要求（内容质量）

1. **世界书要写成"等待探索的沙盒"**，不是任务关卡：
   - `rules` 里必须有独立的沙盒条款（见门槛），写明「没有必须完成的主线 / 不要催 / 世界自己动 / 允许玩家只当普通人」。
   - `mainQuest` 写成"这世界里有人在这么活"的若干**宽泛方向**（每个方向内部容得下好人坏人），
     结尾明确写"这些不是任务，可以一个都不碰"。
2. **背景槽位是"方向"，不是履历**：每个选项 description 控制在 20~90 汉字，
   写"这一类人怎么活、会什么、被人怎么看"，**不要**写成具体官职、具体衙门、具体上司。
3. **`openingSeeds` 是素材，不是写死的第一幕**：每条素材写"这类处境长什么样"——
   典型场合、会碰到的人的类型、这一行当特有的麻烦与体面、这个层级的便利与掣肘。
   **不得**出现具体人名被写成"你的谁"，**不得**出现「你的上司/上峰/同僚/上官」。
   每条要**彼此明显不同**（换一个选项就是换一个世界）。
4. **角色卡写"客观立场"**：他是某个衙门/结社/商号的人，不是"主角的谁"。
   `relationship` 字段写他的位置与立场，不要写"主角的朋友"。
5. **文风要与原素材一致**：调性、用词、句式尽量贴着素材走；
   `customStyle` 里写清"必须做到的事"与"禁止事项"。
6. **专名一律用素材里的真名**，不要自己发明与素材冲突的概念。

---

## 五、验收命令

```powershell
$node='C:\Users\28254\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
cd D:\工作区\pale-notes-web
& $node node_modules\typescript\bin\tsc --noEmit          # 类型必须 0 错误
& $node scripts\check-worlds.mjs                          # 你的世界必须 0 问题
```

`check-worlds.mjs` 输出的格式：

```
  ✓ 世界名                     中文字数   worldLore   rules 角色 物品 lore
  ✗ ...
  —— 沙盒内容 ...
  ✗ 问题清单 ...
```

**必须让你的世界那一行是 ✓，且问题清单里没有你的世界。**

> ⚠️ 脚本会打包 `src/data/builtinWorlds.ts`。你的世界卡必须已经在那里面 import 并加进 `BUILTIN_WORLDS` 数组，
> 否则脚本根本看不到它（这一点由主会话负责，你只要确认它已经在了）。

---

## 六、写作节奏建议（避免一次输出过长被截断）

分块写，每块之后跑一次 `tsc`：

1. 先写文件骨架 + 元数据 + `attributes` / `resources`
2. `worldLore` 分 **3~4 次**追加（每次 2~3 章，用 `edit` 在末尾追加）
3. `rules` + `narrative`
4. `backgrounds` + `openingSeeds`（这段最容易超长，分 2 次）
5. `items` + `lores`
6. `characters` 分 **2~3 次**追加
7. 跑 `check-worlds.mjs`，按报错逐条修

**不要**试图一次性输出整个文件——一定会被截断，而且截断后修起来更慢。
