/* 选题生成层测试（含 fetchModels 与 PROVIDER_PRESETS 测试）
 * 用法: node test/ideate-test.js
 */
'use strict';
const path = require('path');
const { ANGLE_DICT } = require(path.join(__dirname, '..', 'web', 'angles.js'));
const { createIdeator, fallbackIdeas, IDEATE_SYSTEM_PROMPT, buildUserPrompt,
  PROVIDER_PRESETS, normalizeBaseUrl, endpoint, isLikelyChatModel } =
  require(path.join(__dirname, '..', 'web', 'ideate.js'));

let pass = 0, fail = 0;
const ck = (n, c, e) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (e ? '  -> ' + e : '')); } };
const hr = t => console.log('\n' + '='.repeat(72) + '\n' + t + '\n' + '='.repeat(72));

const PROFILE = {
  major: '电子信息工程', grade: '大四', interest: '图像识别',
  gpu: 'none', dataset: 'public', codingLevel: 'mid', weeks: 16,
  goal: 'thesis', count: 4,
};

/* 造一个会返回合法 JSON 的 mock LLM */
function mockLLM() {
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ ideas: [
      { zh: '基于小样本学习的PCB表面缺陷检测', objectEn: 'PCB defect detection',
        methodEn: 'few-shot learning',
        needs: { gpu: 'none', dataset: 'public', weeks: 12, codingLevel: 'mid' },
        rationale: '缺陷样本天然稀少，且有公开数据集，不需要显卡训练' },
      { zh: '基于知识蒸馏的轻量化缺陷检测模型', objectEn: 'defect detection',
        methodEn: 'knowledge distillation',
        needs: { gpu: 'single', dataset: 'public', weeks: 14, codingLevel: 'mid' },
        rationale: '可在小模型上跑通，适合本科阶段' },
      { zh: '基于扩散模型的缺陷样本生成', objectEn: 'defect detection',
        methodEn: 'diffusion model',
        needs: { gpu: 'multi', dataset: 'public', weeks: 20, codingLevel: 'strong' },
        rationale: '有挑战性，但需要较强算力' },
      { zh: '基于图神经网络的电路板元件关系建模', objectEn: 'PCB inspection',
        methodEn: 'graph neural network',
        needs: { gpu: 'single', dataset: 'self-collect', weeks: 18, codingLevel: 'strong' },
        rationale: '电路板天然是图结构' },
    ] }) } }] }),
  };
}

