import { useEffect, useRef } from 'react'
import { User, Package, Users, MoreHorizontal } from 'lucide-react'
import { useGameStore } from '@/stores/game'

/**
 * 手机端抽屉可以装哪几种面板。
 *
 * ⚠️ `'style'`（文风与预设）**没有底栏按钮** —— 它从「更多」菜单里进。
 * 底栏刻意保持四个入口：手机走查里逐个数过
 * （`mobile.mjs` 断言 `labels.length === 4`），加第五个在 390px 上会挤，
 * 而且「换笔法」不是每轮都要点的高频动作，不值得占一格。
 */
export type MobileTab = 'status' | 'inventory' | 'relationships' | 'style'

export interface MobileTabBarProps {
  /** 当前打开的页签；null = 都关着 */
  tab: MobileTab | null
  /**
   * 点某个页签。
   * 传入**当前已打开的那个页签**时表示"再点一次关闭"——
   * 由调用方决定这个行为（这里只负责把点击意图原样传出去）。
   */
  onTab: (t: MobileTab) => void
  onOpenMore: () => void
  moreActive: boolean
}

/**
 * 手机端底部标签栏。
 *
 * 为什么需要它：
 *  在这之前，手机端想看一眼背包必须：点右上角汉堡 → 打开全屏菜单 → 切页签 → 关闭。
 *  每看一次物品就断一次与叙事区的视线连接，来回四步。
 *  而"我现在有什么、谁在旁边"是**高频**操作（几乎每轮都想确认），
 *  高频操作不该藏在菜单里。
 *
 * ⚠️ 第一版做错了：底栏只是把 `mobileTab` 这个状态改掉，
 *  但当时**那个状态的唯一消费者是全屏菜单** —— 菜单关着的时候点底栏，
 *  什么都不会显示。玩家看到的是"底栏点了没反应"。
 *  现在底栏直接控制一个独立的面板抽屉（见 App 里的 MobileSheet）。
 */
export function MobileTabBar({ tab, onTab, onOpenMore, moreActive }: MobileTabBarProps) {
  // 在标签上显示计数，让玩家不进面板就知道有没有新东西
  const inventoryCount = useGameStore(s => s.inventory.length)
  const characterCount = useGameStore(s => s.characters.length)

  /*
    把自己占的高度上报成 CSS 变量 `--dx-tabbar-h`。
    面板抽屉用它来设置 `bottom` —— 这样抽屉与遮罩都不会盖住底栏，
    底栏在抽屉打开时**依然可点**，玩家能在三个面板之间直接切换，
    不必"先关掉再打开"。

    高度是**量出来的**而不是写死的：iOS 安全区会让底栏比桌面高，
    写死会在 iPhone 上压住最后一排内容或露出空隙。
  */
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const report = () => {
      document.documentElement.style.setProperty('--dx-tabbar-h', `${el.offsetHeight}px`)
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => { ro.disconnect(); document.documentElement.style.removeProperty('--dx-tabbar-h') }
  }, [])

  const tabs: { id: MobileTab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: 'status', label: '状态', icon: <User size={20} /> },
    { id: 'inventory', label: '物品', icon: <Package size={20} />, badge: inventoryCount },
    { id: 'relationships', label: '人物', icon: <Users size={20} />, badge: characterCount },
  ]

  return (
    <nav
      ref={ref}
      className="md:hidden shrink-0 z-40 border-t border-text-muted/25 bg-surface/95 backdrop-blur"
      /*
        pb-[env(safe-area-inset-bottom)] 处理 iPhone 的底部横条：
        不加的话最后一排按钮会被系统手势区盖住，点不到。
      */
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex">
        {tabs.map(t => {
          const active = tab === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onTab(t.id)}
              /*
                触摸目标高度 ≥ 56px（含图标与文字），符合移动端可点区域建议。
                `touch-manipulation` 去掉移动端 300ms 双击缩放延迟 ——
                没有它时快速连点会被吞掉，玩家感觉"点了没反应"。
              */
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 relative
                touch-manipulation select-none transition-colors
                ${active ? 'text-accent-lantern' : 'text-text-muted active:text-text-primary'}`}
              aria-pressed={active}
            >
              <span className="relative pointer-events-none">
                {t.icon}
                {!!t.badge && t.badge > 0 && (
                  <span className="absolute -top-1.5 -right-2.5 min-w-[15px] h-[15px] px-0.5 rounded-full bg-accent-lantern text-black text-[9px] font-bold flex items-center justify-center leading-none">
                    {t.badge > 99 ? '99+' : t.badge}
                  </span>
                )}
              </span>
              <span className="text-[10px] pointer-events-none">{t.label}</span>
              {active && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-accent-lantern rounded-full" />
              )}
            </button>
          )
        })}
        <button
          type="button"
          onClick={onOpenMore}
          className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 relative
            touch-manipulation select-none transition-colors
            ${moreActive ? 'text-accent-lantern' : 'text-text-muted active:text-text-primary'}`}
          aria-pressed={moreActive}
        >
          <MoreHorizontal size={20} className="pointer-events-none" />
          <span className="text-[10px] pointer-events-none">更多</span>
          {moreActive && (
            <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-accent-lantern rounded-full" />
          )}
        </button>
      </div>
    </nav>
  )
}
