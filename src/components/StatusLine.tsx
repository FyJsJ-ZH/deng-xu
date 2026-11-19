import { useUIStore } from '@/stores/ui'

/**
 * 状态提示的**常驻一行**（2026-11，替代原来的 `GlobalToast` 浮层）。
 *
 * ## 为什么把浮层删了
 *
 * 玩家原话：「直接删掉弹窗」，再上一句是
 * 「怎么又是 5 秒跳一次弹窗，一直弹窗而没有正文，非常非常令人感到厌厌，
 *  跟催命一样」。
 *
 * 原组件认的是"`statusMessage` 变了就浮一次、2.6 秒收起"。而等待进度那条
 * 消息带秒数，**每刷一次都是新字符串** —— 于是定时器多快、弹窗就多密。
 * 把频率调回 60 秒也只是从"每 5 秒催一次"变成"每分钟催一次"，问题没解决。
 *
 * 现在没有任何浮层：状态消息只以**一行固定的字**存在 —— 不淡入、不淡出、
 * 不自己消失、不占屏幕中央。
 *
 * ## 为什么还留着这一个组件
 *
 * `statusMessage` 原先只在游戏界面的 `StatusBar` 里渲染。主菜单上按返回键
 * 那句「再按一次返回即退出游戏」因此**没有任何 DOM** —— 玩家看到的是
 * 「按键没反应」。所以总得有一个地方让它在游戏界面之外落地。
 *
 * 游戏进行中的进度提示由 `StatusBar` 承担，`App` 只在**非游戏界面**挂这个，
 * 两处不会同时出现同一句话。
 */
export function StatusLine() {
  const statusMessage = useUIStore(s => s.statusMessage)
  if (!statusMessage) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-[80] pointer-events-none px-6 pb-[calc(var(--dx-tabbar-h,0px)+0.9rem)]"
    >
      <p className="mx-auto max-w-lg text-center text-[11px] leading-relaxed text-text-muted">
        {statusMessage}
      </p>
    </div>
  )
}
