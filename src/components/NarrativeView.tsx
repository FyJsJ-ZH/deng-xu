import { useEffect, useRef, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, ArrowDown } from 'lucide-react';

interface NarrativeViewProps {
  messages: { role: string, content: string, reasoning?: string }[];
  isTyping?: boolean;
  isAnalyzingData?: boolean;
  streamingContent?: string | null;
  streamingReasoning?: string | null;
  /** 是否显示思维链（`LLMConfig.showReasoning`）。关掉时既不看历史里的，也不看流式的 */
  showReasoning?: boolean;
}

/** 判定「已经贴底」的容差：小于这个距离就认为玩家还想跟着看 */
const STICK_THRESHOLD = 140;

/**
 * 叙事正文。
 *
 * ## 自动滚动：只在玩家**本来就在底部**时才跟（2026-11）
 *
 * 原来这里是无条件 `scrollIntoView`，依赖数组里还挂着 `streamingContent` ——
 * 也就是说**流式每吐一个字就拽一次**。长文本下后果很具体：
 * 玩家想往上翻两屏看看刚才那段伏笔，手指还没松开就被拽回底部，
 * 几轮下来他根本没法回读。这不是"滚动太积极"，是**抢控制权**。
 *
 * 现在的规则跟聊天软件一样：
 *  - 玩家在底部附近（< 140px）→ 新内容来了自动跟随；
 *  - 他往上翻了 → **不再打扰**，只在右下角放一个「回到底部」；
 *  - 点了那个按钮 → 重新跟随。
 *
 * 判定放在 `onScroll` 里实时更新，而不是每次渲染重算 ——
 * 否则一条流式更新就能把"玩家正在往上看"这个状态抹掉。
 */
