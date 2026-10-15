/**
 * **AI 角色的结构化外观** —— 把"AI 现场创造的 NPC"从中文自由文本
 * 拉进部件级可控的轨道。
 *
 * ## 为什么需要这一层（2026-10，玩家第三次打回）
 *
 * 玩家原话：
 * > 「**局内 NPC 立绘与描述的匹配度仍然非常需要优化**」
 *
 * 查下来问题是**分层的**，前两层上一轮已经解决，剩下的是第三层：
 *
 *  1. ✅ 内置的 110 张角色卡都写了 `look`（部件级显式外观）→ 画得准。
 *  2. ✅ `SessionSetup` 把 `card.look` 透传进 store（原先漏了这一行，
 *     47 张卡白写）→ 已修。
 *  3. ❌ **AI 在游戏里现场创造的 NPC 一个 `look` 都没有** —— 它们只有
 *     `description` 一段自由文本，于是走 `inferTraits()` 的 291 条中文正则去猜。
 *
 * 第 3 层才是"局内 NPC"这个说法的真正所指：玩家在游戏里遇到的
 * 茶摊老板、巡警、码头工人，**全是 AI 当场造的**。
 * `scripts/checks/npc-fidelity.mjs` 的对照图把它的错误率摊在了明处：
 * 描述写"银叶王庭出身的男性精灵、浅金色长发"，画出来是金色卷发配皮甲；
 * 描述写"黑色燕尾服、乌黑长发"，画出来是白头发的老脸。
 *
 * ## 为什么不是"再加几百条正则"
 *
 * 因为**中文描述的表述空间是无穷的**，而正则表是有限的 —— 词表永远追不上。
 * 而且退一步说：即使抽对了"深青色长袍"，**从 67 件衣服里挑哪一件**仍然是猜的
 * （这句话是 `cards.ts` 里上一轮我自己写下的结论，现在轮到 NPC 来验证它）。
 *
 * ## 所以做法是换掉数据来源
 *
 * 让数据 AI 在 `ADD_CHARACTER` 时顺手输出一个**受限枚举**的 `appearance` 对象 ——
 * 它不是自由文本，每个字段只能取清单里的值。于是：
 *
 *  · AI 的出错面从「291 条正则 × 246 个部件」缩小到「11 个字段 × 各 6~26 个固定值」；
 *  · 无效值**静默丢弃**，退回上一轮的推断兜底 —— 也就是「改了只会更好，不会更差」；
 *  · 值域与 LPC 部件是**一一对应**的（本文件就是那张对照表）。
 *
 * ## 最关键的一条指令
 *
 * 提示词里要求 AI **只填它在 `description` 里确实写到的项**，
 * 没写的一律省略。这一条比清单本身更重要：
 * 它保证了「画出来的」与「写出来的」**同源** —— 匹配度问题的根源正是这两者脱节。
 * 见 `aiLookCatalogPrompt()`。
 */

import paletteData from '@/assets/lpc/palettes.json'
import type { SpriteLook } from '@/types/cards'

const PALETTES = paletteData.palettes as Record<string, Record<string, string[]>>

/* ══════════════════════════════════════════════════════════════════════════
   一、语义键 → LPC 部件
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ **只用 `recolors` 不为 `null` 的部件**。
 *
 * `recolors: null` 意味着这件衣服的颜色**画死在贴图里**，`clothColor` 对它无效。
 * 例如 `torso_clothes_robe` 永远是棕色、`torso_jacket_*` 永远是深色、
 * `hair_long_tied` 与 `hair_pigtails` 永远是橙色。
 *
 * 这带来一个明确的取舍：**当"形制"与"颜色"不能兼得时，保颜色**。
 * 理由是颜色错（"乌黑长发"画成橙色）在视觉上远比形制近似更刺眼 ——
 * 玩家反馈里被点名的也正是这一类（"银叶精灵"银发画成金发）。
 *
 * 例外的只有那些**本来就没有可换色版本**的形制：围裙、燕尾服、长袍、和服、甲胄。
 * 它们的固有色恰好是合理的（围裙就该是那个颜色），所以直接用。
 */
