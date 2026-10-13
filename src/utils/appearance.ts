/**
 * 从角色描述里推断外貌特征，用于挑选像素立绘的部件与配色。
 *
 * 为什么需要这个：
 *  原先 `recipeFor()` **只看 `gender` 一个字段**，其余部件与颜色全靠随机数 ——
 *  于是「黑发束成马尾、戴单片眼镜」的管家和「红发守卫队长」抽到的立绘
 *  与描述毫无关系，而且所有人长得都差不多。这就是"匹配度不足"的根因。
 *
 * 这里把角色卡里能拿到的所有文本（描述、性格、身份、名字）合并后做关键词匹配，
 * 提取出发型 / 发色 / 衣着 / 年龄 / 体型 / 配饰等特征，交给 `recipeFor()` 使用。
 *
 * 设计原则：
 *  1. **只做有把握的推断**。命中不了就返回 undefined，让 recipeFor 回退到随机 ——
 *     乱猜比随机更糟，那会让"匹配"变成"错误的确定性"。
 *  2. 中文与英文都认（角色卡可能来自 SillyTavern）。
 *  3. 优先级：明确写出的 > 从身份推断的。
 */

import type { Material } from '@/utils/lpcSprite'

/** 从文本推断出的外貌特征 */
export interface AppearanceTraits {
  /** 发色（对应 LPC hair 调色板名） */
  hairColor?: string
  /** 发型关键词（用于在部件 id 里模糊匹配） */
  hairStyle?: string[]
  /** 肤色（LPC body 调色板名） */
  skin?: string
  /** 衣色（LPC cloth 调色板名）—— 描述里最靠前的那一种（通常是外衣） */
  cloth?: string
  /**
   * 描述里提到的**全部**衣色，按出现位置排序。
   *
   * 为什么要全部：NPC 描述常写「黑色燕尾服，纯白的衬衫」这类多色搭配，
   * 只取第一个会丢掉"白衬衫"，立绘就与描述不像。
   * 配方用它来挑打底层（外层深色 + 内层浅色，层次才对）。
   */
  clothAll?: string[]
  /** 瞳色（LPC eye 调色板名） */
  eye?: string
  /** 年龄气质 */
  age?: 'child' | 'young' | 'adult' | 'elder'
  /** 性别气质 */
  gender?: 'male' | 'female'
  /** 体型 */
  build?: 'slim' | 'average' | 'broad' | 'muscular'
  /** 身份关键词，用于挑衣着（例如"守卫"→盔甲） */
  role?: string[]
  /** 是否戴帽/头盔 */
  headwear?: string[]
  /** 是否有胡须 */
  beard?: boolean
  /**
   * 是否有裙装。
   * 上游的 dress 部件**覆盖整个下半身**（zPos 30，在腿 20 之上），
   * 所以穿裙子时必须**不再叠腿部件** —— 否则裤腿会从裙摆里穿出来。
   */
  skirt?: boolean
  /** 匹配到的原文片段，便于调试与向玩家解释 */
  evidence: string[]
}

// ============================================================================
// 词表
// ============================================================================

/**
 * 发色词表。
 *
 * ⚠️ 两条必须遵守的规则：
 *
 * 1) 每条都必须**明确指向头发**。第一版这里写了裸的 `/white hair|silver hair/`
 *    之类，结果「白手套上永远残留墨痕」里的 white 被当成发色，
 *    管家于是得到一头白发。凡是修饰"发"的规则，就不能匹配别的白色物件。
 *
 * 2) 描述里的发色常常不是标准色名 ——「浅亚麻色」「月白」「麦色」「栗棕」
 *    这类说法在中文角色卡里非常普遍。原先只认"金发/银发/棕发"这些标准词，
 *    于是大量角色推断不出颜色 → 退回随机 → 立绘与描述不符。
 *    下面用 `hairRe()` 把**程度修饰词**（浅/深/淡/暗/亮/银/亚麻/麦…）
 *    系统地组合进去，而不是逐个打补丁。
 */
const HAIR_NOUN = '(?:色)?(?:的)?(?:(?:长|短|直|卷|波浪|蓬松|细软|柔顺)的?)*(?:头发|发丝|长发|短发|卷发|发)'
/** 程度修饰词：允许出现在颜色词之前（"浅亚麻色长发"）或之后（"亚麻色浅发"） */
const DEG = '(?:浅|淡|深|暗|亮|浓|浅色|深色|亚麻|麦|麦色|银|灰|金|蜜|焦糖|奶茶)'
/**
 * 构造发色正则。
 * @param body 颜色主体（可能含多个同义说法，用 `|` 分隔）
 * @param withDeg 是否允许程度修饰词 —— 用于区分"浅X"与"X"对应不同调色板
 */
const hairRe = (body: string, withDeg = false) =>
  new RegExp(
    withDeg
      ? `${DEG}?(?:${body})${HAIR_NOUN}|${DEG}(?:${body})|(?:${body})${HAIR_NOUN}`
      : `(?:${body})${HAIR_NOUN}|(?:${body})`,
    'i'
  )

const ENGLISH_NOUN = 'hair'

const HAIR_COLORS: [RegExp, string][] = [
  // ── 浅色系（放在深色前面：颜色词的匹配顺序决定"浅X"不会被"X"抢走）──
  [new RegExp(`${DEG}?亚麻(?:色)?|亚麻${HAIR_NOUN}|(?:浅|淡)金|浅亚麻|flaxen|linen ${ENGLISH_NOUN}`, 'i'), 'sandy'],
  [new RegExp(`(?:浅|淡|亮)褐|浅棕|浅栗|焦糖|奶茶色|light brown ${ENGLISH_NOUN}`, 'i'), 'light_brown'],

  // ── 金 / 铂 ──
  /*
    ⚠️ 顺序规则：**具体色名必须排在泛化色名之前**。
    「草莓金」原本排在「金」后面，于是被 `金发` 先匹配成 blonde ——
    这类"被更泛的规则抢走"的问题会随着词表变大而变多，所以把
    有专名的（草莓金/铂金/麦金）统一放到最前面。
  */
  [new RegExp(`草莓(?:金|色)|strawberry`, 'i'), 'strawberry'],
  [new RegExp(`铂金|白金色?|(?:银白|霜白)金|platinum`, 'i'), 'platinum'],
  [new RegExp(`麦(?:色|浪|穗)|麦金色|wheat|honey ${ENGLISH_NOUN}`, 'i'), 'gold'],
  [new RegExp(`稻草色|干草色|straw`, 'i'), 'sandy'],
  [new RegExp(`金${HAIR_NOUN}|金发|(?:金|蜜)色(?:的)?${HAIR_NOUN}|黄金|blond|blonde|golden ${ENGLISH_NOUN}`, 'i'), 'blonde'],

  // ── 银 / 白 / 灰 ──
  /*
    ⚠️ 这里绝不能出现裸的「银丝」「银」这类词。
    管家的描述是「右眼佩戴着一枚镶有**银丝**的精致单片眼镜」——
    原先的 `银丝` 命中了眼镜框，于是管家被画成一头银发（描述写的是乌黑长发）。
    与"白手套→白发"是同一类错误：**修饰发色的词必须绑定"发"**。
    下面每条要么是"银X发/银发"，要么是明确的发色词（霜白/月白/花白）。
  */
  [new RegExp(`银${HAIR_NOUN}|银发|银白(?:色)?(?:的)?${HAIR_NOUN}|霜白|月白|silver ${ENGLISH_NOUN}|white ${ENGLISH_NOUN}|grey ${ENGLISH_NOUN}|gray ${ENGLISH_NOUN}`, 'i'), 'silver'],
  [new RegExp(`花白|灰白|斑白|salt.?and.?pepper`, 'i'), 'silver'],
  [new RegExp(`炭灰|烟灰|深灰${HAIR_NOUN}|charcoal ${ENGLISH_NOUN}`, 'i'), 'dark_gray'],
  [new RegExp(`灰${HAIR_NOUN}|灰发|ash ${ENGLISH_NOUN}|grey|gray`, 'i'), 'gray'],
  [new RegExp(`灰烬色|ash(?:en)?`, 'i'), 'ash'],
  [new RegExp(`纯白|雪白|素白|white`, 'i'), 'white'],

  // ── 黑 ──
  [new RegExp(`乌黑|漆黑|墨黑|墨色|纯黑|鸦羽|raven|jet.?black|black ${ENGLISH_NOUN}`, 'i'), 'raven'],
  [new RegExp(`黑${HAIR_NOUN}|黑发|黑色(?:的)?${HAIR_NOUN}|black`, 'i'), 'black'],

  // ── 棕 / 褐 / 栗 ──
  [new RegExp(`栗色|栗棕|板栗|chestnut|maroon ${ENGLISH_NOUN}`, 'i'), 'chestnut'],
  [new RegExp(`(?:深|暗)棕|深褐|咖啡色|巧克力色|dark brown|espresso`, 'i'), 'dark_brown'],
  [new RegExp(`棕${HAIR_NOUN}|棕发|褐色${HAIR_NOUN}|褐发|茶色|蜜褐|brown ${ENGLISH_NOUN}|brunette`, 'i'), 'brown'],

  // ── 红 / 橙 ──
  [new RegExp(`姜红|姜黄|ginger|carrot|cinnamon`, 'i'), 'ginger'],
  [new RegExp(`酒红|暗红|赤褐|auburn`, 'i'), 'redhead'],
  [new RegExp(`红${HAIR_NOUN}|红发|赤发|火红|绯红|red ${ENGLISH_NOUN}|redhead`, 'i'), 'red'],
  [new RegExp(`橙${HAIR_NOUN}|橘${HAIR_NOUN}|橙色|橘色|orange ${ENGLISH_NOUN}`, 'i'), 'orange'],

  // ── 其他 ──
  [hairRe('蓝|靛蓝|海蓝|藏青|blue|navy'), 'blue'],
  [hairRe('绿|翠绿|墨绿|green'), 'green'],
  [hairRe('紫|紫罗兰|薰衣草|violet|purple|lavender'), 'purple'],
  [hairRe('粉|桃粉|樱花|rose|pink'), 'pink'],
  [new RegExp(`玫瑰色|玫红`, 'i'), 'rose'],
]

