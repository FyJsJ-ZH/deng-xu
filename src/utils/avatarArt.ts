/**
 * 程序化人物头像生成（模块化部件版）
 *
 * 为什么不用现成图片素材：
 *  1. 版权 —— Lemma Soft Forums / OpenGameArt / itch.io 上所谓"免费素材"，
 *     授权条款逐个不同（有的要署名、有的禁再分发、有的仅限非商业），
 *     不逐条核验就打包会把风险转嫁给使用者；
 *  2. 可达性 —— 本开发环境无法访问 itch.io 与 Gumroad（Potat0Master 的 sprite、
 *     Humaaans 的分发包都在上面）；GitHub 上的 Humaaans 镜像授权标注互相矛盾；
 *  3. 体积 —— 几十张高清位图会给纯前端站点加上好几 MB。
 *
 * 所以改用「手工设计的部件库 + 程序化组合」：
 *  部件都在 avatarParts.ts，每个部件是**单独画的、有明确轮廓特征**的一片，
 *  而不是数值抖动。组合维度：
 *      体型服装 6 × 发型 10 × 头饰 8 × 眼睛 7 × 眉毛 5 × 嘴 5 × 胡须 7 × 配件 14 × 配色
 *  同一屏里几乎不可能撞脸，且整体风格统一、可离线、单张约 2 KB。
 *
 * 想换成真实美术素材：把 AssetEntry.image 填上图片路径即可（见 resolveAvatar）。
 */

import {
  CLOTHING, HAIRS, HEADWEAR, EYES, BROWS, ACCESSORIES,
  FIG_W, FIG_H, drawTorso, drawHairBack, drawHairFront, drawHeadwear,
  drawEyes, drawMouth, drawAccessory, shadeHex, type PartCtx,
} from '@/utils/avatarParts'

export type AvatarStyle = 'ink' | 'neon' | 'holo' | 'parchment'

export interface AvatarStyleDef {
  id: AvatarStyle
  label: string
  bg: [string, string]
  stroke: string
  accent: string
  lineWidth: number
  scanlines: boolean
  cool?: boolean
}

export const AVATAR_STYLES: Record<AvatarStyle, AvatarStyleDef> = {
  ink: {
    id: 'ink', label: '水墨',
    bg: ['#1b1b1b', '#2b2723'],
    stroke: '#c8bda8', accent: '#f59e0b', lineWidth: 1.5, scanlines: false,
  },
  neon: {
    id: 'neon', label: '霓虹',
    bg: ['#0d1320', '#131a2e'],
    stroke: '#22d3ee', accent: '#f472b6', lineWidth: 1.2, scanlines: true, cool: true,
  },
  holo: {
    id: 'holo', label: '全息',
    bg: ['#0b1512', '#10201c'],
    stroke: '#5eead4', accent: '#fbbf24', lineWidth: 1.2, scanlines: true, cool: true,
  },
  parchment: {
    id: 'parchment', label: '羊皮纸',
    bg: ['#221c14', '#2e2618'],
    stroke: '#e7d3a1', accent: '#b45309', lineWidth: 1.7, scanlines: false,
  },
}

export const AVATAR_STYLE_IDS = Object.keys(AVATAR_STYLES) as AvatarStyle[]

export function getAvatarStyle(id?: string): AvatarStyleDef {
  return AVATAR_STYLES[(id as AvatarStyle)] || AVATAR_STYLES.ink
}