const HAIR: Record<string, string[]> = {
  bald: [''],
  balding: ['hair_balding'],
  shaved: ['hair_buzzcut', 'hair_high_and_tight'],
  short: ['hair_relm_short', 'hair_natural', 'hair_flat_top_fade'],
  cropped: ['hair_flat_top_straight', 'hair_shorthawk'],
  parted: ['hair_parted', 'hair_parted2', 'hair_page'],
  swept: ['hair_swoop', 'hair_swoop_side', 'hair_curtains'],
  curly: ['hair_curly_short2', 'hair_curls_large', 'hair_curly_long'],
  wavy: ['hair_wavy', 'hair_loose'],
  long: ['hair_long', 'hair_long_straight', 'hair_long_center_part'],
  half_up: ['hair_half_up', 'hair_halfmessy'],
  braid: ['hair_braid'],
  ponytail: ['hair_ponytail2', 'hair_high_ponytail'],
  // 没有可换色的"发髻"部件，用齐肩发近似（保颜色）
  bun: ['hair_shoulderl', 'hair_shoulderr'],
  topknot: ['hair_topknot_long', 'hair_topknot_short', 'hair_topknot_long2', 'hair_topknot_short2'],
  afro: ['hair_afro', 'hair_natural'],
  dread: ['hair_dreadlocks_long', 'hair_dreadlocks_short', 'hair_twists_fade', 'hair_twists_straight'],
  mohawk: ['hair_spiked', 'hair_spiked_liberty', 'hair_spiked_liberty2'],
  bob: ['hair_bob', 'hair_page2'],
  pixie: ['hair_pixie'],
  messy: ['hair_messy1', 'hair_messy2', 'hair_long_messy', 'hair_long_messy2', 'hair_bedhead', 'hair_mop'],
  bangs: ['hair_bangs', 'hair_bangsshort', 'hair_bangslong', 'hair_cowlick'],
  idol: ['hair_idol'],
}

const CLOTH: Record<string, string[]> = {
  plain: ['torso_clothes_tshirt', 'torso_clothes_shortsleeve', 'torso_clothes_tshirt_scoop'],
  shirt: ['torso_clothes_longsleeve2_buttoned', 'torso_clothes_longsleeve2_polo', 'torso_clothes_tshirt_buttoned'],
  tunic: ['torso_clothes_longsleeve2', 'torso_clothes_longsleeve', 'torso_clothes_longsleeves2'],
  cardigan: ['torso_clothes_longsleeve2_cardigan', 'torso_clothes_shortsleeve_cardigan', 'torso_clothes_sleeveless2_cardigan'],
  sleeveless: ['torso_clothes_sleeveless1', 'torso_clothes_sleeveless2_polo', 'torso_clothes_sleeveless2_vneck'],
  peasant: ['torso_clothes_longsleeves_cuffed', 'torso_clothes_longsleeves2', 'torso_clothes_shortsleeve'],
  formal: ['torso_clothes_longsleeve2_buttoned', 'torso_clothes_longsleeve2_polo', 'torso_clothes_longsleeve2_scoop'],
  // ↓ 以下几类没有可换色版本，颜色由贴图固定 —— 但它们的固有色本来就在理
  robe: ['torso_clothes_robe'],
  apron: ['torso_aprons_apron', 'torso_aprons_apron_half', 'torso_aprons_apron_full'],
  overalls: ['torso_aprons_overalls'],
  jacket: ['torso_jacket_collared', 'torso_jacket_pockets', 'torso_jacket_frock'],
  vest: ['torso_jacket_iverness', 'torso_jacket_tabard'],
  armour: ['torso_armour_leather'],
  plate: ['torso_armour_plate'],
  legion: ['torso_armour_legion'],
  kimono: ['dress_kimono', 'dress_kimono_longsleeve', 'dress_kimono_oversize', 'dress_kimono_split'],
  bare: [''],
}

/**
 * 这三类是「**颜色写在部件 id 里**」的连衣裙系 —— 每色一个独立贴图，
 * 所以不能靠 `clothColor` 换色，只能按颜色**选 id**。见 `pickDressByColor`。
 */