/**
 * 发型关键词。**按优先级排列：越靠前越先被采用。**
 *
 * ⚠️ 两条踩过的坑：
 *
 * 1) 原来写的是 `利落.*发` —— `.*` 会**跨越整个句子**。管家描述是
 *    「他有着一头乌黑锃亮的长发……利落地向后束成一条及腰的马尾」，
 *    "利落" 与句首的 "发" 被 `.*` 连起来，于是判定成"短发"；
 *    而库里没有 `hair_short*`，回退随机时**拿到了光头部件** ——
 *    玩家看到的是一个秃头管家。
 *    修法：用 `[^。；，\n]{0,6}` 限定距离，绝不让 `.*` 跨句。
 *
 * 2) 原先只取**第一个命中**的发型项，所以"长发"（命中及腰）会被排在
 *    更前面的"短发"（误命中）覆盖。现在由调用方收集全部并按本表顺序
 *    保留优先级：具体款式（马尾/发髻）优先于泛泛的"短发"。
 */
const HAIR_STYLES: [RegExp, string[]][] = [
  [/双马尾|twin.?tail|pigtail/i, ['pig', 'ponytail', 'bangs']],
  [/马尾|ponytail|束成|扎成/i, ['ponytail', 'long', 'bob']],
  [/发髻|盘发|丸子头|bun|updo/i, ['topknot']],
  [/光头|秃顶|bald|shaven head/i, ['bald', 'balding']],
  [/长直发|直发|长直|straight hair/i, ['long', 'long_straight', 'relm_xlong']],
  [/长发|披肩|垂至|及腰|long hair/i, ['long', 'ponytail', 'bangslong', 'relm_xlong']],
  [/卷发|波浪|卷曲|curly|wavy/i, ['curly', 'wavy', 'long']],
  [/脏辫|辫子|braid|dreadlock/i, ['braid', 'dread', 'long']],
  [/刘海|齐刘海|bangs|fringe/i, ['bangs', 'bangsshort', 'bangslong']],
  [/爆炸头|蓬松[^。；，\n]{0,4}发|afro/i, ['afro', 'curly']],
  // ⚠️ 关键词必须是**真实存在的 id 片段**。库里的莫西干部件叫 `hair_shorthawk`，
  //    所以片段要写 `shorthawk` —— 写 `mohawk` 匹配不到任何部件，
  //    命中「莫西干头」后只会退化成随机（这个错是 `check-keywords.mjs` 查出来的）。
  //    `spiked`（尖刺发）作为兜底：punk 风格里两者观感接近。
  [/莫西干|mohawk/i, ['shorthawk', 'spiked']],
  [/蓬乱|凌乱|乱蓬|未打理|unkempt|messy|bedhead/i, ['bedhead', 'messy', 'long']],
  [/短寸|寸头|板寸|buzz/i, ['buzz', 'balding']],
  // 「短发」放最后：它是兜底描述，具体款式应当优先（见上面坑 2）
  [/短发|short hair|利落[^。；，\n]{0,4}发|干练[^。；，\n]{0,4}发/i, ['short', 'bangs', 'bob']],
]

/** 肤色 → LPC body 调色板名 */
/**
 * 肤色 / 种族肤色。
 *
 * ⚠️ 覆盖率诊断显示这里原先只有 10% 命中 —— 因为词表几乎只认「肤」字，
 * 而角色卡里更多写的是**气色**（"面容疲惫""苍白到发青"）或**种族**
 * （"绿皮肤"其实命中了，但精灵/矮人/亡灵这些没被利用）。
 *
 * 肤色随机出错其实很难被察觉（不像"男人穿裙子"那样一眼可见），
 * 但种族确定时肤色也应当确定 —— 兽人总是绿皮、亡灵总是灰皮，
 * 这是玩家会注意到的设定一致性。
 */
const SKINS: [RegExp, string][] = [
  // 种族优先：种族能决定肤色时，比"看起来白净"更可信
  [/兽人|半兽人|orc|goblin|地精|绿皮|绿肤|绿皮肤/i, 'green'],
  [/亡灵|尸|骷髅|undead|lich|zombie|不死/i, 'grey'],
  [/暗精灵|卓尔|drow|dark elf/i, 'taupe'],
  [/黑精灵|夜精灵/i, 'taupe'],
  [/青铜肤|古铜肤|bronze skin/i, 'bronze'],
  [/褐肤|棕肤|brown skin/i, 'brown'],
  [/幽蓝|青灰肤|蓝灰肤/i, 'blue'],
  [/淡紫肤|薰衣草肤|lavender skin/i, 'lavender'],
  [/苍白|惨白|色白|病态.{0,3}白|瓷白|青白|pale|porcelain|ashen|wan\b/i, 'light'],
  [/白皙|白净|白嫩|浅肤|肤色白|fair|light skin|cream/i, 'light'],
  [/小麦|古铜|健康.{0,3}肤|日晒|tan|bronze|olive skin|sun.?tanned/i, 'olive'],
  [/琥珀|蜜色肤|amber skin|golden skin/i, 'amber'],
  [/黝黑|深肤|黑肤|肤色深|dark skin|ebony|swarthy/i, 'dark'],
  [/灰肤|灰色.{0,3}肤|尸灰|灰色皮肤|undead|ashen skin/i, 'grey'],
  [/苍白到发青|发青|青紫/i, 'grey'],
]

/**
 * 衣色。
 * ⚠️ 右侧写法要能覆盖"白色长裙""红色长袍"这类**颜色+衣物**的组合，
 * 不能只写"白衣/白袍" —— 我第一版就是这样漏掉了「白色长裙」，
 * 于是莉莉安的裙子被随机配成石板灰。
 */
/**
 * 衣物名词 —— 出现在颜色之后（可隔着"的"）。
 *
 * 抽出来是因为原来的模式写成 `白(色|衣|袍|裙|衫|服|斗篷|披风)`：
 * 这种"颜色字 + 单字衣物"的写法匹配不了**双字衣物名**，
 * 于是「纯白的衬衫」「黑色的燕尾服」全都漏掉 ——
 * 玩家反馈的"立绘与描述不像"有一部分就是这里漏的。
 * （之前只补过"长裙"这一个特例，属于打补丁而不是修根因。）
 */