function hashSeed(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function makeRng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 从大量候选中选一个：不用取模轮转，避免"每 N 个重复一次"的节律感 */
const pick = <T,>(rng: () => number, list: readonly T[]): T =>
  list[Math.floor(rng() * list.length) % list.length]

// —— 脸型：影响下颌与下巴，配合体型 ——
// 比上一版整体放大：小脸在大画布里必然显得粗糙（缩到 32px 更明显）
const FACE_SHAPES = [
  { rx: 27, ry: 31, jaw: 0, chin: 0 },
  { rx: 30, ry: 28, jaw: 4, chin: 2 },
  { rx: 24, ry: 33, jaw: -2, chin: -4 },
  { rx: 29, ry: 30, jaw: 7, chin: 3 },
  { rx: 25, ry: 29, jaw: -6, chin: -6 },
  { rx: 28, ry: 29, jaw: 5, chin: 1 },
  { rx: 26, ry: 32, jaw: -3, chin: -2 },
]

/** 体型：影响脸宽与肩膀 */
const BUILDS = [
  { name: 'slim', scale: 0.95, w: 0.94 },
  { name: 'average', scale: 1, w: 1 },
  { name: 'broad', scale: 1.05, w: 1.1 },
  { name: 'tall', scale: 0.98, w: 1.03 },
  { name: 'small', scale: 0.9, w: 0.9 },
]

/**
 * 5 档肤色。
 *
 * 关键：这些是**绝对颜色**，直接给高饱和的皮肤色，
 * 而不是像上一版那样"从一个偏灰的底色提亮/压暗"。
 * 上一版提亮后是灰白、压暗后是脏褐，怎么调都浑浊。
 */
const SKIN_TONES = [
  { name: 'porcelain', base: '#f0cdb0' },
  { name: 'fair', base: '#e0b189' },
  { name: 'tan', base: '#c48f5f' },
  { name: 'brown', base: '#94643c' },
  { name: 'deep', base: '#5f3d29' },
]

/** 6 种发色：绝对色，且与肤色形成明确明度差 */
const HAIR_TONES = [
  { name: 'black', base: '#1a1a1e' },
  { name: 'brown', base: '#4a3222' },
  { name: 'ash', base: '#7d7466' },
  { name: 'blond', base: '#d9b463' },
  { name: 'red', base: '#9c3f22' },
  { name: 'white', base: '#e2ded6' },
]

/**
 * 6 套服装配色。
 * 每套给足三档：主色 / 暗部 / 亮部，靠**明度阶梯**而不是色相微调来分层，
 * 这样缩到 32px 时衣服仍有结构感。
 */
const CLOTH_SETS = [
  { light: '#5a6373', base: '#414a59', dark: '#2b323d' },
  { light: '#6b5a45', base: '#4d4033', dark: '#332b22' },
  { light: '#45635c', base: '#2f4a44', dark: '#1f322e' },
  { light: '#6b4a5c', base: '#4d3543', dark: '#33222c' },
  { light: '#4d5a6b', base: '#363f4d', dark: '#242a34' },
  { light: '#7a6a4a', base: '#574c36', dark: '#3a3224' },
]

const EYE_COLORS = ['#1b1b1b', '#3b2a16', '#20443f', '#2f3f6b', '#5a2a2a', '#2b4a2e']

const MOODS = ['neutral', 'smile', 'frown', 'smirk', 'open'] as const

const BEARDS = ['none', 'none', 'none', 'stubble', 'mustache', 'goatee', 'full'] as const

export type HairStyle = (typeof HAIRS)[number]
export type Accessory = (typeof ACCESSORIES)[number]

export interface AvatarTraits {
  face: number
  build: string
  hair: string
  headwear: string
  eyes: string
  brows: string
  mood: string
  beard: string
  accessory: string
  clothing: string
  skin: string
  hairTone: string
}

export interface GeneratedAvatar {
  traits: AvatarTraits
  dataUrl: string
  svg: string
}

export interface AvatarVariant {
  face?: number
  build?: number
  hair?: string
  headwear?: string
  eyes?: string
  brows?: string
  mood?: string
  beard?: string
  accessory?: string
  clothing?: string
  skin?: number
  hairTone?: number
}

/**
 * 生成头像。
 * @param key     稳定标识（优先用角色 id，改名不换脸）
 * @param label   aria-label
 * @param style   世界风格
 * @param tone    世界卡主色（点缀色）
 * @param variant 显式造型；传了就是可复用"素材"，不传则由 key 哈希决定
 */
export function generateAvatar(
  key: string,
  label: string,
  style: AvatarStyle | string = 'ink',
  tone?: string,
  variant?: AvatarVariant
): GeneratedAvatar {
  const def = getAvatarStyle(style)
  const rng = makeRng(hashSeed(`${def.id}::${key}`))

  const faceIdx = variant?.face !== undefined
    ? ((variant.face % FACE_SHAPES.length) + FACE_SHAPES.length) % FACE_SHAPES.length
    : Math.floor(rng() * FACE_SHAPES.length)
  const buildIdx = variant?.build !== undefined
    ? ((variant.build % BUILDS.length) + BUILDS.length) % BUILDS.length
    : Math.floor(rng() * BUILDS.length)

  const hair = variant?.hair ?? pick(rng, HAIRS)
  const headwear = variant?.headwear ?? pick(rng, HEADWEAR)
  const eyes = variant?.eyes ?? pick(rng, EYES)
  const brows = variant?.brows ?? pick(rng, BROWS)
  const mood = variant?.mood ?? pick(rng, MOODS)
  const accessory = variant?.accessory ?? pick(rng, ACCESSORIES)
  const clothing = variant?.clothing ?? pick(rng, CLOTHING)
  const skinIdx = variant?.skin !== undefined ? variant.skin % SKIN_TONES.length : Math.floor(rng() * SKIN_TONES.length)
  const hairIdx = variant?.hairTone !== undefined ? variant.hairTone % HAIR_TONES.length : Math.floor(rng() * HAIR_TONES.length)

  // 胡须：光头/短寸更有胡子气质；兜帽和面罩要留出空间
  let beard = variant?.beard
  if (beard === undefined) {
    const canHaveBeard = headwear !== 'hood' && accessory !== 'mask' && accessory !== 'visor'
    beard = canHaveBeard ? pick(rng, BEARDS) : 'none'
    if ((hair === 'bald' || hair === 'crop' || hair === 'mohawk') && canHaveBeard && rng() < 0.55) {
      beard = pick(rng, ['stubble', 'goatee', 'full'] as const)
    }
  }

  const face = FACE_SHAPES[faceIdx]
  const build = BUILDS[buildIdx]
  const skinTone = SKIN_TONES[skinIdx]
  const hTone = HAIR_TONES[hairIdx]

  const rx = face.rx * build.scale * build.w
  const ry = face.ry * build.scale
  const cx = FIG_W / 2
  // 头放上部：圆内切时刚好是「头 + 一点肩」，圆形与方形容器都不裁到脸
  const cy = 32
  const jawW = rx + face.jaw * 0.5
  const chinY = cy + ry + face.chin

  // 肤色：直接用绝对色。冷色风格（霓虹/全息）往青灰拉一点，避免"暖脸配冷背景"。
  const baseSkin = def.cool ? blendHex(skinTone.base, '#a8bcc4', 0.28) : skinTone.base
  const skin = baseSkin
  const skinDark = shadeHex(skin, -17)

  // 头发：主色 + 明确更暗的暗部，形成可辨认的发丝分层
  const hairBase = hTone.base
  const hairMain = def.cool ? blendHex(hairBase, '#7f97a8', 0.16) : hairBase
  const hairDark = shadeHex(hairMain, -13)

  // 服装：三档明度，靠阶梯而不是色相微调分层
  const cset = pick(rng, CLOTH_SETS)
  const cloth = cset.base
  const clothDark = cset.dark
  const clothLight = cset.light
  const accent = tone || def.accent

  const c: PartCtx = {
    skin, skinDark,
    hair: hairMain, hairDark,
    cloth, clothDark, clothLight,
    accent,
    stroke: def.stroke, lw: def.lineWidth,
    cx, cy, rx, ry, jawW, chinY,
  }

  const seed = hashSeed(`${def.id}::${key}`)
  const parts: string[] = []

  // —— 背景（不缩放，铺满整个画布）——
  parts.push(`<rect width="${FIG_W}" height="${FIG_H}" fill="url(#g${seed})"/>`)
  if (def.scanlines) {
    const lines: string[] = []
    for (let y = 2; y < FIG_H; y += 4) {
      lines.push(`<rect x="0" y="${y}" width="${FIG_W}" height="1" fill="${def.stroke}" opacity="0.05"/>`)
    }
    parts.push(lines.join(''))
  }

  /**
   * —— 人物（整体缩放）——
   *
   * 为什么缩到 0.86：圆形裁切 + 32px 显示时，满尺寸只能看到一个头，
   * 发型/头饰/服装的剪影全被裁掉，辨识度反而下降。
   * 缩小后圆形里是「头 + 肩」，轮廓特征（宽檐帽的檐、兜帽的外扩、
   * 高领、肩甲）才能进入画面。
   * 基准点选 (48,52) 而不是画布中心，缩放后头顶仍在圆内、且略微上移更耐看。
   */
  const body: string[] = []

  // —— 身体 ——
  body.push(drawTorso(c, clothing))

  // —— 脖子 ——
  body.push(
    `<rect x="${(cx - 7 * build.w).toFixed(1)}" y="${(cy + ry - 8).toFixed(1)}" ` +
    `width="${(14 * build.w).toFixed(1)}" height="16" fill="${skinDark}"/>`
  )

  // —— 后发 ——
  body.push(drawHairBack(c, hair))

  // —— 耳朵 ——
  const earY = cy + 3
  body.push(
    `<ellipse cx="${(cx - rx - 1).toFixed(1)}" cy="${earY}" rx="3.8" ry="6" fill="${skinDark}" stroke="${def.stroke}" stroke-width="${def.lineWidth * 0.7}" stroke-opacity="0.45"/>` +
    `<ellipse cx="${(cx + rx + 1).toFixed(1)}" cy="${earY}" rx="3.8" ry="6" fill="${skinDark}" stroke="${def.stroke}" stroke-width="${def.lineWidth * 0.7}" stroke-opacity="0.45"/>`
  )

  // —— 头 ——
  body.push(
    `<path d="M${(cx - rx).toFixed(1)} ${cy} A${rx.toFixed(1)} ${ry.toFixed(1)} 0 1 1 ${(cx + rx).toFixed(1)} ${cy} ` +
    `C${(cx + jawW).toFixed(1)} ${(chinY - 6).toFixed(1)} ${cx + 8} ${chinY.toFixed(1)} ${cx} ${chinY.toFixed(1)} ` +
    `C${cx - 8} ${chinY.toFixed(1)} ${(cx - jawW).toFixed(1)} ${(chinY - 6).toFixed(1)} ${(cx - rx).toFixed(1)} ${cy} Z" ` +
    `fill="${skin}" stroke="${def.stroke}" stroke-width="${def.lineWidth}" stroke-opacity="0.65"/>`
  )

  // —— 五官 / 前发 / 头饰 / 配件 ——
  body.push(drawEyes(c, eyes, brows, eyeColorFor(rng)))
  body.push(drawMouth(c, mood, beard, hairMain))
  body.push(drawHairFront(c, hair))
  body.push(drawHeadwear(c, headwear, hairMain))
  body.push(drawAccessory(c, accessory))

  parts.push(`<g transform="translate(${FIG_W / 2} 52) scale(${BODY_SCALE}) translate(${-FIG_W / 2} -52)">${body.join('')}</g>`)

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FIG_W} ${FIG_H}" width="${FIG_W}" height="${FIG_H}" role="img" aria-label="${escapeXml(label)}">` +
    `<defs><linearGradient id="g${seed}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="${def.bg[0]}"/><stop offset="100%" stop-color="${def.bg[1]}"/>` +
    `</linearGradient></defs>` +
    parts.join('') +
    `</svg>`

  return {
    traits: {
      face: faceIdx, build: build.name, hair, headwear, eyes, brows, mood, beard,
      accessory, clothing, skin: skinTone.name, hairTone: hairMain,
    },
    dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    svg,
  }
}

