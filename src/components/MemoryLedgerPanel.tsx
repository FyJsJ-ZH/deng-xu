import { useState } from 'react'
import { Trash2, Plus, Check, X } from 'lucide-react'
import { useGameStore } from '@/stores/game'
import type { StoryMemory } from '@/utils/memory'

type AddKind = 'affinity' | 'place' | 'item' | null

/** 每种台账的「补记」需要几个输入框、各叫什么 */
const ADD_FIELDS: Record<Exclude<AddKind, null>, { label: string; hint: string }[]> = {
  affinity: [
    { label: '谁', hint: '名字' },
    { label: '内心', hint: '亲 / 近 / 平 / 疏 / 敌（可留空）' },
    { label: '外表', hint: '同上（可留空）' },
  ],
  place: [
    { label: '地点', hint: '名字' },
    { label: '上级', hint: '属于哪（可留空）' },
  ],
  item: [
    { label: '东西', hint: '名字' },
    { label: '在哪', hint: '随身 / 寄存在某处（可留空 = 随身）' },
  ],
}

/**
 * **记忆台账**：把 `StoryMemory` 里那三样「模型记着、但玩家看不见」的东西摆出来。
 *
 * ## 为什么必须有这个面板（2026-11）
 *
 * `affinity` / `places` / `inventory` 在这之前只进提示词。于是出现一个很怪的状态：
 * 模型知道你外套寄在和通号，**你自己不知道** —— 也没法核对、没法纠正。
 * 它记错了，你只会在正文里看到「他走向当铺去赎外套」这种莫名其妙的句子，
 * 而原因埋在一段你根本看不到的记忆里。
 *
 * 右侧原有的两个 tab 都不是这个：
 *  - 「物品与线索」看的是 `WorldCard.items` —— **世界上这种物长什么样**的模板；
 *  - 「人物」看的是角色卡本身。
 * 这三本台账是**这一局跑出来的状态**，和上面两样都不是一回事。
 *
 * ## 只读 + 能删，不做完整编辑器
 *
 * 玩家真正需要的只有一件事：**记错的能清掉**。所以每一行带一个删除，
 * 不做内联编辑（那会引出"改一半没保存"的一堆问题，而收益很小）。
 */