const GARMENT = '(?:色)?(?:的)?(?:长|短|厚|薄)?' +
  '(?:衣|袍|裙|衫|服|甲|斗篷|披风|外套|大衣|风衣|正装|礼服|燕尾服|衬衫|衬衣|上衣|' +
  '马甲|背心|制服|军装|长袍|罩袍|围裙|皮甲|铠甲|胸甲|锁甲|板甲|和服|浴衣|旗袍|' +
  'tunic|shirt|coat|cloak|robe|armou?r|jacket|vest|dress|skirt)'

/**
 * 布料/质地的修饰词，常夹在颜色和衣物名之间。
 *
 * ⚠️ 为什么需要它：中文角色卡极常写「深灰色**素面**长裙」「青色**官**袍」，
 * 颜色词和衣物名之间夹着一个词。而原来的模式是
 * `颜色 + 可选"的长短厚薄" + 衣物名` —— 夹了"素面"就整条匹配失败，
 * 于是**衣色推断不出来、退回随机**。
 * 玩家截图里的「玛尔塔」正是如此：描述明写"深灰色素面长裙"，
 * 结果是随机配色。
 *
 * 限定在**已知的布料词**里，不用 `.*?` 之类的通配 ——
 * 通配会让「灰色眼睛」这类也误命中衣物。
 */
const CLOTH_MOD = '(?:的|素面|素色|绒面|丝质|绸面|布料|布面|棉|麻|丝|绸|缎|绒|呢|皮|毛|粗布|细布)?'

/**
 * 颜色 + [布料词] + 衣物名 —— 衣色表的统一构造器。
 * 或者退一步：颜色单独出现也算（「她一袭白」这种省略衣物的写法）。
 */
const clothRe = (color: string) => new RegExp(`${color}${CLOTH_MOD}${GARMENT}|${color}`, 'i')


const CLOTH_COLORS: [RegExp, string][] = [
  /*
    ⚠️ 除少数专名外，**一律用 `clothRe(颜色字)` 生成**，不要手写衣物名列表。
    我改这张表时 brown 那条漏用 clothRe、手写成了
    `(?:衣|袍|裙|衫|服|甲|外套|大衣)` —— 里面**没有「围裙」**，
    于是「围着棕色围裙」推断不出衣色。
    更糟的是这个错误很难发现：`GARMENT` 常量明明列了围裙，
    表格里却另写了一份窄列表，两份"衣物名词表"不一致。
    下面补了一条测试专门守这件事（提到衣物名就必须能推出衣色）。
  */
  [new RegExp(`(?:白${CLOTH_MOD}${GARMENT}|纯白|素白|皎白|雪白|银白|white\\b)`, 'i'), 'white'],
  [new RegExp(`(?:黑${CLOTH_MOD}${GARMENT}|玄色|墨色|漆黑|乌黑|black\\b)`, 'i'), 'black'],
  /*
    ⚠️ 顺序：**具体色名必须排在泛化色名之前**（ROADMAP 第 44 项定下的规则）。
    「深灰色素面长裙」原先被下面泛化的 `灰${GARMENT}` 抢走 ——
    而 `灰` + `素面` + `长裙` 又匹配不上（见 CLOTH_MOD 的说明），
    于是整条推断直接失败、退回随机配色。现在深灰/浅灰/炭灰排到泛化灰之前。
  */
  [/深灰|暗灰|铁灰|dark ?gr[ae]y/i, 'dark_gray'],
  [/浅灰|银灰|淡灰|light ?gr[ae]y/i, 'light_gray'],
  [/木炭|炭黑|charcoal/i, 'charcoal'],
  [/石板|slate/i, 'slate'],
  [new RegExp(`(?:灰${CLOTH_MOD}${GARMENT}|灰袍|grey\\b|gray\\b)`, 'i'), 'gray'],
  [/深蓝|藏青|靛蓝|navy|dark blue/i, 'navy'],
  [clothRe('蓝'), 'blue'],
  [clothRe('红'), 'red'],
  [/酒红|暗红|栗红|maroon|burgundy/i, 'maroon'],
  [clothRe('绿'), 'green'],
  [/森林绿|深绿|forest green/i, 'forest'],
  [clothRe('棕'), 'brown'],
  [clothRe('褐'), 'brown'],
  [/皮革|皮衣|leather/i, 'brown'],
  [clothRe('紫'), 'purple'],
  [/薰衣草|淡紫|lavender/i, 'lavender'],
  [clothRe('粉'), 'pink'],
  [clothRe('金'), 'yellow'],
  [/金黄|gold\\b/i, 'yellow'],
  [clothRe('黄'), 'yellow'],
  [clothRe('橙'), 'orange'],
  [clothRe('青'), 'teal'],
  [/蓝绿|teal\\b/i, 'teal'],
  [/天蓝|sky blue/i, 'sky'],
  // 银色/铜色/铁色：金属色不是 cloth 调色板的强项，退到最接近的灰/褐
  [new RegExp(`银${CLOTH_MOD}${GARMENT}|银色|silver`, 'i'), 'gray'],
  [new RegExp(`铜${CLOTH_MOD}${GARMENT}|古铜色|青铜`, 'i'), 'walnut'],
  [new RegExp(`墨${CLOTH_MOD}${GARMENT}`, 'i'), 'black'],
]

/** 瞳色 */
const EYE_COLORS: [RegExp, string][] = [
  [/蓝眼|碧眼|蓝眸|blue eyes?/i, 'blue'],
  [/绿眼|翠眸|green eyes?/i, 'green'],
  [/灰眼|灰眸|grey eyes?|gray eyes?/i, 'grey'],
  [/棕眼|褐眸|brown eyes?/i, 'brown'],
  [/金眼|琥珀.*眼|金瞳|amber eyes?|golden eyes?/i, 'gold'],
  [/红眼|赤瞳|血瞳|red eyes?/i, 'red'],
  [/紫眼|紫瞳|violet eyes?|purple eyes?/i, 'purple'],
  [/黑眼|黑眸|black eyes?/i, 'black'],
]

/**
 * 性别。
 *
 * ⚠️ 四条规则，每一条都是踩出来的：
 *
 * 1. **绝不放"王/国王/皇帝"这类词**。它们看着像男性专属，实际会命中
 *    **姓氏「王」**和"老国王的侄女"这类**指别人**的表述 ——
 *    实测角色卡「静水堡的伊瑟琳」（老国王的侄女、寡居）因此被判成男性。
 *
 * 2. **绝不放"老人/老者"这类不含性别的词**。它们只表示"年长"，
 *    放进男性表会把"老妇人"判成男的。性别必须来自**真正带性别的词**。
 *
 * 3. **亲属称谓要连代词一起写**（`他的父亲`、`她的母亲`）。
 *    因为「他的母亲站在旁边」里，被描述者是"他"（男），
 *    "母亲"只是提到的人。把整个短语写进男性表，就能正确判成男性。
 *
 * 4. **女性代词要排在男性代词之前**。`/he\b/` 会命中 "her" 里的 "he"
 *    （`\b` 在 r 前不成立，但 `her` 后面若跟非单词字符就会）。实测
 *    「老国王的侄女，寡居」曾被判成 male，就是这一条。
 *
 * 5. 别把"别人的"关系称谓算到自己头上（见 `stripOtherPeople`）。
 *    实测：一个人的 `personality` 里写「他妻子算」「他替自己和一个寡妇的账户」，
 *    「妻子」「寡妇」被当成**被描述者自己的**性别证据 →
 *    两个明写「三十四岁男子」「三十七岁男子」的角色被判成女性，立绘长出胡子。
 *
 * 6. **"关系称谓"必须排在"自述性别名词"之后**（这是第 5 条的根治办法）。
 *    `妻子`/`寡妇`/`遗孀`/`丈夫`/`女儿`/`儿子` 这类词描述的是**关系**，
 *    默认指"被描述者的配偶/亲属"，可只要那句里主语是别人，它就完全不算数。
 *    而 `男子`/`女子`/`少年`/`妇人` 是**自述性别**，几乎不会指别人。
 *    所以顺序必须是：自述名词 → 亲属短语（连带代词一起剥）→ 代词。
 *    第 5 条的"剥除"只是补漏，第 6 条的排序才是让结论正确的那一步：
 *    「三十七岁男子……他替自己和一个寡妇的账户」里，`男子` 先命中就定了 male，
 *    后面那个 `寡妇` 根本不会被看到。
 */
