/* ==========================================================================
 * 选题决策助手 · 选题生成层（ideate）
 *
 * 职责：把「我是电子信息专业的，对图像识别有兴趣，没GPU，一学期，我想做...」
 *       翻译成 N 个具体到能开题的候选题目，每个带可被文献库检索的英文术语。
 * ========================================================================== */
'use strict';

/**
 * 已按供应商官方文档核对的远程 OpenAI Chat Completions 线路。
 * 不内置本地模型；不再保留无法确认仍受支持的旧服务商。
 * verifiedAt 仅表示线路/默认模型在该日期经官方文档确认，不代表用户 Key、余额或权限有效。
 */
const PROVIDER_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek (官方)', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-flash', docs: 'https://api-docs.deepseek.com/', verifiedAt: '2026-08-19' },
  { id: 'siliconflow', name: '硅基流动 (SiliconFlow)', baseUrl: 'https://api.siliconflow.cn/v1', defaultModel: 'deepseek-ai/DeepSeek-V3.2', docs: 'https://docs.siliconflow.cn/cn/userguide/quickstart', verifiedAt: '2026-08-19' },
  { id: 'zhipu', name: '智谱 BigModel (GLM)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-5-turbo', docs: 'https://open.bigmodel.cn/cn/guide/start/quick-start', verifiedAt: '2026-08-19' },
  { id: 'moonshot', name: '月之暗面 (Kimi)', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-k3', docs: 'https://platform.moonshot.cn/docs/guide/start-using-kimi-api', verifiedAt: '2026-08-19' },
  { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', defaultModel: 'MiniMax-M3', docs: 'https://platform.minimaxi.com/docs/api-reference/text-openai-api', verifiedAt: '2026-08-19' },
  { id: 'openrouter', name: 'OpenRouter (聚合网关)', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openrouter/auto', docs: 'https://openrouter.ai/docs/quickstart', verifiedAt: '2026-08-19' },
  { id: 'openai', name: 'OpenAI (官方)', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', docs: 'https://platform.openai.com/docs/api-reference', verifiedAt: '2026-08-19' },
  { id: 'custom', name: '自定义 OpenAI 兼容接口', baseUrl: '', defaultModel: '', docs: '', verifiedAt: null },
];

/** 接受 BaseURL 或完整端点，统一还原成不带尾斜杠的 API 根地址。 */
function normalizeBaseUrl(raw) {
  return String(raw || '').trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|models)$/i, '');
}

function endpoint(baseUrl, path) {
  return normalizeBaseUrl(baseUrl) + '/' + String(path).replace(/^\/+/, '');
}

/** /models 常混入 embedding、reranker、图片、语音和视频模型，不能放进文本聊天下拉框。 */
const NON_CHAT_MODEL_RE = /(?:^|[\/_\-.])(embeddings?|embed|rerank(?:er)?|moderation|whisper|transcri(?:be|ption)|tts|speech|realtime|dall-e|gpt-image|imagen|stable-diffusion|flux|kolors|cogview|text-to-image|image-generation|video-generation)(?:$|[\/_\-.])/i;
function isLikelyChatModel(item, id) {
  const modelId = String(id || '');
  if (!modelId || NON_CHAT_MODEL_RE.test(modelId)) return false;
  const type = String(item && (item.type || item.task || item.model_type) || '').toLowerCase();
  if (/(embedding|rerank|moderation|image-generation|text-to-image|speech|transcription)/.test(type)) return false;
  const out = item && item.architecture && item.architecture.output_modalities;
  if (Array.isArray(out) && out.length && !out.includes('text')) return false;
  return true;
}

const IDEATE_SYSTEM_PROMPT = [
  '你是一位带过很多本科毕业设计的导师。你的任务是为一个具体的学生提出可落地的选题。',
  '',
  '硬性要求：',
  '1. 题目必须具体到能直接写进开题报告，不要给「人工智能在教育中的应用」这类宽泛方向。',
  '2. 每个题目必须拆出两个【真实存在的英文学术检索词】：',
  '   - objectEn：研究对象/任务，例如 "PCB defect diagnosis"、"bearing fault diagnosis"、"cyberbullying"',
  '   - methodEn：技术手段，例如 "few-shot learning"、"graph neural network"、"diffusion model"',
  '   这两个词会被拿去真实学术数据库精确检索，所以必须是学界通用写法，',
  '   不要自创缩写、不要用中文拼音、不要把两个概念硬拼成一个短语。',
  '3. 必须评估这个题目需要什么条件（needs），字段取值受限：',
  '   - gpu: "none" | "single" | "multi"   （不需要显卡 / 一张消费级显卡 / 多卡）',
  '   - dataset: "public" | "self-collect" | "private"  （公开数据集 / 需自己采集标注 / 需医院企业等非公开数据）',
  '   - weeks: 整数，预计需要多少周完成',
  '   - codingLevel: "beginner" | "mid" | "strong"',
  '   请诚实评估，不要为了让题目好看而低报难度。',
  '4. rationale：一句话说明为什么这个题目适合这个学生（结合他的专业与条件），控制在 60 个汉字以内。',
  '5. onboarding：这个学生选了这题之后，第一步该怎么动。三个字段都必须给，都要具体，每项控制在 80 个汉字以内：',
  '   - firstStep：开题第一周就能上手做的一件具体事。要能立刻执行，',
  '     例如「先跑通 XXX 公开数据集上的 baseline，把原始精度复现出来」，',
  '     不要写「查阅文献」「学习相关知识」这种放在任何题目上都成立的空话。',
  '   - keyRisk：这个题目最可能卡住本科生的那一个难点，以及它为什么难。',
  '   - startFrom：建议从哪个公开数据集或哪类开源实现入手。',
  '     只写你确实知道存在的，不确定就描述该去哪类资源找，不要编造仓库名或链接。',
  '6. 覆盖不同难度：既要有保守稳妥的，也要有一两个有挑战的，让学生自己权衡。',
  '',
  '严禁做的事：',
  '- 严禁判断题目是否新颖、是否有人做过、有多少篇论文 —— 这由真实文献库核查，不是你的工作。',
  '- 严禁在输出里出现「创新性高」「研究较少」「前沿空白」这类你无法证实的判断。',
  '- 严禁编造不存在的英文术语。若不确定某个术语的标准写法，换一个你确定的。',
  '',
  '只输出 JSON，不要任何解释文字、不要 markdown 代码块。格式：',
  '{"ideas":[{"zh":"中文题目","objectEn":"...","methodEn":"...",',
  '"needs":{"gpu":"none","dataset":"public","weeks":12,"codingLevel":"mid"},',
  '"rationale":"...",',
  '"onboarding":{"firstStep":"...","keyRisk":"...","startFrom":"..."}}]}',
].join('\n');

function buildUserPrompt(profile) {
  const p = profile || {};
  const map = {
    gpu: { none: '没有显卡，只有普通笔记本', single: '有一张消费级显卡', multi: '可用实验室多卡服务器', cloud: '可用云平台按需租用' },
    dataset: { none: '没有数据，也没有采集条件', public: '只能用网上的公开数据集', 'self-collect': '有条件自己采集并标注数据', private: '能拿到实验室/医院/企业的非公开数据' },
    codingLevel: { beginner: '编程入门（会写基础脚本）', mid: '编程中等（能改开源项目）', strong: '编程较强（能独立实现算法）' },
  };
  const L = [];
  L.push('学生基本情况与条件约束：');
  L.push('- 专业：' + (p.major || '未填'));
  if (p.grade) L.push('- 年级：' + p.grade);
  if (p.interest) L.push('- 感兴趣的大方向：' + p.interest);
  L.push('- 算力条件：' + (map.gpu[p.gpu] || p.gpu || '未填'));
  L.push('- 数据条件：' + (map.dataset[p.dataset] || p.dataset || '未填'));
  L.push('- 编程水平：' + (map.codingLevel[p.codingLevel] || p.codingLevel || '未填'));
  if (p.weeks) L.push('- 可投入时间：约 ' + p.weeks + ' 周');
  if (p.goal) L.push('- 目标：' + p.goal);

  // 用户自由输入的定制需求描述
  const customWish = (p.customWish || p.extra || '').trim();
  if (customWish) {
    L.push('');
    L.push('★★★ 学生的个性化选题需求与具体想法（请重点围绕以下要求出题）★★★：');
    L.push('"' + customWish + '"');
  }

  const count = parseInt(p.count, 10) || 6;
  L.push('');
  L.push('请根据以上需求与条件，给出 ' + count + ' 个候选题目。');
  L.push('注意：他的条件是硬约束，需要多卡GPU或非公开数据的题目请如实标注 needs，');
  L.push('不要为了凑数而谎报成他能做的 —— 系统随后会自动做条件匹配并筛掉做不了的。');
  return L.join('\n');
}

/* ------------------------------------------------------------------ LLM 与模型列表调用 */

/**
 * 创建选题生成器。用 OpenAI 兼容接口。
 * @param {Object} cfg { baseUrl, apiKey, model, fetchImpl?, temperature?, timeoutMs? }
 */
function createIdeator(cfg) {
  const c = Object.assign({
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    timeoutMs: 180000,
    maxTokens: 6144,
    maxRetries: 1,
    // 最小兼容请求默认不发送 temperature / response_format；仅显式开启才发送。
    temperature: null,
    jsonMode: false,
  }, cfg || {});
  c.baseUrl = normalizeBaseUrl(c.baseUrl);
  const doFetch = c.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);

  function configured() {
    return !!(c.apiKey && c.baseUrl && c.model && doFetch);
  }

  // 在飞的请求，供界面「停止」按钮真正掐断，而不是只让结果不显示。
  const inFlight = new Set();
  let abortedByUser = false;
  function abort() {
    abortedByUser = true;
    for (const ctl of inFlight) { try { ctl.abort(); } catch (e) { /* 已中止 */ } }
    inFlight.clear();
  }

  function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (c.apiKey) h.Authorization = 'Bearer ' + c.apiKey;
    return h;
  }

  function cleanError(status, raw, action) {
    const rawSource = String(raw || '').replace(/\s+/g, ' ');
    const tokenParameterRejected = (status === 400 || status === 422) &&
      /(unknown|unsupported|unrecognized|extra|not permitted|unexpected)[^\n]*(parameter|param|field|argument)/i.test(rawSource) &&
      /(max_tokens|max_completion_tokens|output token|max output)/i.test(rawSource);
    let text = rawSource;
    // 短 key 必然无效，也一并遮蔽；避免错误信息把用户的误填内容带进页面。
    if (c.apiKey) text = text.split(c.apiKey).join('***');
    text = text.slice(0, 300);
    let kind = 'http';
    let hint = '';
    if (status === 400) hint = '请求格式或模型名不被该线路接受';
    else if (status === 401) { kind = 'auth'; hint = 'API Key 缺失、无效或不属于该区域'; }
    else if (status === 402) { kind = 'billing'; hint = '账户余额或额度不足'; }
    else if (status === 403) { kind = 'permission'; hint = 'Key 没有该模型权限，或请求被供应商拒绝'; }
    else if (status === 404) { kind = 'route'; hint = 'Base URL、接口路径或模型名不存在'; }
    else if (status === 429) { kind = 'rate_limit'; hint = '请求过于频繁或已达限额'; }
    else if (status >= 500) { kind = 'upstream'; hint = '供应商服务暂时异常'; }
    const e = new Error(action + '失败：HTTP ' + status + (hint ? '（' + hint + '）' : '') + (text ? '；' + text : ''));
    e.status = status;
    e.kind = kind;
    e.raw = text;
    e.tokenParameterRejected = tokenParameterRejected;
    return e;
  }

  function invalidJson(res, rawText, action) {
    const ct = (res && res.headers && typeof res.headers.get === 'function'
      && res.headers.get('content-type')) || '未返回';
    let snippet = String(rawText || '').replace(/\s+/g, ' ').slice(0, 140) || '（空响应）';
    if (c.apiKey) snippet = snippet.split(c.apiKey).join('***');
    const e = new Error(action + '失败：HTTP ' + (res && res.status) +
      ' 返回的不是 JSON（content-type：' + ct + '）；内容开头：' + snippet);
    e.kind = 'invalid_response';
    e.contentType = ct;
    return e;
  }

  async function request(path, init, timeoutMs, action) {
    if (!c.baseUrl || !doFetch) throw new Error('缺少 Base URL 或当前环境没有 fetch');
    if (abortedByUser) {
      const e = new Error((action || '请求') + '已中止');
      e.kind = 'aborted';
      throw e;
    }
    const url = endpoint(c.baseUrl, path);
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs || c.timeoutMs) : null;
    const stopTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    if (ctl) inFlight.add(ctl);
    try {
      const res = await doFetch(url, Object.assign({}, init || {}, {
        headers: Object.assign({}, headers(), (init && init.headers) || {}),
        signal: ctl ? ctl.signal : undefined,
      }));
      // 拿到响应头后正文仍可能长时间不结束，保留一个与请求超时一致的读取兜底，
      // 防止半开连接让页面永远停在生成中。
      stopTimer();
      timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs || c.timeoutMs) : null;
      // 先取原文再解析：部分供应商（如 DeepSeek）出错时返回无 content-type 的纯文本，
      // 直接 res.json() 会把真正原因吐成“不是 JSON”而丢掉信息。
      let rawText = null;
      if (typeof res.text === 'function') rawText = await res.text();
      if (!res.ok) throw cleanError(res.status, rawText || '', action || '请求');
      let data;
      if (rawText !== null) {
        try { data = JSON.parse(rawText); }
        catch (e) { throw invalidJson(res, rawText, action || '请求'); }
      } else {
        try { data = await res.json(); }
        catch (e) { throw invalidJson(res, '', action || '请求'); }
      }
      return { data, status: res.status, url };
    } catch (e) {
      if (e && e.kind) throw e;
      const msg = String((e && e.message) || e);
      const err = new Error(/AbortError|aborted/i.test(msg)
        ? (action || '请求') + '超时，请检查线路或换一个模型'
        : (action || '请求') + '无法连接：' + msg);
      err.kind = /AbortError|aborted/i.test(msg) ? 'timeout' : 'network';
      throw err;
    } finally {
      stopTimer();
      if (ctl) inFlight.delete(ctl);
    }
  }

  function extractContent(data) {
    const choice = data && data.choices && data.choices[0];
    const msg = choice && choice.message;
    const content = msg && msg.content;
    const finish = choice && (choice.finish_reason || choice.finishReason);
    const responseStatus = data && data.status;
    const incompleteReason = data && data.incomplete_details && data.incomplete_details.reason;
    const truncatedByGateway = finish === 'length' || finish === 'max_tokens' || finish === 'max_output_tokens' ||
      responseStatus === 'incomplete' || incompleteReason === 'max_output_tokens';
    const reasoning = msg && (msg.reasoning_content || msg.reasoning);
    const hasReasoning = typeof reasoning === 'string' && reasoning.trim();

    // 兼容 Chat Completions 的字符串、内容分片数组、旧式 completions.text，
    // 以及部分兼容网关转发的 Responses 风格 output_text/output。
    const readTextParts = value => {
      if (typeof value === 'string') return value;
      if (!Array.isArray(value)) return '';
      return value.map(part => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        if (part.text && typeof part.text.value === 'string') return part.text.value;
        if (typeof part.output_text === 'string') return part.output_text;
        if (typeof part.content === 'string') return part.content;
        if (Array.isArray(part.content)) return readTextParts(part.content);
        return '';
      }).join('');
    };
    const text = readTextParts(content) ||
      readTextParts(content && content.text) ||
      readTextParts(content && content.output_text) ||
      readTextParts(choice && choice.text) ||
      readTextParts(data && data.output_text) ||
      readTextParts(msg && msg.function_call && msg.function_call.arguments) ||
      readTextParts(msg && msg.tool_calls && msg.tool_calls[0] &&
        msg.tool_calls[0].function && msg.tool_calls[0].function.arguments);
    const output = data && data.output;
    const outputText = text || (Array.isArray(output)
      ? output.map(item => readTextParts(item && item.content) || readTextParts(item && item.text)).join('')
      : '') || (data && (data.output_text || data.outputText)
        ? readTextParts(data.output_text || data.outputText) : '') ||
      (data && (data.ideas || data.topics || data.candidates)
        ? JSON.stringify(data) : '') ||
      (data && (data.output_parsed || data.parsed)
        ? JSON.stringify(data.output_parsed || data.parsed) : '') ||
      (msg && (msg.parsed || msg.json)
        ? JSON.stringify(msg.parsed || msg.json) : '') ||
      (content && typeof content === 'object' && !Array.isArray(content)
        ? JSON.stringify(content) : '');

    // 即使 content 非空，finish/status=incomplete 也表示正文可能停在 JSON 中间，
    // 不能把残片交给解析器再误报成普通格式错误。
    if (truncatedByGateway) {
      const err = new Error('模型输出达到长度上限，JSON 可能尚未结束' +
        (hasReasoning ? '（部分额度被思维链占用）' : '') +
        '；系统将自动改用紧凑格式重试');
      err.kind = 'truncated';
      err.finishReason = finish || responseStatus || incompleteReason || null;
      // 带上已收到的正文：部分网关在刚好用尽预算时也报 length，
      // 若这段正文其实已是完整 JSON，上层可直接重用，避免白花一次重试。
      err.partialText = outputText.trim() || null;
      throw err;
    }
    if (outputText.trim()) return outputText.trim();
    // 预设里多数默认模型是推理模型，正文为空通常是额度耗在思维链上，
    // 而不是“这不是文本模型”。按证据分开裁决，别给出误导性诊断。
    let err;
    if (hasReasoning) {
      err = new Error('模型只返回了思维链（reasoning_content），正文 content 为空；请换成非推理模型再试');
      err.kind = 'reasoning_only';
    } else {
      err = new Error('接口返回 200，但缺少可识别的文本内容；已检查 message.content、choices.text、output_text 和 output');
      err.kind = 'incompatible_response';
    }
      err.finishReason = finish || responseStatus || null;
    throw err;
  }

  /** 真正调用指定模型，而不是只检查 HTTP 或 /models。 */
  async function testConnection() {
    if (!configured()) {
      const e = new Error('请先填写完整的 Base URL、API Key 和模型名');
      e.kind = 'not_configured';
      throw e;
    }
    const started = Date.now();
    const body = {
      model: c.model,
      messages: [{ role: 'user', content: '请只回复：OK' }],
      stream: false,
    };
    const r = await request('chat/completions', {
      method: 'POST', body: JSON.stringify(body),
    }, Math.min(c.timeoutMs, 30000), '模型响应测试');
    const content = extractContent(r.data);
    return { ok: true, latency: Date.now() - started, status: r.status, content, url: r.url };
  }

  /** 完整检查：模型枚举与真实聊天分开裁决，/models 失败不会误判聊天线路。 */
  async function diagnose() {
    const settled = await Promise.allSettled([fetchModels(), testConnection()]);
    const modelResult = settled[0].status === 'fulfilled'
      ? { ok: true, total: settled[0].value.total, rawTotal: settled[0].value.rawTotal, models: settled[0].value.models }
      : { ok: false, error: settled[0].reason && settled[0].reason.message, kind: settled[0].reason && settled[0].reason.kind };
    const chatResult = settled[1].status === 'fulfilled'
      ? settled[1].value
      : { ok: false, error: settled[1].reason && settled[1].reason.message, kind: settled[1].reason && settled[1].reason.kind };
    return { ok: chatResult.ok === true, models: modelResult, chat: chatResult };
  }

  /** 模型枚举是辅助能力；失败不等于聊天线路不可用。 */
  async function fetchModels() {
    const r = await request('models', { method: 'GET' }, 15000, '获取模型列表');
    const d = r.data;
    const rawList = Array.isArray(d) ? d : (d && (d.data || d.models)) || [];
    if (!Array.isArray(rawList)) {
      const e = new Error('获取模型列表失败：返回数据缺少 data/models 数组');
      e.kind = 'invalid_response';
      throw e;
    }
    const models = [];
    const seen = new Set();
    for (const item of rawList) {
      const id = typeof item === 'string' ? item : item && (item.id || item.name);
      if (typeof id !== 'string' || !id.trim() || seen.has(id) || !isLikelyChatModel(item, id)) continue;
      seen.add(id);
      models.push(id);
    }
    return { ok: true, models, total: models.length, rawTotal: rawList.length, url: r.url };
  }

  /**
   * 按模型名做参数减法（SillyTavern openai.js:2982 模式）。
   * 先构造全集，再按模型名正则 delete 不支持字段、变形字段名。
   * 这比「失败后按错误文本降级重试」可靠：它预防错误，不消费错误。
   */
  function buildChatBody(messages, maxTokens, stream) {
    const body = {
      model: c.model,
      messages,
      stream: !!stream,
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) {
      body.max_tokens = Math.floor(maxTokens);
    }
    if (Number.isFinite(c.temperature)) body.temperature = c.temperature;
    if (c.jsonMode === true) body.response_format = { type: 'json_object' };

    const model = String(c.model || '').toLowerCase();
    // o1/o3/o4 及 gpt-5 系列推理模型：max_tokens → max_completion_tokens，删采样参数
    // （SillyTavern openai.js:2982 同模式）
    if (/(?:^|\/)(o1|o3|o4|gpt-5)(?:-|$)/.test(model)) {
      if (body.max_tokens != null) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
      }
      delete body.temperature;
      // o1 系列不允许 system 角色，降级为 user
      if (/(?:^|\/)o1(?:-|$)/.test(model)) {
        body.messages = body.messages.map(m =>
          m && m.role === 'system' ? Object.assign({}, m, { role: 'user' }) : m);
      }
    }
    // 注：不在此处把 max_tokens 改成 max_output_tokens。
    // 本项目走的是 OpenAI 兼容端点（包括代理 Gemini 的网关），
    // max_output_tokens 是 Gemini 原生字段，在兼容端上会被当成非法参数。
    return body;
  }

  /**
   * SSE 行解析器（参考 SillyTavern sse-stream.js EventSourceStream）。
   * 按 SSE 规范：事件以空行分隔，同一事件内多条 data: 需用 \n 拼接；
   * 兼容 CRLF；忽略 event:/id:/retry: 和以 : 开头的注释行（如 OpenRouter 心跳）。
   */
  async function* parseSseLines(reader) {
    const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
    let buf = '';
    const flush = function* (block) {
      const dataLines = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue; // 空行与注释行（如 OpenRouter 心跳）
        if (!line.startsWith('data:')) continue;     // event:/id:/retry: 不参与正文
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (!dataLines.length) return;
      // 有些网关把数据帧与 [DONE] 放在同一事件块里，
      // 整块拼接后 JSON.parse 会失败并丢掉最后一个 delta。
      // 先按单行尝试，全部失败才回退到多行拼接（SSE 规范）。
      const perLineOk = dataLines.every(line => {
        const t = line.trim();
        if (!t) return false;
        if (t === '[DONE]') return true;
        try { JSON.parse(t); return true; } catch (e) { return false; }
      });
      if (perLineOk) {
        for (const line of dataLines) {
          const t = line.trim();
          if (t) yield t;
        }
        return;
      }
      const payload = dataLines.join('\n').trim();
      if (payload) yield payload;
    };
    try {
      while (true) {
        if (abortedByUser) return;
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder ? decoder.decode(value, { stream: true })
          : String(value == null ? '' : value);
        // SSE 规范允许 \n\n、\r\n\r\n 与裸 \r\r 作为事件分隔；先统一为 \n。
        buf = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const blocks = buf.split('\n\n');
        buf = blocks.pop() || '';
        for (const block of blocks) yield* flush(block);
      }
      // 尾部不完整多字节序列需要 flush，否则最后几个字会被吞。
      if (decoder) {
        const tailText = decoder.decode();
        if (tailText) buf += tailText;
      }
      buf = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (buf.trim()) yield* flush(buf);
    } finally {
      try { reader.releaseLock(); } catch (e) { /* ignore */ }
    }
  }

  /** 从流 chunk 中读取截断信号，避免把半截 JSON 当成完整结果。 */
  function readStreamFinishReason(data) {
    if (!data || typeof data !== 'object') return null;
    const choice = data.choices && data.choices[0];
    const finish = (choice && (choice.finish_reason || choice.finishReason)) ||
      (Array.isArray(data.candidates) && data.candidates[0] && data.candidates[0].finishReason) ||
      // Anthropic：message_delta.delta.stop_reason 与顶层 stop_reason
      (data.delta && data.delta.stop_reason) ||
      data.stop_reason ||
      (data.incomplete_details && data.incomplete_details.reason) ||
      (data.status === 'incomplete' ? 'incomplete' : null) ||
      (data.type === 'response.incomplete' ? 'incomplete' : null);
    return finish || null;
  }

  // 输出被截断（预算用尽）：需要紧凑重试
  const TRUNCATED_FINISH = new Set(['length', 'max_tokens', 'max_output_tokens',
    'MAX_TOKENS', 'incomplete']);
  // 被内容策略阻断：重试同样会被阻，必须直接报错而不是静默接受残片
  const BLOCKED_FINISH = new Set(['content_filter', 'SAFETY', 'RECITATION',
    'PROHIBITED_CONTENT', 'BLOCKLIST']);

  /**
   * 按形状嗅探（非 provider 名）从流 chunk JSON 提取增量文本。
   * 覆盖：OpenAI delta.content / Anthropic delta.text / Gemini candidates[].parts[].text /
   * llama.cpp content / OpenRouter delta.content ?? message.content ?? text。
   * 参考 SillyTavern getStreamingReply() (openai.js:3129)。
   */
  function extractStreamDelta(data) {
    if (!data || typeof data !== 'object') return '';
    // Anthropic / Claude
    if (data.delta && typeof data.delta.text === 'string') return data.delta.text;
    if (data.delta && typeof data.delta.thinking === 'string') return '';
    // Gemini candidates[].content.parts[].text（跳过 thought 标记的 reasoning）
    if (Array.isArray(data.candidates)) {
      const parts = data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts;
      if (Array.isArray(parts)) {
        return parts.filter(p => p && !p.thought)
          .map(p => (p && p.text) || '').join('');
      }
    }
    // OpenAI chat completions delta
    const choice = data.choices && data.choices[0];
    if (choice) {
      const delta = choice.delta || {};
      if (typeof delta.content === 'string') return delta.content;
      if (typeof delta.text === 'string') return delta.text;
      if (Array.isArray(delta.content)) {
        return delta.content.map(p => (p && (p.text || '')) || '').join('');
      }
      // 某些兼容层把最终 message 放进 chunk
      const msg = choice.message || {};
      if (typeof msg.content === 'string') return msg.content;
    }
    // llama.cpp / 本地推理裸文本
    if (typeof data.content === 'string') return data.content;
    if (typeof data.token === 'string') return data.token;
    return '';
  }

  /**
   * 流内错误提取（参考 SillyTavern tryParseStreamingError, openai.js:1624）。
   * 部分供应商在 SSE 流中嵌入错误 JSON，需要在拼接正文前拦截。
   */
  function tryParseStreamError(data) {
    if (!data || typeof data !== 'object') return null;
    const errObj = data.error ||
      (data.detail && data.detail.error) ||
      (data.message && typeof data.message === 'object' && data.message.error ? data.message : null);
    if (!errObj) return null;
    let msg = String(errObj.message || errObj.msg || JSON.stringify(errObj)).slice(0, 200);
    // 与 cleanError/invalidJson 保持一致的脱敏，避免网关回显 Authorization 时泄密。
    if (c.apiKey) msg = msg.split(c.apiKey).join('***');
    const e = new Error('流式请求失败：' + msg);
    e.kind = 'stream_error';
    return e;
  }

  /**
   * 流式 chat 请求。stream=true 时用 SSE 逐块累积，避免正文挂起超时和 max_tokens 截断。
   * 若流式通道本身失败（如供应商不支持 SSE），静默回退非流式。
   */
  async function chatStream(messages, maxTokens) {
    const body = buildChatBody(messages, maxTokens, true);
    const url = endpoint(c.baseUrl, 'chat/completions');
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    // 空闲超时：每收到一块数据就续命。
    // 用墙钟总超时会把正常的长流（推理模型常见）硬砍，还会丢弃已收正文。
    let timer = null;
    const armTimer = () => {
      if (!ctl) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(), c.timeoutMs);
    };
    armTimer();
    if (ctl) inFlight.add(ctl);
    let full = '';
    let reader = null;
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: Object.assign(headers(), { Accept: 'text/event-stream' }),
        body: JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined,
      });
      armTimer();
      if (!res.ok) {
        const raw = typeof res.text === 'function' ? await res.text() : '';
        throw cleanError(res.status, raw, '流式生成选题');
      }
      const ct = (res.headers && typeof res.headers.get === 'function'
        ? res.headers.get('content-type') : '') || '';
      // 供应商返回普通 JSON 而非 SSE 流时，直接把完整 JSON 交给统一归一化层，
      // 不需要 SSE 解析，也不需要回退非流式重复请求。
      if (!ct.includes('text/event-stream') && !ct.includes('text/stream')) {
        const raw = typeof res.text === 'function' ? await res.text() : '';
        let data;
        try { data = JSON.parse(raw); }
        catch (e) { throw invalidJson(res, raw, '流式生成选题'); }
        return extractContent(data);
      }
      if (!res.body || typeof res.body.getReader !== 'function') {
        const e = new Error('当前环境不支持流式响应读取');
        e.kind = 'stream_unsupported';
        throw e;
      }
      let truncatedFinish = null;
      let blockedFinish = null;
      let sawDone = false;
      reader = res.body.getReader();
      for await (const data of parseSseLines(reader)) {
        armTimer();
        if (data === '[DONE]') { sawDone = true; break; }
        let chunk;
        try { chunk = JSON.parse(data); } catch (e) { continue; }
        const streamErr = tryParseStreamError(chunk);
        if (streamErr) throw streamErr;
        full += extractStreamDelta(chunk);
        const finish = readStreamFinishReason(chunk);
        if (finish && TRUNCATED_FINISH.has(finish)) truncatedFinish = finish;
        else if (finish && BLOCKED_FINISH.has(finish)) blockedFinish = finish;
      }
      if (blockedFinish) {
        const err = new Error('模型因内容策略阻断而停止输出（' + blockedFinish +
          '）；重试同样会被阻，请调整定制需求描述或换一个模型');
        err.kind = 'content_blocked';
        throw err;
      }
      // 流式也会被输出上限截断；此时正文可能停在 JSON 中间，
      // 必须按截断处理以触发紧凑重试，不能当成完整结果。
      if (truncatedFinish) {
        const err = new Error('流式输出达到长度上限（' + truncatedFinish +
          '），JSON 可能尚未结束；系统将自动改用紧凑格式重试');
        err.kind = 'truncated';
        err.finishReason = truncatedFinish;
        err.partialText = full.trim() || null;
        throw err;
      }
      const text = full.trim();
      if (!text) {
        // 空正文（如推理模型只吐思维链）不能静默回退再发一次付费请求。
        const e = new Error('流式响应未返回可用正文' +
          (sawDone ? '' : '（流被提前结束）') +
          '；请换成非推理模型或稍后重试');
        e.kind = 'empty_stream';
        throw e;
      }
      // 流正常结束但没有 [DONE]，且正文本身不完整：按截断处理。
      if (!sawDone && likelyTruncatedJson(text)) {
        const err = new Error('流在 JSON 完成前被提前关闭；系统将自动改用紧凑格式重试');
        err.kind = 'truncated';
        err.finishReason = 'stream_closed';
        err.partialText = text;
        throw err;
      }
      return text;
    } catch (e) {
      // 被空闲超时/用户中止掉时，也把已收正文交出去，供上层尝试抢救。
      if (e && !e.partialText && full.trim()) e.partialText = full.trim();
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      if (ctl) inFlight.delete(ctl);
      // 提前 break 后不 cancel 会泄连接
      if (reader) { try { reader.cancel(); } catch (e) { /* ignore */ } }
    }
  }

  /** 生成时采用广泛兼容的 Chat Completions 负载，并明确预留 JSON 输出预算。 */
  async function chat(messages, opts) {
    const o = opts || {};
    const maxTokens = Number.isFinite(o.maxTokens) ? o.maxTokens : c.maxTokens;
    // 优先尝试流式（避开正文挂起与输出截断）。
    // 只有「已证实 SSE 通道本身不可用」才回退非流式；
    // 其余错误（鉴权、流内错误、空正文、截断、内容阻断）一律终止，
    // 否则同一次生成会对同一个 prompt 发出两次付费请求。
    const STREAM_FALLBACK_KINDS = new Set(['stream_unsupported', 'invalid_response']);
    const RETRYABLE_KINDS = new Set(['network', 'timeout', 'rate_limit', 'upstream']);
    if (c.stream !== false && !o.noStream) {
      let streamErr = null;
      for (let i = 0; i <= c.maxRetries; i++) {
        throwIfAborted('生成选题');
        try {
          const streamTxt = await chatStream(messages, maxTokens);
          if (streamTxt) return { text: streamTxt, via: 'stream' };
          break;
        } catch (e) {
          streamErr = e;
          if (abortedByUser) throw e;
          // 可恢复故障在流式通道内重试，不降级成非流式重发。
          if (RETRYABLE_KINDS.has(e.kind) && i < c.maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
            continue;
          }
          break;
        }
      }
      if (streamErr && !STREAM_FALLBACK_KINDS.has(streamErr.kind)) throw streamErr;
      // 落到这里说明确实不支持 SSE，才允许重发为非流式。
    }

    // 非流式回退：按 buildChatBody 构建（已按模型名做过参数减法）
    const body = buildChatBody(messages, maxTokens, false);
    let lastErr = null;
    for (let i = 0; i <= c.maxRetries; i++) {
      if (abortedByUser) {
        const e = new Error('生成选题已中止');
        e.kind = 'aborted';
        throw e;
      }
      try {
        const r = await request('chat/completions', {
          method: 'POST', body: JSON.stringify(body),
        }, c.timeoutMs, '生成选题');
        return { text: extractContent(r.data), via: 'http' };
      } catch (e) {
        lastErr = e;
        if (abortedByUser) break;
        const retryable = e.kind === 'network' || e.kind === 'timeout' ||
          e.kind === 'rate_limit' || e.kind === 'upstream';
        if (!retryable || i >= c.maxRetries) break;
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
    throw lastErr || new Error('LLM 调用失败');
  }

  function sanitizeModelJson(s) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (escaped) { out += ch; escaped = false; continue; }
        if (ch === '\\') { out += ch; escaped = true; continue; }
        if (ch === '"') { out += ch; inString = false; continue; }
        if (ch === '\n') { out += '\\n'; continue; }
        if (ch === '\r') { out += '\\r'; continue; }
        if (ch === '\t') { out += '\\t'; continue; }
        out += ch;
        continue;
      }
      if (ch === '"') { out += ch; inString = true; continue; }
      if (ch === ',') {
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        if (s[j] === '}' || s[j] === ']') continue;
      }
      out += ch;
    }
    return out;
  }

  function tryParseJson(s) {
    try { return JSON.parse(s); } catch (e) { /* 尝试无害修复 */ }
    const repaired = sanitizeModelJson(s);
    if (repaired !== s) {
      try { return JSON.parse(repaired); } catch (e) { /* fall through */ }
    }
    return null;
  }

  /**
   * 从夹杂解释文字的回复中提取括号完整、字符串转义合法的 JSON 候选。
   * 先收集所有候选，再按「带候选列表字段」优先于「单个题目对象」选择，
   * 避免外层容器被截断时退回到内层第一个完整对象、把多题静默缩成一题。
   */
  function parseEmbeddedJson(s) {
    let fallback = null;
    for (let start = 0; start < s.length; start++) {
      if (s[start] !== '{' && s[start] !== '[') continue;
      const stack = [];
      let inString = false;
      let escaped = false;
      for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{' || ch === '[') stack.push(ch);
        else if (ch === '}' || ch === ']') {
          const open = stack.pop();
          if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) break;
          if (!stack.length) {
            const candidate = s.slice(start, i + 1);
            const parsed = tryParseJson(candidate);
            if (parsed !== null && isCandidateData(parsed)) {
              // 带显式候选列表的容器才是可信的完整输出；
              // 单个题目对象只能做最后兵，且不能掩盖截断事实。
              if (hasCandidateList(parsed)) return parsed;
              if (fallback === null) fallback = parsed;
            }
            break;
          }
        }
      }
    }
    return fallback;
  }

  function hasCandidateList(d) {
    if (Array.isArray(d)) return true;
    if (!d || typeof d !== 'object') return false;
    return Array.isArray(d.ideas) || Array.isArray(d.topics) || Array.isArray(d.list) ||
      Array.isArray(d.items) || Array.isArray(d.candidates) || Array.isArray(d.results);
  }

  function isCandidateData(d) {
    if (!d || typeof d !== 'object') return false;
    if (Array.isArray(d)) {
      return d.some(item => item && typeof item === 'object' &&
        (item.objectEn || item.object_en || item.object || item.researchObject || item.research_object));
    }
    return !!(d.ideas || d.topics || d.list || d.items || d.candidates || d.results ||
      d.output_parsed || d.parsed || d.objectEn || d.object_en || d.title || d.topic);
  }

  function likelyTruncatedJson(s) {
    const start = s.search(/[\[{]/);
    if (start < 0) return false;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
    return inString || depth > 0;
  }

  /** 容错解析：支持 markdown、思考块、BOM、尾逗号和 JSON 前后解释文字。 */
  function parseIdeas(txt) {
    let s = String(txt).replace(/^\uFEFF/, '').trim();
    // 部分推理模型把思考过程塞进 content；先移除完整 think/analysis/reasoning 块。
    s = s.replace(/<(think|analysis|reasoning)>[\s\S]*?<\/\1>/gi, '').trim();
    s = s.replace(/^```(?:json|javascript|js)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let d = tryParseJson(s);
    // 整体直接解析失败时，先判定是不是被截断。
    // 被截断就不得再从残片里“捣”出部分题目，否则会把 6 题静默缩成 1 题。
    if (d === null && likelyTruncatedJson(s)) {
      const compact = s.replace(/\s+/g, ' ');
      const head = compact.slice(0, 100) || '（空）';
      const tail = compact.length > 100 ? compact.slice(-100) : head;
      const err = new Error('模型输出疑似在 JSON 完成前被截断；开头：' + head +
        (tail !== head ? '；末尾：' + tail : ''));
      err.kind = 'truncated_json';
      throw err;
    }
    if (d === null) d = parseEmbeddedJson(s);
    // 个别网关把 JSON 文本再次 JSON 编码，解开一层字符串包装。
    if (typeof d === 'string') d = tryParseJson(d.trim());
    if (d === null) {
      const truncated = likelyTruncatedJson(s);
      const compact = s.replace(/\s+/g, ' ');
      const head = compact.slice(0, 100) || '（空）';
      const tail = compact.length > 100 ? compact.slice(-100) : head;
      const err = new Error((truncated
        ? '模型输出疑似在 JSON 完成前被截断'
        : '模型输出不是合法 JSON 格式') +
        '；开头：' + head + (tail !== head ? '；末尾：' + tail : ''));
      err.kind = truncated ? 'truncated_json' : 'invalid_model_json';
      throw err;
    }
    let arr;
    if (Array.isArray(d)) arr = d;
    else if (d && typeof d === 'object') {
      arr = d.ideas || d.topics || d.list || d.items || d.candidates || d.results;
      if (!arr && (d.objectEn || d.object_en || d.title || d.topic)) arr = [d];
    }
    if (!Array.isArray(arr) || !arr.length) {
      const err = new Error('模型返回的 JSON 中缺少 ideas/topics/items/candidates/results 列表');
      err.kind = 'invalid_model_json';
      throw err;
    }
    const normalized = arr.map(normalizeIdea).filter(Boolean);
    if (!normalized.length) {
      const err = new Error('模型返回了候选列表，但没有任何题目包含可检索的 objectEn 字段');
      err.kind = 'invalid_model_json';
      throw err;
    }
    return normalized;
  }

  /** 归一化 + 兜底 */
  function normalizeIdea(x) {
    if (!x || typeof x !== 'object') return null;
    const objectEn = String(x.objectEn || x.object_en || x.object || x.researchObject ||
      x.research_object || x.taskEn || x.task_en || '').trim();
    if (!objectEn) return null;
    const n = x.needs || x.requirements || x.constraints || x.resources || {};
    const rawGpu = String(n.gpu || n.gpuRequirement || n.gpu_requirement || '').toLowerCase();
    const rawDataset = String(n.dataset || n.data || n.dataRequirement || n.data_requirement || '').toLowerCase();
    const rawCoding = String(n.codingLevel || n.coding_level || n.programming || n.skill || '').toLowerCase();
    const gpuMap = { cpu: 'none', 'no-gpu': 'none', 'no_gpu': 'none', none: 'none',
      '无显卡': 'none', '无需显卡': 'none',
      single: 'single', 'single-gpu': 'single', 'single_gpu': 'single', one: 'single', cloud: 'single',
      '单卡': 'single', '消费级单卡': 'single', '云算力': 'single',
      multi: 'multi', 'multi-gpu': 'multi', 'multi_gpu': 'multi', cluster: 'multi',
      '多卡': 'multi', '集群': 'multi' };
    const datasetMap = { public: 'public', open: 'public', opensource: 'public', 'open-source': 'public',
      '公开': 'public', '公开数据集': 'public',
      'self-collect': 'self-collect', 'self_collect': 'self-collect', collect: 'self-collect',
      '自行采集': 'self-collect', '自采': 'self-collect',
      private: 'private', proprietary: 'private', clinical: 'private',
      '私有': 'private', '非公开': 'private', '临床数据': 'private' };
    const codingMap = { beginner: 'beginner', basic: 'beginner', novice: 'beginner',
      '入门': 'beginner', '初级': 'beginner',
      mid: 'mid', intermediate: 'mid', '中等': 'mid', '中级': 'mid',
      strong: 'strong', advanced: 'strong', '较强': 'strong', '高级': 'strong' };
    const pick = (v, allow, dft) => allow.includes(String(v)) ? String(v) : dft;
    const weeksValue = n.weeks || n.time || n.duration || n.estimatedWeeks || n.estimated_weeks;
    const weeks = parseInt(weeksValue, 10);
    // 上手路径整体可缺失：模型不给就是不给，不编造，界面按“未提供”处理。
    const ob = x.onboarding || x.onBoarding || x.startup || {};
    const pickText = v => {
      const s = String(v == null ? '' : v).trim();
      return s ? s : null;
    };
    const onboarding = {
      firstStep: pickText(ob.firstStep || ob.first_step || ob.start),
      keyRisk: pickText(ob.keyRisk || ob.key_risk || ob.risk),
      startFrom: pickText(ob.startFrom || ob.start_from || ob.dataset || ob.baseline),
    };
    return {
      zh: String(x.zh || x.titleZh || x.title_zh || x.title || x.topic || x.name || objectEn).trim(),
      objectEn,
      methodEn: String(x.methodEn || x.method_en || x.method || x.approachEn || x.approach_en || '').trim(),
      rationale: x.rationale || x.reason || x.fit ? String(x.rationale || x.reason || x.fit).trim() : null,
      onboarding: (onboarding.firstStep || onboarding.keyRisk || onboarding.startFrom)
        ? onboarding : null,
      needs: {
        gpu: pick(gpuMap[rawGpu] || rawGpu, ['none', 'single', 'multi'], 'single'),
        dataset: pick(datasetMap[rawDataset] || rawDataset, ['public', 'self-collect', 'private'], 'public'),
        weeks: Number.isFinite(weeks) && weeks > 0 ? weeks : 14,
        codingLevel: pick(codingMap[rawCoding] || rawCoding, ['beginner', 'mid', 'strong'], 'mid'),
      },
      source: 'llm',
    };
  }

  function throwIfAborted(action) {
    if (!abortedByUser) return;
    const e = new Error((action || '生成选题') + '已中止');
    e.kind = 'aborted';
    throw e;
  }

  /** 主入口：根据学生情况生成候选题目；格式失败时自动紧凑重试一次。 */
  async function generate(profile) {
    if (!configured()) {
      const e = new Error('未配置大模型：需要填写完整的 Base URL、API Key 与 Model');
      e.code = 'NOT_CONFIGURED';
      throw e;
    }
    abortedByUser = false;
    const userPrompt = buildUserPrompt(profile);
    const standard = [
      { role: 'system', content: IDEATE_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ];
    let chatResult;
    throwIfAborted('生成选题');
    try {
      chatResult = await chat(standard);
      throwIfAborted('生成选题');
      const ideas = parseIdeas(chatResult.text);
      return { ok: true, ideas, raw: chatResult.text, model: c.model, via: chatResult.via };
    } catch (e) {
      const recoverable = e && ['truncated', 'truncated_json', 'invalid_model_json'].includes(e.kind);
      if (!recoverable || abortedByUser) throw e;
      // 截断信号只是「怀疑」。先验证已收到的正文能否解析成合法候选，
      // 能解析就直接用，不为一个不确定的 finish_reason 白花一次付费调用。
      if (e.kind === 'truncated' && e.partialText) {
        try {
          const salvaged = parseIdeas(e.partialText);
          if (salvaged.length) {
            return { ok: true, ideas: salvaged, raw: e.partialText, model: c.model,
              salvagedFromTruncation: true };
          }
        } catch (ignored) { /* 确实不完整，转入紧凑重试 */ }
      }
    }

    const strictSystem = IDEATE_SYSTEM_PROMPT + [
      '',
      '上一次回复未形成合法完整 JSON。请重新生成，不要续写上一次内容。',
      '本次每个 rationale 和 onboarding 子字段最多 40 个汉字，JSON 使用单行紧凑格式。',
      '禁止使用 markdown、注释、尾随逗号或 JSON 之外的任何文字。',
    ].join('\n');
    throwIfAborted('生成选题');
    try {
      chatResult = await chat([
        { role: 'system', content: strictSystem },
        { role: 'user', content: userPrompt },
      ], { maxTokens: Math.max(4096, c.maxTokens || 0) });
      throwIfAborted('生成选题');
      const ideas = parseIdeas(chatResult.text);
      return { ok: true, ideas, raw: chatResult.text, model: c.model, recovered: true, via: chatResult.via };
    } catch (e) {
      if (e && ['truncated', 'truncated_json', 'invalid_model_json'].includes(e.kind)) {
        e.message += '；已自动用紧凑 JSON 重试一次，仍失败。建议换用非推理模型或减少候选题数量';
      }
      throw e;
    }
  }

  return {
    generate,
    configured,
    abort,
    diagnose,
    testConnection,
    fetchModels,
    buildUserPrompt,
    parseIdeas,
    get config() { return Object.assign({}, c, { apiKey: c.apiKey ? '***' : '' }); }
  };
}

/* ------------------------------------------------------------------ 无模型兜底 */
function fallbackIdeas(angleDict, discipline, count) {
  const rows = angleDict[discipline] || [];
  const tasks = rows.filter(r => r[2] === 'task');
  const techs = rows.filter(r => r[2] === 'emerging' || r[2] === 'mainstream');
  const out = [];
  for (const t of tasks) {
    for (const h of techs) {
      out.push({
        zh: '基于' + h[1] + '的' + t[1],
        objectEn: t[0], methodEn: h[0],
        rationale: null,
        needs: { gpu: 'single', dataset: 'public', weeks: 14, codingLevel: 'mid' },
        source: 'template',
        warning: '模板组合生成，语义合理性未经模型判断，需人工确认题目是否讲得通',
      });
      if (out.length >= (count || 8) * 3) break;
    }
    if (out.length >= (count || 8) * 3) break;
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, count || 8);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createIdeator, fallbackIdeas, IDEATE_SYSTEM_PROMPT, buildUserPrompt,
    PROVIDER_PRESETS, normalizeBaseUrl, endpoint, isLikelyChatModel,
  };
}
