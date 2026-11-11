import { describe, it, expect } from 'vitest'
import { describeEmptyNarrative } from '@/utils/engineErrors'

/**
 * 「模型给了空正文」的归因。
 *
 * 玩家实测：在局内设置里填了「单次回复上限」，再点重新生成，屏幕上只有
 * 「模型返回了空内容，请检查模型名称与接口地址」—— 模型名和地址都没坏，
 * 是思考模式把 max_tokens 吃光了。
 *
 * 这里钉的就是"不同成因必须给出不同的下一步"，而且**都要能照着改**。
 */

describe('空正文归因', () => {
  it('★ 思考链吃光额度 → 说清是额度问题，并给出两个改法', () => {
    const msg = describeEmptyNarrative({
      finishReason: 'length',
      reasoning: '让我构思：这一场要写他从门里出来……',
      maxTokens: 2048,
      thinkingLikely: true,
    })
    expect(msg).toContain('思考链')
    expect(msg).toContain('2048')
    // 第一改法：留空让程序推算（它会自动给思考垫 4096 的余量）
    expect(msg).toContain('留空')
    expect(msg).toMatch(/思考模式/)
    // 绝不能再说"检查模型名称与接口地址"——那是让它去查没坏的东西
    expect(msg).not.toContain('接口地址')
  })

  it('★ 撞到额度但一条思维链都没有 → 这是纯额度问题', () => {
    const msg = describeEmptyNarrative({ finishReason: 'length', maxTokens: 1024 })
    expect(msg).toContain('1024')
    expect(msg).toContain('上限')
    expect(msg).not.toContain('思考链')
  })

  /*
    ⚠️ 2026-11：玩家连报两轮「正文回空」，而兜底那句让他去查模型名与地址 ——
    两样都是好的。真正的原因是额度不够，只是**Gemini 把这件事写成了 `MAX_TOKENS`**，
    而我们只认小写 `length`，于是判成"没撞上限"，落到兜底。
  */
  it('★ Gemini 的 MAX_TOKENS 也算撞上限（别因为大小写与写法不同就漏判）', () => {
    for (const r of ['MAX_TOKENS', 'max_tokens', 'MAX_OUTPUT_TOKENS', 'max_completion_tokens']) {
      const msg = describeEmptyNarrative({ finishReason: r, maxTokens: 6196 })
      expect(msg, r).toContain('6196')
      expect(msg, r).toContain('上限')
    }
  })

  it('只有思维链、没有 finish_reason（部分中转不给） → 仍然指向额度与思考模式', () => {
    const msg = describeEmptyNarrative({ reasoning: '想了一大段', thinkingLikely: true, maxTokens: 3000 })
    expect(msg).toMatch(/额度|思考模式/)
  })

  it('什么都没给 → 保留原来那句兜底（模型名/地址真的可能错）', () => {
    expect(describeEmptyNarrative({})).toContain('模型返回了空内容')
  })

  it('没填过 max_tokens 时不编一个数字出来', () => {
    const msg = describeEmptyNarrative({ finishReason: 'length', reasoning: '想了很久' })
    expect(msg).toContain('当前上限')
    expect(msg).not.toMatch(/undefined|NaN/)
  })
})