/**
 * 性别词表 —— **按档位分层**，逐档尝试，前一档命中就不再往下看。
 *
 * ## 为什么必须分档（2026-10 的第二次修正）
 *
 * 原先是一张**扁平**表 + `firstHit`（取词表顺序里第一个命中的），它同时有两个
 * **方向相反**的错，而且互相掩盖：
 *
 *   · ① 女性表排在男性表之前 → 「二十六岁的**男性**……这道疤反而让他在
 *     **女性**群体中人气更高」被判成 female（"女性"指的是别人，
 *     织命星典的艾德·黑钢因此长了女脸）；
 *   · 可若把顺序倒过来，又会踩另一个坑：「元婴**修士**，**女子**」——
 *     「修士」在西幻里指 friar（男），在中式修仙里却是**男女通用**的称呼，
 *     而它出现得更早 → 判成 male（埃律西昂的冷鸢因此长了男脸）。
 *
 * 两个错的共同点是：**把"隐含性别"的词和"明确性别"的词放在同一档里比先后**。
 * 所以现在按可靠度分档，**档内**才比位置与年龄邻近：
 *
 *   ①a 明确的自述性别词（女子 / 男子 / 女性 / 男性 / 妇人…）
 *   ①b 隐含性别的身份职业词（修女 / 侍女 / 修士 / 农夫…）—— **歧义词全关在这一档**
 *   ②  带代词的亲属短语（他的父亲 / 她的母亲）—— 代词已把关系归给了某人
 *   ③  裸的关系称谓（侄女 / 鳏夫…）—— 只在全文没有自述性别词时才用
 *   ④  女性代词（**先于**男性代词：`/he\b/` 会命中 "her" 里的 "he"）
 *   ⑤  男性代词
 *
 * ⚠️ ①b 这一档是**为什么需要分档**的最好例子：`修士`/`农夫`/`侍卫` 这些词
 * 单独看有统计倾向，值得用；但一旦让它们跟 `女子`/`男子` 平起平坐，
 * 就会在"元婴修士，女子"这种句子上翻车。它们只能当**次选**。
 */
const GENDER_TIERS: [RegExp, 'male' | 'female'][][] = [
  /*
    ①a 明确的自述性别词。
    刻意**不含** `妻子`/`寡妇`/`遗孀`/`丈夫`/`女儿`/`儿子`/`侄女`/`孙女`（关系词，见 ③），
    也**不含**职业身份词（见 ①b）。
  */
  [
    [/少女|姑娘|女孩|女生|女子|女士|女性|妇人|妇女|女人|夫人|太太|主母|小姐|妃子|王妃|皇后|公主|女王|女皇|处女|girl|woman|lady|madam|female|princess|queen|maiden/i, 'female'],
    [/少年|男子|男人|男性|先生|男士|少爷|公子|男童|男孩|男生|汉子|大汉|壮汉|老汉|boy|man|male|sir|mister|gentleman/i, 'male'],
  ],
  // ①b 隐含性别的身份/职业词（歧义词都在这一档，只能当次选）
  [
    [/女仆|侍女|丫鬟|女官|女侠|女将|女修|女弟子|师姐|师妹|修女|尼姑|接生婆|媒婆|巫女|witch|nun/i, 'female'],
    [/修士|和尚|僧|农夫|男仆|侍卫|男爵|公公|师兄|师弟|monk|brother/i, 'male'],
  ],
  /*
    ② 带代词的亲属短语：「他的父亲」→ 被描述者是男性。
    代词已经把关系**归给了别人或自己**，所以这一条比裸的关系词可靠。
  */
  [
    [/她(?:的)?(?:父亲|妈妈|母亲|爹|娘|儿子|女儿|妻子|丈夫|兄弟|姐妹|家人)/i, 'female'],
    [/他(?:的)?(?:父亲|妈妈|母亲|爹|娘|儿子|女儿|妻子|丈夫|兄弟|姐妹|家人)/i, 'male'],
  ],
  /*
    ③ 裸的关系称谓（兜底，优先级最低的一档名词）。
    走到这里说明全文没有任何"自述性别"的词，只能靠关系推断 ——
    比如「老国王的侄女，寡居」就是这一档。
  */
  [
    [/妻子|妃子|寡妇|遗孀|皇后|公主|女王|女皇|女儿|侄女|孙女|外甥女|养女|继女|widow|daughter|niece|queen|princess/i, 'female'],
    [/丈夫|鳏夫|儿子|孙子|外甥|养子|继子|husband|son|nephew/i, 'male'],
  ],
  // ④⑤ 代词档（女性**必须先于**男性：`/he\b/` 会命中 "her" 里的 "he"）
  [
    [/她|she\b|her\b/i, 'female'],
    [/他|he\b|his\b/i, 'male'],
  ],
]

/**
 * 剥掉「别人的」亲属/关系称谓，避免它们被当成被描述者自己的性别证据。
 *
 * 为什么必须有这一步：角色卡的 `personality` 常写「他妻子算」
 * 「他替一个寡妇管账」「他女儿画的猫」——这些词**描述的是别人**，
 * 但 `/妻子|寡妇|女儿/` 只看字形，会把被描述者判成女性。
 * 实测代价：两个明写「三十四岁男子」「三十七岁男子」的工程师与经纪人
 * 被判成女性，立绘给他们配了胡子（审计脚本报"推断为女性却配了胡须"）。
 *
 * 注意**只剥"别人的"**，不剥被描述者自己的：
 *   · `他(的)?妻子` → 剥（是他的妻子）
 *   · `一个寡妇`     → 剥（是另一位当事人）
 *   · 但 `他是个鳏夫` 不剥 —— 那是在说他自己
 */
const OTHERS_KIN = '父亲|母亲|妈妈|爹|娘|爸爸|儿子|女儿|妻子|媳妇|丈夫|老婆|兄弟|姐妹|家人|遗孀'
/** 带代词的：`他妻子` / `他的妻子` / `她女儿` */
const RE_KIN_WITH_PRONOUN = new RegExp(`[他她](?:的)?(?:${OTHERS_KIN})`, 'g')
/**
 * 不定指的：`一个寡妇` / `那位寡妇` / `一个寡妇的账户` / `某个遗孀`
 *
 * ⚠️ 必须允许中间的「的」：「一个**寡妇的**账户」里的寡妇是别人的，
 * 但 `(?:一个)(?:寡妇)` 这种紧邻写法匹配不到它 ——
 * 实测就是这一处让「三十七岁男子」仍然被判成女性。
 */
const RE_KIN_INDEFINITE = /(?:一|那|这|某)(?:个|位|名)?(?:寡妇|遗孀|妻子|丈夫|鳏夫|女儿|儿子)(?:的)?/g

function stripOtherPeople(text: string): string {
  return text
    .replace(RE_KIN_WITH_PRONOUN, '（他人）')
    .replace(RE_KIN_INDEFINITE, '（他人）')
}

/** 年龄 */
/**
 * 年龄。
 *
 * ⚠️ 顺序很重要，"老"必须排在"中年"**之后**判断不了 ——
 * 因为「五十岁的老者」同时含数字与"老"，`firstHit` 取第一个命中的，
 * 所以更**具体**的规则要写在前面（这里 50 岁 → adult 是错的，
 * 因此把"岁数大"的规则提到中年之前）。
 */