function eyeColorFor(rng: () => number): string {
  return EYE_COLORS[Math.floor(rng() * EYE_COLORS.length) % EYE_COLORS.length]
}

/**
 * 人物在画布内的缩放比。
 * Math.sqrt(0.75) ≈ 0.866 —— 面积缩到 75%，圆形裁切下能露出肩部轮廓。
 */
const BODY_SCALE = 0.866

// ============================================================================
// 统一解析
// ============================================================================

/**
 * 优先级：角色卡自带图片 > 素材库 id > 按稳定标识程序化生成。
 * 最后一种永远不会失败，所以"有没有素材"不再是显示的前提。
 */
export function resolveAvatar(options: {
  key: string
  label: string
  image?: string
  avatarId?: string
  style?: string
  tone?: string
}): string {
  const { key, label, image, avatarId, style, tone } = options
  if (image) return image
  if (avatarId && isKnownAvatarId(avatarId)) {
    const asset = generateCatalogAvatar(avatarId, label, style, tone)
    if (asset) return asset.dataUrl
  }
  return generateAvatar(key, label, style || 'ink', tone).dataUrl
}

// ============================================================================
// 颜色
// ============================================================================

function blendHex(a: string, b: string, t: number): string {
  const pa = parseHex(a)
  const pb = parseHex(b)
  if (!pa || !pb) return a
  const f = (x: number, y: number) => Math.round(x + (y - x) * t)
  const r = f(pa[0], pb[0])
  const g = f(pa[1], pb[1])
  const bl = f(pa[2], pb[2])
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

export { shadeHex }

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (ch) =>
    ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch === '"' ? '&quot;' : '&apos;'
  )
}

