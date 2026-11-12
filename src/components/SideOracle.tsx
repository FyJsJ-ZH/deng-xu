import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Send, Sparkles, Copy, Check, Loader2, Wand2 } from 'lucide-react'
import { llmChat, extractContent, suggestMaxTokens } from '@/api/llm'
import { resolveReplyLength } from '@/types/cards'
import { useSessionStore } from '@/stores/session'
import { useGameStore } from '@/stores/game'
import { useUIStore } from '@/stores/ui'
import { collectWorldProperNouns } from '@/constants/prompts'
import {
  ORACLE_MODES,
  buildOracleMessages,
  pickLatestNarrative,
  shouldPolish,
  type OracleMode,
} from '@/utils/sideOracle'

/**
 * **旁路 AI**（侧边神谕）。
 *
 * ## 它为什么必须是一个独立窗口
 *
 * 玩家在玩的时候想问「她为什么这么做」。如果直接发给主模型，那条提问会进 history，
 * 成为后续叙事的上下文 —— 剧情被带跑。所以这条旁路**只读** history，一个字都不写回去
 * （写不进去是结构保证：`utils/sideOracle.ts` 不 import 任何 store）。
 *
 * ## 三个模式共用一套 UI，但各自只做一件事
 *
 * - 问剧情 / 查设定：**戏外回答**，不续写正文
 * - 修文字：重写最新一条回复。**默认只显示结果 + 复制**，
 *   「替换」是显式动作且不可撤销 —— 见按钮上的说明
 */