/**
 * 岁数表达式。
 *
 * ⚠️ 实测**内置角色卡里的岁数全部是中文数字**，一个阿拉伯数字都没有：
 * 「三十四岁」「五十多岁」「四十岁上下」「六十岁上下」「十九岁」。
 * 而我第一版只写了 `\b\d+\s*岁`（阿拉伯）—— 于是 20 张卡里只有 2 张推断出年龄，
 * 其余全部退回随机年龄，其中 2 张因此拿到**老年脸**（十七八岁的少年画成老头）。
 *
 * 允许数字与"岁"之间夹 多/来/余/几/出头，以及"岁"后的 上下/左右/前后/出头。
 * "岁"本身**可省**（「四十出头」「七八岁的小女孩」都会出现）。
 *
 * ⚠️ 这个正则**只负责抓取，不负责解析**。
 * 我一开始想用一个多可选分组的复杂正则，一次把「十七八」「三四十」
 * 「十四」「五十六」「七八」全解析出来 —— **连错三次**：
 *   · 第二个数字做成可选 → 「十四」先命中"四" → 判成 4 岁
 *   · 把 `X十Y` 放前面   → 「十七八」被切成 17 + 残留"八"，整条失配
 *   · 把裸两位数字放前面 → 「十七八」的"七八"被读成 78
 * 中文数字的约数写法（十七八 = 17~18）本质是**解析问题**，不是匹配问题。
 * 交给下面的 `parseCnAge()` 顺次读取，逻辑才看得清、也才测得准。
 */
const AGE_EXPR = /([一二三四五六七八九十百两\d]{1,4})\s*(?:多|来|余|几)?\s*(?:岁\s*(?:上下|左右|前后|出头|多)?|出头)/

/**
 * 解析中文/阿拉伯数字岁数；约数区间取**偏低**的一侧（两端通常同档）。
 *
 *   十四 → 14     五十六 → 56     十九 → 19     四十 → 40
 *   十七八 → 17（十七~十八）      七八 → 7（7~8）
 *   三四十 → 35（三十~四十，跨档取中值）
 */
function parseCnAge(s: string): number | null {
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  const D: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const vals: number[] = []
  for (const c of s) {
    if (c === '十') { vals.push(vals.length ? -1 : 10); continue }   // -1 = "接在前一个数字后面当十位"
    const v = D[c]
    if (v === undefined) { vals.push(NaN); continue }
    vals.push(v)
  }
  if (!vals.length || vals.some(v => Number.isNaN(v))) return null
  // 展开 -1 标记：把前一个数字 ×10
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] === -1) {
      vals[i - 1] = vals[i - 1] * 10
      vals.splice(i, 1)
      i--
    }
  }
  if (!vals.length) return null
  // 全是个位、且两位数 → 约数（七八 = 7~8），取较小值
  if (vals.length >= 2 && vals.every(v => v < 10)) {
    const [a, b] = vals
    return Math.round((a + b) / 2)   // 7~8 → 7.5→8；(7+8)/2 四舍五入
  }
  // 普通情况：把各位拼起来（十四 → 10+4=14；三四十 → 30+40=70 → 见下）
  let total = 0
  for (const v of vals) total += v
  // "三四十"这种"两个十位"的约数：30 与 40 取中值
  const tensVals = vals.filter(v => v >= 10)
  if (tensVals.length >= 2) return Math.round(tensVals.reduce((a, b) => a + b, 0) / tensVals.length)
  return total
}

/**
 * 从文本里读岁数并分档。
 *
 * 为什么单独一个函数、而不是塞进 AGES 表：
 * 中文数字没法用正则直接做区间判断（`[4-5][0-9]` 只对阿拉伯数字成立），
 * 只能**先取出数值、再比较**。
 */
function ageFromNumber(text: string): 'child' | 'young' | 'adult' | 'elder' | undefined {
  const m = text.match(AGE_EXPR)
  if (!m) return undefined
  const n = parseCnAge(m[1])
  if (n === null) return undefined
  if (n <= 16) return 'child'
  if (n <= 39) return 'young'
  if (n <= 59) return 'adult'
  return 'elder'
}

/**
 * 年龄（按泛称判断；**岁数优先**，见 inferTraits 里的调用顺序）。
 *
 * ⚠️ 泛化单字不能裸用。「老」原先裸写在 elder 规则里，
 * 于是「**老**板」「**老**师」「**老**陈」全被判成老者 ——
 * 酒馆老板随机拿到一张老年脸（"老板"本意是店主，与年龄无关）。
 * 现在只认"老者/老妇/老人"这类**明确指年龄**的词。
 */
const AGES: [RegExp, 'child' | 'young' | 'adult' | 'elder'][] = [
  [/老者|老妇|老人|老头|老太|年老|年迈|上了年纪|白发苍苍|垂暮|花甲|古稀|耄耋|elder|elderly|old man|old woman|aged/i, 'elder'],
  [/中年|壮年|不惑|知天命|middle.?aged/i, 'adult'],
  [/青年|年轻人|年轻|少年郎|rookie|young man|young woman|youth/i, 'young'],
  [/少年|少女|孩童|幼童|小孩|儿童|child|kid/i, 'child'],
]

/** 体型 */
const BUILDS: [RegExp, 'slim' | 'average' | 'broad' | 'muscular'][] = [
  [/瘦|纤细|单薄|削瘦|孱弱|slim|thin|slender|gaunt|frail/i, 'slim'],
  [/魁梧|高大|壮硕|虎背|健壮|肌肉|muscular|burly|broad.?shouldered|hulking/i, 'muscular'],
  [/敦实|结实|壮实|stocky|sturdy|plump|heavy.?set/i, 'broad'],
]

/**
 * 身份 → 暗示的衣着类型。
 *
 * ⚠️ 右侧的关键词必须是**素材库里真实存在的 id 片段**。
 * 我第一版凭想象写了 `chainmail` / `plate` / `formal` / `suit` / `leather.?apron`，
 * 结果：库里没有 chainmail 和 formal，`leather.?apron` 又匹配不到
 * `torso_aprons_apron`（它的 id 里没有 "leather"）——
 * 于是铁匠穿上了 overalls（工装裤）、管家穿上了长袖 T 恤。
 * 关键词筛选是"命中才用"，**写错的代价是静默失效**，不会报错。
 *
 * 下面的关键词都对着 lpcSprite.ts 里实际存在的 id 核对过。
 */
