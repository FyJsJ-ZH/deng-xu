/**
 * 从 PNG 角色卡里取 SillyTavern 数据。
 *
 * ## 为什么值得单独测
 *
 * 这条路径**没有任何报错的机会**：PNG 解析是按字节偏移走的，
 * 偏移算错一位，得到的就是一段"看起来像 JSON"的垃圾，然后 `JSON.parse` 抛，
 * 用户看到的是"文件不是合法 JSON"—— 而文件其实完全正常。
 *
 * 所以这里钉的是**结构**：chunk 边界、`iTXt` 的三个 \0 分隔、base64 → UTF-8。
 */
import { describe, it, expect } from 'vitest'
import { readStCardFromPng, bookOfCard, hasBook } from './pngCard'

/** 拼一个最小 PNG：只放这条路径会读的 chunk（CRC 由本模块跳过，填 0 即可） */
function buildPng(chunks: { type: string; data: Uint8Array }[]): ArrayBuffer {
  const parts: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (const c of chunks) {
    const len = c.data.length
    parts.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff)
    for (const ch of c.type) parts.push(ch.charCodeAt(0))
    parts.push(...Array.from(c.data))
    parts.push(0, 0, 0, 0)   // CRC 占位
  }
  return new Uint8Array(parts).buffer
}

const enc = (s: string) => new TextEncoder().encode(s)

function textChunk(key: string, value: string) {
  return { type: 'tEXt', data: enc(`${key}\u0000${value}`) }
}

/** 把对象按 ST 的方式编码：UTF-8 → base64 */
function stEncode(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

const card = {
  spec: 'chara_card_v3',
  data: {
    name: '黑色修士',
    description: '',
    character_book: {
      name: '黑色修士',
      entries: [
        { keys: ['绯夜'], content: '色欲司掌者。' },
        { keys: ['柳不移'], content: '散修联盟盟主。' },
      ],
    },
  },
}

describe('readStCardFromPng', () => {
  it('★ 从 tEXt 的 chara 里取出卡（含中文，必须走 UTF-8）', () => {
    const buf = buildPng([textChunk('chara', stEncode(card))])
    const out = readStCardFromPng(buf) as typeof card
    expect(out).not.toBeNull()
    expect(out.data.name).toBe('黑色修士')
    expect(out.data.character_book.entries).toHaveLength(2)
  })

  it('ccv3 优先于 chara', () => {
    const v2 = { name: '旧版' }
    const buf = buildPng([textChunk('chara', stEncode(v2)), textChunk('ccv3', stEncode(card))])
    const out = readStCardFromPng(buf) as typeof card
    expect(out.data.name).toBe('黑色修士')
  })

  it('★ iTXt 的偏移：跳过「压缩标志 + 语言标签 + 译文关键字」三段', () => {
    // 结构：keyword \0 flag(0) method(0) languageTag \0 translatedKeyword \0 text
    const payload = stEncode(card)
    const data = enc(`chara\u0000\u0000\u0000zh\u0000中文名\u0000${payload}`)
    const buf = buildPng([{ type: 'iTXt', data }])
    const out = readStCardFromPng(buf) as typeof card
    expect(out?.data?.name).toBe('黑色修士')
  })

  it('不是 PNG → null（WebP / JPEG 存不了卡数据）', () => {
    const buf = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).buffer
    expect(readStCardFromPng(buf)).toBeNull()
  })

  it('PNG 但没有 chara → null', () => {
    const buf = buildPng([textChunk('Software', 'some-editor')])
    expect(readStCardFromPng(buf)).toBeNull()
  })

  it('★ base64 坏了 → null，而不是抛异常（导入路径不能因为一张坏图就崩）', () => {
    const buf = buildPng([textChunk('chara', '这不是base64!!!')])
    expect(readStCardFromPng(buf)).toBeNull()
  })

  it('空文件 → null', () => {
    expect(readStCardFromPng(new ArrayBuffer(0))).toBeNull()
  })
})

describe('bookOfCard / hasBook', () => {
  it('V3 在 data.character_book', () => {
    expect(bookOfCard(card)).toBe(card.data.character_book)
  })

  it('V2 在顶层 character_book', () => {
    const v2 = { name: 'x', character_book: { entries: [{ content: 'a' }] } }
    expect(bookOfCard(v2)).toBe(v2.character_book)
  })

  it('★ 只有空 entries 的书不算有书（否则会导入一张空白世界卡）', () => {
    expect(hasBook({ data: { character_book: { entries: [] } } })).toBe(false)
    expect(hasBook(card)).toBe(true)
    expect(hasBook({ data: { name: '普通角色卡' } })).toBe(false)
    expect(hasBook(null)).toBe(false)
  })

  it('entries 是对象 map（旧 ST 写法）也认', () => {
    expect(hasBook({ character_book: { entries: { 0: { content: 'a' } } } })).toBe(true)
  })
})
