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

  /** 生成时采用广泛兼容的 Chat Completions 负载，并明确预留 JSON 输出预算。 */
  async function chat(messages, opts) {
    const o = opts || {};
    const maxTokens = Number.isFinite(o.maxTokens) ? o.maxTokens : c.maxTokens;
    const buildBody = tokenField => {
      const body = { model: c.model, messages, stream: false };
      if (tokenField && Number.isFinite(maxTokens) && maxTokens > 0) {
        body[tokenField] = Math.floor(maxTokens);
      }
      if (Number.isFinite(c.temperature)) body.temperature = c.temperature;
      if (c.jsonMode === true) body.response_format = { type: 'json_object' };
      return body;
    };
    const tokenFields = Number.isFinite(maxTokens) && maxTokens > 0
      ? ['max_tokens', 'max_completion_tokens', null]
      : [null];

    let lastErr = null;
    for (const tokenField of tokenFields) {
      const body = buildBody(tokenField);
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
          return extractContent(r.data);
        } catch (e) {
          lastErr = e;
          // 只有明确指向 token 参数不兼容的 400/422 才切换参数名，
          // 普通鉴权、模型不存在等错误不能盲目重复请求。
          const tokenRejected = e.tokenParameterRejected === true;
          if (tokenRejected && tokenField !== null) break;
          // 用户主动停止产生的 AbortError 与真超时同 kind，不能拿去重试。
          if (abortedByUser) break;
          const retryable = e.kind === 'network' || e.kind === 'timeout' ||
            e.kind === 'rate_limit' || e.kind === 'upstream';
          if (!retryable || i >= c.maxRetries) break;
          await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
      }
      const canTryNextTokenField = lastErr && lastErr.tokenParameterRejected === true;
      if (!canTryNextTokenField) break;
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

  /** 从夹杂解释文字的回复中提取第一个括号完整、字符串转义合法的 JSON 候选。 */
  function parseEmbeddedJson(s) {
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
            if (parsed !== null && isCandidateData(parsed)) return parsed;
            break;
          }
        }
      }
    }
    return null;
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
    let txt;
    throwIfAborted('生成选题');
    try {
      txt = await chat(standard);
      throwIfAborted('生成选题');
      const ideas = parseIdeas(txt);
      return { ok: true, ideas, raw: txt, model: c.model };
    } catch (e) {
      const recoverable = e && ['truncated', 'truncated_json', 'invalid_model_json'].includes(e.kind);
      if (!recoverable || abortedByUser) throw e;
    }

    const strictSystem = IDEATE_SYSTEM_PROMPT + [
      '',
      '上一次回复未形成合法完整 JSON。请重新生成，不要续写上一次内容。',
      '本次每个 rationale 和 onboarding 子字段最多 40 个汉字，JSON 使用单行紧凑格式。',
      '禁止使用 markdown、注释、尾随逗号或 JSON 之外的任何文字。',
    ].join('\n');
    throwIfAborted('生成选题');
    try {
      txt = await chat([
        { role: 'system', content: strictSystem },
        { role: 'user', content: userPrompt },
      ], { maxTokens: Math.max(4096, c.maxTokens || 0) });
      throwIfAborted('生成选题');
      const ideas = parseIdeas(txt);
      return { ok: true, ideas, raw: txt, model: c.model, recovered: true };
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
