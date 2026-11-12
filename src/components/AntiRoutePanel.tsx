import { useUIStore } from '@/stores/ui'
import {
  DEFAULT_ANTI_ROUTE,
  nextTier, nextRefract, nextTrunc,
  tierLabel, refractLabel, truncLabel,
  antiRouteActive,
  type AntiRouteConfig,
} from '@/utils/antiRoute'
import { Shield, Info } from 'lucide-react'

/**
 * **防降级加固层**（2026-11，从酒馆脚本「卢克之光 V0.94」移植）。
 *
 * ## 它解决的问题
 *
 * 玩家丢进来一份 440 KB 的酒馆扩展，说「加上这个随机头部和脚本的功能」。
 * 那份脚本做的是**请求体改写**：给别人的提示词做无害微扰、插叙述层、
 * 补被截断的段落，目的是让渠道/服务商认不出这是同一套预设，
 * 从而避免被降级、被静默改写、被写到一半掐断。
 *
 * 本作的提示词是我们自己拼的，所以只取它**注入的文案与档位**，
 * 不做"改写别人"那一套。
 *
 * ## 为什么默认全关
 *
 * 强档一轮多花六七百 token，而**防全知会禁止写内心话、禁止替角色做决定** ——
 * 对想看细腻心理描写的玩家是减分项。它治的是"角色什么都知道、什么都配合"
 * 这种病，不是所有人都得吃这付药。
 *
 * ## 一句诚实的话
 *
 * 原作者自己写的：**它只发现，不阻止**。渠道若静默改写响应，这边看不出来。
 */