export function MemoryLedgerPanel() {
  const memory = useGameStore(s => s.memory)
  const setMemory = useGameStore(s => s.setMemory)

  /** 正在补记哪一类（null = 没在补记） */
  const [adding, setAdding] = useState<AddKind>(null)
  const [draft, setDraft] = useState<string[]>([])

  /** 复制一份改完塞回去（`setMemory` 内部会 normalize） */
  const edit = (mut: (m: StoryMemory) => void) => {
    const next: StoryMemory = JSON.parse(JSON.stringify(memory))
    mut(next)
    setMemory(next)
  }

  const startAdd = (kind: Exclude<AddKind, null>) => {
    setAdding(kind)
    setDraft(ADD_FIELDS[kind].map(() => ''))
  }

  /** 把补记的那一条写进台账（空名字直接忽略，不打扰玩家） */
  const commitAdd = () => {
    if (!adding) return
    const v = draft.map(s => s.trim())
    if (!v[0]) { setAdding(null); return }
    edit(m => {
      if (adding === 'affinity') {
        m.affinity.push({ who: v[0], inner: v[1] || '未知', outer: v[2] || '未知' })
      } else if (adding === 'place') {
        m.places.push(v[1] ? { name: v[0], parent: v[1] } : { name: v[0] })
      } else {
        m.inventory.push({ name: v[0], where: v[1] || '随身' })
      }
    })
    setAdding(null)
  }

  /** 空台账时也要能补记 —— 所以那一支不能提前 return */
  const empty = !memory.affinity.length && !memory.places.length && !memory.inventory.length

  const addBar = adding && (
    <div className="rounded border border-accent-edge/30 bg-accent-edge/5 p-2 space-y-1">
      <div className="flex items-center justify-between text-[10px] text-accent-edge">
        <span>{adding === 'affinity' ? '补一条好感' : adding === 'place' ? '补一个地点' : '补一样东西'}</span>
        <button onClick={() => setAdding(null)} className="hover:text-text-primary"><X size={11} /></button>
      </div>
      {ADD_FIELDS[adding].map((f, i) => (
        <input
          key={f.label}
          value={draft[i] ?? ''}
          onChange={e => setDraft(d => { const n = [...d]; n[i] = e.target.value; return n })}
          onKeyDown={e => { if (e.key === 'Enter') commitAdd() }}
          placeholder={`${f.label}：${f.hint}`}
          className="w-full rounded bg-black/30 px-2 py-1 text-[11px] outline-none focus:ring-1 focus:ring-accent-edge/40 placeholder:text-text-muted/60"
        />
      ))}
      <button
        onClick={commitAdd}
        className="w-full flex items-center justify-center gap-1 rounded bg-accent-edge/20 py-1 text-[11px] text-accent-edge hover:bg-accent-edge/30"
      >
        <Check size={11} /> 记下
      </button>
    </div>
  )

  if (empty) {
    return (
      <div className="p-4 text-xs text-text-muted leading-relaxed space-y-2">
        <p>台账还是空的。</p>
        <p className="opacity-70">
          它由摘要 AI 每轮记账：谁对你怎么想、去过哪些地方、东西放在哪。
          玩过几轮之后这里才会有东西。
        </p>
        <p className="opacity-70">
          记错了可以删掉；模型漏记的可以自己补 —— 补进去的它下一轮就会当依据用。
        </p>
        {addBar}
        <div className="flex flex-wrap gap-1.5 pt-1">
          <button onClick={() => startAdd('affinity')} className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] hover:border-accent-edge/40 hover:text-accent-edge"><Plus size={10} /> 好感</button>
          <button onClick={() => startAdd('place')} className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] hover:border-accent-edge/40 hover:text-accent-edge"><Plus size={10} /> 地点</button>
          <button onClick={() => startAdd('item')} className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] hover:border-accent-edge/40 hover:text-accent-edge"><Plus size={10} /> 东西</button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-2 space-y-4 text-xs">
      {/* ── 好感双轨 ── */}
      {memory.affinity.length > 0 && (
        <section>
          <SectionHead title="好感（内心 / 外表）" onAdd={() => startAdd('affinity')} />
          <ul className="space-y-0.5">
            {memory.affinity.map(a => (
              <li key={a.who} className="group flex items-start gap-1 leading-snug">
                <span className="flex-1 min-w-0">
                  <span className="text-text-primary">{a.who}</span>
                  <span className="text-text-muted"> · 内 </span>
                  <span className={innerClass(a.inner)}>{a.inner}</span>
                  <span className="text-text-muted"> / 外 </span>
                  <span className={outerClass(a.outer)}>{a.outer}</span>
                  {a.note && <span className="block text-[10px] text-text-muted/80 mt-0.5">{a.note}</span>}
                </span>
                <button
                  onClick={() => edit(m => { m.affinity = m.affinity.filter(x => x.who !== a.who) })}
                  className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-accent-grail shrink-0 mt-0.5"
                  title="删掉这一条（模型也不会再拿它当依据）"
                >
                  <Trash2 size={11} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── 地点树 ── */}
      {memory.places.length > 0 && (
        <section>
          <SectionHead title="地点（由大到小）" onAdd={() => startAdd('place')} />
          <ul className="space-y-0.5">
            {renderTree(memory.places).map(({ node, depth }) => (
              <li key={node.name} className="group flex items-start gap-1 leading-snug">
                <span className="flex-1 min-w-0" style={{ paddingLeft: depth * 10 }}>
                  <span className="text-text-muted/50">{depth > 0 ? '└ ' : ''}</span>
                  <span className="text-text-primary">{node.name}</span>
                </span>
                <button
                  onClick={() => edit(m => { m.places = m.places.filter(x => x.name !== node.name) })}
                  className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-accent-grail shrink-0 mt-0.5"
                  title="删掉这个地点"
                >
                  <Trash2 size={11} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── 物品台账 ── */}
      {memory.inventory.length > 0 && (
        <section>
          <SectionHead title="手上有什么 · 放在哪" onAdd={() => startAdd('item')} />
          <ul className="space-y-0.5">
            {memory.inventory.map(it => (
              <li key={it.name} className="group flex items-start gap-1 leading-snug">
                <span className="flex-1 min-w-0">
                  <span className="text-text-primary">{it.name}</span>
                  <span className="text-text-muted"> · </span>
                  <span className={/随身/.test(it.where) ? 'text-accent-edge' : 'text-text-secondary'}>
                    {it.where}
                  </span>
                  {it.note && <span className="block text-[10px] text-text-muted/80 mt-0.5">{it.note}</span>}
                </span>
                <button
                  onClick={() => edit(m => { m.inventory = m.inventory.filter(x => x.name !== it.name) })}
                  className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-accent-grail shrink-0 mt-0.5"
                  title="删掉这一条"
                >
                  <Trash2 size={11} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 补记的输入区（点任一区块标题旁的 ＋ 才出现） */}
      {addBar}

      <p className="text-[10px] text-text-muted/60 pt-1 leading-relaxed">
        这三本由摘要 AI 记账，每轮可能只更新其中一两样。
        记错了删掉即可；模型漏记的可以自己补 —— 补进去的它下一轮就会当依据用。
      </p>
    </div>
  )
}

/** 区块标题 + 补记按钮（三块共用，避免三处重复写同样的 class） */
function SectionHead({ title, onAdd }: { title: string; onAdd: () => void }) {
  return (
    <div className="flex items-center justify-between mb-1">
      <h3 className="text-[10px] uppercase tracking-wider text-text-muted">{title}</h3>
      <button
        onClick={onAdd}
        className="text-text-muted hover:text-accent-edge transition-colors"
        title="模型漏记了？自己补一条"
      >
        <Plus size={11} />
      </button>
    </div>
  )
}

/** 内心档位上色：亲近绿、疏远暖、未知灰 */
function innerClass(v: string): string {
  if (/亲|近/.test(v)) return 'text-accent-edge'
  if (/疏|敌/.test(v)) return 'text-accent-grail'
  return 'text-text-muted'
}

/** 外表档位：它只是"表现出来的"，所以整体比内心淡一档 */
function outerClass(v: string): string {
  if (/亲|近/.test(v)) return 'text-accent-edge/70'
  if (/疏|敌/.test(v)) return 'text-accent-grail/70'
  return 'text-text-muted/70'
}

/** 把扁平的地点列表排成「父在前、子缩进」的顺序（孤儿与环都要能渲染出来） */
function renderTree(nodes: { name: string; parent?: string }[]): { node: { name: string; parent?: string }; depth: number }[] {
  const known = new Set(nodes.map(n => n.name))
  const kids = new Map<string, typeof nodes>()
  const roots: typeof nodes = []
  for (const n of nodes) {
    if (!n.parent || !known.has(n.parent)) roots.push(n)
    else {
      const list = kids.get(n.parent) || []
      list.push(n)
      kids.set(n.parent, list)
    }
  }
  const out: { node: { name: string; parent?: string }; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (n: { name: string; parent?: string }, depth: number) => {
    if (seen.has(n.name)) return
    seen.add(n.name)
    out.push({ node: n, depth })
    for (const c of kids.get(n.name) || []) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  for (const n of nodes) if (!seen.has(n.name)) { seen.add(n.name); out.push({ node: n, depth: 0 }) }
  return out
}
