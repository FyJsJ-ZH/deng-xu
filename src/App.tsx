import { useEffect, Suspense } from 'react'
import { GlobalToast } from '@/components/GlobalToast'
import { StartScreen } from '@/components/StartScreen'
import { useGameStore } from '@/stores/game'
import { useSessionStore } from '@/stores/session'
import { useBackNavigation } from '@/hooks/useBackNavigation'
import { lazyWithRetry, appLoadedCleanly } from '@/utils/lazyWithRetry'
import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary'

/**
 * 游戏界面（**懒加载**，2026-11 第三十四轮）。
 *
 * ## 为什么拆
 *
 * 玩家报「进入首页很卡，有时候刷新还会卡在无法访问界面」。
 * 量首屏：4 个模块、gzip 310 KB，其中 `index` 一块 221 KB ——
 * 因为**主菜单替整个游戏界面背了债**。
 *
 * `App.tsx` 原先静态 import 了十六个只有开局以后才用得到的面板
 * （状态栏、选择面板、编年史、物品、人物、台账、立绘、调试、手机底栏与抽屉、
 * 场景背景、旁路助手、回溯确认……）＋ 引擎 hook。
 * 而玩家打开站点时看到的第一屏只有主菜单一张卡片墙。
 *
 * 拆出去之后：主菜单只下主菜单，进游戏时才取这一包。
 * 代价是开局多一次请求（本地实测 <100ms），换每次打开站点少下 200 KB 左右。
 *
 * ⚠️ 反过来也要守住：`GameShell` 里**不许** import 主菜单用得上的东西，
 * 否则 Rollup 会把它提回主包。
 */
const GameShell = lazyWithRetry(() =>
  import('@/components/GameShell').then(m => ({ default: m.GameShell }))
)

/**
 * 应用外壳 —— 只做两件事：决定现在该显示哪一屏，以及挂全局提示。
 *
 * 这里刻意保持极薄：任何组件一旦被它静态 import，就会落进首屏包。
 */
function App() {
  const isGameStarted = useGameStore(s => s.isGameStarted)
  const world = useSessionStore(s => s.world)

  /*
    返回键逻辑在主菜单也要挂（"再按一次返回即退出"的提示靠它），
    游戏界面里由 GameShell 再挂一次 —— 两边是两棵树，浮层不共享。
  */
  useBackNavigation()

  // 应用成功跑起来 8 秒后，把「模块加载失败自动重载」的计数归零，
  // 这样下次真的遇到网络故障时还能享受自动重载。
  // 放在最外层而不是各 chunk 里：单个 chunk 成功不代表整页健康，
  // 若在重载循环中提前归零就会变成无限刷新。
  useEffect(() => {
    const t = setTimeout(() => appLoadedCleanly(), 8000)
    return () => clearTimeout(t)
  }, [])

  /*
    一次性守卫：进了游戏界面但会话里没有世界卡（会话被清、换了浏览器、
    存档损坏等）时，绝不能停在游戏界面发一堆「尚未选择世界卡」——
    玩家没有任何按钮可点。这里直接退回卡库，让流程重新开始。

    注意：必须顺手把 isGameStarted 置回 false。
    否则 StartScreen 自己的 `if (isGameStarted) return null` 会让它渲染空内容，
    结果是整页全白 —— 比原来的死胡同更难排查（没有报错、没有任何可点的东西）。
  */
  if (isGameStarted && !world) {
    useGameStore.getState().returnToTitle()
    return null
  }

  return (
    /*
      ⚠️ **根级 Suspense 是安全网，别删。**

      2026-11 拆包时踩到的：下面这些页面里任何一个 lazy chunk 还没到，
      组件就会 `throw` 一个 promise。外层没有 Suspense 边界时，
      React 在"同步输入"里 suspend 会**把整棵树卸载**——整页变空白，
      只剩下 index.html 那个启动屏还在闪「正在载入…」。

      这一层兜住漏网的 suspend：最坏也只是整页换成一句话，
      而不是白屏或者整个界面消失。
    */
    <Suspense
      fallback={
        <div className="min-h-screen min-h-[100dvh] w-full bg-background flex items-center justify-center">
          <span className="text-xs font-mono text-text-muted">正在载入…</span>
        </div>
      }
    >
      {!isGameStarted ? (
        <StartScreen />
      ) : (
        <ChunkErrorBoundary label="游戏界面加载失败">
          <Suspense
            fallback={
              <div className="h-screen h-[100dvh] w-full bg-background flex items-center justify-center">
                <span className="text-xs font-mono text-text-muted">正在载入…</span>
              </div>
            }
          >
            <GameShell />
          </Suspense>
        </ChunkErrorBoundary>
      )}
      {/*
        `GlobalToast` 必须挂在这个层级 —— 主菜单上的「再按一次返回即退出游戏」
        就是在这里提示的，而 `statusMessage` 原先只在游戏界面的 StatusBar 里渲染，
        于是主菜单上的提示**根本没有 DOM**，玩家看到的是"按键没反应"。
      */}
      <GlobalToast />
    </Suspense>
  )
}

export default App
