import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { buildVersionProbe } from './scripts/vite-plugin-build-version'

// 端口优先用 5173；被占用时自动往后找，避免「一键启动」因为端口冲突直接失败。
const DEFAULT_PORT = Number(process.env.PORT) || 5173

export default defineConfig({
  /*
    `buildVersionProbe()` 解决「更新后浏览器还显示旧版」——
    GitHub Pages 给 index.html 发 max-age=600，而静态托管改不了响应头。
    它注入一个"主动问线上有没有新版"的探测脚本，细节见那个文件。
  */
  plugins: [react(), buildVersionProbe()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // 用相对路径打包，这样 dist 放在任何子目录下（含 GitHub Pages 子路径）都能直接打开。
  // 原项目把它写死成 '/pale-notes/'，是给上游作者自己的 Pages 仓库用的。
  base: './',
  server: {
    // 监听所有网卡（不只是 localhost），这样同一局域网下的手机 / 平板可以直接访问。
    // 首次在 Windows 上运行会弹防火墙授权，选择「允许专用网络」即可。
    // 想只在本机访问就设成 HOST=127.0.0.1。
    host: process.env.HOST || '0.0.0.0',
    port: DEFAULT_PORT,
    // 不用 strictPort：5173 被占用时自动换端口，而不是直接报错退出
    strictPort: false,
    watch: {
      // 忽略编辑器/工具产生的临时文件与目录。
      // 某些原子写入实现（含本仓库开发时用到的工具）会在项目内建临时目录再改名，
      // chokidar 正好在它被删除的瞬间注册监听就会抛 EBUSY 并拖垮整个 dev server。
      ignored: [
        '**/.*.tmpdir/**',
        '**/*.tmp',
        '**/*.temp',
        '**/*.swp',
        '**/*.swx',
        '**/*~',
        '**/.tmp/**',
        '**/.probe/**',
        '**/.git/**',
        // 无头浏览器会把用户数据写进项目里（Cookies/Cache 处于锁定状态），
        // chokidar 一碰就 EBUSY，足以把 dev server 直接打挂。
        '**/edge-*/**',
        '**/chrome-*/**',
        /*
          ⚠️ **走查截图目录必须忽略**（2026-11，本地跑 `check:all` 时踩到）。

          走查每过一步就往 `playtest-shots/` 写一张截图，而 vite 把这个目录
          当成源码在监听 —— 于是每写一张图就触发一次 **page reload**，
          把正在被 puppeteer 驱动的那个页面整页刷掉。

          症状极具误导性：报的是 `__gameStore is not defined`
          （main.tsx 里那个 dev-only 的 window 挂载随页面重载一起消失了），
          看起来像 store 没初始化或某个模块挂了，实际与业务代码无关。
          更坑的是它**随截图数量而加重** —— 跑单套时偶尔能过，跑全套必红。
        */
        '**/playtest-shots/**',
      ],
    },
  },
  preview: {
    host: process.env.HOST || '0.0.0.0',
    port: DEFAULT_PORT,
    strictPort: false,
  },
  build: {
    chunkSizeWarningLimit: 1000,
    /**
     * 内联阈值调到 1KB。
     *
     * Vite 默认 4KB，会把 LPC 的 60 张部件图（0.4–3.5KB）和 17KB 的调色板
     * 全部转成 base64 塞进入口 —— 实测入口因此从 218KB 涨到 334KB，
     * 超过之前验证过的安全线（≤232KB 最稳）。
     *
     * 这些图是**按需加载**的（只加载当前角色用到的 8 张），
     * 外置后入口回到约 220KB，且浏览器只并发取真正需要的那几张。
     * 只有小于 1KB 的小图标仍然内联。
     */
    assetsInlineLimit: 1024,
    rollupOptions: {
      output: {
        /**
         * 刻意把依赖拆成多个 chunk。
         *
         * 原因不是"优雅"，是可用性：surge 免费 CDN 传大文件会中途把连接掐断。
         * 实测单个 810 KB 的文件连取 8 次失败 5 次（ERR_CONNECTION_RESET / UND_ERR_SOCKET），
         * 页面上表现为"脚本加载失败"。拆小之后每个 chunk 都能在超时前传完。
         *
         * 拆法按「首屏是否真的需要」来分：
         *  - vendor  ：react / react-dom / zustand —— 首屏必需
         *  - motion  ：framer-motion —— 被 6 个组件引用，无法懒加载，单独成块便于缓存
         *  - markdown：react-markdown + rehype-raw —— 只有叙事区用，跟首屏无关
         *  - icons   ：lucide-react —— tree-shake 后不大，但引用点极多
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined

          // 注意：不要把 markdown 再往下拆成两块。
          // 试过把 rehype-raw 与 react-markdown 分到两个 chunk，Rollup 报
          // "Circular chunk: md-html -> md-core -> md-html" —— 循环 chunk 会让
          // 模块初始化顺序不确定，可能在求值期拿到 undefined，比体积问题更危险。
          // 284 KB 这块只在实际进入游戏时才加载（见 NarrativeView 的懒加载），
          // 而且下面把首屏的 index chunk 压到安全线以下，避免多路并发争带宽。
          if (/[\\/]node_modules[\\/].*(react-markdown|rehype-raw|remark-|rehype-|micromark|mdast|hast|unified|vfile|unist|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities|html-url-attributes|html-void-elements|web-namespaces|trim-lines|devlop|estree|longest-streak|ccount|markdown-table|zwitch|bail|trough|is-plain-obj|extend)/.test(id)) {
            return 'markdown'
          }
          if (id.includes('framer-motion') || id.includes('motion-dom') || id.includes('motion-utils')) {
            return 'motion'
          }
          if (id.includes('lucide-react')) {
            return 'icons'
          }
          // react / react-dom 单独一块：entry 依赖它，拆开后单个请求都更小，
          // 每个请求的失败窗口随之变小。实测合并成 296 KB 单文件反而更差。
          if (id.includes('react-dom') || /[\\/]node_modules[\\/]react[\\/]/.test(id) || id.includes('scheduler')) {
            return 'vendor'
          }
          if (id.includes('zustand')) {
            return 'vendor'
          }
          return undefined
        },
      },
    },
  },
})