const ROLES: [RegExp, string[]][] = [
  // 守卫/骑士/士兵/战士 → 盔甲
  [/守卫|卫兵|骑士|士兵|武士|战士|佣兵|雇佣兵|巡逻|队长|guard|knight|soldier|warrior|sentry|watchman|paladin|圣殿|mercenary|legion/i,
    ['torso_armour_plate', 'torso_armour_legion', 'torso_armour_leather']],
  // 修行者/弟子/门派 → 长袍（仙侠与武侠题材的主力衣着）
  [/弟子|门人|传人|修士|剑修|散修|道人|真人|尊者|长老|掌门|宗主|侠客|剑客|刀客|武人|disciple|monk|ascetic|cultivator|swordsman/i,
    ['torso_clothes_robe', 'torso_clothes_longsleeve_formal']],
  // 法师/学者/祭司 → 长袍
  [/法师|术士|巫师|学者|研究|祭司|牧师|神官|萨满|mage|wizard|sorcer|scholar|warlock|priest|cleric|shaman|druid/i,
    ['torso_clothes_robe']],
  // 管家/仆从/女仆 → 正装外套
  [/管家|仆从|侍者|女仆|侍从|butler|servant|maid|steward|valet|footman/i,
    ['torso_jacket_collared', 'torso_jacket_pockets', 'torso_jacket_frock']],
  // 商人/店主/酒保 → 马甲/外套
  [/商人|店主|掌柜|老板|酒保|商贩|merchant|shopkeep|trader|innkeep|barkeep|bartender|shopkeeper/i,
    ['torso_jacket_pockets', 'torso_clothes_longsleeve2_buttoned']],
  // 盗贼/刺客/游侠/猎手 → 皮甲或无袖（便于行动）
  [/盗贼|刺客|游侠|猎手|猎人|斥候|rogue|thief|assassin|ranger|hunter|scout|bandit/i,
    ['torso_armour_leather', 'torso_clothes_sleeveless1']],
  // 贵族/领主/王室 → 礼服
  [/贵族|领主|国王|女王|亲王|公主|王子|伯爵|公爵|noble|lord|lady|king|queen|prince|princess|duke|count|baron/i,
    ['torso_jacket_tabard', 'torso_jacket_iverness', 'torso_jacket_frock']],
  // 铁匠/工匠/矿工 → 皮围裙
  [/铁匠|工匠|矿工|技工|smith|blacksmith|miner|craftsman|artisan/i,
    ['torso_aprons_apron', 'torso_aprons_apron_half']],
  // 农民/村民 → 长袖或工装
  [/农民|农妇|农夫|村民|农户|farmer|peasant|villager|peasantry/i,
    ['torso_clothes_longsleeve', 'torso_aprons_overalls']],
  // 船员/水手/船长/海盗 → 束袖长衫
  [/船员|水手|船长|海盗|渔夫|sailor|captain|pirate|fisher|boatswain/i,
    ['torso_clothes_longsleeves_cuffed', 'torso_clothes_longsleeve']],
  // 官员/文官/吏员 → 正装外套（对应中式官袍的"正式"感）
  [/官员|文官|官吏|吏员|县令|知府|宰相|大臣|official|magistrate|bureaucrat|mandarin|minister/i,
    ['torso_jacket_collared', 'torso_clothes_longsleeve_formal']],
  // 学生/学徒 → 衬衫马甲
  [/学生|学徒|门生|student|apprentice|acolyte|pupil/i,
    ['torso_clothes_longsleeve2_buttoned', 'torso_clothes_longsleeve2_polo', 'torso_clothes_longsleeve2_cardigan']],
  // 医生/药师/护士 → 白衣长衫
  [/医生|医师|药师|护士|郎中|doctor|physician|apothecary|nurse|healer/i,
    ['torso_clothes_longsleeve_formal', 'torso_clothes_longsleeve']],
  // 现代职业（西装/制服感）
  [/上班族|职员|白领|公务员|律师|银行|office|clerk|businessman|salaryman|lawyer|banker/i,
    ['torso_clothes_longsleeve_formal', 'torso_clothes_longsleeve2_buttoned']],
  [/警察|警官|保安|巡警|police|officer|sheriff|constable/i,
    ['torso_jacket_collared', 'torso_armour_leather']],
  [/厨师|厨子|伙夫|cook|chef/i, ['torso_aprons_apron', 'torso_clothes_shortsleeve']],
  [/艺人|吟游|歌者|舞|bard|minstrel|performer|dancer/i,
    ['torso_clothes_longsleeve2_scoop', 'torso_jacket_iverness']],
  [/店员|收银|服务生|waitress|waiter|shop assistant/i,
    ['torso_clothes_shortsleeve_polo', 'torso_clothes_longsleeve2_polo']],
  // 种族本身也能定型：精灵多穿轻甲长衣、矮人偏工装
  [/精灵|elf|elven/i, ['torso_armour_leather', 'torso_clothes_longsleeve_formal']],
  [/矮人|dwarf|dwarven/i, ['torso_aprons_overalls', 'torso_armour_leather']],
  [/兽人|半兽人|orc|goblin|地精/i, ['torso_armour_leather', 'torso_clothes_sleeveless1']],
  [/亡灵|尸|骷髅|undead|lich/i, ['torso_clothes_robe']],
]

/**
 * 头饰 → 关键词。
 * 同样必须对应真实 id。注意：**上游没有眼镜/面具类部件**
 * （我原以为有，写了 glasses/monocle，结果"戴单片眼镜的管家"匹配不到任何东西）。
 * 匹配不到时配方会**不加头饰**而不是随机加一个 —— 见 lpcSprite 的说明。
 */
const HEADWEAR: [RegExp, string[]][] = [
  [/头盔|兜鍪|helm|helmet/i,
    ['hat_helmet_nasal', 'hat_helmet_barbuta_simple', 'hat_helmet_flattop', 'hat_helmet_legion', 'hat_helmet_morion', 'hat_helmet_sugarloaf']],
  [/兜帽|连帽|风帽|头罩|hood/i, ['hat_hood_cloth', 'hat_hood_hijab']],
  [/头巾|包头|包巾|抹额|turban|headband|头带|发带/i,
    ['hat_headband_thick', 'hat_headband_tied', 'hat_bandana', 'hat_bandana_pirate']],
  [/王冠|冠冕|皇冠|宝冠|金冠|crown|coronet/i, ['hat_formal_crown', 'hat_accessory_crest']],
  [/角冠|犄角|horns/i, ['hat_accessory_horns_upward']],
  [/翼冠|羽翼冠/i, ['hat_accessory_wings']],
  [/三角帽|海盗帽|双角帽|tricorne|bicorne/i,
    ['hat_bicorne_athwart_admiral', 'hat_tricorne_captain_skull', 'hat_bicorne_foreaft_commodore', 'hat_bandana_pirate_skull']],
  /*
    帽子。
    ⚠️ 上游**没有棒球帽 / 无檐帽 / 针织帽**（我核对了 36 件 hat 部件的 id，
    只有 cap_leather / cap_bonnie 这几个）。所以"戴棒球帽"这类描述
    只能落到皮质便帽上 —— 这是素材边界，不是词表问题。
    把常见帽子词都归到这里，至少能加一顶"帽子"，而不是什么都没有。
    另外「乌纱帽」「官帽」也归这里：上游没有中式官帽，
    用深色皮帽近似比不加更接近设定。
  */
  [/帽子|礼帽|便帽|棒球帽|鸭舌帽|无檐帽|针织帽|毛线帽|斗笠|毡帽|乌纱帽|官帽|hat|cap|beanie/i,
    ['hat_cap_leather', 'hat_cap_leather_feather', 'hat_cap_bonnie_tilt', 'hat_cap_bonnie']],
  [/尖顶盔|维京|spangenhelm|sugarloaf/i, ['hat_helmet_spangenhelm_viking', 'hat_helmet_sugarloaf']],
  [/大盔|全罩|封闭式|greathelm/i, ['hat_helmet_greathelm']],
  [/面甲|护面|visor/i, ['hat_visor_round_raised', 'hat_visor_horned']],
  [/圣诞帽|holiday/i, ['hat_holiday_christmas']],
  [/法冠|星辰冠|仙冠|celestial/i, ['hat_magic_celestial']],
  /*
    眼镜/单片眼镜/眼罩/面具：**上游没有这类部件**（我在 LPC 定义树里搜过，
    hat_glasses_* / hat_eyepatch / hat_mask_* 都不存在）。
    仍然保留这条规则并给出**空关键词列表**，理由是：
      - 关键词列表为空 ⇒ 配方不会加任何头饰（正确的行为：宁可少一个配饰，
        也不能因为"戴眼镜"就随机配一顶野蛮人头盔）；
      - 同时 evidence 里会留下「头饰:单片眼镜」，说明作者的设定被读到了。
    将来如果补了眼镜素材，只需把 id 填进这个数组即可。
  */
  [/单片眼镜|眼镜|眼罩|面具|面罩|glasses|monocle|eyepatch|mask/i, []],
]

/** 胡须 */
const BEARD_RE = /胡须|胡子|大胡|络腮|山羊胡|髭|beard|moustache|mustache|whisker/i

/**
 * 裙装。
 * LPC 的 dress 部件覆盖整个下半身，所以命中它就要**去掉腿部件**，
 * 否则裤腿会从裙摆里透出来（比不穿裙子更难看）。
 *
 * ⚠️ 这里踩过一个隐蔽的坑：第一版写了 `robe-like`，
 * 而正则里的 `-` 是普通字符、`e` 由 `-` 修饰成了"零或多个"，
 * 于是 `rob-?like` 实际匹配了 `torso_clothes_shortsleeve` 里的 "robe"！
 * 结果"村里的年轻人"被判成穿裙装，拿到一件没有颜色变体的和服、
 * 而且腿部件与裙子同时出现。
 * 凡是写"可选的连字符"，必须转义：`robe\-like`。
 */