export function SideOracle({ open, onClose }: { open: boolean; onClose: () => void }) {
  const world = useSessionStore(s => s.world)
  const history = useGameStore(s => s.history)
  const location = useGameStore(s => s.location)
  const summary = useGameStore(s => s.summary)
  const playerName = useGameStore(s => s.playerName)
  const llm = useUIStore(s => s.llm)

  const [mode, setMode] = useState<OracleMode>('plot')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [copied, setCopied] = useState<number | null>(null)
  const [replaced, setReplaced] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, busy])

  // 切换模式保留历史（玩家常在两问之间来回切），但清掉上一次的错误
  useEffect(() => { setError(null) }, [mode])

  const latestNarrative = pickLatestNarrative(history)

  const send = useCallback(async () => {
    if (!world || busy) return
    const q = input.trim()
    if (mode !== 'polish' && !q) return
    if (mode === 'polish' && !shouldPolish(latestNarrative)) {
      setError('最新一条回复太短，不值得改（少于 120 字）')
      return
    }

    setError(null)
    setBusy(true)
    setMessages(prev => [...prev, { role: 'user', content: mode === 'polish' ? `修文字：${q || '去掉 AI 味'}` : q }])

    try {
      const msgs = buildOracleMessages(mode, {
        worldTitle: world.title,
        worldLore: world.worldLore,
        rules: world.rules,
        playerName,
        location,
        summary,
        recent: history.map(h => ({ role: h.role, content: h.content })),
        question: q,
        target: latestNarrative,
        nouns: collectWorldProperNouns(world, 160),
      })

      const res = await llmChat({
        messages: msgs,
        config: llm,
        // 改文字要好文笔，问剧情用便宜的模型就够
        model: mode === 'polish' ? llm.narrativeModel : llm.analysisModel,
        stream: false,
        temperature: mode === 'polish' ? llm.temperature : 0.3,
        maxTokens: mode === 'polish'
          ? suggestMaxTokens(resolveReplyLength(world.narrative), llm.narrativeModel, llm.provider, llm.thinking ?? 'auto')
          : 2048,
      })

      const text = extractContent(res).trim()
      setMessages(prev => [...prev, { role: 'assistant', content: text || '（空回复）' }])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setInput('')
    }
  }, [world, busy, input, mode, llm, playerName, location, summary, history, latestNarrative])

  const copy = useCallback((text: string, i: number) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(i)
      setTimeout(() => setCopied(c => (c === i ? null : c)), 1500)
    }).catch(() => { /* 剪贴板不可用时静默 */ })
  }, [])

  /** 把手改后的正文写回 history 的最后一条 assistant 消息（不可撤销） */
  const replaceLatest = useCallback((text: string) => {
    const h = useGameStore.getState().history
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].role === 'assistant') {
        const next = [...h]
        next[i] = { ...next[i], content: text }
        useGameStore.setState({ history: next })
        setReplaced(true)
        setTimeout(() => setReplaced(false), 2000)
        return
      }
    }
    setError('找不到可替换的回复')
  }, [])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <aside className="relative w-full max-w-[420px] h-full bg-background border-l border-white/10 flex flex-col">
        <header className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-accent-lantern" />
            <span className="text-sm font-medium">旁路助手</span>
            <span className="text-[10px] text-text-muted">只读 · 不动你的存档</span>
          </div>
          <button onClick={onClose} className="p-1 text-text-muted hover:text-text-primary" aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <nav className="flex gap-1 px-3 py-2 border-b border-white/10">
          {ORACLE_MODES.map(m => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              title={m.hint}
              className={`px-3 py-1.5 rounded text-xs transition-colors ${
                mode === m.id
                  ? 'bg-accent-lantern/20 text-accent-lantern'
                  : 'text-text-muted hover:text-text-primary hover:bg-white/5'
              }`}
            >
              {m.label}
            </button>
          ))}
        </nav>

        <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && (
            <div className="text-xs text-text-muted leading-relaxed space-y-2">
              <p>{ORACLE_MODES.find(m => m.id === mode)?.hint}</p>
              <p className="text-[10px] opacity-70">
                {mode === 'polish'
                  ? '会重写最新一条回复。结果先给你看，确认了再替换 —— 替换不可撤销。'
                  : '它只读你最近的对话与世界书，不会写回任何东西，也不会推进剧情。'}
              </p>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
              <div className={`inline-block max-w-full text-left rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                m.role === 'user' ? 'bg-accent-lantern/15 text-text-primary' : 'bg-white/5 text-text-primary'
              }`}>
                {m.content}
              </div>
              {m.role === 'assistant' && (
                <div className="flex gap-2 mt-1">
                  <button
                    onClick={() => copy(m.content, i)}
                    className="text-[10px] text-text-muted hover:text-text-primary flex items-center gap-1"
                  >
                    {copied === i ? <Check size={11} /> : <Copy size={11} />}
                    {copied === i ? '已复制' : '复制'}
                  </button>
                  {mode === 'polish' && (
                    <button
                      onClick={() => replaceLatest(m.content)}
                      className="text-[10px] text-text-muted hover:text-accent-grail flex items-center gap-1"
                      title="覆盖最新一条回复（不保留原文）"
                    >
                      <Wand2 size={11} />
                      替换最新一条
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}

          {busy && (
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <Loader2 size={12} className="animate-spin" />
              正在想…
            </div>
          )}
          {replaced && <p className="text-[10px] text-accent-edge">已替换最新一条回复</p>}
          {error && <p className="text-[10px] text-accent-grail break-all">{error}</p>}
        </div>

        <footer className="border-t border-white/10 p-3 space-y-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() }
            }}
            rows={2}
            placeholder={mode === 'polish' ? '要怎么改？（留空 = 只去 AI 味）' : '问点什么…'}
            className="w-full resize-none rounded bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-accent-lantern/40 placeholder:text-text-muted"
          />
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-text-muted">Ctrl+Enter 发送</span>
            <button
              onClick={() => void send()}
              disabled={busy || (mode !== 'polish' && !input.trim())}
              className="flex items-center gap-1.5 rounded bg-accent-lantern/20 px-3 py-1.5 text-xs text-accent-lantern disabled:opacity-40 hover:bg-accent-lantern/30"
            >
              <Send size={12} />
              发送
            </button>
          </div>
        </footer>
      </aside>
    </div>
  )
}