export function AntiRoutePanel() {
  const llm = useUIStore(s => s.llm)
  const setLlm = useUIStore(s => s.setLlm)
  const cfg: AntiRouteConfig = llm.antiRoute ?? DEFAULT_ANTI_ROUTE

  const patch = (p: Partial<AntiRouteConfig>) => {
    setLlm({ antiRoute: { ...cfg, ...p } })
  }

  const on = antiRouteActive(cfg)

  return (
    <section className="rounded border border-text-muted/20 bg-surface/20 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Shield size={13} className={on ? 'text-accent-lantern shrink-0' : 'text-text-muted shrink-0'} />
        <h2 className="text-xs font-serif font-bold text-text-primary">防降级加固</h2>
        <span className={`ml-auto text-[10px] ${on ? 'text-accent-lantern' : 'text-text-muted'}`}>
          {on ? '已开启' : '全关'}
        </span>
      </div>

      <p className="text-[10px] text-text-muted leading-relaxed">
        给提示词加"这一轮必须照做"的硬约束。全关时一个字都不注入。
        觉得模型被渠道降智、角色什么都懂、谁都围着主角转、正文总写到一半断掉 ——
        按对应的那一项开。
      </p>

      {/* 三档循环的四个开关 */}
      <div className="space-y-1.5">
        <Row
          label="防全知"
          hint="每个角色只能用他自己的见闻：没写在场就是没看见，看见皱眉就只看见皱眉"
          cost="轻 ~65 tok / 强 ~700 tok"
          value={tierLabel(cfg.know)}
          active={cfg.know !== 'off'}
          onClick={() => patch({ know: nextTier(cfg.know) })}
          spin="tier"
          dataAttr="know"
        />
        <Row
          label="去媚"
          hint="世界自己转；你说的是请求不是命令，对方可以敷衍、拖着、拒绝"
          cost="轻 ~55 tok / 强 ~650 tok"
          value={tierLabel(cfg.charm)}
          active={cfg.charm !== 'off'}
          onClick={() => patch({ charm: nextTier(cfg.charm) })}
          spin="tier"
          dataAttr="charm"
        />
        <Row
          label="抗截断"
          hint="事前提醒写够长度、别停在半句、别写「以上就是」这类收尾语"
          cost="~90 tok"
          value={truncLabel(cfg.trunc)}
          active={cfg.trunc !== 'off'}
          onClick={() => patch({ trunc: nextTrunc(cfg.trunc) })}
          spin="trunc"
          dataAttr="trunc"
        />
        <Row
          label="防路由"
          hint="每轮加一个无害随机标记，让渠道认不出这是同一套提示词（标记放在末尾，前缀缓存照常命中）"
          cost="~10 tok"
          value={refractLabel(cfg.refract)}
          active={cfg.refract !== 'off'}
          onClick={() => patch({ refract: nextRefract(cfg.refract) })}
          spin="refract"
          dataAttr="refract"
        />
      </div>

      {/* 反 OOC：总闸 + 四个子项 */}
      <div className="rounded border border-text-muted/20 bg-black/20 p-2 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-text-secondary">反 OOC</span>
          <span className="text-[9px] text-text-muted">四件事各管各的</span>
          <button
            onClick={() => patch({ ooc: !cfg.ooc })}
            data-anti="ooc"
            aria-pressed={cfg.ooc}
            className={`ml-auto text-[9px] px-1.5 py-0.5 rounded border transition-colors
              ${cfg.ooc
                ? 'border-accent-lantern/60 text-accent-lantern bg-accent-lantern/10'
                : 'border-text-muted/30 text-text-muted hover:text-text-secondary'}`}
            title={cfg.ooc ? '关掉总闸（四个子项一律不生效）' : '打开总闸'}
          >
            {cfg.ooc ? '开' : '关'}
          </button>
        </div>
        <div className={`grid grid-cols-2 gap-1 ${cfg.ooc ? '' : 'opacity-40 pointer-events-none'}`}>
          {([
            ['oocRoll', '点名', '先认出在场的是谁，再各自对照世界书'],
            ['oocTpl', '反模板', '别用眼底闪过、嘴角勾起这类现成动作包'],
            ['oocChg', '变更门槛', '态度变了要指得出是哪件事改的'],
            ['oocVoice', '口吻一致', '换给另一个人说也成立 ⇒ 重写'],
          ] as const).map(([key, label, hint]) => (
            <button
              key={key}
              onClick={() => patch({ [key]: !cfg[key] } as Partial<AntiRouteConfig>)}
              data-ooc={key}
              aria-pressed={cfg[key]}
              title={hint}
              className={`text-[10px] px-1.5 py-1 rounded border text-left transition-colors
                ${cfg[key]
                  ? 'border-text-muted/50 text-text-secondary'
                  : 'border-text-muted/25 text-text-muted/70'}`}
            >
              <span className={cfg[key] ? '' : 'line-through'}>{label}</span>
            </button>
          ))}
        </div>
        {!cfg.ooc && (
          <p className="text-[9px] text-text-muted/60">总闸关着：四个子项一律不生效，也不注任何字。</p>
        )}
      </div>

      <p className="flex items-start gap-1 text-[9px] text-text-muted/70 leading-relaxed">
        <Info size={9} className="mt-0.5 shrink-0" />
        <span>
          改动<b>下一轮</b>生效，只影响发给模型的那一份 —— 不写存档、不改世界卡。
          它只帮你发现异常，挡不住渠道静默改写响应。
        </span>
      </p>
    </section>
  )
}

function Row({
  label, hint, cost, value, active, onClick, dataAttr,
}: {
  label: string
  hint: string
  cost: string
  value: string
  active: boolean
  onClick: () => void
  spin?: 'tier' | 'refract' | 'trunc'
  dataAttr: string
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-text-secondary">{label}</div>
        <div className="text-[9px] text-text-muted/80 leading-relaxed">{hint}</div>
        <div className="text-[9px] text-text-muted/50 font-mono">{cost}</div>
      </div>
      <button
        onClick={onClick}
        data-anti={dataAttr}
        aria-pressed={active}
        title={`点一下换一档（${value}）`}
        className={`shrink-0 mt-0.5 text-[10px] px-2 py-0.5 rounded border transition-colors
          ${active
            ? 'border-accent-lantern/60 text-accent-lantern bg-accent-lantern/10'
            : 'border-text-muted/30 text-text-muted hover:text-text-secondary'}`}
      >
        {value}
      </button>
    </div>
  )
}
