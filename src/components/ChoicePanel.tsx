import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { AttributeDef } from '@/types/cards';

interface Option {
  id: string;
  text: string;
  /** 性相 id（或 'neutral' / 'story'）—— 由数据 AI 标注，见 prompts 的选项生成协议 */
  style?: string;
  disabled?: boolean;
}

interface ChoicePanelProps {
  options: Option[];
  /**
   * 当前世界的属性（性相）定义 —— **选项的颜色从这里取**。
   *
   * 为什么不写死一张色表：世界卡的属性是玩家可改的（卡片编辑器里能加自己的相），
   * 写死的表一改世界就对不上，而"对不上"的表现是不报错、只是颜色灰掉。
   * 更关键的是：**颜色必须和右上角状态栏里那个相的颜色一致**，
   * 否则玩家会以为是两个东西。
   */
  attributes?: AttributeDef[];
  onSelect: (id: string) => void;
  onCustomAction?: (text: string) => void;
  disabled?: boolean;
  isInputAllowed?: boolean;
}

/** 找不到性相时的兜底色（中性灰） */
const NEUTRAL = '#8b8b8b';

export function ChoicePanel({
  options, attributes = [], onSelect, onCustomAction, disabled, isInputAllowed = true,
}: ChoicePanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [customInput, setCustomInput] = useState('');

  useEffect(() => {
    if (options.length > 0) setIsExpanded(true);
  }, [options]);

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (customInput.trim() && onCustomAction && !disabled && isInputAllowed) {
      onCustomAction(customInput.trim());
      setCustomInput('');
    }
  };

  if (options.length === 0 && !isInputAllowed) return null;

  /** 一个选项属于哪个性相（找不到就 null） */
  const aspectOf = (style?: string) =>
    style ? attributes.find(a => a.id === style) : undefined;

  return (
    <div className="border-t border-text-muted/20 bg-black/40 backdrop-blur-md shadow-[0_-10px_40px_rgba(0,0,0,0.3)] transition-all duration-300">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-center p-2 text-text-muted hover:text-text-primary hover:bg-white/5 transition-colors"
      >
        {isExpanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="p-4 md:p-6 pt-0 flex flex-col gap-3 max-w-3xl mx-auto">
              {isInputAllowed && (
                <form onSubmit={handleCustomSubmit} className="mb-4">
                  <div className="relative group">
                    <input
                      type="text"
                      value={customInput}
                      onChange={(e) => setCustomInput(e.target.value)}
                      placeholder="输入你的行动..."
                      disabled={disabled}
                      className="w-full bg-black/20 border border-text-muted/30 rounded-sm p-3 pl-4 pr-12 text-text-primary placeholder:text-text-muted/50 focus:border-accent-lantern focus:bg-black/40 outline-none transition-all font-serif"
                    />
                    <button
                      type="submit"
                      disabled={!customInput.trim() || disabled}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-text-muted hover:text-accent-lantern disabled:opacity-30 transition-colors"
                    >
                      <span className="sr-only">发送</span>
                      →
                    </button>
                  </div>
                </form>
              )}

              <div className="text-xs font-serif text-text-muted uppercase tracking-[0.3em] text-center mb-4 opacity-60">
                — 抉择 —
              </div>

              {options.map((opt, index) => {
                const isDisabled = disabled || opt.disabled;
                const isStory = opt.style === 'story';
                const attr = aspectOf(opt.style);
                const color = isStory ? undefined : (attr?.color || NEUTRAL);

                /*
                  性相选项的样式全部走 inline style：
                  边框与文字用该相的颜色，悬停只提亮背景。
                  尾部的相名（「灯」「刃」…）就是原作那个做法——
                  让玩家一眼看出"这个选项是哪一种人做的事"。
                */
                const inline: React.CSSProperties = isStory || !color
                  ? {}
                  : { borderColor: `${color}66`, color };

                return (
                  <motion.button
                    key={opt.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.1 }}
                    onClick={() => !isDisabled && onSelect(opt.id)}
                    disabled={isDisabled}
                    style={inline}
                    className={`
                      w-full p-4 text-left border rounded-sm transition-all duration-300 font-serif text-base md:text-lg relative overflow-hidden group
                      ${isStory
                        ? 'border-text-primary text-text-primary bg-surface/80 hover:bg-surface hover:border-accent-lantern font-bold tracking-wide'
                        : 'border-text-muted/40 text-text-primary hover:bg-white/5'}
                      ${isDisabled ? 'opacity-50 cursor-not-allowed grayscale' : 'hover:shadow-lg hover:-translate-y-0.5'}
                    `}
                  >
                    {/*
                      ⚠️ 选项文字**必须能完整显示**（2026-11，玩家在手机上截图反馈：
                      「不答话，先看清他筐里装的…」「手按上黑布裹着的刀柄，慢…」——
                      两条都被截成了省略号）。

                      原因是我为了给右侧的相名标让位置，给文字加了 `truncate`
                      （= overflow:hidden + text-overflow:ellipsis + white-space:nowrap）。
                      桌面宽屏看着没事，手机上一行放不下就直接吃掉后半句，
                      而选项恰恰是玩家最需要读全的东西。

                      现在：文字允许多行（不 truncate），相名标 shrink-0 只占它需要的宽度。
                      `items-start` 让「◇」和相名标对齐第一行，而不是垂直居中。
                    */}
                    <span className="relative z-10 flex items-start justify-between gap-2">
                      <span className="flex items-start gap-2 sm:gap-3 min-w-0">
                        <span
                          className="opacity-60 text-xs shrink-0 mt-1"
                          style={color ? { color } : undefined}
                        >◇</span>
                        <span className="min-w-0 break-words">{opt.text}</span>
                      </span>
                      <span className="flex items-center gap-2 shrink-0 mt-0.5">
                        {attr && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded-sm font-mono border whitespace-nowrap"
                            style={{ color, borderColor: `${color}55` }}
                            title={`选它偏向「${attr.name}」——${attr.description || ''}`}
                          >
                            {attr.name}
                          </span>
                        )}
                        {!isDisabled && <span className="hidden sm:inline opacity-0 group-hover:opacity-100 transition-opacity text-sm font-mono">→</span>}
                      </span>
                    </span>
                    {!isDisabled && <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000" />}
                  </motion.button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