export function NarrativeView({
  messages, isTyping, isAnalyzingData, streamingContent, streamingReasoning, showReasoning,
}: NarrativeViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isThinkingExpanded, setIsThinkingExpanded] = useState(true);
  /** 玩家是否还贴着底部（true = 跟随新内容） */
  const stickRef = useRef(true);
  /** 供渲染用的镜像（ref 变化不触发重绘，按钮的显隐要用 state） */
  const [atBottom, setAtBottom] = useState(true);
  /** 历史回复里被展开的思维链（按消息下标） */
  const [openReasoning, setOpenReasoning] = useState<Set<number>>(new Set());

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = gap < STICK_THRESHOLD;
    stickRef.current = near;
    setAtBottom(near);
  }, []);

  useEffect(() => {
    if (!stickRef.current) return;
    // 等 DOM 落地再滚，否则量到的是旧高度
    const timer = setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
    return () => clearTimeout(timer);
  }, [messages, isTyping, streamingContent, streamingReasoning]);

  const jumpToBottom = useCallback(() => {
    stickRef.current = true;
    setAtBottom(true);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const toggleReasoning = useCallback((i: number) => {
    setOpenReasoning(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);

  return (
    <div className="relative h-full">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto scroll-smooth"
      >
        {/*
          ⚠️ 场景背景**不能**放在这个滚动容器里面。
          之前写成 `sticky top-0 h-0` 想让背景不随内容滚动，结果 h-0 把高度设成 0，
          里面 absolute inset-0 的图片 bounding box 变成 656×0 —— 等于完全没画出来。
          正确做法：背景交给外层不滚动的容器（见 App.tsx），这里只负责正文。
        */}
        {/*
          aria-live="polite" 让读屏软件在叙事更新时朗读新内容。
          之前叙事流对读屏完全不可见 —— 这是个纯文字游戏，内容就是唯一的产出，
          对读屏用户来说等于什么都收不到。
          用 polite 而不是 assertive：叙事段落很长，打断当前朗读会很烦。
        */}
        <div
          className="relative p-4 md:p-12 space-y-6 md:space-y-8 font-serif leading-loose text-base md:text-lg"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="叙事内容"
        >
        {messages.map((msg, index) => {
          const hasReasoning = showReasoning && msg.role === 'assistant' && !!msg.reasoning?.trim();
          const isOpen = openReasoning.has(index);
          return (
          <motion.div
            key={index}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            className={`max-w-3xl mx-auto ${msg.role === 'user' ? 'flex justify-end' : ''}`}
          >
            {msg.role === 'user' ? (
              <div className="inline-block bg-surface/10 border-l-2 border-accent-lantern/50 pl-4 py-2 text-base text-text-secondary italic font-mono">
                {msg.content}
              </div>
            ) : msg.role === 'system' ? (
              <div className="border border-accent-lantern/20 bg-black/20 p-4 rounded-sm text-sm font-mono text-accent-lantern/80 flex items-start gap-3">
                <div className="mt-1 text-accent-lantern">✦</div>
                <div className="flex-1 leading-relaxed whitespace-pre-wrap">
                  {msg.content.replace(/^> \*\*状态变更\*\*: \n?/, '')}
                </div>
              </div>
            ) : (
              <div>
                {/* ── 思维链（存档里那条回复本来怎么想的）── */}
                {hasReasoning && (
                  <div className="mb-3 bg-black/20 border-l-2 border-accent-moth/30 rounded-r text-sm text-text-muted font-mono overflow-hidden">
                    <button
                      onClick={() => toggleReasoning(index)}
                      className="w-full flex items-center justify-between p-2 px-4 bg-black/10 hover:bg-black/20 transition-colors cursor-pointer"
                      title="这条回复生成时模型的思考过程（不占正文，也不会再发给模型）"
                    >
                      <div className="flex items-center gap-2 text-accent-moth/60 uppercase tracking-wider text-xs font-bold">
                        <span className="opacity-60">◇</span> 思维链
                      </div>
                      {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                    <AnimatePresence initial={false}>
                      {isOpen && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="p-4 pt-2 whitespace-pre-wrap opacity-80 leading-relaxed border-t border-white/5">
                            {msg.reasoning}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
                <div className="prose prose-invert prose-lg prose-p:text-text-primary/90 prose-headings:text-accent-lantern prose-strong:text-accent-forge max-w-none drop-shadow-sm">
                  <ReactMarkdown rehypePlugins={[rehypeRaw]}>
                    {msg.content}
                  </ReactMarkdown>
                </div>
              </div>
            )}

            {index < messages.length - 1 && msg.role === 'assistant' && (
              <div className="flex items-center justify-center my-8 opacity-30">
                <div className="h-px w-12 bg-text-muted"></div>
                <div className="mx-2 text-text-muted">✦</div>
                <div className="h-px w-12 bg-text-muted"></div>
              </div>
            )}
          </motion.div>
          );
        })}

        {(showReasoning ? (streamingReasoning || streamingContent) : streamingContent) && (
          <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-3xl mx-auto"
          >
              {showReasoning && streamingReasoning && (
                  <div className="mb-6 bg-black/20 border-l-2 border-accent-moth/30 rounded-r text-sm text-text-muted font-mono overflow-hidden">
                      <button
                        onClick={() => setIsThinkingExpanded(!isThinkingExpanded)}
                        className="w-full flex items-center justify-between p-2 px-4 bg-black/10 hover:bg-black/20 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-2 text-accent-moth/60 uppercase tracking-wider text-xs font-bold">
                            <span className="animate-pulse">●</span> 思维链
                        </div>
                        {isThinkingExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>

                      <AnimatePresence initial={false}>
                        {isThinkingExpanded && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="overflow-hidden"
                          >
                            <div className="p-4 pt-2 whitespace-pre-wrap opacity-80 leading-relaxed border-t border-white/5">
                                {streamingReasoning}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                  </div>
              )}

              {streamingContent && (
                  <div className="prose prose-invert prose-lg prose-p:text-text-primary/90 prose-headings:text-accent-lantern prose-strong:text-accent-forge max-w-none drop-shadow-sm">
                      <ReactMarkdown rehypePlugins={[rehypeRaw]}>
                          {streamingContent}
                      </ReactMarkdown>
                  </div>
              )}
          </motion.div>
        )}

        {isAnalyzingData && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center gap-3 py-6 text-accent-lantern/60 font-mono text-xs tracking-[0.2em] uppercase border-t border-white/5 mt-8"
          >
            <div className="flex items-center gap-3">
              <div className="flex gap-2">
                 <span className="w-1.5 h-1.5 bg-accent-lantern/50 rounded-full animate-pulse"></span>
                 <span className="w-1.5 h-1.5 bg-accent-lantern/50 rounded-full animate-pulse delay-100"></span>
                 <span className="w-1.5 h-1.5 bg-accent-lantern/50 rounded-full animate-pulse delay-200"></span>
              </div>
              <span>正在解析因果...</span>
              <div className="flex gap-2">
                 <span className="w-1.5 h-1.5 bg-accent-lantern/50 rounded-full animate-pulse delay-200"></span>
                 <span className="w-1.5 h-1.5 bg-accent-lantern/50 rounded-full animate-pulse delay-100"></span>
                 <span className="w-1.5 h-1.5 bg-accent-lantern/50 rounded-full animate-pulse"></span>
              </div>
            </div>
            <span className="text-[10px] opacity-50">Analyzing Causality</span>
          </motion.div>
        )}

        {isTyping && !streamingContent && !(showReasoning && streamingReasoning) && !isAnalyzingData && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex gap-1 items-center text-accent-moth text-sm"
          >
            <span className="w-2 h-2 bg-accent-moth rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
            <span className="w-2 h-2 bg-accent-moth rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
            <span className="w-2 h-2 bg-accent-moth rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
            <span className="ml-2">命运正在编织...</span>
          </motion.div>
        )}
        <div ref={bottomRef} />
        </div>
      </div>

      {/* 玩家往上翻了：给一个明确的出口，而不是把他拽回来 */}
      {!atBottom && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 rounded-full bg-black/60 backdrop-blur px-3 py-1.5 text-[11px] text-text-secondary border border-white/10 hover:text-text-primary hover:bg-black/80 transition-colors shadow-lg"
          title="回到最新一条"
        >
          <ArrowDown size={12} />
          回到底部
        </button>
      )}
    </div>
  );
}
