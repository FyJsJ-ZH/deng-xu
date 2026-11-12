/**
 * 角色卷宗（`dossiers`）与人物名归一化 —— 2026-11 第十一轮。
 *
 * ## 这组测试钉的是什么
 *
 * 玩家报的症状是「推进剧情后人物重复出现」+「线索里全是人物的事」。
 * 两个症状背后是同一个洞：**这个人自己的经历没有地方放**。
 * 于是它要么被写进 `bonds`（关系现值，下一轮就被覆盖），
 * 要么被发成 `ADD_FACT`（和真正的悬案挤在同一张表里）。
 *
 * 所以这里钉三件事：
 *  1. 卷宗是**并集**，不是覆盖 —— 覆盖等于"这个人上一轮还是谁"被忘掉；
 *  2. 卷宗只渲染**在场的人** —— 全渲染会让模型把甲的来历安到乙头上；
 *  3. 同一个人写成两种名字时**并成一份** —— 分开等于他被劈成两个人。
 */
import { describe, it, expect } from 'vitest'
import {
  emptyMemory,
  mergeMemory,
  normalizeMemory,
  renderDossiersForPrompt,
  DOSSIER_PER_CHARACTER,
} from './memory'
import { factOwner } from './facts'

describe('角色卷宗 · 并集而不是覆盖', () => {
  it('两轮写进来的事实都留着', () => {
    const a = mergeMemory(emptyMemory(), {
      dossiers: { 小满: ['爷爷上月去世，临终把怀表给了他'] },
    })
    const b = mergeMemory(a, {
      dossiers: { 小满: ['认主角作师父，跟着学手艺'] },
    })
    expect(b.dossiers['小满']).toHaveLength(2)
    expect(b.dossiers['小满'].join()).toContain('怀表')
    expect(b.dossiers['小满'].join()).toContain('师父')
  })

  it('重复提交同一件事只留一条（模型会重复报）', () => {
    const a = mergeMemory(emptyMemory(), { dossiers: { 小满: ['爷爷上个月去世'] } })
    const b = mergeMemory(a, { dossiers: { 小满: ['爷爷上个月去世'] } })
    expect(b.dossiers['小满']).toHaveLength(1)
  })

  it('★ 名字差一个空格 / 括号注解时并成一份，不劈成两个人', () => {
    const a = mergeMemory(emptyMemory(), { dossiers: { 小满: ['住在秤钩巷后头'] } })
    const b = mergeMemory(a, { dossiers: { '小满 ': ['认主角作师父'] } })
    expect(Object.keys(b.dossiers)).toHaveLength(1)
    expect(b.dossiers['小满']).toHaveLength(2)
  })

  it('不同的人**不能**合并（并错比分开更坏）', () => {
    const a = mergeMemory(emptyMemory(), { dossiers: { 小满: ['住在秤钩巷'] } })
    const b = mergeMemory(a, { dossiers: { 炉边女人: ['在斗技场后巷掌勺'] } })
    expect(Object.keys(b.dossiers)).toHaveLength(2)
  })

  it('每人最多留 DOSSIER_PER_CHARACTER 条（留最近的）', () => {
    const many = Array.from({ length: DOSSIER_PER_CHARACTER + 5 }, (_, i) => `第${i}件事`)
    const m = mergeMemory(emptyMemory(), { dossiers: { 小满: many } })
    expect(m.dossiers['小满']).toHaveLength(DOSSIER_PER_CHARACTER)
    expect(m.dossiers['小满'].at(-1)).toBe(`第${DOSSIER_PER_CHARACTER + 4}件事`)
  })

  it('坏数据（字符串 / 数组）被收敛成空表，不让渲染层崩', () => {
    expect(normalizeMemory({ dossiers: '小满欠我钱' }).dossiers).toEqual({})
    expect(normalizeMemory({ dossiers: [] }).dossiers).toEqual({})
    expect(normalizeMemory({ dossiers: { 小满: '不是数组' } }).dossiers).toEqual({})
  })
})