const DRESS_PREFIX: Record<string, string> = {
  dress: 'dress_bodice_',
  sash: 'dress_sash_',
  slit: 'dress_slit_',
}
/** 连衣裙可用的颜色（与 `dress_bodice_*` 的文件名一一对应） */
const DRESS_COLORS = ['black', 'blue', 'brown', 'gray', 'green', 'navy', 'pink', 'purple', 'red', 'white']

const LEGS_POOL = ['legs_pants', 'legs_pants2', 'legs_formal', 'legs_leggings', 'legs_widepants', 'legs_cuffed']
const LEGS_SKIRT = ['legs_skirt_straight', 'legs_skirts_plain', 'legs_skirt_belle', 'legs_skirts_slit']

const HAT: Record<string, string[]> = {
  hood: ['hat_hood_cloth', 'hat_hood_hijab'],
  bandana: ['hat_bandana', 'hat_headband_tied', 'hat_headband_thick'],
  cap: ['hat_cap_leather', 'hat_cap_bonnie', 'hat_cap_leather_feather'],
  helm: ['hat_helmet_nasal', 'hat_helmet_morion', 'hat_helmet_legion', 'hat_helmet_barbuta_simple', 'hat_helmet_spangenhelm_viking'],
  greathelm: ['hat_helmet_greathelm', 'hat_helmet_sugarloaf', 'hat_helmet_barbuta'],
  crown: ['hat_formal_crown'],
  circlet: ['hat_headband_hairtie_rune', 'hat_magic_celestial'],
  horns: ['hat_accessory_horns_upward'],
  wings: ['hat_accessory_wings'],
  crest: ['hat_accessory_crest'],
  visor: ['hat_visor_round_raised', 'hat_visor_horned'],
  none: [''],
}

const BEARD: Record<string, string[]> = {
  stubble: ['beards_5oclock_shadow', 'beards_trimmed'],
  mustache: ['beards_mustache', 'beards_chevron', 'beards_handlebar', 'beards_horseshoe', 'beards_bigstache'],
  goatee: ['beards_french', 'beards_medium'],
  full: ['beards_beard', 'beards_medium'],
  long: ['beards_beard', 'beards_winter', 'beards_lampshade'],
  none: [''],
}

const CAPE: Record<string, string[]> = {
  plain: ['cape_solid', 'cape_trim'],
  tattered: ['cape_tattered'],
}

/** 头部件由「性别 + 年龄 + 体型」三者共同决定 —— 这是立绘观感里最要紧的一项 */
function pickHead(sex: string, age: string, build: string): string {
  if (age === 'child') return sex === 'female' ? 'heads_human_female_small' : 'heads_human_male_small'
  if (age === 'elder') return sex === 'female' ? 'heads_human_female_elderly' : 'heads_human_male_elderly'
  if (sex === 'female') return 'heads_human_female'
  if (build === 'slim') return 'heads_human_male_gaunt'
  if (build === 'heavy') return 'heads_human_male_plump'
  return 'heads_human_male'
}

/* ══════════════════════════════════════════════════════════════════════════
   二、稳定随机（同一个语义键要落到固定的那一个部件上）
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 一个语义键往往对应好几个部件（"short" 有 3 个短发部件）。
 * 这里按**角色 id** 决定挑哪一个：同一个角色每次渲染拿到的都是同一件，
 * 而不同的角色会分散到不同部件上 —— 免得一屋子 NPC 全是一个发型。
 */
function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function pickStable(pool: string[], seed: string, salt: string): string {
  if (!pool.length) return ''
  if (pool.length === 1) return pool[0]
  return pool[hashSeed(`${seed}::${salt}`) % pool.length]
}

/* ══════════════════════════════════════════════════════════════════════════
   三、解析
   ══════════════════════════════════════════════════════════════════════════ */

/** AI 输出的外观对象（每个字段都只能是清单里的值，非法值会被丢掉） */
export interface AiLookSpec {
  sex?: string
  age?: string
  build?: string
  hair?: string
  hairColor?: string
  skin?: string
  cloth?: string
  clothColor?: string
  legs?: string
  hat?: string
  beard?: string
  cape?: string
  eye?: string
}

/** 该色键是否真的存在于对应的调色板里（不存在就当 AI 没说，退回推断） */
function colorOk(material: string, key: string): string | undefined {
  if (!key) return undefined
  return PALETTES[material]?.[key] ? key : undefined
}