// ============================================================================
// 素材库（供 AI 挑选）
// ============================================================================

export interface AssetEntry {
  id: string
  label: string
  /** 可选：真实图片路径。填了就跳过程序化生成 */
  image?: string
  variant: AvatarVariant
}

const HAIR_LABEL: Record<string, string> = {
  bald: '光头', crop: '寸头', short: '短发', bob: '齐耳短发', long: '长发',
  bun: '丸子头', ponytail: '马尾', mohawk: '莫西干', topknot: '高发髻', curly: '卷发',
}
const HEADWEAR_LABEL: Record<string, string> = {
  none: '', hood: '兜帽', hat: '宽檐帽', helm: '头盔', circlet: '额饰',
  bandana: '头巾', crown: '冠冕', goggles: '护目镜（架在额头）',
}
const ACC_LABEL: Record<string, string> = {
  none: '', glasses: '方框眼镜', roundspecs: '圆框眼镜', shades: '墨镜', visor: '全息面罩',
  eyepatch: '单眼罩', monocle: '单片眼镜', mask: '下半脸面罩', scar: '面部刀疤',
  facepaint: '面部纹样', earring: '耳饰', headset: '通讯耳机', pipe: '烟斗', pendant: '项坠',
}
const EYE_LABEL: Record<string, string> = {
  plain: '', wide: '大眼', narrow: '细长眼', sleepy: '困倦眼', sharp: '锐利眼',
  closed: '眯眼', glow: '发光眼',
}
const BUILD_LABEL: Record<string, string> = {
  slim: '瘦', average: '', broad: '壮硕', tall: '高挑', small: '矮小',
}
const CLOTH_LABEL: Record<string, string> = {
  tunic: '交领衣', coat: '敞开外套', armor: '胸甲', robe: '长袍', jacket: '夹克', rags: '破布衣',
}
const BEARD_LABEL: Record<string, string> = {
  none: '', stubble: '胡茬', mustache: '八字胡', goatee: '山羊胡', full: '络腮胡',
}