describe('角色卷宗 · 渲染', () => {
  const m = mergeMemory(emptyMemory(), {
    dossiers: {
      小满: ['爷爷上月去世，临终把怀表给了他', '认主角作师父'],
      炉边女人: ['在斗技场后巷掌酒馆的勺'],
    },
  })

  it('只渲染在场的角色（不在场的不占 token、也不串到别人身上）', () => {
    const text = renderDossiersForPrompt(m, ['小满'])
    expect(text).toContain('小满')
    expect(text).toContain('怀表')
    expect(text).not.toContain('炉边女人')
  })

  it('没有卷宗的人不写进来（写"暂无"只会暗示模型这人很重要但没东西）', () => {
    const text = renderDossiersForPrompt(m, ['小满', '某个路人'])
    expect(text).not.toContain('某个路人')
  })

  it('没有任何卷宗时整块不注入', () => {
    expect(renderDossiersForPrompt(emptyMemory(), ['小满'])).toBe('')
    expect(renderDossiersForPrompt(m, [])).toBe('')
  })

  it('★ 必须同时说清「不要重演」与「他仍然不知道你的事」', () => {
    // 这两句是这一层唯一的防线：少一句，模型要么把经历重演一遍，要么又变回全知
    const text = renderDossiersForPrompt(m, ['小满'])
    expect(text).toContain('不要重演')
    expect(text).toContain('他们仍然不知道你的事')
  })
})

describe('角色卷宗 · 存全、渲染短（2026-11 第二十三轮）', () => {
  /*
    玩家原话：「这个抽屉相当于只有个目录，或许可以在这里都每个线索中补充原本就有的线索详情」。

    病根是**截断放错了层**：存储与渲染共用同一个 40 字上限，
    于是面板上看到的是「……房东太太没赶他，说爷爷…」——
    一句被砍半的话，而那正是他点开这张卡唯一想看的东西。

    现在：存储留 200（面板看全文），渲染截 40（提示词只要提醒）。
  */
  const long = '诺姆住在秤钩巷后头，过一条水沟、有棵歪脖子树的那片，一间小屋，灶在院子里，下雨得搭棚。爷爷的草席还铺着没动。'

  it('★ 存储不截断（面板要显示全文）', () => {
    const m = mergeMemory(emptyMemory(), { dossiers: { 诺姆: [long] } })
    expect(m.dossiers['诺姆'][0]).toBe(long)
  })

  it('★ 渲染要截断（提示词只要提醒，不要原文）', () => {
    /*
      2026-11：渲染上限从 40 抬到 90（玩家：「恢复到不影响游玩的最佳状态」）——
      40 字在中文里常常砍在半句话上。所以这里用一条 150 字的来验截断，
      而 `long`（52 字）现在是**原样渲染**的。
    */
    const mid = '乙'.repeat(150)
    const m = mergeMemory(emptyMemory(), { dossiers: { 诺姆: [mid] } })
    const text = renderDossiersForPrompt(m, ['诺姆'])
    expect(text).toContain('乙'.repeat(80))
    expect(text).not.toContain('乙'.repeat(120))

    // 正常长度（一句完整的经历）不截
    const normal = mergeMemory(emptyMemory(), { dossiers: { 诺姆: [long] } })
    expect(renderDossiersForPrompt(normal, ['诺姆'])).toContain('草席')
  })

  it('超过存储上限（200 字）才截，并留一个省略号', () => {
    const huge = '这是一句非常长的底细描写，'.repeat(30)
    const m = mergeMemory(emptyMemory(), { dossiers: { 诺姆: [huge] } })
    expect(m.dossiers['诺姆'][0].length).toBeLessThanOrEqual(200)
    expect(m.dossiers['诺姆'][0].endsWith('…')).toBe(true)
  })
})

describe('线索归属判断（factOwner）', () => {
  it('名字里带角色名 → 记在他名下', () => {
    expect(factOwner('小满的住处', ['小满', '炉边女人'])).toBe('小满')
    expect(factOwner('炉边女人的警告', ['小满', '炉边女人'])).toBe('炉边女人')
  })

  it('不带人名的悬案仍然留在线索页', () => {
    expect(factOwner('怀表盖内侧的刻字', ['小满', '炉边女人'])).toBeNull()
  })

  it('一个字的角色名不参与匹配（否则会命中一切）', () => {
    expect(factOwner('他住在哪', ['他'])).toBeNull()
  })

  it('多重命中取最长的那个（具体比笼统更对）', () => {
    expect(factOwner('小满的爷爷的怀表', ['小满', '小满的爷爷'])).toBe('小满的爷爷')
  })
})
