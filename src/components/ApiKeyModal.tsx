import { useState, useEffect } from 'react';
import { useUIStore, applyProviderPreset } from '@/stores/ui';
import { useGameStore } from '@/stores/game';
import { PROVIDER_PRESETS, testConnectionDetailed, probeModels, isGeminiLike } from '@/api/llm';
import { classifyLlmError } from '@/api/llmErrors';
import { THINKING_MIN_MAX_TOKENS } from '@/utils/engineErrors';
import type { LLMConfig } from '@/types/cards';

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

/**
 * 模型设置弹窗
 *
 * 原版是「填 DeepSeek Key」专用弹窗，现在改成通用多服务商配置表单：
 * 服务商 / 地址 / Key / 叙事模型 / 结算模型 / 温度 / 思维链。
 */
export function ApiKeyModal() {
  const { llm, setLlm, isApiKeyModalOpen, setApiKeyModalOpen } = useUIStore();

  const [draft, setDraft] = useState<LLMConfig>(llm);
  const [status, setStatus] = useState<TestStatus>('idle');
  const [lastError, setLastError] = useState<any>(null);
  /**
   * 这个地址下能用的模型清单（2026-11）。
   *
   * `null` = 还没拉过；`[]` = 拉了，对方不回清单（多数中转不实现 `/models`）。
   * 以前这份清单只以「前 12 个…等 27 个」的形式出现在报错的一行小字里，
   * 玩家看到「等 27 个」之后就断了 —— 剩下的名字他一个都拿不到。
   */
  const [catalog, setCatalog] = useState<string[] | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogFilter, setCatalogFilter] = useState('');
  /** 刚点了哪个「叙事 / 结算」，给一行即时反馈（手机上输入框在屏幕另一头） */
  const [picked, setPicked] = useState<string | null>(null);

  // 本地服务（如 ollama）不需要 Key，因此不强制弹出
  const shouldShow = isApiKeyModalOpen || (!llm.apiKey && llm.provider !== 'ollama');
  // 已经有可用配置时，允许用右上角的 ✕ 关闭
  const canDismiss = Boolean(llm.apiKey) || llm.provider === 'ollama';

  // 每次显示时把表单重置为 store 里的当前配置
  useEffect(() => {
    if (shouldShow) {
      setDraft(llm);
      setStatus('idle');
      setLastError(null);
      setCatalog(null);
      setCatalogFilter('');
      setPicked(null);
    }
    // 只在弹窗显示状态变化时同步，避免用户编辑过程中被覆盖
  }, [shouldShow]);

  const patch = (updates: Partial<LLMConfig>) => setDraft(prev => ({ ...prev, ...updates }));

  // 服务端回包里那个 model（实际提供服务的模型名），可能为空（还没调过）
  const lastResponseModel = useGameStore(s => s.lastResponseModel);

  const preset = PROVIDER_PRESETS.find(p => p.id === draft.provider);
  const needsKey = preset?.needsKey !== false;
  const modelCandidates = preset?.models ?? [];
  const baseUrlMissing = !draft.baseUrl.trim();
  const keyMissing = needsKey && !draft.apiKey.trim();
  const modelMissing = !draft.narrativeModel.trim() || !draft.analysisModel.trim();
  const canSave = !baseUrlMissing && !keyMissing && !modelMissing;

  /** 筛选后的清单（子串匹配，不分大小写 —— 这家的名字里有大写也有中文前缀） */
  const catalogQuery = catalogFilter.trim().toLowerCase();
  const shownModels = (catalog ?? []).filter(
    m => !catalogQuery || m.toLowerCase().includes(catalogQuery)
  );

  const handleProviderChange = (provider: LLMConfig['provider']) => {
    setDraft(prev => applyProviderPreset(prev, provider));
    setStatus('idle');
    setLastError(null);
  };

  const handleTest = async () => {
    setStatus('testing');
    setLastError(null);
    setPicked(null);
    try {
      const { catalog: got } = await testConnectionDetailed(draft);
      if (got.length) setCatalog(got);
      setStatus('success');
    } catch (error: any) {
      console.error(error);
      setLastError(error);
      // 「模型名对不上」这条会把完整清单挂在错误上 —— 顺手留到列表里
      if (Array.isArray(error?.info?.modelCatalog) && error.info.modelCatalog.length) {
        setCatalog(error.info.modelCatalog);
      }
      setStatus('error');
    }
  };

  /**
   * 只拉模型清单，不发任何生成请求。
   *
   * 单独给一个入口，是因为玩家想知道的常常不是「配错了没有」，
   * 而是「这家到底有什么」—— 测通了也一样。`/models` 是最轻的一个请求。
   */
  const handleListModels = async () => {
    if (catalogBusy || baseUrlMissing) return;
    setCatalogBusy(true);
    setPicked(null);
    try {
      const probe = await probeModels(draft);
      setCatalog(probe.models);
      if (!probe.models.length && probe.networkError) {
        const info = classifyLlmError(undefined, '', probe.networkError.err);
        setLastError({ info });
        setStatus('error');
      }
    } finally {
      setCatalogBusy(false);
    }
  };

  const pickModel = (model: string, slot: 'narrative' | 'analysis') => {
    patch(slot === 'narrative' ? { narrativeModel: model } : { analysisModel: model });
    setPicked(`${slot === 'narrative' ? '叙事模型' : '结算模型'} 已填：${model}`);
  };

  const handleSave = () => {
    if (!canSave) return;
    setLlm(draft);
    setApiKeyModalOpen(false);
    setStatus('idle');
  };

  const handleClose = () => {
    if (!canDismiss) return;
    setApiKeyModalOpen(false);
    setStatus('idle');
  };

  const exportErrorLog = () => {
    if (!lastError) return;
    const key = draft.apiKey;
    const info = lastError?.info;
    const base = (draft.baseUrl || '').trim();
    /*
      这份日志是给人看的诊断包，不是堆栈转储。2026-11 玩家导出的那一份
      只有 message / stack / baseUrl / model —— 而 message 是
      「网络连接失败」，于是谁都看不出真相是端口已经关了。

      `raw` 才是那一趟 fetch 真正抛出来的话（`Failed to fetch` /
      `net::ERR_CONNECTION_REFUSED` / `Load failed`）。少它一个词，
      排查就从"看日志"变成"猜"。
    */
    const errorInfo = {
      message: lastError?.message || String(lastError),
      kind: info?.kind,
      status: info?.status,
      hint: info?.hint,
      raw: info?.raw,
      stack: lastError?.stack,
      time: new Date().toISOString(),
      userAgent: navigator.userAgent,
      // https 页面调 http 接口会被浏览器直接拦掉，报的话与"断网"一模一样
      pageOrigin: location.origin,
      baseUrl: draft.baseUrl,
      mixedContent: location.protocol === 'https:' && /^http:\/\//i.test(base),
      provider: draft.provider,
      model: draft.narrativeModel,
      analysisModel: draft.analysisModel,
      summaryModel: draft.summaryModel || undefined,
      // 完整清单也要进日志 —— 只写「等 27 个」，出了这份文件还是查不到名字
      modelCatalog: info?.modelCatalog ?? catalog ?? undefined,
      inputKeyMasked: key ? `${key.slice(0, 3)}...${key.slice(-4)}` : 'empty'
    };
    const blob = new Blob([JSON.stringify(errorInfo, null, 2)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'llm-settings-error.log';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!shouldShow) return null;

  const inputClass =
    'w-full bg-background border border-text-muted/40 rounded p-2 text-text-primary focus:border-accent-lantern outline-none text-sm';
  const labelClass = 'block text-xs text-text-muted mb-1 tracking-wider';

  return (
    <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-[100] p-4">
      <div className="bg-surface border border-text-muted p-6 rounded-lg max-w-lg w-full space-y-4 shadow-2xl relative max-h-[90vh] overflow-y-auto">
        {canDismiss && (
          <button
            onClick={handleClose}
            className="absolute top-4 right-4 text-text-muted hover:text-text-primary"
            aria-label="关闭"
          >
            ✕
          </button>
        )}

        <h2 className="text-xl font-serif text-accent-lantern">模型设置</h2>

        <p className="text-xs text-text-muted bg-black/20 p-2 rounded border border-text-muted/20">
          密钥仅保存在本机浏览器中，请求由浏览器直接发往你所填写的模型服务商，不经过任何第三方服务器。
        </p>

        {/* 服务商 */}
        <div>
          <label className={labelClass} htmlFor="llm-provider">模型服务商</label>
          <select
            id="llm-provider"
            value={draft.provider}
            onChange={(e) => handleProviderChange(e.target.value as LLMConfig['provider'])}
            className={inputClass}
          >
            {PROVIDER_PRESETS.map(p => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>

        {/* 接口地址 */}
        <div>
          <label className={labelClass} htmlFor="llm-base-url">
            接口地址（Base URL）{draft.provider === 'custom' && <span className="text-accent-grail"> *必填</span>}
          </label>
          <input
            id="llm-base-url"
            type="text"
            value={draft.baseUrl}
            onChange={(e) => patch({ baseUrl: e.target.value })}
            placeholder="https://your-endpoint/v1"
            className={`${inputClass} font-mono`}
          />
          <p className="text-[10px] text-text-muted mt-1">
            需为 OpenAI 兼容端点（<code>/chat/completions</code>）。预设服务商也允许覆盖。
          </p>
        </div>

        {/* API Key */}
        {needsKey ? (
          <div>
            <label className={labelClass} htmlFor="llm-api-key">API Key</label>
            <input
              id="llm-api-key"
              type="password"
              value={draft.apiKey}
              onChange={(e) => patch({ apiKey: e.target.value })}
              placeholder="sk-..."
              className={`${inputClass} font-mono`}
            />
            {preset?.keyUrl && (
              <a
                href={preset.keyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-accent-lantern hover:underline mt-1 inline-block"
              >
                前往 {preset.label} 获取 Key ↗
              </a>
            )}
          </div>
        ) : (
          <div className="text-xs text-text-muted bg-black/20 p-2 rounded border border-text-muted/20">
            本地服务无需 API Key，留空即可。
          </div>
        )}

        {/* 模型 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="llm-narrative-model">叙事模型</label>
            <input
              id="llm-narrative-model"
              type="text"
              list="llm-narrative-model-options"
              value={draft.narrativeModel}
              onChange={(e) => patch({ narrativeModel: e.target.value })}
              placeholder="用于写作与对话"
              className={`${inputClass} font-mono`}
            />
            <datalist id="llm-narrative-model-options">
              {modelCandidates.map(m => <option key={m} value={m} />)}
            </datalist>
          </div>
          <div>
            <label className={labelClass} htmlFor="llm-analysis-model">结算模型</label>
            <input
              id="llm-analysis-model"
              type="text"
              list="llm-analysis-model-options"
              value={draft.analysisModel}
              onChange={(e) => patch({ analysisModel: e.target.value })}
              placeholder="用于状态结算"
              className={`${inputClass} font-mono`}
            />
            <datalist id="llm-analysis-model-options">
              {modelCandidates.map(m => <option key={m} value={m} />)}
            </datalist>
          </div>
          {/*
            ── 摘要模型（2026-11）──

            玩家原话：「换了结算模型后正文速度变快了，字数也少了」。

            `analysisModel` 一直同时干两份活：读状态吐 JSON（要准），
            以及读十几轮剧情写前情摘要 + 三层记忆（要读得懂）。后者产出的东西
            **每一轮都整份进正文提示词** —— 它降档了，正文就跟着变短。

            所以单开一格。留空 = 跟随结算模型，与从前的行为一模一样。
          */}
          <div>
            <label className={labelClass} htmlFor="llm-summary-model">
              摘要模型 <span className="text-text-muted/70">（可选）</span>
            </label>
            <input
              id="llm-summary-model"
              type="text"
              list="llm-analysis-model-options"
              value={draft.summaryModel ?? ''}
              onChange={(e) => patch({ summaryModel: e.target.value })}
              placeholder="留空 = 跟随结算模型"
              className={`${inputClass} font-mono`}
            />
            <p className="text-[10px] text-text-muted mt-1 leading-relaxed">
              每 6 轮跑一次，写前情摘要与记忆。它降档不会让这一轮变快，
              只会让<b className="text-text-secondary">后面每一轮写得更短</b> ——
              结算可以换 lite，这一格别跟着换。
            </p>
          </div>
        </div>
        <p className="text-[10px] text-text-muted -mt-2">
          模型名可自由填写；下拉候选仅作参考，随服务商切换而更新。
        </p>
        {/*
          2026-11 玩家截图：两个模型名只差一个大小写（叙事 `...-Argon-high`、
          结算 `...-argon-high`），而中转大小写敏感 —— 于是"测试连接"用结算那个过了，
          一生成就 `未知模型`。这种情况肉眼几乎看不出来，所以在这里点名。
        */}
        {(() => {
          const a = draft.narrativeModel.trim()
          const b = draft.analysisModel.trim()
          if (!a || !b || a === b) return null
          if (a.toLowerCase() !== b.toLowerCase()) return null
          return (
            <p className="text-[10px] text-accent-grail -mt-2 leading-relaxed">
              两个模型名<b>只差大小写</b>（<span className="font-mono">{a}</span> /{' '}
              <span className="font-mono">{b}</span>）。有些中转是大小写敏感的，
              其中一个会报「未知模型」—— 建议统一成服务商文档里的写法。
            </p>
          )
        })()}

        {/* 温度 */}
        <div>
          <div className="flex items-center justify-between">
            <label className={labelClass} htmlFor="llm-temperature">发散程度（temperature）</label>
            <span className="text-xs font-mono text-accent-lantern">{draft.temperature.toFixed(1)}</span>
          </div>
          <input
            id="llm-temperature"
            type="range"
            min={0}
            max={1.5}
            step={0.1}
            value={draft.temperature}
            onChange={(e) => patch({ temperature: Number(e.target.value) })}
            className="w-full accent-accent-lantern"
          />
        </div>

        {/* 单次回复上限 */}
        <div>
          <label className={labelClass} htmlFor="llm-max-tokens">单次回复上限（max_tokens）</label>
          <input
            id="llm-max-tokens"
            type="number"
            min={256}
            max={32768}
            step={256}
            value={draft.maxTokens ?? ''}
            onChange={(e) => {
              const v = e.target.value.trim()
              patch({ maxTokens: v === '' ? undefined : Number(v) })
            }}
            placeholder="留空 = 按世界的篇幅自动推算"
            className={`${inputClass} font-mono`}
          />
          <p className="text-[10px] text-text-muted mt-1 leading-relaxed">
            这一项决定模型<b>一次最多能写多少字</b>。留空时按目标字数自动推算
            （1800 字 ≈ 3600 token；会思考的情况按 3 倍给，不思考按 2 倍 ——
            思考模式下思维链和正文抢同一份额度）。如果你的服务商把单次输出封在 4096，
            在这里填 4096；填了以后所有调用都不会超过它。
            <br />
            <b>Gemini 系例外</b>：它的思考量不可控，填多少都会被抬到 65536（用不完不收费）。
          </p>
          {/*
            ⚠️ 填太小 + 思考模式 = 正文一个字都写不出来（2026-11 玩家实测）。
            思维链先把额度吃光，`content` 还没开始就没了，错误信息看着像
            "模型名填错了"。所以在他填的那一刻就点出来，别等生成失败。
          */}
          {(draft.thinking ?? 'auto') !== 'off'
            && typeof draft.maxTokens === 'number'
            && draft.maxTokens > 0
            && draft.maxTokens < THINKING_MIN_MAX_TOKENS && (
              <p className="text-[10px] text-accent-grail mt-1 leading-relaxed">
                这个值偏小：思考模式下思维链会先吃掉几千 token，正文可能一个字都写不出来。
                建议留空让程序按篇幅推算，或填到 {THINKING_MIN_MAX_TOKENS} 以上。
              </p>
            )}
        </div>

        {/* 思考模式（2026-11） */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className={labelClass}>思考模式</span>
            <span className="text-[10px] font-mono text-text-muted">决定模型想不想</span>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {([
              { v: 'auto', label: '跟随服务商', hint: '不发这个参数。报文与以前完全一样，由服务商按自己的默认来 —— 不确定就选这个。' },
              { v: 'on', label: '开启', hint: '先思考再写：叙事更稳，但首字更慢、token 更贵（思考量也算输出）。' },
              { v: 'off', label: '关闭', hint: '直接写：更快更省，没有思维链。正文额度也按非思考给（2 倍而不是 3 倍）。Gemini 系关不掉，见下面那行。' },
            ] as const).map(o => {
              const active = (draft.thinking ?? 'auto') === o.v
              return (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => patch({ thinking: o.v })}
                  title={o.hint}
                  className={`px-2 py-1.5 text-[11px] rounded border transition-colors ${
                    active
                      ? 'border-accent-lantern/60 text-accent-lantern bg-accent-lantern/10'
                      : 'border-text-muted/30 text-text-muted hover:text-text-primary hover:border-text-muted/60'
                  }`}
                >
                  {o.label}
                </button>
              )
            })}
          </div>
          <p className="text-[10px] text-text-muted leading-relaxed">
            {isGeminiLike(draft.narrativeModel || '', draft.baseUrl || '') ? (
              <>
                当前模型是 <span className="font-mono">Gemini</span> 系的：它 <b>默认就思考</b>，
                而且不认 <span className="font-mono">thinking</span> 字段 —— 实测关不掉，
                该吐的思维链照吐（我试过 <span className="font-mono">reasoning_effort</span>、
                <span className="font-mono">thinking_budget</span> 四种写法，一种都没用）。
                所以这个开关对它会<b>失效</b>（报文里干脆不发，免得让你以为已经关上了）。
                代价是首字更慢，而且<b>额度一律按 65536 给</b> ——
                它同一份提示词的思考量能从 3000 字跳到 10000 字，16384 也会被吃光，
                然后回一个「finish_reason 有值、正文是空串」的空壳。额度用不完不收费，
                所以这里不精打细算；「单次回复上限」<b>留空最好</b>（填了也会被抬到上限）。
                结算那一轮读进来的状态更大、更慢，可以把下面的「结算模型」单独换成一个不想事的模型。
              </>
            ) : (draft.thinking ?? 'auto') === 'auto'
              ? '不发送 thinking 字段，各家按自己的默认走。DeepSeek 的 V4 系列默认是开着的。'
              : (draft.thinking ?? 'auto') === 'on'
                ? '发送 {"thinking": {"type": "enabled"}}。认这个字段的主要是 DeepSeek 官方端点，别家可能不认。'
                : '发送 {"thinking": {"type": "disabled"}}。认这个字段的主要是 DeepSeek 官方端点，别家可能不认。'}
          </p>
        </div>

        {/* 思维链 */}
        <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={draft.showReasoning}
            onChange={(e) => patch({ showReasoning: e.target.checked })}
            className="accent-accent-lantern"
          />
          <span>显示思维链 <span className="text-text-muted text-xs">（只管显示，不管模型想不想）</span></span>
        </label>

        {/* 状态与操作 */}
        {status === 'success' && (
          <p className="text-xs text-accent-edge">连接成功，配置可用。</p>
        )}
        {/*
          「上次请求实际用的模型」（2026-11）。
          玩家问过「官方不是下架 R1 和 V3 了吗，我们调用的到底是什么」——
          配置里填的是**别名**（deepseek-flash 背后是 V4.1-Flash-1017，
          明天可能是别的版本），所以这里显示的是**服务端回包里那个 model 字段**，
          不是我们发出去的那个字符串。
        */}
        {lastResponseModel && (
          <p className="text-[10px] font-mono text-text-muted leading-relaxed">
            上次请求服务端回报的模型：<span className="text-text-secondary">{lastResponseModel}</span>
            {lastResponseModel !== draft.narrativeModel && (
              <span className="text-accent-lantern">（与你填的 {draft.narrativeModel} 不同 —— 这是服务商的映射或中转）</span>
            )}
          </p>
        )}
        {status === 'error' && (
          <div className="space-y-2 border border-accent-grail/30 bg-accent-grail/5 p-2 rounded">
            {/*
              这里以前是一句固定的话：「连接失败，请检查接口地址、模型名与 Key 是否正确。」
              —— 三选一，等于让玩家自己猜（2026-11 他就在这三样都没错的情况下卡了两轮）。
              现在显示分类后的**具体那一句**，例如
              「模型名对不上：「…-Argon-high」—— 服务商里叫「…-argon-high」，大小写差了一点」。
            */}
            <p className="text-xs text-accent-grail break-words">
              {lastError?.info?.message || '连接失败，请检查接口地址、模型名与 Key 是否正确。'}
            </p>
            {lastError?.info?.hint && (
              <p className="text-[10px] text-text-muted leading-relaxed break-words">
                {lastError.info.hint}
              </p>
            )}
            {lastError?.info?.raw && lastError.info.raw !== lastError.info.message && (
              <p className="text-[10px] font-mono text-text-muted/70 break-all">
                {lastError.info.raw}
              </p>
            )}
            {!lastError?.info && (
              <p className="text-[10px] font-mono text-text-muted break-all">
                {lastError?.message || String(lastError)}
              </p>
            )}
            {/*
              玩家自己开了 / 关了思考模式，然后在别的端点上测连接失败时，
              最可能的错因恰恰不是 Key 也不是模型名，而是那个参数不被认。
              不说这一句，他会去反复改模型名。
            */}
            {(draft.thinking ?? 'auto') !== 'auto' && (
              <p className="text-[10px] text-text-muted leading-relaxed">
                也可能是这个端点不认 <span className="font-mono">thinking</span> 参数 ——
                把「思考模式」改回「跟随服务商」再测一次（那一档不发这个字段）。
              </p>
            )}
            <button
              onClick={exportErrorLog}
              className="text-xs text-text-muted underline hover:text-text-primary"
            >
              导出错误日志
            </button>
          </div>
        )}

        {/*
          ── 模型清单（2026-11）──
          玩家的原话：「想要能看到此接口地址的所有可选模型」。

          以前这份清单只以「这家现在可选：A、B、C…等 27 个」的形式出现在报错的
          一行小字里。问题不在"看不全"，而在**剩下的名字完全拿不到**：
          这家的命名是 `pg-gemini-3.5-flash-lite` / `抗截断-pg-gemini-3.5-flash-lite`
          / `假流式-pg-gemini-3.5-flash-lite` 这种，靠猜拼不出来。

          所以给一个独立入口：不测连接、不发生成请求，只问 `/models`，
          然后可筛、可点 —— 点「叙事」「结算」直接填进对应的框。
        */}
        <div className="space-y-2 border border-text-muted/30 rounded p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-text-secondary">
              模型清单
              {catalog && <span className="text-text-muted">（{catalog.length} 个）</span>}
            </span>
            <button
              onClick={handleListModels}
              disabled={catalogBusy || baseUrlMissing}
              className="text-[11px] text-accent-lantern underline hover:text-accent-lantern/80 disabled:opacity-50"
            >
              {catalogBusy ? '拉取中…' : catalog ? '重新拉取' : '拉取清单'}
            </button>
          </div>

          {catalog === null ? (
            <p className="text-[10px] text-text-muted leading-relaxed">
              向这个地址要一次模型列表。只发一个 <span className="font-mono">/models</span> 请求，
              不生成任何内容、不花钱。
            </p>
          ) : catalog.length === 0 ? (
            <p className="text-[10px] text-text-muted leading-relaxed">
              这个地址没返回清单（多数中转不实现 <span className="font-mono">/models</span>），
              只能按服务商的文档手填模型名。
            </p>
          ) : (
            <>
              <input
                value={catalogFilter}
                onChange={(e) => setCatalogFilter(e.target.value)}
                placeholder="筛选，比如 gemini-3.5 / flash / 抗截断"
                className="w-full bg-background border border-text-muted/40 rounded px-2 py-1.5 text-[11px] text-text-primary focus:border-accent-lantern outline-none"
              />
              <ul className="max-h-56 overflow-y-auto space-y-0.5 pr-1">
                {shownModels.map(m => (
                  <li key={m} className="flex items-center gap-1.5">
                    <span className="font-mono text-[11px] text-text-secondary break-all flex-1">
                      {m}
                    </span>
                    <button
                      onClick={() => pickModel(m, 'narrative')}
                      title="填进「叙事模型」"
                      className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-text-muted/40 text-text-muted hover:text-accent-lantern hover:border-accent-lantern/60"
                    >
                      叙事
                    </button>
                    <button
                      onClick={() => pickModel(m, 'analysis')}
                      title="填进「结算模型」"
                      className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-text-muted/40 text-text-muted hover:text-accent-lantern hover:border-accent-lantern/60"
                    >
                      结算
                    </button>
                  </li>
                ))}
              </ul>
              {shownModels.length === 0 && (
                <p className="text-[10px] text-text-muted">没有匹配的名字。</p>
              )}
            </>
          )}

          {picked && <p className="text-[10px] text-accent-edge break-all">{picked}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={handleTest}
            disabled={status === 'testing' || baseUrlMissing}
            className="px-4 py-2 text-sm text-text-secondary border border-text-muted/40 rounded hover:text-text-primary hover:border-text-muted disabled:opacity-50 transition-colors"
          >
            {status === 'testing' ? '测试中...' : '测试连接'}
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="px-4 py-2 text-sm bg-accent-lantern/20 text-accent-lantern border border-accent-lantern/50 rounded hover:bg-accent-lantern/30 disabled:opacity-50 transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
