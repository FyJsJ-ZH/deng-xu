import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, RotateCcw } from 'lucide-react'
import { copyText } from '@/utils/clipboard'

interface RewindConfirmProps {
  /** 要回到第几轮结束时 */
  turn: number
  /** 那一轮玩家输入的**完整原文**（可能是空串：开局那些轮没有玩家输入） */
  action: string
  onCancel: () => void
  onConfirm: () => void
}

/**
 * 回溯确认框。
 *
 * ## 为什么从 `window.confirm` 换成自绘的
 *
 * 原先这里是一句 `window.confirm(...)`，把那一轮的行动原文塞在提示文字里。
 * 它在手机上有一个致命的限制：**原生对话框里的文字选不中、也复制不了**。
 *
 * 而回溯最真实的用法恰恰是**抄一遍再改**：
 * 「提出收养小满，虽然他没有亲人了，但可以认我为义父」——
 * 玩家想回到那一轮，把后面半句换个说法再走一遍。
 * 原生 confirm 逼着他关掉弹窗、翻回去、用眼睛重新敲一遍，
 * 而那段文字早被后几轮的叙事顶出屏幕了。
 *
 * 所以这里做三件事：
 *  1. 行动原文用**可选中的正文**显示（`select-text` + `whitespace-pre-wrap`）；
 *  2. 旁边给一个「复制」按钮，一条点击就进剪贴板；
 *  3. 破坏性提醒（之后全部作废）用一栏 ⚠️ 单独摆出来，别和正文混在一起。
 *
 * ## 为什么「确定」不是默认焦点
 *
 * 这是一个**不可撤销**的操作。焦点落在「取消」上，误触回车不会把几十轮作废。
 */
export function RewindConfirm({ turn, action, onCancel, onConfirm }: RewindConfirmProps) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // Esc 取消：屏幕上这个框挡住了一切，给一个不用找按钮的出路
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const doCopy = async () => {
    const ok = await copyText(action)
    setCopied(ok ? 'ok' : 'fail')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied('idle'), 1800)
  }

  const hasAction = action.trim().length > 0

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={`回到第 ${turn} 轮结束时`}
    >
      <div
        className="w-full max-w-md bg-background border border-text-muted/25 rounded-lg overflow-hidden shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* 标题 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-text-muted/20">
          <RotateCcw size={13} className="text-accent-lantern shrink-0" />
          <div className="text-sm font-serif text-text-primary">回到第 {turn} 轮结束时？</div>
        </div>

        <div className="px-4 py-3 space-y-2.5">
          {/* 那一轮的行动 —— 可选中、可复制 */}
          <div className="space-y-1.5">
            <div className="text-[10px] text-text-muted tracking-wider">你在那一轮输入的行动</div>
            {hasAction ? (
              <div className="rounded border border-text-muted/20 bg-black/25 px-2.5 py-2 max-h-[9rem] overflow-y-auto select-text">
                <p className="text-xs text-text-secondary leading-relaxed font-serif whitespace-pre-wrap break-words">
                  {action}
                </p>
              </div>
            ) : (
              <p className="text-xs text-text-muted italic">（那一轮没有记录到输入）</p>
            )}
          </div>

          {/* 破坏性提醒：和正文分开，别让人看成一件事 */}
          <div className="flex items-start gap-1.5 rounded border border-accent-grail/25 bg-accent-grail/5 px-2.5 py-2">
            <AlertTriangle size={11} className="text-accent-grail shrink-0 mt-0.5" />
            <p className="text-[11px] text-text-secondary leading-relaxed">
              这一轮之后发生的事会
              <span className="text-accent-grail">全部作废</span>
              （叙事、数值、关系、记忆一起回滚）。
            </p>
          </div>
        </div>

        {/* 操作栏：复制在左（次要），取消 / 确定在右 */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-text-muted/20 bg-black/20">
          {hasAction ? (
            <button
              onClick={doCopy}
              className={`flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-[11px] transition-colors
                ${copied === 'ok'
                  ? 'border-accent-edge/50 text-accent-edge'
                  : copied === 'fail'
                    ? 'border-accent-grail/50 text-accent-grail'
                    : 'border-text-muted/30 text-text-muted hover:text-text-primary hover:border-text-muted/60'}`}
              title="把这一轮的行动原文复制走，改两个字再发一次"
            >
              {copied === 'ok' ? <Check size={11} /> : <Copy size={11} />}
              {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败' : '复制行动'}
            </button>
          ) : (
            <span />
          )}

          <div className="flex-1" />

          <button
            autoFocus
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-[11px] text-text-muted hover:text-text-primary transition-colors"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="rounded border border-accent-grail/40 bg-accent-grail/10 px-3 py-1.5 text-[11px] text-accent-grail hover:bg-accent-grail/20 transition-colors"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