/**
 * 构建素材库。
 * 按维度程序化枚举，加部件时自动扩容，不会漏配 id。
 * 用互质步长打散各维度，避免"每 7 条重复一次脸"这类节律。
 */
function buildCatalog(): AssetEntry[] {
  const out: AssetEntry[] = []
  const F = FACE_SHAPES.length
  const B = BUILDS.length
  const SK = SKIN_TONES.length
  const HT = HAIR_TONES.length
  const EY = EYES.length
  const BR = BROWS.length
  const MO = MOODS.length

  let i = 0
  for (const hair of HAIRS) {
    for (const accessory of ACCESSORIES) {
      // 头饰与发型要相容：兜帽/头盔/护目镜不适合爆炸头与高发髻
      let headwear: string = HEADWEAR[(i * 3) % HEADWEAR.length]
      const incompatible =
        (headwear === 'hood' || headwear === 'helm' || headwear === 'goggles' || headwear === 'hat') &&
        (hair === 'curly' || hair === 'mohawk' || hair === 'topknot')
      if (incompatible) headwear = 'none'

      const clothing = CLOTHING[(i * 5) % CLOTHING.length]
      // 面罩/面罩类配件与胡须冲突
      const beardBlocked = accessory === 'mask' || accessory === 'visor'
      const beard = beardBlocked
        ? 'none'
        : (hair === 'bald' || hair === 'crop' || hair === 'mohawk')
          ? (['stubble', 'goatee', 'full', 'none'] as const)[i % 4]
          : 'none'

      const bits = [
        BUILD_LABEL[BUILDS[(i * 2) % B].name],
        HAIR_LABEL[hair],
        SKIN_TONES[(i * 3) % SK].name,
        HEADWEAR_LABEL[headwear],
        CLOTH_LABEL[clothing],
        BEARD_LABEL[beard],
        EYE_LABEL[EYES[(i * 2) % EY]],
        ACC_LABEL[accessory],
      ].filter(Boolean)

      out.push({
        id: `p${String(i + 1).padStart(2, '0')}`,
        label: bits.join('、'),
        variant: {
          hair,
          accessory,
          headwear,
          clothing,
          beard,
          face: (i * 3) % F,
          build: (i * 2) % B,
          skin: (i * 3) % SK,
          hairTone: (i * 5) % HT,
          eyes: EYES[(i * 2) % EY],
          brows: BROWS[(i * 3) % BR],
          mood: MOODS[(i * 4) % MO],
        },
      })
      i++
    }
  }
  return out
}

