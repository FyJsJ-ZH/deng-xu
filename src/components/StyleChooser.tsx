import { useMemo } from 'react'
import { Sparkles, AlertTriangle } from 'lucide-react'
import { useLibraryStore } from '@/stores/library'
import {
  NARRATIVE_STYLES, EMPTY_STYLE_CHOICE, stylesOf, styleById,
  type NarrativeStyleGroup, type StyleChoice,
} from '@/data/narrativeStyles'
import { styleConflicts } from '@/utils/narrativePreset'

/**
 * 文风开关 —— 「怎么写」的那一排旋钮。
 *
 * ## 为什么要单独做成组件而不是塞进预设
 *
 * 预设是**整套换**（别人写的、你整份接受），文风是**逐项调**（我今天想写轻一点）。
 * 混在一起会出现一个很别扭的状态：为了换文风，得重新导入一份预设。
 *
 * 所以两者并存：
 *   · 「叙事预设」= 规则底盘（创作准则、任务链、每轮纪律）
 *   · 「文风」    = 笔法（这一档决定文字是简练还是堆砌）
 *
 * ## 四组为什么长这样
 *
 * | 组 | 规则 | 理由 |
 * |---|---|---|
 * | 核心 | **单选** | 两种笔法同时生效，模型只能在矛盾里瞎猜 |
 * | 附加 | 多选 | 它是"加味"，本来就该能叠 |
 * | 基础 | 多选 | 管白描、情感基调这类地基 |
 * | 纠偏 | 多选 | 治的是不同的病，可以一起上 |
 *
 * 世界卡自己的 `customStyle` 永远在最前，这一层永远在最后 ——
 * 玩家刚点的那一下，才是他此刻真正想要的。
 */
export function StyleChooser() {
  const choice = useLibraryStore(s => s.styleChoice)
  const setChoice = useLibraryStore(s => s.setStyleChoice)

  const conflicts = useMemo(() => styleConflicts(choice), [choice])
  const active = NARRATIVE_STYLES.filter(s =>
    s.id === choice.core || choice.extra.includes(s.id)
    || choice.base.includes(s.id) || choice.polish.includes(s.id))

  const toggle = (id: string, group: NarrativeStyleGroup) => {
    if (group === 'core') {
      // 再点一次 = 取消（不启用核心文风也是一种合法选择）
      void setChoice({ ...choice, core: choice.core === id ? '' : id })
      return
    }
    const key = group as 'extra' | 'base' | 'polish'
    const list = choice[key]
    void setChoice({
      ...choice,
      [key]: list.includes(id) ? list.filter(x => x !== id) : [...list, id],
    })
  }

  return (
    <section className="rounded border border-text-muted/20 bg-surface/20 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles size={13} className="text-accent-lantern shrink-0" />
        <h2 className="text-xs font-serif font-bold text-text-primary">文风</h2>
        <span className="text-[10px] text-text-muted">
          {active.length ? `已选 ${active.length} 项` : '未选，只按世界卡自己的文风写'}
        </span>
        {active.length > 0 && (
          <button
            onClick={() => { void setChoice({ ...EMPTY_STYLE_CHOICE }) }}
            className="ml-auto text-[10px] text-text-muted hover:text-accent-lantern"
          >
            全部清空
          </button>
        )}
      </div>

      <Group
        label="核心文风" hint="单选。决定这一档文字是简练还是堆砌"
        items={stylesOf('core')} choice={choice} group="core" onToggle={toggle}
      />
      <Group
        label="附加风格" hint="可叠在核心文风上"
        items={stylesOf('extra')} choice={choice} group="extra" onToggle={toggle}
      />
      <Group
        label="基础规范" hint="管白描与情感基调这类地基"
        items={stylesOf('base')} choice={choice} group="base" onToggle={toggle}
      />
      <Group
        label="纠偏" hint="治 AI 常犯的毛病，可叠加"
        items={stylesOf('polish')} choice={choice} group="polish" onToggle={toggle}
      />

      {conflicts.length > 0 && (
        <div className="space-y-1">
          {conflicts.map((c, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[10px] text-amber-300/90 leading-relaxed">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span>
                「{c.a}」与「{c.b}」互相矛盾：一个要这么做、一个明令禁止。
                两条都开，模型只能挑一边，写出来会忽冷忽热 —— 建议去掉一条。
              </span>
            </div>
          ))}
        </div>
      )}

      {active.length > 0 && (
        <p className="text-[10px] text-text-muted leading-relaxed">
          {/*
            去掉名字开头的图标再念 —— 「🖋️简练网文：推进最快…」读起来像弹幕。
            ⚠️ 不能用 `^[^\s]+` 切：`✅基础文风` 的 ✅ 后面**没有空格**，
            那样会把整个名字都吃掉，摘要变成「：全份预设里最硬的一块」。
          */}
          {active
            .map(s => `${s.name.replace(/^[^\p{L}\p{N}]+/u, '')}：${s.note}`)
            .join('；')}
        </p>
      )}
    </section>
  )
}

/** 一组 chips */
function Group({
  label, hint, items, choice, group, onToggle,
}: {
  label: string
  hint: string
  items: ReturnType<typeof stylesOf>
  choice: StyleChoice
  group: NarrativeStyleGroup
  onToggle: (id: string, group: NarrativeStyleGroup) => void
}) {
  const isOn = (id: string) =>
    group === 'core'
      ? choice.core === id
      : (choice[group as 'extra' | 'base' | 'polish']).includes(id)

  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="text-[10px] font-serif text-text-secondary">{label}</span>
        <span className="text-[9px] text-text-muted/70">{hint}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map(s => {
          const on = isOn(s.id)
          return (
            <button
              key={s.id}
              onClick={() => onToggle(s.id, group)}
              title={s.note}
              className={`px-2 py-1 text-[10px] rounded border transition-colors leading-none
                ${on
                  ? 'border-accent-lantern/60 bg-accent-lantern/10 text-accent-lantern'
                  : 'border-text-muted/25 text-text-secondary hover:border-text-muted/50'}`}
            >
              {s.name}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 给世界卡编辑器用：把一条内置文风的正文取出来 */
export function styleTextOf(id: string): string {
  return styleById(id)?.text ?? ''
}
