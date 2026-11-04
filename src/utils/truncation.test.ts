import { describe, it, expect } from 'vitest'
import { detectTruncation } from '@/utils/truncation'

describe('叙事截断检测', () => {
  describe('正常输出不该被误报（这是最重要的）', () => {
    const normal = [
      '他推开门，冷风灌了进来。',
      '「你终于来了。」她说。',
      '街上没有人。灯柱上的烛火晃了一下，又稳住了。',
      '你听见远处传来钟声——只有一声。',
      'The door opened.\n\nNobody was there.',
      '第一段。\n\n第二段结束得更彻底。',
      '她笑了（那种笑你见过一次）。',
      '他问：「你确定吗？」',
    ]
    for (const t of normal) {
      it(`正常：${t.slice(0, 22)}…`, () => {
        expect(detectTruncation(t).truncated).toBe(false)
      })
    }

    it('空串不算截断（由另一条路径处理）', () => {
      expect(detectTruncation('').truncated).toBe(false)
      expect(detectTruncation('   ').truncated).toBe(false)
    })

    it('短但完整的句子不算截断（不能因为短就报）', () => {
      expect(detectTruncation('好。').truncated).toBe(false)
      // 即使期望篇幅很长，只要句子收住了就不报
      expect(detectTruncation('他走了。', 600).truncated).toBe(false)
    })
  })

  describe('强证据：应当判定为截断', () => {
    it('引号没闭合', () => {
      const r = detectTruncation('他说：「我们得走了，不然')
      expect(r.truncated).toBe(true)
      expect(r.confidence).toBe('high')
      expect(r.reason).toContain('「」')
    })

    it('书名号没闭合', () => {
      const r = detectTruncation('他翻开《灰烬回响')
      expect(r.truncated).toBe(true)
      expect(r.confidence).toBe('high')
    })

    it('括号没闭合', () => {
      const r = detectTruncation('她停下脚步（那种停顿')
      expect(r.truncated).toBe(true)
      expect(r.confidence).toBe('high')
    })

    it('结尾停在连接词上', () => {
      for (const tail of ['因为', '所以', '但是', '然后', '于是', '而且', '如果']) {
        const r = detectTruncation(`他之所以停下，是${tail}`)
        expect(r.truncated, `尾部「${tail}」应被识别`).toBe(true)
        expect(r.confidence).toBe('high')
      }
    })

    it('结尾停在助词上', () => {
      const r = detectTruncation('那是他的')
      expect(r.truncated).toBe(true)
    })
  })

  describe('弱证据', () => {
    it('结尾停在逗号/冒号上、没有收束标点 → 弱证据', () => {
      const r = detectTruncation('他走进屋子，看见桌上摆着三只杯子，')
      expect(r.truncated).toBe(true)
      expect(r.confidence).toBe('low')
    })

    it('明显短于设定篇幅且没有收束标点 → 弱证据', () => {
      const r = detectTruncation('他推开门，冷风灌了进来，街上没有', 600)
      expect(r.truncated).toBe(true)
      expect(r.confidence).toBe('low')
    })

    it('短但有收束标点 → 不报（避免误报）', () => {
      expect(detectTruncation('他推开门。', 600).truncated).toBe(false)
    })

    it('以名词收尾、无收束标点 → 不报（弱证据要求有句中标点或明显过短）', () => {
      // 这条是「宁可漏报不可误报」的体现：光看结尾是名词无法断定被截断
      expect(detectTruncation('他走进屋子，看见桌上摆着三只杯子').truncated).toBe(false)
    })
  })

  describe('reason 是可显示给玩家的中文', () => {
    const samples = [
      '他说：「我们得走了，不然',
      '他之所以停下，是因为',
      '他走进屋子',
    ]
    it('每条判定都带可读理由', () => {
      for (const s of samples) {
        const r = detectTruncation(s, 600)
        if (r.truncated) {
          expect(r.reason).toBeTruthy()
          expect(r.reason!).toMatch(/[\u4e00-\u9fa5]/)
          expect(r.reason!).not.toMatch(/[{}]/)
        }
      }
    })
  })
})

/**
 * `finish_reason` 与新的字数阈值（2026-11）。
 *
 * ## 玩家原话
 * > 「现在的每次对话字数依旧连 1000 字都没有」
 *
 * 根因有两个，都在这组测试里：
 *  1. **代码从来没看 `finish_reason`** —— 只能靠"结尾有没有句号"猜。
 *     可模型撞上限时很会**把话说圆**（刚好收在句号上），两个弱判据都不成立，
 *     于是"被切断"被判成"写完了"，续写逻辑不触发。
 *  2. **"明显偏短"的阈值是 0.35**：1800×0.35 = 630 字。也就是说 900 字算"够长"。
 */
describe('finish_reason=length · 唯一确定的证据', () => {
  it('★ 接口说撞上限了，就一定是撞了（哪怕文本看着完整）', () => {
    const r = detectTruncation('他说完这句话就走了。', 1800, 'length')
    expect(r.truncated).toBe(true)
    expect(r.confidence).toBe('high')
    expect(r.reason).toMatch(/token 上限/)
  })

  it('finish_reason=stop 时照常走启发式（不给它乱扣截断的帽子）', () => {
    expect(detectTruncation('他说完这句话就走啊。', 100, 'stop').truncated).toBe(false)
  })

  it('大小写都认；别的值不算强证据', () => {
    expect(detectTruncation('很短。', 1800, 'STOP').truncated).toBe(false)
    expect(detectTruncation('很短。', 1800, 'LENGTH').truncated).toBe(true)
  })
})

describe('字数明显偏短 · 阈值提到 0.55', () => {
  it('★ 960 字的完整收尾也要判（期望 1800，只写了一半）', () => {
    const text = '他走进当铺，柜台后的人抬起头。'.repeat(60)   // 15 字 × 60 = 900
    const r = detectTruncation(text, 1800)
    expect(text.length).toBeGreaterThanOrEqual(900)
    expect(r.truncated).toBe(true)
    expect(r.confidence).toBe('low')
  })

  it('★ 短场景不误报（200 字以下，哪怕离期望很远）', () => {
    expect(detectTruncation('他摇了摇头，没说话。', 1800).truncated).toBe(false)
  })

  it('够长的正常收尾不报（提阈值不能变成"什么都报"）', () => {
    const text = '他走进当铺，柜台后的人抬起头。'.repeat(120)   // 1920 字
    expect(detectTruncation(text, 1800).truncated).toBe(false)
  })
})
