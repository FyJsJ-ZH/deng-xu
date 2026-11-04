/**
 * 复制到剪贴板 —— 2026-11 第二十二轮。
 *
 * ## 为什么要单独测这个
 *
 * 它看着只有三行，但**失败是静默的**：玩家以为抄好了，粘贴出来是空的，
 * 而这件事在手机上比在桌面上常见得多（权限被拒、非安全上下文、
 * iOS 要求调用发生在用户手势的同一个任务里）。
 *
 * 所以这里钉住的是**降级链**：现代 API → textarea + execCommand → 返回 false。
 * 任何一环"吞掉错误并假装成功"，都会让按钮显示"已复制"而剪贴板是空的。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { copyText } from './clipboard'

/** 一个够用的假 document：只实现 copyText 会碰的那几个方法 */
function stubDocument(execResult: boolean) {
  const ta = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
  }
  const doc = {
    createElement: vi.fn(() => ta),
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
    execCommand: vi.fn(() => execResult),
  }
  vi.stubGlobal('document', doc)
  return { doc, ta }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('copyText', () => {
  it('空文本直接返回 false，不碰任何 API', async () => {
    const writeText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    expect(await copyText('')).toBe(false)
    expect(await copyText('   ')).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('现代 API 可用时走它', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    expect(await copyText('提出收养小满')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('提出收养小满')
  })

  it('★ 现代 API 抛错（权限被拒 / 非 https）时退回 textarea 路径', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { doc, ta } = stubDocument(true)

    expect(await copyText('要复制的一段')).toBe(true)
    expect(doc.execCommand).toHaveBeenCalledWith('copy')
    // 值必须真的塞进去、并且被选中 —— 否则复制到的是上一次的内容
    expect(ta.value).toBe('要复制的一段')
    expect(ta.select).toHaveBeenCalled()
    expect(ta.setSelectionRange).toHaveBeenCalledWith(0, 6)
    // 临时节点要收干净：留在 DOM 里会污染后续的 focus
    expect(doc.body.removeChild).toHaveBeenCalled()
  })

  it('★ 没有 navigator.clipboard（老浏览器 / http）也走 textarea', async () => {
    vi.stubGlobal('navigator', {})
    stubDocument(true)
    expect(await copyText('abcd')).toBe(true)
  })

  it('★ 两条路都失败 → false，绝不假装成功', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('nope')) },
    })
    stubDocument(false)
    expect(await copyText('x')).toBe(false)
  })

  it('连 document 都没有（极端环境）→ false，不抛异常', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', undefined)
    expect(await copyText('x')).toBe(false)
  })
})