/**
 * 把 AI 给的语义外观解析成**部件级 `SpriteLook`**。
 *
 * ⚠️ 返回的 `SpriteLook` **只包含它确认过的字段**。
 * 没给、或给了非法值的字段一律留空 —— `recipeFor` 对留空字段会退回
 * `inferTraits()` 的推断。于是这一层的作用是「**在推断之上叠加确定性**」，
 * 而不是「一旦 AI 输出就走另一条路」。这个性质保证了它不会把结果改坏。
 *
 * @param spec AI 输出的原始对象（`unknown`：它可能给任何东西，包括字符串和 null）
 * @param seed 角色 id —— 决定同一语义键落到哪个具体部件
 */
export function resolveAiLook(spec: unknown, seed: string): SpriteLook | undefined {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return undefined
  const raw = spec as Record<string, unknown>
  const s = (k: string): string => (typeof raw[k] === 'string' ? (raw[k] as string).trim().toLowerCase() : '')

  const look: SpriteLook = {}
  let filled = 0
  const put = <K extends keyof SpriteLook>(k: K, v: SpriteLook[K] | undefined) => {
    if (v === undefined) return
    look[k] = v
    filled++
  }

  // —— 性别 / 年龄 / 体型 → 头部件 ——
  // 这一项优先级最高：历史 bug「男性 NPC 拿到女性的脸」就是它出错造成的。
  const sexRaw = s('sex')
  const sex = sexRaw === 'female' || sexRaw === 'f' || sexRaw === '女' ? 'female'
    : sexRaw === 'male' || sexRaw === 'm' || sexRaw === '男' ? 'male'
      : ''
  const ageRaw = s('age')
  const age = ['child', 'youth', 'adult', 'elder'].includes(ageRaw) ? ageRaw : ''
  const buildRaw = s('build')
  const build = ['slim', 'ordinary', 'heavy'].includes(buildRaw) ? buildRaw : ''
  /*
    只在 AI **真的写了性别**时才锁定头部件。
    它没写的时候不要默认成 male —— 那会把描述里明明写着的"妇人"压成男人。
    这种时候留空，交给 inferTraits 从中文里读。
  */
  if (sex) put('head', pickHead(sex, age, build))

  // —— 头发 ——
  const hairKey = s('hair')
  if (hairKey && HAIR[hairKey]) put('hair', pickStable(HAIR[hairKey], seed, 'hair'))
  put('hairColor', colorOk('hair', s('hairColor')))

  // —— 肤色（兽人用 fur_*，普通人用前八个） ——
  put('skin', colorOk('body', s('skin')))

  // —— 上装 ——
  const clothKey = s('cloth')
  const clothColor = s('clothColor')
  if (clothKey && DRESS_PREFIX[clothKey]) {
    // 连衣裙系：颜色写在 id 里，必须按色选件
    const want = DRESS_COLORS.includes(clothColor) ? clothColor : pickStable(DRESS_COLORS, seed, 'dresscolor')
    put('torso', `${DRESS_PREFIX[clothKey]}${want}`)
  } else if (clothKey && CLOTH[clothKey]) {
    put('torso', pickStable(CLOTH[clothKey], seed, 'cloth'))
    put('clothColor', colorOk('cloth', clothColor))
  } else {
    put('clothColor', colorOk('cloth', clothColor))
  }

  /*
    ── 下装 ──

    ⚠️ **只在 AI 明确登记了 `legs` 时才写这个字段。**

    这里原先有一段"给了上衣就顺手补一条裤子"的兜底，实测**是个 bug**：
    "穿深蓝色制服短裙的女学生"那张，AI 登记了上衣没登记下装，
    补上去的 `legs_pants` 直接把 `inferTraits` 已经读到的"短裙"顶掉了 ——
    左右对照图里看得很清楚，右边从裙子变成了长裤，比改之前还差。

    教训与这个文件开头写的是同一件事：**这一层的职责是"在推断之上叠加确定性"，
    不是"替推断做决定"。** 中文描述里"穿长裙""扎着裤脚"这类信息，
    `inferTraits` 读得到，比这里按性别猜准得多。
  */
  const legsKey = s('legs')
  if (legsKey === 'none') {
    put('legs', '')                                        // 明确不要下装
  } else if (legsKey === 'skirt') {
    put('legs', pickStable(LEGS_SKIRT, seed, 'skirt'))      // 明确要裙装
  } else if (legsKey) {
    const id = `legs_${legsKey}`
    if (LEGS_POOL.includes(id) || LEGS_SKIRT.includes(id)) put('legs', id)
  }
  // 其余情况留空，交给 recipeFor：它会按 inferTraits 的裙装判断取裙或取裤。

  /*
    ── 鞋 ──

    这里**不填**。原先有一句无条件的 `put('feet', ...)`，看着无害，其实有两个毛病：

      1. 它违背这个文件的核心约定 ——「只填 AI 确实写到的项」。鞋几乎不会写进
         角色描写里，AI 也从没登记过它（清单里就没有 `feet` 这个键）。
      2. 它会让**所有** AI 造的 NPC 穿同一双鞋 —— 因为池子固定、种子只按角色 id 分，
         而鞋本来该由 `recipeFor` 按年龄/身份去挑（它还知道 `feet_plate_toe` 配甲胄）。

    少填一个字段，就是让下游那套已经调好的逻辑多管一件事。删掉。
  */

  // —— 帽子 / 胡子 / 披风 ——
  const hatKey = s('hat')
  if (hatKey && HAT[hatKey]) put('hat', pickStable(HAT[hatKey], seed, 'hat'))
  const beardKey = s('beard')
  if (beardKey && BEARD[beardKey]) put('beard', pickStable(BEARD[beardKey], seed, 'beard'))
  const capeKey = s('cape')
  if (capeKey && CAPE[capeKey]) put('cape', pickStable(CAPE[capeKey], seed, 'cape'))

  // —— 瞳色 ——
  put('eye', colorOk('eye', s('eye')))

  return filled ? look : undefined
}

