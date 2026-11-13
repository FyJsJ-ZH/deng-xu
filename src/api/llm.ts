import { LlmError, classifyLlmError } from './llmErrors';
/**
 * 通用 OpenAI 兼容 Chat Completions 封装
 *
 * 原版只写死了 DeepSeek 的 reasoner 模型与官方地址。
 * 现在服务商、地址、模型、温度全部来自 LLMConfig，可接任何 OpenAI 兼容端点。
 */

import type { LLMConfig, PresetSampling } from '@/types/cards';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /**
   * **思维链**（推理模型的 `reasoning_content`）。
   *
   * ⚠️ 这个字段**永远不发给 API** —— 拼请求时只取 `role` / `content`
   * （见 `useGameEngine` 里 `history.map(h => ({ role, content }))`）。
   * 各家服务商对"把上一轮的思考回传"态度不一，有的直接 400。
   * 它纯粹是本地的展示与存档用途：让玩家读完之后还能翻回去看模型当时怎么想的。
   */
  reasoning?: string;
}

export interface ChatOptions {
  messages: ChatMessage[];
  config: LLMConfig;
  /** 使用的模型；缺省用 config.narrativeModel */
  model?: string;
  stream?: boolean;
  /** 覆盖 config.temperature */
  temperature?: number;
  /**
   * 覆盖 `config.maxTokens`。
   *
   * ⚠️ 叙事调用**必须传** —— 见 `suggestMaxTokens()` 与 `LLMConfig.maxTokens` 的说明：
   * 不发这个参数，回复长度就由服务商默认值决定，提示词里写「约 1800 字」也没用。
   */
  maxTokens?: number;
  /** 要求返回 JSON 对象（部分服务商支持） */
  jsonMode?: boolean;
  /**
   * 单次调用覆盖玩家的「思考模式」设置（2026-11）。
   *
   * 为什么必须有这个口子：数据结算、摘要、续写这三类调用要的是**稳定结构**
   * 或者**短而准**的输出，思考模式在这里纯属副作用 ——
   * 它抢 `max_tokens`、让 JSON 不再被 `response_format` 约束、
   * 每轮还多花钱。玩家在设置里开的思考是给"写小说"的，不是给"结算"的。
   */
  thinking?: 'auto' | 'on' | 'off';
  /**
   * 预设自带的采样参数（2026-11）。
   *
   * 来自导入的酒馆预设顶层字段（见 `PresetSampling`）。`buildBody` 只挑
   * 服务商认的那几个发：OpenAI 系的四个标准参数 + `stop`；`top_k` / `min_p` /
   * `repetition_penalty` 只在**非 OpenAI 官方**的端点上发（llama.cpp / vLLM 系
   * 那几家中转才认），认不出的端点由 `llmChat` 的降级链摘掉重发。
   */
  sampling?: PresetSampling;
  /**
   * 预填（prefill）—— 在消息数组末尾追加一条空的 assistant（2026-11）。
   *
   * 默认由 `config.prefill` 决定（叙事调用才考虑）。它让模型落在**续写**状态，
   * 而不是每一轮重新判断「我是谁、该不该写」—— 破甲稳定性的关键一环。
   * 代价见 `LLMConfig.prefill` 的说明。
   */
  prefill?: boolean;
  signal?: AbortSignal;
}

export interface ProviderPreset {
  id: LLMConfig['provider'];
  label: string;
  baseUrl: string;
  /** 供 UI 下拉的候选模型 */
  models: string[];
  /** 是否需要 API Key（本地 ollama 不需要） */
  needsKey: boolean;
  keyUrl?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    /*
      ⚠️ 这两个名字换了（2026-11）。

      原先候选与默认值都是 `deepseek-chat` / `deepseek-reasoner` —— 而它们
      在官方更新日志里是**2026-07-24 停止使用**的旧名（2026-04-24 起进入三个月
      过渡期，期间分别指向 V4 Flash 的非思考/思考模式）。旧的 R1、V3 更是
      早在 2025 年就被 V3.1/V3.2 覆盖掉了，从未有过叫 `deepseek-r1` 的 API 模型名。

      现在官方价目表上只有两个：`deepseek-flash`（V4.1-Flash-1017）与
      `deepseek-v4-pro`（V4-Pro-0813）。发旧名字的后果是 400 model not found，
      或者吃到一次随时可能撤掉的兜底路由 —— 两种都不该由玩家承担。
    */
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    needsKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen2.5-72B-Instruct',
      'Qwen/Qwen3-235B-A22B',
    ],
    needsKey: true,
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'deepseek/deepseek-chat',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-2.0-flash-001',
      'meta-llama/llama-3.3-70b-instruct',
    ],
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    models: ['qwen2.5:14b', 'llama3.1:8b', 'mistral-nemo'],
    needsKey: false,
  },
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容端点',
    baseUrl: '',
    models: [],
    needsKey: true,
  },
];

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  narrativeModel: 'deepseek-flash',
  analysisModel: 'deepseek-flash',
  /*
    ⚠️ 0.8 → 0.7（2026-11）。

    玩家问「氛围为什么不如原作」。除了素材不足，温度也是一个真实原因：
    我们要的那种写法（冷、克制、具体、靠细节而不是靠形容词）在 0.8 下容易滑向
    "华丽但空"——形容词开始自己繁殖，动作反而少了。0.7 明显更稳，
    而 0.7 也不会让文字变得死板（0.5 以下才会开始重复）。

    玩家仍然可以在设置里自己调，这只是默认值。
  */
  temperature: 0.7,
  /*
    思考模式默认「跟随服务商」—— 也就是**不发这个字段**。

    不默认 `'off'` 的理由：老玩家的每一轮报文都和以前一模一样，
    这次改动对他们等于零（包括那些正在用 `deepseek-reasoner` 的人）。
    不默认 `'on'` 的理由：对不认识这个字段的端点发它，可能直接 400。
  */
  thinking: 'auto',
  /*
    **默认开**（2026-11 改）。

    ⚠️ 这个字段以前的处境很荒唐：它在类型里躺了好几轮、设置页也可以拨，
    但**从来没有任何代码读它** —— 流式思维链是无条件显示的，
    于是"关掉"没有任何效果，"打开"也没有任何效果。

    等它真正接上逻辑时，默认值是 `false`，一下子把原本能看到的思维链藏了起来：
    玩家报「现在看不到思维链了」，看到的其实是我把门关上了。

    所以默认改 true：模型给了就显示，没给就什么都不显示（那由模型决定，不是开关）。
  */
  showReasoning: true,
};