const SKIRT_RE = /长?裙|连衣裙|裙装|裙摆|裙裾|礼服|晚礼服|和服|浴衣|旗袍|\bdress\b|\bskirt\b|\bkimono\b|\bgown\b/i

// ============================================================================
// 提取
// ============================================================================

/** 在文本里找第一个命中的词表项 */
function firstHit<T>(text: string, table: [RegExp, T][]): { value: T; evidence: string } | undefined {
  for (const [re, value] of table) {
    const m = text.match(re)
    if (m) return { value, evidence: m[0] }
  }
  return undefined
}

/**
 * 取「**出现位置**最靠前」的命中，而不是「词表顺序」最靠前的。
 *
 * ## 为什么性别需要它（2026-10 修）
 *
 * `firstHit` 按词表顺序返回 —— 对颜色/年龄那是合理的（词表顺序 = 优先级）。
 * 但 `GENDERS` 里 ① 女性表排在 ① 男性表**之前**（历史原因见 GENDERS 的规则 4），
 * 于是**任何同时含男女词的描述都会被判成 female**。
 *
 * 实测代价：织命星典的艾德·黑钢，`description` 开头明写「二十六岁的**男性**」，
 * 结尾有一句「这道疤反而让他在**女性**群体中人气更高」—— 后者指的是别人，
 * 却把这位帝国陆军少校画成了女性。埃律西昂的卡西乌斯·维特里乌斯同理
 * （他的 `relationship` 里提到「女皇」，而本人是「男子」）。
 * 这两条都被审计脚本报成「推断为女性，却用了男性头部」——
 * **是推断错了，不是作者写错了**。
 *
 * ## 排序规则（从硬到软）
 *
 *   1. `nearAgeFirst` 打开时，**紧邻年龄表述的命中最硬**：
 *      「二十六岁的男性」比「女性群体」可靠得多。判据是命中处往前 12 字内
 *      出现 `\d+岁` / 年龄 / 年纪 / 年岁。
 *   2. 其次比**出现位置**，靠前的赢（描述通常先把本人讲清楚，再提别人）。
 *   3. 位置也相同时**不替换**，保留词表顺序 —— 这一条专为 `her` 里的 `he`：
 *      `/he\b/` 与 `/her\b/` 会匹配到同一位置，女性表在前才能判对。
 */
function firstHitByPosition<T>(
  text: string,
  table: [RegExp, T][],
  nearAgeFirst = false,
): { value: T; evidence: string } | undefined {
  let best: { value: T; at: number; rank: number; evidence: string } | undefined
  for (const [re, value] of table) {
    const m = text.match(re)
    if (!m || m.index === undefined) continue
    const at = m.index
    let rank = 0
    if (nearAgeFirst) {
      const before = text.slice(Math.max(0, at - 12), at)
      rank = /\d+\s*(?:岁|歲)|年龄|年纪|年岁/.test(before) ? 0 : 1
    }
    if (!best || rank < best.rank || (rank === best.rank && at < best.at)) {
      best = { value, at, rank, evidence: m[0] }
    }
  }
  return best ? { value: best.value, evidence: best.evidence } : undefined
}

/** 收集所有命中的词表项（用于身份/头饰这类可叠加的特征） */
function allHits<T>(text: string, table: [RegExp, T][]): { values: T[]; evidence: string[] } {
  const values: T[] = []
  const evidence: string[] = []
  for (const [re, value] of table) {
    const m = text.match(re)
    if (m) { values.push(value); evidence.push(m[0]) }
  }
  return { values, evidence }
}

/**
 * 按**在原文里出现的位置**收集命中项。
 *
 * 与 `allHits` 的区别：那个按词表顺序返回，这个按文本顺序。
 * 对衣色很重要 —— 「黑色燕尾服，纯白的衬衫」里黑色在前，
 * 它才是外衣（最显眼的那个）；按词表顺序可能先命中"白"，
 * 于是立绘给一件白外套，与描述正相反。
 */
/**
 * 词表导出 —— **仅供校验工具与测试使用**，运行时代码不要依赖它。
 *
 * 为什么必须导出：`ROLES` / `HEADWEAR` 里写的是**部件 id 片段**，
 * 而写错 id 的代价是**静默失效** —— 不报错、不抛异常，
 * 只是关键词匹配不到任何部件，然后退化成随机（"铁匠穿工装裤、
 * 管家戴野蛮人头盔"就是这么来的）。
 *
 * 这类缺陷无法靠运行时断言发现（它"正常工作"，只是结果错），
 * 只能拿真实的 `runtime.json` 反查。`scripts/check-keywords.mjs` 就是干这个的。
 */
export const __tablesForValidation = {
  HAIR_COLORS, HAIR_STYLES, SKINS, CLOTH_COLORS, AGES, BUILDS, ROLES, HEADWEAR,
  GARMENT, BEARD_RE, SKIRT_RE,
}

function hitsInOrder<T>(text: string, table: [RegExp, T][]): { value: T; evidence: string; at: number }[] {  const out: { value: T; evidence: string; at: number }[] = []
  for (const [re, value] of table) {
    // 用全局匹配找出该模式在文本里最早的位置
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    const m = g.exec(text)
    if (m) out.push({ value, evidence: m[0], at: m.index })
  }
  return out.sort((a, b) => a.at - b.at)
}

/**
 * 从角色信息里推断外貌特征。
 *
 * @param input 把角色卡里所有可用文本都传进来 —— 描述、性格、身份、名字都能提供线索。
 *              例如名字叫「红发艾拉」时，光看名字就足以定下发色。
 */