export const AVATAR_CATALOG: AssetEntry[] = buildCatalog()

const CATALOG_BY_ID = new Map(AVATAR_CATALOG.map(a => [a.id, a]))

export function isKnownAvatarId(id?: string): boolean {
  return !!id && CATALOG_BY_ID.has(id)
}

export function getAvatarAsset(id?: string): AssetEntry | undefined {
  return id ? CATALOG_BY_ID.get(id) : undefined
}

/** 按 id 生成一张素材头像 */
export function generateCatalogAvatar(id: string, label: string, style?: string, tone?: string): GeneratedAvatar | null {
  const asset = CATALOG_BY_ID.get(id)
  if (!asset) return null
  return generateAvatar(id, label, style, tone, asset.variant)
}

/**
 * 给 AI 的素材清单文本（一行一条，控制提示词长度）。
 *
 * ## 为什么要瘦身（2026-11，玩家报「用 gemini 时速度极慢」）
 *
 * 这个清单有 140 条，每条 label 是拼出来的长相（`瘦、光头、porcelain、交领衣、胡茬`）。
 * 原样发出去是 **4256 字符**，而数据 AI 的整份提示词才 16522 字符 ——
 * 这一个清单就占了四分之一，模型每轮都要读完它才轮到干活。
 *
 * 减掉两类东西，一条都不丢、挑得还是一样准：
 *
 * - **英文色值 key**（`porcelain` / `brown` / `deep` / `tan`）——那是渲染用的材质名，
 *   对"挑哪一个最贴合描写"没有任何信息量；
 * - **第 5 项以后的特征** ——四个特征足够区分 140 个头像，
 *   而 label 平均 25 字符，砍掉一半还多。
 *
 * 顺手在末尾补一句说明，因为 id 是 `p01`~`p140` 这种纯编号，
 * 不说清楚模型会以为 `p` 后面那个数字有意义。
 */
export function avatarCatalogPrompt(): string {
  const rows = AVATAR_CATALOG.map(a => {
    const feats = String(a.label)
      .split('、')
      .map(s => s.trim())
      .filter(s => /[\u4e00-\u9fff]/.test(s))
      .slice(0, 4)
    const label = feats.length ? feats.join('、') : String(a.label).slice(0, 10)
    return `${a.id}=${label}`
  })
  return `${rows.join('；')}\n（id 只是编号，看等号后面的长相特征挑。）`
}

/**
 * 校验并去重 AI 给出的 avatarId。
 * 模型会编造清单外的 id（幻觉），也可能把同一个 id 给多个角色 —— 两者都会伤观感。
 * 返回 undefined 表示不接受，由 resolveAvatar 按角色 id 哈希生成一张独有的脸。
 */
export function pickAvatarId(
  proposed: unknown,
  selfId: string,
  taken: Iterable<string | undefined>
): string | undefined {
  if (typeof proposed !== 'string') return undefined
  const used = new Set<string>()
  for (const t of taken) {
    if (t && t !== selfId) used.add(t)
  }
  if (!isKnownAvatarId(proposed)) return undefined
  if (used.has(proposed)) return undefined
  return proposed
}