(async () => {
  hr('1. 服务商预设与内置 BaseURL');
  ck('只保留官方文档可确认且可用的远程线路',
     Array.isArray(PROVIDER_PRESETS) && PROVIDER_PRESETS.length === 8);
  const ids = PROVIDER_PRESETS.map(p => p.id);
  ck('包含 7 个远程服务商与 custom',
     ['deepseek', 'siliconflow', 'zhipu', 'moonshot', 'minimax',
      'openrouter', 'openai', 'custom'].every(id => ids.includes(id)));
  ck('不包含本地模型与已知不可用的阿里百炼',
     !ids.includes('ollama') && !ids.includes('lmstudio') &&
     !ids.includes('qwen') && !ids.includes('lingyi'));
  ck('各远程预设包含已核实 URL、默认模型与日期',
     PROVIDER_PRESETS.filter(p => p.id !== 'custom').every(p =>
       p.baseUrl && p.defaultModel && p.verifiedAt));
  const deepseek = PROVIDER_PRESETS.find(p => p.id === 'deepseek');
  ck('DeepSeek 使用官方文档的 base_url 与现行模型',
     deepseek.baseUrl === 'https://api.deepseek.com' &&
     deepseek.defaultModel === 'deepseek-v4-flash');
  const minimax = PROVIDER_PRESETS.find(p => p.id === 'minimax');
  ck('MiniMax 使用现行官方 OpenAI 线路与模型',
     minimax.baseUrl === 'https://api.minimaxi.com/v1' && minimax.defaultModel === 'MiniMax-M3');
  ck('BaseURL 接受完整 chat/models 端点并归一化',
     normalizeBaseUrl('https://x.test/v1/chat/completions/') === 'https://x.test/v1' &&
     endpoint('https://x.test/v1/models', 'chat/completions') === 'https://x.test/v1/chat/completions');

  hr('2. fetchModels 模型拉取功能');
  const mockModelsFetch = async (url) => {
    if (url.endsWith('/models')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          object: 'list',
          data: [
            { id: 'deepseek-chat', object: 'model' },
            { id: 'deepseek-reasoner', object: 'model' },
            { id: 'deepseek-chat', object: 'model' }, // 测试重复项去重
            { id: 'text-embedding-v4', object: 'model' },
            { id: 'BAAI/bge-reranker-v2', object: 'model' },
            { id: 'gpt-image-1', object: 'model' },
          ]
        })
      };
    }
    return mockLLM();
  };

  const modelIdeator = createIdeator({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test',
    model: 'deepseek-chat',
    fetchImpl: mockModelsFetch
  });

  const mList = await modelIdeator.fetchModels();
  ck('fetchModels 成功拉取模型列表', mList.ok && Array.isArray(mList.models), JSON.stringify(mList));
  ck('fetchModels 自动去重，并排除 embedding/reranker/image 模型',
     mList.models.length === 2 && mList.rawTotal === 6 &&
     mList.models.includes('deepseek-chat') && mList.models.includes('deepseek-reasoner'));
  ck('聊天模型过滤器不会误删普通文本模型',
     isLikelyChatModel({}, 'qwen-plus') && !isLikelyChatModel({}, 'text-embedding-v4'));
  const diag = await modelIdeator.diagnose();
  ck('diagnose 同时验证模型枚举与真实聊天响应',
     diag.ok && diag.models.ok && diag.chat.ok && diag.chat.content.startsWith('{'));

  const listFailChatOk = createIdeator({
    baseUrl: 'https://x/v1', apiKey: 'k', model: 'm',
    fetchImpl: async url => url.endsWith('/models')
      ? { ok: false, status: 404, text: async () => 'no models route' }
      : mockLLM()
  });
  const partialDiag = await listFailChatOk.diagnose();
  ck('/models 失败不误判可正常聊天的线路',
     partialDiag.ok && !partialDiag.models.ok && partialDiag.chat.ok);

  // 测试异常处理
  const failModelIdeator = createIdeator({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'bad-key',
    model: 'deepseek-chat',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'Unauthorized invalid api key' })
  });
  let fetchErr = null;
  try { await failModelIdeator.fetchModels(); } catch (e) { fetchErr = e; }
  ck('fetchModels 401 报错时抛出明确信息', !!fetchErr && fetchErr.message.includes('401'));

  // DeepSeek 出错时返回无 content-type 的纯文本，不能把真实原因吐成“不是 JSON”
  const plainTextIdeator = createIdeator({
    baseUrl: 'https://api.deepseek.com', apiKey: 'bad', model: 'deepseek-v4-flash',
    fetchImpl: async () => ({ ok: false, status: 401, headers: { get: () => null },
      text: async () => 'Authentication Fails (governor)' })
  });
  let plainErr = null;
  try { await plainTextIdeator.fetchModels(); } catch (e) { plainErr = e; }
  ck('无 content-type 的纯文本 401 仍报认证失败并带原文',
     !!plainErr && plainErr.kind === 'auth' &&
     plainErr.message.includes('Authentication Fails'), plainErr && plainErr.message);

  // 真正的非 JSON（如被网关/门户拦截返回 200 HTML）必须报出可诊断信息
  const htmlIdeator = createIdeator({
    baseUrl: 'https://x/v1', apiKey: 'k', model: 'm',
    fetchImpl: async () => ({ ok: true, status: 200,
      headers: { get: k => k === 'content-type' ? 'text/html; charset=utf-8' : null },
      text: async () => '<!doctype html><html><head><title>登录转发</title></head>' })
  });
  let htmlErr = null;
  try { await htmlIdeator.fetchModels(); } catch (e) { htmlErr = e; }
  ck('200 非 JSON 时报出状态码/content-type/正文片段',
     !!htmlErr && htmlErr.kind === 'invalid_response' &&
     htmlErr.message.includes('HTTP 200') &&
     htmlErr.message.includes('text/html') &&
     htmlErr.message.includes('<!doctype html>'), htmlErr && htmlErr.message);

  hr('3. prompt 设计（防止模型越界替数据下判断）');
  ck('system prompt 明令禁止模型判断新颖性/论文数',
     IDEATE_SYSTEM_PROMPT.includes('严禁判断题目是否新颖') &&
     IDEATE_SYSTEM_PROMPT.includes('有多少篇论文'));
  ck('禁止输出「创新性高」「研究较少」这类不可证实的话',
     IDEATE_SYSTEM_PROMPT.includes('创新性高') && IDEATE_SYSTEM_PROMPT.includes('研究较少'));
  ck('要求英文术语是学界通用写法（否则检索不到）',
     IDEATE_SYSTEM_PROMPT.includes('学界通用写法') &&
     IDEATE_SYSTEM_PROMPT.includes('不要自创缩写'));
  ck('needs 取值被限定枚举', IDEATE_SYSTEM_PROMPT.includes('"none" | "single" | "multi"'));
  ck('要求诚实评估难度', IDEATE_SYSTEM_PROMPT.includes('不要为了让题目好看而低报难度'));

  const up = buildUserPrompt(PROFILE);
  ck('user prompt 把条件翻译成人话（无显卡→中文描述）',
     up.includes('没有显卡') && up.includes('只能用网上的公开数据集'));
  ck('user prompt 告知模型条件是硬约束、系统会自动筛',
     up.includes('硬约束') && up.includes('条件匹配'));
  ck('user prompt 带上题目数量', up.includes('4 个候选题目'));

  hr('4. 生成与归一化');
  const ide = createIdeator({ apiKey: 'sk-test', baseUrl: 'https://x/v1',
                              model: 'mock', fetchImpl: async () => mockLLM() });
  ck('configured() 正确', ide.configured() === true);
  const r = await ide.generate(PROFILE);
  ck('生成 4 个候选题', r.ok && r.ideas.length === 4, String(r.ideas.length));
  ck('每题都有中文题目与 objectEn',
     r.ideas.every(x => x.zh && x.objectEn));
  ck('needs 字段完整且取值合法',
     r.ideas.every(x => ['none','single','multi'].includes(x.needs.gpu) &&
                        ['public','self-collect','private'].includes(x.needs.dataset) &&
                        Number.isFinite(x.needs.weeks) &&
                        ['beginner','mid','strong'].includes(x.needs.codingLevel)));
  ck('source 标为 llm（供界面标注为模型推断）',
     r.ideas.every(x => x.source === 'llm'));
  ck('覆盖不同难度（既有 gpu:none 也有 gpu:multi）',
     r.ideas.some(x => x.needs.gpu === 'none') && r.ideas.some(x => x.needs.gpu === 'multi'));

  hr('5. 容错解析（模型输出不规范时不能崩）');
  const cases = [
    ['裹 markdown 代码块', '```json\n{"ideas":[{"zh":"题目A","objectEn":"bearing fault diagnosis","methodEn":"few-shot learning"}]}\n```'],
    ['前后有解释文字', '好的，以下是建议：\n{"ideas":[{"zh":"题目B","objectEn":"cyberbullying"}]}\n希望有帮助！'],
    ['顶层就是数组', '[{"zh":"题目C","objectEn":"gut brain axis","methodEn":"machine learning"}]'],
    ['字段用下划线命名', '{"ideas":[{"zh":"题目D","object_en":"solid state electrolyte","method_en":"machine learning","needs":{"coding_level":"strong"}}]}'],
    ['needs 取值非法', '{"ideas":[{"zh":"题目E","objectEn":"perovskite solar cell","needs":{"gpu":"超算","dataset":"随便","weeks":"很久","codingLevel":"神"}}]}'],
    ['推理模型 content 含 think 块', '<think>先推理一大段</think>\n{"ideas":[{"zh":"题目F","objectEn":"bearing fault diagnosis"}]}'],
  ];
  for (const [name, txt] of cases) {
    try {
      const out = ide.parseIdeas(txt);
      ck(name + ' -> 解析成功', out.length >= 1 && !!out[0].objectEn, JSON.stringify(out[0] || {}));
    } catch (e) { ck(name + ' -> 解析成功', false, e.message); }
  }
  const bad = ide.parseIdeas('{"ideas":[{"zh":"题目E","objectEn":"perovskite solar cell","needs":{"gpu":"超算","dataset":"随便","weeks":"很久","codingLevel":"神"}}]}')[0];
  ck('非法 needs 被兜底为保守默认值',
     bad.needs.gpu === 'single' && bad.needs.dataset === 'public' &&
     bad.needs.weeks === 14 && bad.needs.codingLevel === 'mid',
     JSON.stringify(bad.needs));
  ck('缺 objectEn 的条目被丢弃',
     ide.parseIdeas('{"ideas":[{"zh":"只有中文"},{"zh":"有的","objectEn":"cyberbullying"}]}').length === 1);

  let threw = null;
  try { ide.parseIdeas('这不是JSON'); } catch (e) { threw = e; }
  ck('完全无法解析时抛出明确错误', !!threw && threw.message.includes('不是合法 JSON'));

  hr('6. 未配置模型时的行为');
  const noKey = createIdeator({});
  ck('configured() 为 false', noKey.configured() === false);
  let e2 = null;
  try { await noKey.generate(PROFILE); } catch (e) { e2 = e; }
  ck('未配置时抛 NOT_CONFIGURED（供界面切兜底）',
     !!e2 && e2.code === 'NOT_CONFIGURED');
  ck('config 不泄露 apiKey',
     createIdeator({ apiKey: 'sk-secret' }).config.apiKey === '***');

  hr('7. 无模型兜底（必须自带警告）');
  const fb = fallbackIdeas(ANGLE_DICT, '电子信息', 6);
  ck('兜底能生成 6 个候选', fb.length === 6, String(fb.length));
  ck('每个都带 warning 说明语义未经判断',
     fb.every(x => x.warning && x.warning.includes('语义合理性未经模型判断')));
  ck('source 标为 template', fb.every(x => x.source === 'template'));

  hr('8. LLM 调用异常处理');
  const errIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm',
    maxRetries: 0,
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'invalid api key' }) });
  let e3 = null;
  try { await errIde.generate(PROFILE); } catch (e) { e3 = e; }
  ck('HTTP 401 时抛出含状态码的错误', !!e3 && e3.message.includes('401'), e3 && e3.message);

  let sentBody = null;
  const minIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm',
    maxRetries: 0,
    fetchImpl: async (url, init) => { sentBody = JSON.parse(init.body); return mockLLM(); } });
  const rr = await minIde.generate(PROFILE);
  ck('正式调用使用最小兼容负载，不强塞 temperature/response_format',
     rr.ok && !('temperature' in sentBody) && !('response_format' in sentBody),
     JSON.stringify(sentBody));

  let calls = 0;
  const retryIde = createIdeator({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm',
    maxRetries: 1,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 500, text: async () => 'temporary' };
      return mockLLM();
    } });
  const retried = await retryIde.generate(PROFILE);
  ck('仅对可恢复的 5xx 故障重试', retried.ok && calls === 2, 'calls=' + calls);

  hr('结果: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
