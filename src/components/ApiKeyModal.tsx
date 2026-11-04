import { useState, useEffect } from 'react';
import { useUIStore, applyProviderPreset } from '@/stores/ui';
import { PROVIDER_PRESETS, testConnection } from '@/api/llm';
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
    }
    // 只在弹窗显示状态变化时同步，避免用户编辑过程中被覆盖
  }, [shouldShow]);

  const patch = (updates: Partial<LLMConfig>) => setDraft(prev => ({ ...prev, ...updates }));

  const preset = PROVIDER_PRESETS.find(p => p.id === draft.provider);
  const needsKey = preset?.needsKey !== false;
  const modelCandidates = preset?.models ?? [];
  const baseUrlMissing = !draft.baseUrl.trim();
  const keyMissing = needsKey && !draft.apiKey.trim();
  const modelMissing = !draft.narrativeModel.trim() || !draft.analysisModel.trim();
  const canSave = !baseUrlMissing && !keyMissing && !modelMissing;

  const handleProviderChange = (provider: LLMConfig['provider']) => {
    setDraft(prev => applyProviderPreset(prev, provider));
    setStatus('idle');
    setLastError(null);
  };

  const handleTest = async () => {
    setStatus('testing');
    setLastError(null);
    try {
      await testConnection(draft);
      setStatus('success');
    } catch (error) {
      console.error(error);
      setLastError(error);
      setStatus('error');
    }
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
    const errorInfo = {
      message: lastError?.message || String(lastError),
      stack: lastError?.stack,
      time: new Date().toISOString(),
      userAgent: navigator.userAgent,
      provider: draft.provider,
      baseUrl: draft.baseUrl,
      model: draft.narrativeModel,
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
        </div>
        <p className="text-[10px] text-text-muted -mt-2">
          模型名可自由填写；下拉候选仅作参考，随服务商切换而更新。
        </p>

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
            （1800 字 ≈ 3600 token，推理模型 ×3）。如果你的服务商把单次输出封在 4096，
            在这里填 4096；填了以后所有调用都不会超过它。
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
          <span>显示思维链（仅对支持思维链的模型有效）</span>
        </label>

        {/* 状态与操作 */}
        {status === 'success' && (
          <p className="text-xs text-accent-edge">连接成功，配置可用。</p>
        )}
        {status === 'error' && (
          <div className="space-y-2 border border-accent-grail/30 bg-accent-grail/5 p-2 rounded">
            <p className="text-xs text-accent-grail">连接失败，请检查接口地址、模型名与 Key 是否正确。</p>
            <p className="text-[10px] font-mono text-text-muted break-all">
              {lastError?.message || String(lastError)}
            </p>
            <button
              onClick={exportErrorLog}
              className="text-xs text-text-muted underline hover:text-text-primary"
            >
              导出错误日志
            </button>
          </div>
        )}

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
