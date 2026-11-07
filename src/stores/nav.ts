import { create } from 'zustand'

/**
 * 应用层级（"视野"）。
 *
 * 为什么要把它做成显式状态，而不是散在各个组件的 useState 里：
 *
 *  手机返回键需要知道"上一条路"是什么。原先层级散落各处 ——
 *  App 管游戏界面、StartScreen 自己用 `view` 状态管主菜单/卡片库/世界书 ——
 *  于是返回键没有任何"上一级"可以退：它只能一路穿透到浏览器，
 *  把玩家直接送回浏览器主页。这是同一个问题被反馈了两次的原因。
 *
 *  现在所有层级都写在这里，返回键只需沿着这个栈往上退。
 *
 * 层级顺序（从深到浅）：
 *   game → setup → worldbook → library → menu
 *
 * `stack` 记录走过的路径，用来支持"层层后退"；
 * 它不是浏览器的历史栈，而是**应用自己的**层级栈，
 * 和浏览器历史一一对应地同步（见 useBackNavigation）。
 */
export type View =
  | { name: 'menu' }
  /*
    ── 为什么 library 需要 `intent` ──
    原先主菜单的「开始新游戏」「世界书」「卡片库」三个入口
    都 push 了同一个 `{ name: 'library' }`，于是**点哪个进去都一模一样**，
    三个入口等于一个。`intent` 把"进来做什么"显式化：

      · play      —— 开始新游戏：卡片墙是**选世界**用的，
                     每张卡上给"用这个世界开始"
      · worldbook —— 世界书：只读地翻内置世界的设定集，不给"开始游戏"入口
      · library   —— 卡片库：管理/导入导出/编辑，重点是维护而不是开局

    `worldbookMode` 保留以兼容既有调用（等价于 intent === 'worldbook'）。
  */
  | { name: 'library'; worldbookMode?: boolean; intent?: 'play' | 'worldbook' | 'library' }
  | { name: 'worldbook'; worldId: string }
  /*
    setup 也要带上"是从哪进来的"。
    ⚠️ 为什么不能只靠 library 那一层：从选角按「返回卡库」时走的是
    `nav.back()` → `history.back()`，那是**异步**的；而 `setSetupWorldId(null)`
    是同步的。于是会有一瞬间 DOM 已经渲染成卡片墙、而 `nav.view` 还停在 setup ——
    这时若读 `view.name === 'library'` 判断用途，就会拿到默认值，
    标题从「开始新游戏」错闪成「卡片库」。
    把 intent 存在 setup 自己身上，就不依赖异步回退的时序了。
  */
  | { name: 'setup'; worldId: string; intent?: 'play' | 'worldbook' | 'library' }
  /** 主角预设管理页（「提前设定主角」） */
  | { name: 'heroes' }
  /**
   * 叙事预设库（「怎么写」的那一摞，可切换）。
   *
   * 与 `heroes` 同为"开局前先设好"的二级页，所以层级并列在 menu 之下，
   * 不进 library —— 它管的不是卡，而是叠加在所有卡上的那层文风。
   */
  | { name: 'presets' }
  | { name: 'game' }

interface NavState {
  /** 当前层级 */
  view: View
  /** 走过的层级（不含当前），最后一个是"上一级" */
  stack: View[]
  /** 跳到某个层级（同时压入一条浏览器历史，保证返回键有东西可退） */
  push: (v: View) => void
  /** 回到上一级（同时弹掉一条历史）；已经在最浅层时返回 false */
  back: () => boolean
  /** 只改层级、不碰历史（供 popstate 处理器使用） */
  backSilent: () => boolean
  /** 清空层级栈并回到主菜单 */
  reset: () => void
}

/**
 * 层级与浏览器历史**必须一一对应**。
 *
 * ⚠️ 这是返回键功能被反馈三次的最终病根：
 *   前几版只维护 nav 的 stack，历史却没有同步增长。
 *   于是"游戏界面"这种深层级在历史里只占**一条**，
 *   按一次返回就跨过好几个层级直接退出页面。
 *   实测表现：打开抽屉按返回，抽屉关了但页面也退出了。
 *
 * 现在：push 压一条历史、back 弹一条、backSilent 只改状态（用于 popstate 回调，
 * 因为那时浏览器已经替我们弹过了）。
 */
export const useNavStore = create<NavState>()((set, get) => ({
  view: { name: 'menu' },
  stack: [],

  push: (v) => {
    const cur = get().view
    // 同一层级重复压栈没有意义（例如反复点同一个世界书）
    if (JSON.stringify(cur) === JSON.stringify(v)) return
    set({ view: v, stack: [...get().stack, cur] })
    // 与层级同步压入历史：返回键才有东西可退
    if (typeof window !== 'undefined') {
      window.history.pushState({ __dxNav: true, depth: get().stack.length }, '')
    }
  },

  back: () => {
    const { stack } = get()
    if (!stack.length) return false
    // 交给浏览器弹栈，popstate 里再走 backSilent —— 历史与层级保持一致
    if (typeof window !== 'undefined') {
      window.history.back()
      return true
    }
    const prev = stack[stack.length - 1]
    set({ view: prev, stack: stack.slice(0, -1) })
    return true
  },

  /**
   * 只改层级、不碰历史。
   * 由 `useBackNavigation` 的 popstate 处理器调用 ——
   * 那时浏览器**已经**弹掉了一条，再弹一次就会多退一级。
   */
  backSilent: () => {
    const { stack } = get()
    if (!stack.length) return false
    const prev = stack[stack.length - 1]
    set({ view: prev, stack: stack.slice(0, -1) })
    return true
  },

  reset: () => set({ view: { name: 'menu' }, stack: [] }),
}))

/** 这个层级是否算"最外层"（在这里再退就该问玩家要不要退出） */
export function isRootView(v: View): boolean {
  return v.name === 'menu'
}
