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
  '4. rationale：一句话说明为什么这个题目适合这个学生（结合他的专业与条件）。',
  '5. onboarding：这个学生选了这题之后，第一步该怎么动。三个字段都必须给，都要具体：',
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
    let text = String(raw || '').replace(/\s+/g, ' ');
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
    return e;
  }

  function invalidJson(res, rawText, action) {
    const ct = (res && res.headers && typeof res.headers.get === 'function'
      && res.headers.get('content-type')) || '未返回';
    const snippet = String(rawText || '').replace(/\s+/g, ' ').slice(0, 140) || '（空响应）';
    const e = new Error(action + '失败：HTTP ' + (res && res.status) +
      ' 返回的不是 JSON（content-type：' + ct + '）；内容开头：' + snippet);
    e.kind = 'invalid_response';
    e.contentType = ct;
    return e;
  }

  async function request(path, init, timeoutMs, action) {
    if (!c.baseUrl || !doFetch) throw new Error('缺少 Base URL 或当前环境没有 fetch');
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
      // 超时只覆盖建连与响应头。正文可能慢慢吐（推理模型尤其如此），
      // 此时打断会把真正的超时伪装成“200 但空响应”，所以拿到响应头就解除。
      stopTimer();
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
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content.map(x => typeof x === 'string' ? x : (x && x.text) || '').join('').trim();
      if (text) return text;
    }
    // 预设里多数默认模型是推理模型，正文为空通常是额度耗在思维链上，
    // 而不是“这不是文本模型”。按证据分开裁决，别给出误导性诊断。
    const reasoning = msg && (msg.reasoning_content || msg.reasoning);
    const hasReasoning = typeof reasoning === 'string' && reasoning.trim();
    const finish = choice && choice.finish_reason;
    let err;
    if (finish === 'length') {
      err = new Error('模型还没输出正文就到达长度上限' +
        (hasReasoning ? '，额度被思维链占满' : '') +
        '；请换成非推理模型，或调高该模型的输出上限');
      err.kind = 'truncated';
    } else if (hasReasoning) {
      err = new Error('模型只返回了思维链（reasoning_content），正文 content 为空；请换成非推理模型再试');
      err.kind = 'reasoning_only';
    } else {
      err = new Error('接口返回 200，但缺少 choices[0].message.content；该模型可能不是 Chat Completions 文本模型');
      err.kind = 'incompatible_response';
    }
    err.finishReason = finish || null;
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

  /** 生成时采用最小兼容负载，靠 prompt + 容错解析保证 JSON。 */
  async function chat(messages) {
    const body = { model: c.model, messages, stream: false };
    if (Number.isFinite(c.temperature)) body.temperature = c.temperature;
    if (c.jsonMode === true) body.response_format = { type: 'json_object' };

    let lastErr = null;
    abortedByUser = false;
    for (let i = 0; i <= c.maxRetries; i++) {
      try {
        const r = await request('chat/completions', {
          method: 'POST', body: JSON.stringify(body),
        }, c.timeoutMs, '生成选题');
        return extractContent(r.data);
      } catch (e) {
        lastErr = e;
        // 用户主动停止产生的 AbortError 与真超时同 kind，不能拿去重试。
        if (abortedByUser) break;
        const retryable = e.kind === 'network' || e.kind === 'timeout' ||
          e.kind === 'rate_limit' || e.kind === 'upstream';
        if (!retryable || i >= c.maxRetries) break;
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
    throw lastErr || new Error('LLM 调用失败');
  }

  /** 容错解析：模型可能裹 markdown 代码块或加前后缀 */
  function parseIdeas(txt) {
    let s = String(txt).trim();
    // 部分推理模型把思考过程塞进 content；先移除完整 think 块再找 JSON。
    s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let d = null;
    try { d = JSON.parse(s); } catch (e) { /* 继续尝试截取 */ }
    if (d === null) {
      const oi = s.indexOf('{'), ai = s.indexOf('[');
      const start = (oi < 0) ? ai : (ai < 0 ? oi : Math.min(oi, ai));
      const isArr = start >= 0 && s[start] === '[';
      const end = isArr ? s.lastIndexOf(']') : s.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { d = JSON.parse(s.slice(start, end + 1)); } catch (e) { /* fall through */ }
      }
    }
    if (d === null) {
      throw new Error('模型输出不是合法 JSON 格式：' + String(txt).slice(0, 160));
    }
    const arr = Array.isArray(d) ? d : (d.ideas || d.topics || d.list || []);
    if (!Array.isArray(arr) || !arr.length) throw new Error('模型返回的 JSON 中缺少 ideas 列表');
    return arr.map(normalizeIdea).filter(Boolean);
  }

  /** 归一化 + 兜底 */
  function normalizeIdea(x) {
    if (!x || typeof x !== 'object') return null;
    const objectEn = String(x.objectEn || x.object_en || x.object || '').trim();
    if (!objectEn) return null;
    const n = x.needs || {};
    const pick = (v, allow, dft) =>
      allow.includes(String(v)) ? String(v) : dft;
    const weeks = parseInt(n.weeks, 10);
    // 上手路径整体可缺失：模型不给就是不给，不编造，界面按“未提供”处理。
    const ob = x.onboarding || x.onBoarding || {};
    const pickText = v => {
      const s = String(v == null ? '' : v).trim();
      return s ? s : null;
    };
    const onboarding = {
      firstStep: pickText(ob.firstStep || ob.first_step),
      keyRisk: pickText(ob.keyRisk || ob.key_risk),
      startFrom: pickText(ob.startFrom || ob.start_from),
    };
    return {
      zh: String(x.zh || x.title || x.topic || objectEn).trim(),
      objectEn,
      methodEn: String(x.methodEn || x.method_en || x.method || '').trim(),
      rationale: x.rationale ? String(x.rationale).trim() : null,
      onboarding: (onboarding.firstStep || onboarding.keyRisk || onboarding.startFrom)
        ? onboarding : null,
      needs: {
        gpu: pick(n.gpu, ['none', 'single', 'multi'], 'single'),
        dataset: pick(n.dataset, ['public', 'self-collect', 'private'], 'public'),
        weeks: Number.isFinite(weeks) && weeks > 0 ? weeks : 14,
        codingLevel: pick(n.codingLevel || n.coding_level, ['beginner', 'mid', 'strong'], 'mid'),
      },
      source: 'llm',
    };
  }

  /** 主入口：根据学生情况生成候选题目 */
  async function generate(profile) {
    if (!configured()) {
      const e = new Error('未配置大模型：需要填写完整的 Base URL、API Key 与 Model');
      e.code = 'NOT_CONFIGURED';
      throw e;
    }
    const txt = await chat([
      { role: 'system', content: IDEATE_SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(profile) },
    ]);
    const ideas = parseIdeas(txt);
    return { ok: true, ideas, raw: txt, model: c.model };
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
