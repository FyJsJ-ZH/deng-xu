import { X } from 'lucide-react'
import { StatusPanel } from '@/components/StatusPanel'
import { InventoryPanel } from '@/components/InventoryPanel'
import { RelationshipPanel } from '@/components/RelationshipPanel'
import { NarrativeControls } from '@/components/NarrativeControls'
import type { MobileTab } from '@/components/MobileTabBar'

const TITLES: Record<MobileTab, string> = {
  status: '状态',
  inventory: '物品',
  relationships: '人物关系',
  style: '文风与预设',
}

/**
 * 手机端面板抽屉。
 *
 * 底栏点哪个就弹哪个 —— 这是**独立于"更多"菜单**的一层。
 *
 * 第一版把页签内容只做进"更多"菜单里，底栏改的只是一个没人消费的状态，
 * 于是点底栏什么都不出现（玩家反馈「底栏无效」）。
 * 现在抽屉直接由底栏驱动，菜单只管设置类操作。
 *
 * 抽屉只占屏幕下半部分（`max-h-[70vh]`），**保留上方一部分叙事区可见** ——
 * 看一眼背包时不该完全失去上下文。这是与全屏菜单的关键区别。
 */
export function MobileSheet({
  tab, onClose,
}: {
  tab: MobileTab
  onClose: () => void
}) {
  return (
    <div
      className="md:hidden fixed left-0 right-0 top-0 z-30 flex flex-col justify-end"
      /*
        bottom 用底栏上报的高度 —— 抽屉与遮罩都停在底栏上方，
        底栏因此在抽屉打开时**依然可点**，可以直接在面板间切换。
        （之前遮罩是 inset-0 盖满整屏，把底栏整个盖住，
         点底栏的任何按钮实际都点在遮罩上，表现为"切页签没反应"。）
      */
      style={{ bottom: 'var(--dx-tabbar-h, 0px)' }}
    >
      {/*
        点击上方空白处关闭。刻意用独立的透明层而不是让整层都能关：
        面板内部滚动/点击时不该误触关闭。
      */}
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-[1px]"
      />

      <div className="relative bg-surface border-t border-text-muted/30 rounded-t-xl shadow-2xl flex flex-col max-h-[70vh] animate-slide-up">
        <div className="h-11 shrink-0 flex items-center justify-between px-4 border-b border-text-muted/20">
          <div className="flex items-center gap-2">
            {/* 下拉把手：暗示这个面板可以关上 */}
            <span className="w-8 h-1 rounded-full bg-text-muted/40" />
            <span className="font-serif font-bold text-sm text-accent-lantern">{TITLES[tab]}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 -mr-1.5 rounded text-text-muted hover:text-text-primary touch-manipulation"
            aria-label="关闭面板"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain p-4">
          {tab === 'status' && <StatusPanel className="h-auto overflow-visible border-none p-0 bg-transparent" />}
          {tab === 'inventory' && <InventoryPanel className="h-auto overflow-visible border-none p-0 bg-transparent" />}
          {tab === 'relationships' && <RelationshipPanel className="h-auto overflow-visible border-none p-0 bg-transparent" />}
          {tab === 'style' && <NarrativeControls />}
        </div>
      </div>
    </div>
  )
}
