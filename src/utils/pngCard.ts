/**
 * 从 **PNG 角色卡**里取出 SillyTavern 的数据（2026-11 第二十六轮）
 *
 * ## 为什么需要它
 *
 * 玩家丢进来一张 3.4MB 的 PNG 和一张 WebP，问"怎么用"。
 * 本作的导入器只吃 JSON —— PNG 连 `JSON.parse` 都过不去，
 * 界面上表现为"点了没反应 / 文件不是合法 JSON"，而那张卡里
 * 装着 226 条、26 万字的设定。
 *
 * 而 ST 生态里"重设定卡"大量是这个形态：卡片的 `description` 是空的，
 * 内容全在 `character_book` 里。不认 PNG，等于把这些卡整批挡在门外。
 *
 * ## ST 怎么把 JSON 塞进图片
 *
 * PNG 是按 chunk 组织的。ST 在文件末尾附近写一个 `tEXt` chunk：
 *
 * ```
 * 关键字 "chara" \0 base64(UTF-8 JSON)
 * ```
 *
 * 新版还会再写一份 `ccv3`（内容通常与 `chara` 相同，作者导出时重复存了一遍 ——
 * 那张 3.4MB 的卡里 2.5MB 是这两份）。
 *
 * ## 两个容易踩的点
 *
 * 1. **必须解 base64 再按 UTF-8 解码**。`atob()` 出来的是"每个字符一个字节"的
 *    二进制字符串，直接 `JSON.parse` 会把中文全部解成乱码；
 * 2. **`iTXt` 的头比 `tEXt` 长**（压缩标志 + 语言标签 + 译文关键字），
 *    偏移算错会读到乱码，而且不会报错 —— 只会得到一份"看起来像 JSON"的垃圾。
 */

type Chunk = { type: string; data: Uint8Array }

/** 逐 chunk 走一遍 PNG。遇到 IEND 或数据用尽就停。 */
function readChunks(buf: ArrayBuffer): Chunk[] {
  const bytes = new Uint8Array(buf)
  if (bytes.length < 8) return []
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) if (bytes[i] !== magic[i]) return []

  const view = new DataView(buf)
  const out: Chunk[] = []
  let i = 8
  while (i + 8 <= bytes.length) {
    const len = view.getUint32(i)
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7])
    const start = i + 8
    if (start + len > bytes.length) break
    out.push({ type, data: bytes.subarray(start, start + len) })
    i = start + len + 4   // 跳过 CRC
    if (type === 'IEND') break
  }
  return out
}

/** 从 `tEXt` / `iTXt` 里按关键字取值（返回**原始字符串**，还没 base64 解码） */
function textChunk(chunk: Chunk): { key: string; value: string } | null {
  const { type, data } = chunk
  const nul = data.indexOf(0)
  if (nul < 0) return null
  const key = String.fromCharCode(...data.subarray(0, nul))

  if (type === 'tEXt') {
    // 严格来说 tEXt 是 latin1，但 ST 写的是 base64（纯 ASCII），无差别
    let s = ''
    for (let i = nul + 1; i < data.length; i++) s += String.fromCharCode(data[i])
    return { key, value: s }
  }

  if (type === 'iTXt') {
    /*
      iTXt 的结构：
        keyword \0  compressionFlag(1)  compressionMethod(1)
        languageTag \0  translatedKeyword \0  text(UTF-8)
      漏掉任何一段，取到的都是偏移错位的乱码。
    */
    let p = nul + 1
    const compFlag = data[p]
    p += 2
    for (let n = 0; n < 2; n++) {
      const q = data.indexOf(0, p)
      p = q < 0 ? data.length : q + 1
    }
    if (compFlag === 1) return { key, value: '' }   // zlib 压缩过，本模块不解
    const body = data.subarray(p)
    return { key, value: new TextDecoder().decode(body) }
  }

  return null
}

/** base64 → UTF-8 文本 */
function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/**
 * 读 PNG 角色卡。不是 PNG、或里面没有卡数据时返回 `null`。
 *
 * 返回的是**解好的整张卡 JSON**（V2 会把字段摊平，V3 在 `data` 里），
 * 调用方通常只需要 `card.data?.character_book ?? card.character_book`。
 */
export function readStCardFromPng(buf: ArrayBuffer): unknown | null {
  const chunks = readChunks(buf)
  if (!chunks.length) return null

  let raw = ''
  for (const c of chunks) {
    if (c.type !== 'tEXt' && c.type !== 'iTXt') continue
    const t = textChunk(c)
    if (!t) continue
    if (t.key === 'ccv3' && t.value) { raw = t.value; break }   // 优先 V3
    if (t.key === 'chara' && t.value) raw = t.value
  }
  if (!raw) return null

  try {
    return JSON.parse(decodeBase64Utf8(raw))
  } catch {
    return null
  }
}

/** 从卡 JSON 里取世界书（V3 在 `data.character_book`，V2 可能在顶层） */
export function bookOfCard(card: unknown): unknown | null {
  if (!card || typeof card !== 'object') return null
  const c = card as { data?: { character_book?: unknown }; character_book?: unknown }
  return c.data?.character_book ?? c.character_book ?? null
}

/** 这张卡里有没有可用的世界书 */
export function hasBook(card: unknown): boolean {
  const book = bookOfCard(card)
  if (!book || typeof book !== 'object') return false
  const entries = (book as { entries?: unknown }).entries
  if (Array.isArray(entries)) return entries.length > 0
  if (entries && typeof entries === 'object') return Object.keys(entries).length > 0
  return false
}