export function inferTraits(input: {
  name?: string
  description?: string
  personality?: string
  scenario?: string
  relationship?: string
  gender?: string
  age?: string
}): AppearanceTraits {
  // 名字权重最高：出现在名字里的外貌词几乎一定是刻意的（「红发艾拉」「独眼杰克」）。
  // 这里不做加权计算，而是把名字放在最前 —— 因为 firstHit 取第一个命中，
  // 顺序本身就是优先级。
  const text = [
    input.name || '',
    input.age || '',
    input.description || '',
    input.personality || '',
    input.scenario || '',
    input.relationship || '',
    input.gender || '',
  ].filter(Boolean).join(' \n ')

  const out: AppearanceTraits = { evidence: [] }

  const hair = firstHit(text, HAIR_COLORS)
  if (hair) { out.hairColor = hair.value; out.evidence.push(`发色:${hair.evidence}`) }

  const styleHits = allHits(text, HAIR_STYLES)
  if (styleHits.values.length) {
    out.hairStyle = [...new Set(styleHits.values.flat())]
    out.evidence.push(`发型:${styleHits.evidence.join('/')}`)
  }

  const skin = firstHit(text, SKINS)
  if (skin) { out.skin = skin.value; out.evidence.push(`肤色:${skin.evidence}`) }

  /*
    衣色：**收集全部**，不只取第一个。
    描述里常常写了多种颜色（「黑色燕尾服，纯白的衬衫」「棕色皮甲配绿色束腰」），
    只取第一个会丢掉后面的信息 —— 那正是"立绘和描述不像"的常见原因。
    按出现位置排序，`cloth` 取最靠前的（通常是外衣，最显眼），
    其余放进 `clothAll` 供配方挑打底层。
  */
  const clothHits = hitsInOrder(text, CLOTH_COLORS)
  if (clothHits.length) {
    out.cloth = clothHits[0].value
    out.clothAll = [...new Set(clothHits.map(h => h.value))]
    out.evidence.push(`衣色:${clothHits.map(h => h.evidence).join('/')}`)
  }

  const eye = firstHit(text, EYE_COLORS)
  if (eye) { out.eye = eye.value; out.evidence.push(`瞳色:${eye.evidence}`) }

  /*
    年龄：**先看明确岁数**，再按泛称判断。
    岁数是显式信息，比"少年"这种泛称可信 —— 旧版把 `少年` 排在表首，
    于是「十七八岁的少年」被判成 child（十七八岁画成小孩脸）。
  */
  const byNumber = ageFromNumber(text)
  const age = byNumber ? { value: byNumber, evidence: (text.match(AGE_EXPR) || [''])[0].trim() } : firstHit(text, AGES)
  if (age) { out.age = age.value; out.evidence.push(`年龄:${age.evidence}`) }

  const build = firstHit(text, BUILDS)
  if (build) { out.build = build.value; out.evidence.push(`体型:${build.evidence}`) }

  const roles = allHits(text, ROLES)
  if (roles.values.length) {
    out.role = [...new Set(roles.values.flat())]
    out.evidence.push(`身份:${roles.evidence.join('/')}`)
  }

  const headwear = allHits(text, HEADWEAR)
  if (headwear.values.length) {
    out.headwear = [...new Set(headwear.values.flat())]
    out.evidence.push(`头饰:${headwear.evidence.join('/')}`)
  }

  if (BEARD_RE.test(text)) {
    out.beard = true
    out.evidence.push('胡须')
  }

  if (SKIRT_RE.test(text)) {
    out.skirt = true
    out.evidence.push('裙装')
  }

  /*
    性别推断。
    ⚠️ 这是**立绘错配最大的来源之一**：推断不出性别时，头部部件会从
    男女混合池里随机抽，于是"约莫四十出头的妇人"能抽到一张留胡子的男脸。
    玩家截图里的「玛尔塔·魏斯」正是如此 —— 描述里"妇人"两个字没被任何规则覆盖。

    规则要点：
      1. **零依赖**：绝不因为"没有性别线索"就假定某一性别。
         旧版有一行 `if (age === 'elder' && !gender) gender = 'male'` ——
         那是硬编码的男性偏见，直接把"老妇人"变成男脸。已删。
      2. 具体名词优先于代词：代词（他/她）可能指**别人**
         （「他母亲站在旁边」里的"他"不是被描述者），可信度最低，放最后。
      3. 「少年」与「少女」共用"少"字，必须把「少女」的判断放在前面，
         否则 `/少年/` 会先命中而把姑娘判成男的。
  */
  const explicitGender = /女|female|woman|girl/i.test(input.gender || '')
    ? 'female'
    : /男|male|man|boy/i.test(input.gender || '')
      ? 'male'
      : undefined

  if (explicitGender) {
    out.gender = explicitGender
  } else {
    /*
      ⚠️ 必须先剥掉"别人的"亲属称谓再判断。
      实测事故：工程师的 personality 写了「他妻子算」、经纪人的写了
      「他替自己和一个寡妇的账户各买了三百索尔」——
      「妻子」「寡妇」被当成**被描述者自己**的性别证据，
      于是两个明写「三十四岁男子」「三十七岁男子」的角色被判成女性，
      立绘给他们配了胡子（审计脚本报"推断为女性却配了胡须"）。
      亲属词描述的是别人，不能算在自己头上。
    */
    const genderText = stripOtherPeople(text)
    /*
      ⚠️ **逐档**尝试，而不是在一张扁平表里取第一个命中。两个理由都能举出真实事故：
        · 扁平表里 ① 女性表排在 ① 男性表之前 → 「二十六岁的男性……让他在
          **女性**群体中人气更高」判成 female；
        · 把顺序倒过来 → 「元婴**修士**，**女子**」判成 male（"修士"男女通用）。
      分档之后，每一档内部才用 `firstHitByPosition` 比位置与年龄邻近。
      完整推理见 `GENDER_TIERS` 的注释。
    */
    let genderHit: { value: 'male' | 'female'; evidence: string } | undefined
    for (const tier of GENDER_TIERS) {
      genderHit = firstHitByPosition(genderText, tier, true)
      if (genderHit) break
    }
    if (genderHit) {
      out.gender = genderHit.value
      out.evidence.push(`性别:${genderHit.evidence}`)
    }
  }

  /*
    年龄兜底：**从物种/职业的常识反推**，而不是掷骰子。
    推断不出年龄时，如果已经知道是"学徒"这类词，按少年处理；
    否则保持 undefined，让配方各自挑合理默认（不硬塞一张老人脸）。
  */
  if (!out.age && /学徒|弟子|门生|学生|见习|童工|apprentice|student|acolyte/i.test(text)) {
    out.age = 'young'
    out.evidence.push('年龄:学徒（按年轻人处理）')
  }

  return out
}

/** LPC 调色板名解析：把"语义色"映射到调色板里实际存在的名字 */
export interface PaletteLookup {
  (material: Material): string[]
}

/**
 * 把语义颜色名解析为调色板里真实存在的名字。
 *
 * 调色板里的命名不完全统一（black / dark_brown / blonde…），
 * 所以这里用"包含匹配 + 候选顺序"来找，而不是硬编码一一对应 ——
 * 万一上游调色板改了名字，也只会退化成"找不到就用随机"，不会崩。
 */
export function resolvePaletteName(
  want: string | undefined,
  available: string[]
): string | undefined {
  if (!want) return undefined
  // 两侧都要转小写：available 转了但 want 没转的话，'BLACK' 就匹配不上 'black'
  const w = want.toLowerCase()
  const lower = available.map(a => a.toLowerCase())

  // 1. 精确
  const exact = lower.indexOf(w)
  if (exact >= 0) return available[exact]

  // 2. 语义色的候选顺序（第一个命中的就用）
  /*
    ⚠️ 候选名要对应**调色板里真实存在的名字**（见 palettes.json）：
      hair: 26 个  body: 22 个  cloth: 24 个  eye: 8 个
    第一版我写了 olive 之类的名字，而 body 调色板里其实是 taupe —— 找不到就退化成随机，
    于是"健康的小麦色皮肤"变成随便一个肤色。
  */
  const ALIASES: Record<string, string[]> = {
    black: ['black', 'raven', 'charcoal'],
    dark_brown: ['dark_brown', 'chestnut', 'light_brown', 'brown'],
    brown: ['brown', 'chestnut', 'light_brown', 'walnut'],
    blonde: ['blonde', 'sandy', 'gold', 'yellow'],
    silver: ['silver', 'white', 'gray', 'platinum', 'ash'],
    red: ['red', 'redhead', 'ginger', 'maroon'],
    orange: ['orange', 'carrot', 'ginger'],
    blue: ['blue', 'navy', 'sky', 'teal'],
    green: ['green', 'forest', 'bright_green', 'dark_green'],
    purple: ['purple', 'violet', 'lavender'],
    pink: ['pink', 'rose'],
    // 肤色：body 调色板用的是 light / amber / olive / taupe / bronze / brown / black
    light: ['light', 'pale_green'],
    olive: ['olive', 'taupe', 'amber'],
    dark: ['black', 'brown', 'bronze'],
    grey: ['taupe', 'gray', 'slate'],
    /*
      灰色系。
      ⚠️ 调色板**各材质不统一**（实测 `palettes.json`）：
        hair  有 dark_gray / gray / ash / platinum，**没有** charcoal / slate
        cloth 有 gray / slate / charcoal，**没有** dark_gray / light_gray
      所以「深灰」在不同材质上要落到不同的名字。
      这里用候选链表达"哪个先有就用哪个"，而不是硬编码一张材质对应表 ——
      上游调色板改名时最坏也只是退化成 gray，不会静默失败。
    */
    dark_gray: ['dark_gray', 'charcoal', 'gray', 'slate'],
    light_gray: ['light_gray', 'ash', 'silver', 'gray', 'slate'],
    charcoal: ['charcoal', 'dark_gray', 'gray'],
    slate: ['slate', 'gray', 'charcoal'],
    white: ['white', 'light'],
    navy: ['navy', 'blue'],
    gold: ['gold', 'yellow', 'amber'],
    yellow: ['yellow', 'gold'],
    gray: ['gray', 'slate', 'charcoal'],
    teal: ['teal', 'sky', 'blue'],
    sky: ['sky', 'teal'],
    maroon: ['maroon', 'red'],
    lavender: ['lavender', 'purple'],
    forest: ['forest', 'green'],
  }
  const cands = ALIASES[w] || [w]
  for (const c of cands) {
    const i = lower.findIndex(n => n === c)
    if (i >= 0) return available[i]
  }
  for (const c of cands) {
    const i = lower.findIndex(n => n.includes(c))
    if (i >= 0) return available[i]
  }
  return undefined
}