/* ══════════════════════════════════════════════════════════════════════════
   四、给 AI 的清单
   ══════════════════════════════════════════════════════════════════════════ */

/** 只列调色板里真实存在的键，避免提示词与数据漂移 */
function colorKeys(material: string): string {
  return Object.keys(PALETTES[material] || {}).join('|')
}

/**
 * 外观清单文本，插进数据 AI 的 system prompt。
 *
 * ⚠️ 最后那条「**只填你在描述里确实写到的项**」是整个方案的支点，不能删：
 * 立绘与描述不匹配的**根源**就是这两者各写各的 ——
 * 描述由叙事 AI 随手写，立绘由正则表另外猜一遍。
 * 要求 AI 在写描述的同时登记外观，等于让两者出自同一个决定。
 */
export function aiLookCatalogPrompt(): string {
  return `sex      male|female                     ← **尽量填**：从你对这个人的描写判断
age      child|youth|adult|elder            ← child≈14 以下，youth≈15-22，elder≈60 以上
build    slim|ordinary|heavy
hair     ${Object.keys(HAIR).join('|')}
hairColor  ${colorKeys('hair')}
skin     ${colorKeys('body')}
cloth    ${Object.keys(CLOTH).join('|')}|${Object.keys(DRESS_PREFIX).join('|')}
clothColor  ${colorKeys('cloth')}   （dress/sash/slit 只认 ${DRESS_COLORS.join('|')}）
legs     pants|pants2|formal|leggings|widepants|cuffed|skirt|none
hat      ${Object.keys(HAT).join('|')}
beard    ${Object.keys(BEARD).join('|')}
cape     ${Object.keys(CAPE).join('|')}
eye      ${colorKeys('eye')}`
}

/** 领口等部位的信息性说明，供 README / 校验脚本引用 */
export const LOOK_SPEC_META = {
  hairKeys: Object.keys(HAIR),
  clothKeys: Object.keys(CLOTH),
  dressKeys: Object.keys(DRESS_PREFIX),
  hatKeys: Object.keys(HAT),
  beardKeys: Object.keys(BEARD),
  capeKeys: Object.keys(CAPE),
  dressColors: DRESS_COLORS,
  colorPalettes: {
    hair: colorKeys('hair'),
    body: colorKeys('body'),
    cloth: colorKeys('cloth'),
    eye: colorKeys('eye'),
  },
}
