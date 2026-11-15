/**
 * 拒答识别（2026-11）。
 *
 * ## 玩家报的事
 *
 * 「这个预填真的起作用了吗，前面已经破甲了下一轮又被拒绝了」。
 *
 * 查下来不是预填的事 —— 是**拒答从来没有被识别**。
 *
 * 模型拒答时返回的不是错误、也不是空串，而是一小段话：
 * 「我无法继续这个场景。如果你愿意，我们可以……」。
 * 它通过了所有已有检查（不是空包、不是 `finish_reason: length`），于是被当成正文：
 *
 *  1. 写进 `history` —— 下一轮模型看着自己刚拒绝过，接着拒，而且更快；
 *  2. 被 `detectTruncation` 判成「写短了」，触发**续写** ——
 *     系统拿「你是续写助手，接着最后一个字写完」再要一次，模型就接着拒。
 *
 * 两种情况都比原文更糟。所以判据的第一要求是：**能在它进历史之前抓住它**。
 */
import { describe, it, expect } from 'vitest'
import { detectRefusal } from '@/utils/truncation'

describe('detectRefusal：认出拒答', () => {
  it('★ 最常见的三种开场', () => {
    const cases = [
      '很抱歉，我无法继续这个场景。',
      '我无法提供这类内容。如果换成另一个设定，我很乐意帮忙。',
      '作为一个 AI 助手，我不能写这种描写。',
    ]
    for (const t of cases) {
      expect(detectRefusal(t, 1800).refused, t).toBe(true)
    }
  })

  it('英文拒答也认', () => {
    expect(detectRefusal("I'm sorry, but I can't continue this scene.", 1800).refused).toBe(true)
    expect(detectRefusal("I cannot write this content.", 1800).refused).toBe(true)
  })

  it('★ 不点名"无法"、但明显在推辞（弱证据，置信度 low）', () => {
    const r = detectRefusal('这个场景涉及的内容不太适合我展开。我们可以换个方向继续。', 1800)
    expect(r.refused).toBe(true)
    expect(r.confidence).toBe('low')
  })
})

describe('★ 不误伤：这些必须判成正常正文', () => {
  it('长正文里某处出现"我不能" —— 那是人物在说话', () => {
    const body = '他把杯子推回去。\n「我不能。」\n'
      + '屋子里安静了一会儿，窗外有人在收摊，铁皮撞在石板上。'.repeat(20)
    expect(detectRefusal(body, 1800).refused).toBe(false)
  })

  it('短场景里的对话（整段就是一句拒绝）也不算', () => {
    const body = '「我不能。」她把信折好，塞回抽屉。'
    // 开头不是话术，而是引号里的台词 —— 强判据只认"开头就是我/抱歉"
    expect(detectRefusal(body, 1800).refused).toBe(false)
  })

  it('正常开场的正文（哪怕很短）不算', () => {
    expect(detectRefusal('他推开门。屋里没有人。', 1800).refused).toBe(false)
  })

  it('空串不判拒答（那是另一条路径）', () => {
    expect(detectRefusal('', 1800).refused).toBe(false)
    expect(detectRefusal('   ', 1800).refused).toBe(false)
  })

  it('★ 拒答话术后紧跟大段叙事 → 不算（模型先道个歉然后照写了）', () => {
    const body = '抱歉，我理解这个场景比较激烈。\n\n' + '他推开门，冷风灌进来。'.repeat(120)
    // 长度超过目标的五成，说明它真的写了
    expect(detectRefusal(body, 1800).refused).toBe(false)
  })
})

describe('长度闸：拒答不会真的铺开写', () => {
  it('目标 1800 字时，900 字以上不再判拒答', () => {
    const body = '我无法继续这个场景。' + '字'.repeat(900)
    expect(detectRefusal(body, 1800).refused).toBe(false)
  })

  it('目标 800 字时，闸门是 600（不低于 600）', () => {
    // 800 * 0.5 = 400，max(600, 400) = 600
    const body = '我无法继续这个场景。' + '字'.repeat(500)
    expect(body.length).toBeLessThan(600)
    expect(detectRefusal(body, 800).refused).toBe(true)
  })

  it('不传目标字数时按 600 兜底', () => {
    expect(detectRefusal('我无法继续这个场景。', undefined).refused).toBe(true)
    expect(detectRefusal('我无法继续这个场景。' + '字'.repeat(700), undefined).refused).toBe(false)
  })
})