export function getPreset(provider: LLMConfig['provider']): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(p => p.id === provider);
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  // 用户可能填 https://host（不带 /v1），也可能填到 /v1/chat/completions
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}${suffix}`;
}

/** 模型名看着像推理模型（会先吐一大段思维链） */
export function isReasonerModel(name: string): boolean {
  return /reasoner|(^|[-_/])r1($|[-_/])|o1|o3|thinking/.test(String(name || '').toLowerCase());
}

/**
 * 这个模型是不是 **Gemini 系**（含经第三方中转的）。
 *
 * ## 为什么需要这条判断（2026-11，玩家在手机上撞的）
 *
 * 玩家用 `vtx-抗截断-gemini-3.8-flash-high` 走一家 OpenAI 兼容中转，
 * 每一轮都红：
 *
 * > Forced function calling (mode = ANY) is not supported when
 * > 'response_mime_type' is not set to 'text/plain'. Please set
 * > 'tool_config.function_calling_config.mode=AUTO' or set
 * > 'response_mime_type' to 'text/plain'.
 *
 * 根因不在我们、也不在模型，在**两套语义的错位**：
 *
 * - OpenAI 那边的 `response_format: {type:'json_object'}` 表示"请输出 JSON"；
 * - 中转把它翻译成 Gemini 的 `response_mime_type: 'application/json'`；
 * - 而 Vertex 在 mime 不是 `text/plain` 时，默认的 function calling 模式是
 *   `ANY`（强制必须调用工具）—— 我们没给工具，于是直接被打回。
 *
 * 实测（同一个中转、同一个模型，只改这一个字段）：
 *
 * | 请求体 | 结果 |
 * |---|---|
 * | `response_format: json_object` + thinking + max_tokens + temperature | **400** |
 * | 去掉 `response_format` | 200，返回干净 JSON |
 * | 保留 json_object、去掉 thinking | **400**（与 thinking 无关） |
 * | `response_format: {type:'text'}` | 200 |
 *
 * 所以对 Gemini 系改成 `{type:'text'}`：既避开 mime 冲突，
 * 又明确告诉它"别用 JSON mime"。JSON 的约束退回提示词层 ——
 * 数据引擎那份 prompt 本来就把 schema 写死了，而
 * `utils/jsonRepair.ts` 的容错解析连代码围栏都能剥。
 *
 * ⚠️ 认不出模型名时（玩家自填奇怪名字）还有第二道保险：
 * `llmChat` 抓到这条 400 会把 `response_format` 整个去掉重发一次。
 */
export function isGeminiLike(model: string, baseUrl = ''): boolean {
  const m = String(model || '').toLowerCase();
  if (/gemini|gemma|palm|bison|vertex/.test(m)) return true;
  const u = String(baseUrl || '').toLowerCase();
  return /generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|vertex/.test(u);
}

/**
 * 旧模型名 → 现行名字。键是**已经停止使用**的名字（小写）。
 *
 * 为什么要一张表而不是一句正则：这些名字背后是**具体的历史版本**
 * （`deepseek-chat` 在 2026-04 指的是 V4 Flash 的非思考模式，再往前是 V3.2），
 * 而正则只能判断"像不像"，判断不了"还活着没有"。
 *
 * 迁移时机在 `stores/ui.ts` 的 persist migrate —— 见那里的说明。
 */
const LEGACY_DEEPSEEK_MODELS: Record<string, string> = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-r1': 'deepseek-flash',
  'deepseek-v3': 'deepseek-flash',
  'deepseek-v3.1': 'deepseek-flash',
  'deepseek-v3.2': 'deepseek-flash',
  // 官方说这个名仍可调用，但对应模型已下线、被路由到 V4.1 Flash —— 直接换正名
  'deepseek-v4-flash': 'deepseek-flash',
};

/**
 * 把已停用的 DeepSeek 模型名换成现行名字；认不出来的原样返回。
 *
 * 只在 `provider === 'deepseek'` 时用：自定义端点 / 中转站完全可能
 * 自己起一个叫 `deepseek-chat` 的映射，替它改名会直接把人家打坏。
 */
export function migrateDeepSeekModelName(model: string): string {
  const key = String(model || '').trim().toLowerCase();
  return LEGACY_DEEPSEEK_MODELS[key] ?? model;
}

/**
 * DeepSeek 2026 系列（V4 / V4.1）**默认开启思考模式**。
 *
 * 官方文档：「思考模式默认打开，且 effort 默认为 high」，要关得显式传
 * `{"thinking": {"type": "disabled"}}`。
 *
 * 这件事对两个地方有直接影响：
 *
 *  1. `max_tokens` —— 思维链和正文抢同一份额度，必须按 3 倍给；
 *  2. `temperature` / `response_format` —— 思考模式下 temperature 不生效
 *     （传了不报错，只是白传）。
 *
 * 所以判定要和 `isReasonerModel` 分开：那个是"名字长得像推理模型"，
 * 这个是"这个服务商的这个模型默认就在思考"。混在一起会让
 * `deepseek-flash` 永远不发 temperature，将来真想关思考模式时就没法调了。
 */
export function isThinkingByDefault(provider: string, model: string): boolean {
  if (provider !== 'deepseek') return false;
  return /^deepseek-(flash|v4-flash|v4-pro)$/.test(String(model || '').trim().toLowerCase());
}

/** 玩家在设置里对「思考模式」的选择（见 `LLMConfig.thinking`） */
export type ThinkingMode = 'auto' | 'on' | 'off';

/**
 * **这一次调用到底会不会思考**。
 *
 * 三处要用同一个答案，所以合成一个函数：
 *  - `buildBody` 决定发不发 `thinking`、要不要压掉 `temperature`；
 *  - `suggestMaxTokens` 决定给 2 倍还是 3 倍额度；
 *  - 引擎决定"没收到思维链"时该不该提示玩家换模型。
 *
 * 分开写的话，最典型的翻车是：玩家选了「关掉思考」，界面却还在提示
 * 「你的模型不返回思维链，换 deepseek-flash 才有」—— 他明明是自己关的。
 */
export function willThink(model: string, provider: string, mode: ThinkingMode = 'auto'): boolean {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  /*
    auto：让服务商按它自己的默认来 —— 我们只能按已知的信息猜。

    Gemini 那一族（含中转）**默认就在思考**：实测 `gemini-3.8-flash`
    哪怕请求里一个字都没提 thinking，返回里也带着整屏的
    `reasoning_content`。所以它属于「默认思考」，得按 3 倍给额度，
    否则思维链会和正文抢同一份 `max_tokens`，正文在 1200 字上下被截断。
  */
  return isReasonerModel(model) || isThinkingByDefault(provider, model) || isGeminiLike(model);
}

/**
 * 发出去的 `max_tokens` 绝不超过这个数。
 *
 * 65536 是主流服务商里最紧的公共上限（Gemini 系、Claude 系都在这一档）。
 * 再往上只有 DeepSeek 的 393216，而叙事正文 1800 字 × 3 倍也只到 5400 ——
 * 为了那点用不完的余量去撞别人的 400，不值。
 *
 * 比 65536 更低的模型（GPT-4o 16384、部分中转 8192）由 `llmChat`
 * 按报错里的真实上限自动降级重发，不需要在这里逐个维护。
 */
export const MAX_OUTPUT_TOKENS_CAP = 65536

/**
 * 思考模式下，**给思维链预留的额度**（token）。
 *
 * ## 为什么必须预留（2026-11，玩家报「用 gemini 会返回空内容」）
 *
 * 在这之前，额度是按「正文要写多少字」算的：`字数 × 2`（思考时 ×3）。
 * 700 字的目标 → 2100 token。而实测 Gemini 走中转时，
 * **光是思考就吃掉 2000~3000 token**（结算那一轮实测 `reasoning_tokens: 2929`），
 * 2100 的额度连思考都不够 —— 正文一个字都吐不出来，界面上就是「模型返回了空内容」。
 *
 * 结论是这条系数错在**把两件东西当成一件**：
 * 正文长度是可估的（字数 × 2），思维链长度**不可估**（同一模型能想 200 也能想 3000）。
 * 所以不能按比例给，得**先垫一笔固定额度**，正文再按字数算。
 *
 * 4096 这个数来自实测：Gemini 结算一轮 2929 token、DeepSeek V4 思考模式
 * 常在 2000~3500 之间。垫 4096 之后，正文那头还有原来的空间。
 */
const THINKING_RESERVE = 4096

/**
 * 给「思考量不可控」的模型直接顶到上限。
 *
 * ## 为什么不能按比例给（2026-11，实测数据）
 *
 * 同一个模型、同一份提示词，思考量可以差一倍以上：
 *
 * | `max_tokens` | 思考 | 正文 | 结果 |
 * |---|---|---|---|
 * | 6196 | 4724 字符 | 1200 字 | 成功（险） |
 * | 16384 | 3131 字符 | 1203 字 | 成功 |
 * | 500 | **10546 字符** | **0 字** | 撞上限，`finish_reason=length` |
 *
 * 第三行是关键：思考从 4724 涨到 10546（≈3000~5000 token），
 * 而正文一个字都没开始。任何"字数 × N + 固定预留"的公式在这种波动下都会漏。
 *
 * 未用完的额度**不收费**，所以对这类模型不必精打细算 —— 直接给满。
 */
const UNBOUNDED_THINKING_CAP = 16384

/**
 * Gemini 系（含中转）叙事一轮到底给多少 —— **给满**。
 *
 * ## 为什么 16384 也不是安全线（2026-11，第二次实测）
 *
 * 上一轮把 Gemini 顶到 16384 之后玩家又报了一次「成功输出一次，重试就空」，
 * 而他截下来的原始回包是这样的：
 *
 * ```json
 * {"choices":[{"index":0,"message":{"role":"assistant","content":""},
 *              "finish_reason":"stop"}]}
 * ```
 *
 * 注意 `finish_reason` 是 `stop` 而不是 `length`：服务商认为这一轮**正常结束**了，
 * 只是 `content` 是空字符串。翻译过来是「它一直在想，想到自己觉得该收尾，
 * 一个字都没落笔」。
 *
 * 也就是说，对这类模型**不存在一个"够用"的数**：16384 有时够（思考 3076 字符），
 * 有时一次就吃光（500 额度那次实测思考 10546 字符）。额度越大，它反而越早收敛
 * （16384 时思考量比 6196 时还少），所以唯一稳的做法是把抽屉全拉开。
 *
 * 65536 是 Gemini 官方这一档的 `maxOutputTokens` 上限，未用完的额度不收费；
 * 撞到更低的中转由 `llmChat` 按报错里的真实上限自动降级重发。
 */
const GEMINI_OUTPUT_BUDGET = MAX_OUTPUT_TOKENS_CAP

/**
 * Gemini 系「要一份 JSON」时的额度。
 *
 * 结算的输出只有几百字，但它读进来的是整份状态的 JSON，思考比叙事更重
 * （实测 `reasoning_tokens: 2929` 只是常规水平）。给 32768 而不是顶到 65536，
 * 是因为结构化输出真写长了反而更难解析 —— 留一档余量的同时不让它跑野。
 */
const GEMINI_JSON_BUDGET = 32768

/**
 * 玩家手填的「单次回复上限」→ 实际发出去的额度。
 *
 * ## 为什么手填的值也要动（2026-11，玩家报「用 gemini 会返回空内容」）
 *
 * 玩家填这个数的本意是"别写太长"，但它在报文里是 `max_tokens` ——
 * **思维链 + 正文的总和**。Gemini 走中转时思考实测 2265~5000 token，
 * 他填 4096，正文就只剩一点点空间，稍一展开就整轮空。
 *
 * 所以：会思考的模型把他填的值当"正文那头"，另垫一笔；
 * 思考量不可控的（Gemini 系）直接顶到 `GEMINI_OUTPUT_BUDGET`（65536）。
 */
export function withThinkingReserve(
  configured: number,
  model = '',
  provider = '',
  thinking: ThinkingMode = 'auto',
): number {
  const base = Math.max(0, Math.floor(Number.isFinite(configured) ? configured : 0))
  if (isGeminiLike(model) && thinking !== 'off') return GEMINI_OUTPUT_BUDGET
  const want = willThink(model, provider, thinking) ? base + THINKING_RESERVE : base
  return Math.min(UNBOUNDED_THINKING_CAP, want)
}

/**
 * 按「目标回复字数」推算该发多大的 `max_tokens`。
 *
 * ## 换算依据
 *
 * 中文在不同 tokenizer 下差异很大：DeepSeek 约 0.6~1 token/字，
 * GPT 系约 1.5~2 token/字。**按 1.5 这个中间值往上取整**，
 * 宁可多发一点额度（没用完不花钱），也不要卡在临界点上把正文截断。
 *
 * - 普通模型：`replyLength × 2`
 * - 思考的模型：`replyLength × 3 + THINKING_RESERVE`
 *   —— 思维链和正文抢同一份额度，而它抢走的量不可预测
 *
 * 「会不会思考」现在有三条来源：名字像（`isReasonerModel`）、
 * 服务商的这个模型默认在思考（`isThinkingByDefault`，DeepSeek V4）、
 * 或者它是 Gemini 系（`isGeminiLike`，实测默认就吐 `reasoning_content`）。
 *
 * 下限 1024，上限 16384（多数服务商的单次输出上限，超了会被直接拒；
 * Gemini 系例外，见 `GEMINI_OUTPUT_BUDGET`）。
 * 玩家在设置里填了 `maxTokens` 时以他填的为准。
 */
export function suggestMaxTokens(
  replyLength: number,
  model = '',
  provider = '',
  thinking: ThinkingMode = 'auto',
): number {
  const chars = Number.isFinite(replyLength) && replyLength > 0 ? replyLength : 1800;
  const thinks = willThink(model, provider, thinking);
  /*
    Gemini 系（含中转）的思考量**不可控**：同一份提示词实测 4724 字符到 10546 字符，
    任何按比例给的额度都会漏一次。未用完的额度不收费，所以直接给满 ——
    这一条是 2026-11 玩家反复报「正文回空」之后加的，见 `UNBOUNDED_THINKING_CAP`。
  */
  if (thinks && isGeminiLike(model)) return GEMINI_OUTPUT_BUDGET;
  const per = thinks ? 3 : 2;
  const base = Math.ceil(chars * per);
  const want = thinks ? base + THINKING_RESERVE : base;
  return Math.min(UNBOUNDED_THINKING_CAP, Math.max(1024, want));
}

/**
 * 结算 / 摘要这类「要一份 JSON」的调用该给多少额度。
 *
 * 与叙事不是一回事：它输出的是一份结构化清单（几百字），**但**它读进来的是
 * 当前状态的整个 JSON，思考量比叙事更重（实测 Gemini 一轮 2929 token）。
 * 而它原来被写死在 4096 —— 思考 2900 + JSON 700 就顶到天花板，
 * 再长一点就被截断，于是玩家看到「这一轮的正文已经写好了，但数据结算没能解析出来」。
 *
 * 所以按模型给：会思考的给 4 倍（4096 → 16384），不会的给 2 倍（→ 8192）。
 * 玩家自己填了 `maxTokens` 时尊重他，但不会低于这个下限 ——
 * 「填小了会静默失败」比「多花一点额度」糟得多（没用完的额度不收费）。
 */
export function suggestJsonMaxTokens(model = '', baseUrl = '', configured?: number): number {
  const user = typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : 0;
  /*
    Gemini 系单独一档（2026-11）：它的思考量不可控，16384 都可能被吃光 ——
    结算空回的表现是「正文写好了，但数据没结算」，比叙事空回更让人摸不着头脑。
  */
  if (isGeminiLike(model, baseUrl)) {
    return Math.min(MAX_OUTPUT_TOKENS_CAP, Math.max(user, GEMINI_JSON_BUDGET));
  }
  const thinks = isReasonerModel(model);
  const floor = 4096 * (thinks ? 4 : 2);
  return Math.min(16384, Math.max(user, floor));
}

/**
 * 组装请求体。
 *
 * @param over 内部降级开关，调用方不该传
 */
/**
 * 预填的内容 —— 一个全角空格（2026-11）。
 *
 * 为什么是它：模型需要看到「assistant 这边已经有东西了」才会进入续写状态，
 * 但那段东西**又不能出现在正文里**。全角空格在多数分词器里是独立 token
 * （比半角空格更难被 strip 掉），字面上又没有任何语义。
 *
 * 正文解析那边（`useGameEngine`）会 `trimStart()`，所以哪怕它漏进输出也不可见。
 */
const PREFILL_TEXT = '\u3000';

function buildBody(
  opts: ChatOptions,
  stream: boolean,
  over: { noResponseFormat?: boolean; noExtraSampling?: boolean } = {},
): string {
  const { messages, config, model, temperature, jsonMode } = opts;
  /*
    ── 预填（prefill，2026-11）──

    在消息数组末尾追加一条**空的 assistant**，模型于是落在「我已经开写了」
    的状态里，而不是每一轮重新判断「我是谁、该不该写」。

    这对破甲稳不稳是决定性的：从零开始的 assistant 位，模型必须先做一次
    自我定位，破甲词灵不灵全看它那一刻的判定 —— 表现出来就是「时灵时不灵」。
    prefill 把这个判定绕过去了。

    ⚠️ 最后一条已经是 assistant 时不加（继续生成那类调用），否则会出现
    两条连续的 assistant，部分端点会 400。
  */
  const wireMessages: Array<{ role: string; content: string }> =
    messages.map(m => ({ role: m.role, content: m.content }));
  if (opts.prefill) {
    const last = wireMessages[wireMessages.length - 1];
    if (!last || last.role !== 'assistant') {
      wireMessages.push({ role: 'assistant', content: PREFILL_TEXT });
    }
  }
  const body: Record<string, unknown> = {
    /*
      模型名**去掉首尾空格**（2026-11）。从网页或聊天窗口复制过来时常带一个
      尾随空格或换行，肉眼看不出来，服务商却认不出这个名字 ——
      而报错只会说"未知模型"，玩家照着屏幕上的名字核对一百遍也发现不了。
    */
    model: (model || config.narrativeModel || '').trim(),
    /*
      **只发 role 与 content。**

      `ChatMessage` 上那个 `reasoning` 是本地展示/存档用的（让玩家回看模型怎么想的），
      各家服务商对"把上一轮的思考回传"态度不一 —— 有的忽略，有的直接 400。
      所以在这里统一剥掉，而不是指望每个调用方都记得。
    */
    messages: wireMessages.map(m => ({ role: m.role, content: m.content })),
    stream,
  };

  // 推理模型通常拒绝 temperature / response_format，只在明确安全时附带
  const modelName = String(body.model).toLowerCase();

  /*
    ── 流式也要 usage（2026-11）──

    玩家对过一次账：后台显示这一轮花了七分钱，游戏里只显示四分。

    流式响应里 usage 通常**只在最后一帧**附带，而不少 OpenAI 兼容实现
    默认根本不发 —— 于是我们退到"按字符数估算"，而估算只看得见正文，
    看不见思考链（思考模式下思维链常常比正文还长）。少算的部分就是这么来的。

    `stream_options.include_usage` 就是让服务商把最后一帧带上 usage 的开关。
    只对确认支持它的服务商发：这几位都是标准 OpenAI 兼容实现；
    自定义端点不认识这个字段时**可能直接 400**，而 400 比少算几分钱糟得多。
  */
  const streamUsageProviders = new Set(['deepseek', 'openai', 'openrouter', 'siliconflow']);
  if (stream && streamUsageProviders.has(config.provider)) {
    body.stream_options = { include_usage: true };
  }
  /*
    **两条都要判**（2026-11）。

    名字像推理模型（reasoner / r1 / o1 …）是一种；
    2026 的 DeepSeek V4 系列是另一种 —— 名字里没有任何推理标记，
    但官方"思考模式默认打开"。思考模式下 temperature 不生效
    （传了不报错，只是白传），所以照样不该发。

    第三条来源是**玩家自己选的**（`config.thinking`）：他可以在设置里
    显式开关思考模式，那比我们的猜测更权威 —— `willThink` 统一处理这三者。
    第四条是**单次调用自己的要求**（`opts.thinking`，2026-11）：
    结算 / 摘要这类调用必须关掉思考，哪怕玩家在设置里开着 —— 那是给写小说开的。
  */
  const mode: ThinkingMode = opts.thinking ?? config.thinking ?? 'auto';
  const isThinking = willThink(modelName, config.provider, mode);

  /*
    ── thinking：只在玩家**明确表态**时才发（2026-11）──

    `'auto'` 意味着"照旧"：报文与没有这个功能时完全一致，零风险。
    只有选了开 / 关才把字段放进请求体 —— 并且这时最好让玩家知道，
    认这个字段的主要是 DeepSeek 官方那一套，别家可能直接 400。

    ⚠️ **Gemini 系跳过**（2026-11）：那是 DeepSeek 的私有字段，
    Gemini 的 OpenAI 兼容层不认它 —— 实测带上不报错，但也**一点用没有**：
    该吐的思维链照吐。既然不起作用，就别发一个会让人误以为"已经关掉了"的字段。
    这个事实得让玩家知道，所以界面上的开关文案会另外说明（见设置页）。
  */
  if (mode !== 'auto' && !isGeminiLike(modelName, config.baseUrl)) {
    body.thinking = { type: mode === 'on' ? 'enabled' : 'disabled' };
  }

  /*
    ── max_tokens：**必须显式发**（2026-11）──

    这一行是本项目「字数不达标」问题的真正解。在此之前从来没发过 max_tokens，
    于是长度由服务商默认值决定：官方 4096 够用，中转站常见 2048 ——
    中文约 1365 字，正是玩家说的「不到 1200 字」。

    ⚠️ 还有个反向的坑（2026-11，玩家在手机上撞的）：玩家手填的值**原样透传**，
    他照着模型的上下文长度填了 1000000，而那个模型（Gemini 系中转）
    只让写到 65536 —— 请求在服务商侧就被打回来了，正文一个字都没生成，
    界面上只有一句英文报错。

    所以这里加一道硬闸。65536 是主流里最紧的那档公共上限（Gemini / Claude 系），
    再往上的 DeepSeek 393216 我们用不到：正文 1800 字 × 3 倍也只到 5400。
    真撞到更低的模型（GPT-4o 16384），`llmChat` 会按服务商报的数字自动降级重发。
  */
  const rawMaxTokens = opts.maxTokens ?? config.maxTokens;
  const maxTokens = typeof rawMaxTokens === 'number' && Number.isFinite(rawMaxTokens) && rawMaxTokens > 0
    ? Math.min(Math.floor(rawMaxTokens), MAX_OUTPUT_TOKENS_CAP)
    : undefined;
  if (maxTokens !== undefined) {
    body.max_tokens = maxTokens;
  }

  /*
    ── 采样参数：入参 → 预设 → 玩家设置（2026-11）──

    ## 为什么要把预设的这一组接上

    玩家报「一模一样的预设，本项目的破甲不如酒馆」。查下来一半是位置（见
    `buildNarrativePromptBody` 与 `narrativePreset.ts` 的说明），另一半是这里：
    酒馆的预设 JSON 顶层就带着作者调好的 `temperature` / `top_p` /
    `repetition_penalty` / `custom_stop`，而上一版导入器**只搬走了文字**。

    低温度让它老实按格式吐字，penalty 压住「同一个动作包反复用」的退化，
    stop 串在它想开口说「作为一个 AI」时直接切断 —— 这三件事缺一件都会
    让「同一份预设」表现出不同的人格。

    ## 优先级

    `opts.temperature`（单次调用显式指定）> `sampling.temperature`（预设作者）
    > `config.temperature`（玩家的设置页）。作者调好的值比玩家的默认值更具体，
    但显式传参比两者都权威。

    ## 扩展参数的风险

    `top_k` / `min_p` / `repetition_penalty` 不是 OpenAI 标准字段。
    llama.cpp、vLLM 那几家中转认；OpenAI 官方会 400。所以：
      - 官方端点一律不发；
      - 其余端点发，真被拒时 `llmChat` 会带着 `noExtraSampling` 摘掉重发。
    `stop` 是标准字段，任何非思考模式都发。
  */
  const sampling = opts.sampling;
  /*
    ⚠️ `noExtraSampling` **只摘扩展字段**，不摘整组（2026-11）。

    它是在端点报「不认识 top_k」之后被置位的。这时候 `temperature` / `top_p` /
    `stop` 都是标准字段、对方明明认 —— 一并摘掉等于因为一个字段不可用，
    把作者调好的整套采样都扔了，玩家会觉得"降级之后文风变了"。
  */
  const extraOk = !over.noExtraSampling && config.provider !== 'openai';
  const effectiveTemp = temperature ?? sampling?.temperature ?? config.temperature;
  if (!isThinking && typeof effectiveTemp === 'number') {
    body.temperature = effectiveTemp;
  }
  if (sampling) {
    if (!isThinking) {
      if (typeof sampling.topP === 'number') body.top_p = sampling.topP;
      if (typeof sampling.frequencyPenalty === 'number') body.frequency_penalty = sampling.frequencyPenalty;
      if (typeof sampling.presencePenalty === 'number') body.presence_penalty = sampling.presencePenalty;
    }
    if (!isThinking && extraOk) {
      if (typeof sampling.topK === 'number') body.top_k = sampling.topK;
      if (typeof sampling.minP === 'number') body.min_p = sampling.minP;
      if (typeof sampling.repetitionPenalty === 'number') body.repetition_penalty = sampling.repetitionPenalty;
    }
    if (sampling.stop?.length) body.stop = sampling.stop;
  }
  if (jsonMode && !isThinking) {
    /*
      ── 这里分两种服务商（2026-11，见 `isGeminiLike` 的说明）──

      OpenAI / DeepSeek 这一套认 `json_object`，能真的把模型的输出锁成 JSON；
      Gemini 系（含中转）拿到它会被翻成 `response_mime_type: application/json`，
      然后撞上 Vertex 默认的「强制 function calling」，整轮 400。

      所以 Gemini 系发 `{type:'text'}`：语义上等于"就是纯文本，别加 mime"。
      实测这条路能过，而 JSON 的约束由提示词与 `parseModelJson` 的容错兜着。

      认不出模型时（玩家自填的名字）先按 OpenAI 那套发 —— 那是最常见的；
      真撞上了，`llmChat` 会把 `response_format` 整个摘掉重发一次。
    */
    body.response_format = over.noResponseFormat
      ? undefined
      : isGeminiLike(modelName, config.baseUrl)
        ? { type: 'text' }
        : { type: 'json_object' };
    // `undefined` 会被 JSON.stringify 丢掉，但显式的 undefined 键不如直接删干净
    if (body.response_format === undefined) delete body.response_format;
  }
  return JSON.stringify(body);
}

/**
 * 发起一次对话请求。
 * stream=true 时返回原始 Response（交给调用方读取 SSE），否则返回解析后的 JSON。
 *
 * 关于重试（这是关键设计，别退化成"失败就算了"）：
 * 「叙事 AI」和「数据 AI」两段流水线里，任何一段因网络抖动失败，
 * 整轮就白跑了 —— 玩家投入几十秒等待与一次 API 费用，最后只得到一句报错。
 * 所以对**可重试**的错误（限流 / 5xx / 网络 / 超时）自动退避重试；
 * 对**不可重试**的（Key 无效、余额不足、模型名错）立刻失败 ——
 * 那类问题重试一百次也不会好，只会浪费时间与配额。
 *
 * 流式请求（stream=true）不在此处重试：SSE 一旦开始吐字就已经产生了副作用，
 * 重试会导致叙事内容重复。它的重试放在调用方按「整轮」粒度处理。
 */
export async function llmChat(opts: ChatOptions): Promise<any | Response> {
  const { config, stream = false, signal } = opts;
  const url = joinUrl(config.baseUrl, '/chat/completions');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

  /**
   * 这一次实际会发出去的 `max_tokens`。
   *
   * 它是**可变**的：服务商嫌太大时，下面会按它报的实际上限把它压下来重发。
   * 所以请求体不能像以前那样在循环外构建一次 —— 得跟着它走。
   */
  let effectiveMaxTokens = opts.maxTokens ?? config.maxTokens;
  /** 降级重发最多两次：65536 → 32768 → 16384。压到这个数还被拒，就是别的问题了 */
  let limitRetryLeft = 2;

  /**
   * 把 `response_format` 摘掉重发的机会（2026-11）。
   *
   * 只有一种错误会用到它：Gemini 系中转把 `json_object` 翻成了
   * `response_mime_type: application/json`，撞上 Vertex 的强制 function calling。
   * 详见 `isGeminiLike` 的说明。它和 `max_tokens` 降级是两个正交的开关，
   * 各留一次机会 —— 同时撞上时最多多花两次请求，比让玩家看到红框划算。
   */
  let jsonModeRetryLeft = 1;
  /** 本次请求要不要禁用 `response_format` */
  let noResponseFormat = false;
  /**
   * 扩展采样参数被拒时摘掉重发的机会（2026-11）。
   *
   * `top_k` / `min_p` / `repetition_penalty` 是 llama.cpp / vLLM 系的字段，
   * OpenAI 官方与部分严格中转不认识，会回 400「unrecognized parameter」。
   * 而它们对破甲稳定性有实际作用（见 `buildBody` 里那段说明），不该因为
   * 一家端点不认就整个放弃 —— 先带着发，被拒了摘掉重发。
   */
  let extraSamplingRetryLeft = 1;
  let noExtraSampling = false;

  const maxAttempts = stream ? 1 : RETRY_MAX_ATTEMPTS;

  let lastErr: LlmError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 用户已取消就别再发请求了
    if (signal?.aborted) throw new LlmError(classifyLlmError(undefined, '', { name: 'AbortError' }));

    const body = buildBody({ ...opts, maxTokens: effectiveMaxTokens }, stream, {
      noResponseFormat,
      noExtraSampling,
    });

    try {
      const response = await fetch(url, { method: 'POST', headers, body, signal });

      if (response.ok) {
        if (stream) return response;
        return response.json();
      }

      const errorText = await response.text().catch(() => '');
      const info = classifyLlmError(response.status, errorText);
      lastErr = new LlmError(info);

      /*
        ── 输出额度超了：压到服务商给的那个数，原地重发（2026-11）──

        玩家的手机上存着 `maxTokens: 1000000`（他照抄了模型的上下文长度），
        而那个 Gemini 系中转只让写到 65536。旧代码把这串数字原样发出去，
        服务商直接 400，正文一个字都没生成 —— 界面上只有一段英文 JSON。

        这里做两件事：
          1. 用报错里解析出来的上限覆盖本次额度（不是猜的，是服务商自己写的）；
          2. 把这一次从重试预算里退回去 —— 它根本没轮到模型干活。

        **流式也安全**：能走到这里说明 `response.ok === false`，
        SSE 一个字都还没开始吐，重发不会造成内容重复。
      */
      if (
        limitRetryLeft > 0
        && info.kind === 'max_tokens'
        && effectiveMaxTokens !== undefined
      ) {
        /*
          优先用服务商自己写的那个数（`info.outputLimit`）。
          报错里没带数字时（中转的 400 常常只有一句话），就**减半**再试 ——
          给满 65536 是有代价的：不是每家都真收得了这个数，
          而"额度被拒"和"额度不够"必须都能活下来。
          减半两次仍被拒，才把这个错误交给玩家。
        */
        const next = info.outputLimit !== undefined
          ? info.outputLimit
          : Math.max(THINKING_RESERVE, Math.floor(effectiveMaxTokens / 2))
        if (next < effectiveMaxTokens) {
          limitRetryLeft -= 1
          effectiveMaxTokens = next
          attempt -= 1
          continue
        }
      }

      /*
        ── Gemini 系拒了 JSON 模式：摘掉 `response_format` 原地重发（2026-11）──

        正常情况下 `isGeminiLike` 已经提前把它改成 `{type:'text'}` 了，
        走不到这里。能走到的都是"没认出来"的：玩家自定义了模型名、
        或者换了一家中转、或者模型名里根本没有 gemini 字样。

        这类错误的原文是 Vertex 的 function calling 抱怨（见 `isGeminiLike`），
        与我们的业务无关，玩家看不懂也改不了。**摘掉重发**是最好的处理 ——
        JSON 的约束本来就有两重兜底：提示词里的 schema，和 `parseModelJson`。
      */
      if (jsonModeRetryLeft > 0 && info.kind === 'function_calling' && !noResponseFormat) {
        jsonModeRetryLeft -= 1;
        noResponseFormat = true;
        attempt -= 1;
        continue;
      }

      /*
        ── 扩展采样参数被拒：摘掉它们原地重发（2026-11）──

        `top_k` / `min_p` / `repetition_penalty` 非 OpenAI 标准字段。
        只在我们**确实带了参数**、且报错读起来像「不认识的字段」时才降级 ——
        否则一次普通的 400（模型名错、余额不足）也会被误判成参数问题，
        白白多花一次请求。
      */
      if (
        extraSamplingRetryLeft > 0
        && !noExtraSampling
        && opts.sampling
        && /unknown|unrecognized|unsupported|unexpected|extra[_ ]?field|invalid[^.]{0,20}param|不支持|未知(?:的)?(?:参数|字段)/i.test(errorText)
      ) {
        extraSamplingRetryLeft -= 1;
        noExtraSampling = true;
        attempt -= 1;
        continue;
      }

      // 不可重试 → 立刻抛出（例如 Key 无效、余额不足）
      if (!info.retryable || attempt === maxAttempts) throw lastErr;

      await backoff(attempt, signal);
    } catch (e) {
      // 已经是我们包装过的，直接决定是否继续
      if (e instanceof LlmError) {
        if (!e.info.retryable || attempt === maxAttempts) throw e;
        lastErr = e;
        await backoff(attempt, signal);
        continue;
      }
      // 网络层异常（断网 / DNS / 连接被重置）
      const info = classifyLlmError(undefined, '', e);
      lastErr = new LlmError(info);
      if (info.kind === 'aborted') throw lastErr;
      if (!info.retryable || attempt === maxAttempts) throw lastErr;
      await backoff(attempt, signal);
    }
  }

  throw lastErr || new LlmError(classifyLlmError(undefined, '', '未知错误'));
}

/** 非流式请求的最大尝试次数（1 次原始 + 2 次重试） */
const RETRY_MAX_ATTEMPTS = 3;

/**
 * 指数退避 + 抖动。
 * 抖动很重要：两段流水线若同时被限流，固定间隔会让它们同步重试、继续互相挤。
 */
function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const base = 700 * Math.pow(2, attempt - 1);   // 700ms → 1400ms
  const jitter = Math.random() * 400;
  const ms = Math.min(base + jitter, 8000);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LlmError(classifyLlmError(undefined, '', { name: 'AbortError' })));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new LlmError(classifyLlmError(undefined, '', { name: 'AbortError' })));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface ParsedChunk {
  content?: string;
  reasoning?: string;
  /**
   * 这一段的 `finish_reason`。
   *
   * 通常只有最后一个 chunk 才有；`'length'` 表示**输出撞到 token 上限**。
   * 这是"这段是不是被截断"的唯一确定证据 —— 比"结尾有没有句号"这种启发式可靠得多，
   * 因为模型撞上限时常常刚好把话说圆。
   */
  finishReason?: string;
  /**
   * 服务端回报的**实际模型名**。
   *
   * 为什么要捞这个：`model` 参数发出去的是一个**别名**
   * （`deepseek-flash` 背后可能是 V4.1-Flash-1017，也可能是更新的版本），
   * 而中转站甚至可以悄悄改路由。玩家问「我们到底在调什么模型」时，
   * 唯一可信的答案是**回包里的这个字段**，不是我们配置里那个字符串。
   */
  model?: string;
}

/** 解析一行 SSE data，返回其中的增量文本 */
export function parseSseLine(line: string): ParsedChunk | null {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    const json = JSON.parse(payload);
    const delta = json.choices?.[0]?.delta || json.choices?.[0]?.message || {};
    const chunk: ParsedChunk = {};
    if (typeof delta.content === 'string' && delta.content) chunk.content = delta.content;
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) chunk.reasoning = reasoning;
    const finish = json.choices?.[0]?.finish_reason;
    if (typeof finish === 'string' && finish) chunk.finishReason = finish;
    if (typeof json.model === 'string' && json.model) chunk.model = json.model;
    // ⚠️ finishReason 也要算"有效的 chunk"：只有它在、内容为空的那一段
    // （每个流最后几乎都有一帧这样的）如果被丢掉，截断就永远判不出来。
    return chunk.content || chunk.reasoning || chunk.finishReason || chunk.model ? chunk : null;
  } catch {
    return null;
  }
}

/** 从非流式响应里取出正文 */
export function extractContent(response: any): string {
  const message = response?.choices?.[0]?.message;
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  // 部分服务商返回 content 数组
  if (Array.isArray(message.content)) {
    return message.content.map((c: any) => (typeof c === 'string' ? c : c?.text || '')).join('');
  }
  return '';
}

/**
 * 问服务商要一份**模型清单**。
 *
 * ## 为什么值得单独做（2026-11 玩家截图）
 *
 * 他两个模型名只差一个大小写（叙事 `...-Argon-high`、结算 `...-argon-high`），
 * 而中转是大小写敏感的：结算那个能跑、叙事那个回 `未知模型`。
 * 于是他看到的是「链接成功」，一生成就报错，改来改去都不知道错在哪一个字上。
 *
 * 有了清单就不一样了：直接告诉他"服务商里叫 ...-argon-high"，
 * 或者"这家根本没有这个模型，可选的是这些"。
 *
 * 拉不到就返回空数组（很多中转不实现 `/models`，不该因此判失败）。
 */
export async function listModels(config: LLMConfig): Promise<string[]> {
  const base = (config.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${base}/models`, {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const arr = Array.isArray(json?.data) ? json.data
      : Array.isArray(json?.models) ? json.models
      : Array.isArray(json) ? json : [];
    return arr
      .map((x: any) => (typeof x === 'string' ? x : x?.id ?? x?.name))
      .filter((x: any): x is string => typeof x === 'string' && !!x.trim());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 快速连通性测试。
 *
 * ## 为什么两个模型都要测（2026-11 玩家截图）
 *
 * 玩家点「测试连接」显示成功，一进游戏立刻：
 *
 * ```
 * {"detail":"未知模型: vtx-抗截断-gemini-4-Argon-high"}
 * ```
 *
 * 原因很简单 —— 这里原来只测 `analysisModel`。他两个模型名只差大小写
 * （叙事 `Argon`、结算 `argon`），中转大小写敏感：结算那个能跑，
 * 叙事那个压根不存在。于是「测试成功」是个**假信号**，
 * 而玩家对着一个绿色的成功提示去查别的，越查越远。
 *
 * 现在：先问模型清单（快、准，还能指出大小写差在哪），
 * 拉不到清单才真跑一次请求；失败时把是**哪个模型**说清楚。
 */
export async function testConnection(config: LLMConfig): Promise<void> {
  const models = [config.narrativeModel, config.analysisModel]
    .map(m => (m || '').trim())
    .filter((m, i, arr) => !!m && arr.indexOf(m) === i);

  if (!models.length) {
    throw new LlmError({
      kind: 'model', retryable: false,
      message: '还没有填模型名',
      hint: '「叙事模型」与「结算模型」都填上再测',
    });
  }

  const catalog = await listModels(config);
  if (catalog.length) {
    const missing = models.filter(m => !catalog.includes(m));
    if (missing.length) {
      const lines = missing.map(m => {
        const same = catalog.find(x => x.toLowerCase() === m.toLowerCase());
        return same
          ? `「${m}」—— 服务商里叫「${same}」，大小写差了一点`
          : `「${m}」—— 它的模型清单里没有这个名字`;
      });
      throw new LlmError({
        kind: 'model', retryable: false,
        message: `模型名对不上：${lines.join('；')}`,
        hint: `这家现在可选：${catalog.slice(0, 12).join('、')}`
          + (catalog.length > 12 ? ` 等 ${catalog.length} 个` : ''),
      });
    }
    return;
  }

  // 拿不到清单（多数中转不实现 /models）→ 老老实实跑一次最小请求
  const results = await Promise.all(models.map(model => llmChat({
    messages: [{ role: 'user', content: 'ping' }],
    config,
    model,
    stream: false,
  }).then(() => null, (e: unknown) => e)));

  const failedAt = results.findIndex(r => r !== null);
  if (failedAt === -1) return;

  const err = results[failedAt];
  const model = models[failedAt];
  if (err instanceof LlmError) {
    throw new LlmError({ ...err.info, message: `「${model}」—— ${err.info.message}` });
  }
  throw err;
}
