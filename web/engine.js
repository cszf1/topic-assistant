/* ==========================================================================
 * 选题体检站 · 核心引擎（纯逻辑，无 DOM 依赖，浏览器 + Node 双环境）
 *
 * 机制与 probe/scan.py 的 v3 完全一致。以下每条约束都由实测得出，
 * 依据见 PLAN.md §14（对抗审查）与 eval/M0-report.md（地基验证）：
 *
 *  1. 双短语 AND —— 主方向与角度各自加引号，分子分母同口径。
 *     无引号时 OpenAlex 按 token-AND 匹配，会让
 *     "PCB defect detection semantic communication" 退化为
 *     「正文含 {PCB,defect,detection,semantic,communication}」，
 *     v2 因此产出 7/7 全假的"金矿榜"。
 *  2. 一律 group_by=publication_year —— 1 credit（行查询要 10），
 *     且顺带拿到分年趋势，省钱与拿趋势是同一个动作。
 *  3. 术语性校验 —— 主方向加引号后 <100 篇则拒绝执行。
 *     实测 "social media adolescent mental health" 仅 9 篇、
 *     "gut microbiome depression" 仅 8 篇，属多概念拼接，
 *     继续扫描会让几乎所有角度落入 D 组，结果不可用。
 *  4. 自反剔除用【子集判定】而非交集非空。用交集会因 learning/detection
 *     这类通用词大面积误杀（实测主方向 "machine learning for defect
 *     detection" 曾误杀 10 个角度，改子集判定后降为 1 个）。
 *  5. method 类在【计算时】排除出 C 组，不能只在展示层拦 ——
 *     否则数据里仍标记为空位（实测 bearing 的 meta-analysis、
 *     社科的 ethnography 都这么漏出来）。
 *  6. C 组门槛用相对阈值 max(10, 域量×1%)，禁止跨学科硬编码 ——
 *     实测社科红海 168x > 材料空位 69x，任何全局阈值都会系统性出错。
 *  7. 查询失败绝不静默 —— 重试后仍失败则记入 failed，
 *     结果带 isComplete，避免残缺结果被当成全量。
 *  8. 不提供 MFR 排行榜 —— 小方向区分度仅 1.6 倍，
 *     大方向榜首被 meta-analysis/systematic review 等方法词占据。
 *     故 mfr 字段仅供参考，产品语义在四分类上。
 *  9. 通用层按学科白名单并入 —— 通用层含大量 ML 技术角度，
 *     对工科合适，对社科/人文会制造大批无关"空位"
 *     （实测社科 C 组 6 个无关项全部来自通用层）。
 *
 * OpenAlex 开放 CORS（Access-Control-Allow-Origin: *），故浏览器可直连，
 * 无需后端代理；且每位访客用自己 IP 的额度，天然分摊。
 * ========================================================================== */
'use strict';

const API_BASE = 'https://api.openalex.org/works';
const GENERAL = '通用';
const GENERAL_BLOCK = new Set(['社科', '法学', '传播', '语言', '教育', '心理', '管理']);
const NO_GAP_CATEGORIES = new Set(['method']);

const DEFAULTS = {
  minFocusForCrowded: 5,     // 专研低于此 -> B 组（低置信）
  gapMinMention: 10,         // C 组门槛下限
  gapRatio: 0.01,            // C 组门槛 = max(gapMinMention, 域量 × 此值)
  termMinStrict: 100,        // 术语校验：低于此拒绝执行（多概念拼接）
  termMinWarn: 500,          // 低于此警告样本偏少
  // 主题集中度：top1 primary_topic 占比。真实研究方向的文献聚集在少数主题上，
  // 通用词散布全库。实测 PCB defect detection 80.2%、perovskite solar cell 90.4%、
  // cyberbullying 36.6%（真实方向下界）；而 harness 0.7%、novel 0.3%、
  // approach 0.3%、framework 0.9%。故 5% 是安全的拒绝线。
  topicFocusMinStrict: 0.05,
  topicFocusMinWarn: 0.20,
  concurrency: 4,            // 并发上限，过高会被限流
  retries: 3,
  retryBaseDelay: 1200,
  includeGeneral: true,
};

const STOP_WORDS = new Set(
  ('learning detection analysis system systems network networks model modeling ' +
   'modelling method methods based using data approach study research prediction ' +
   'classification recognition optimization design assessment evaluation ' +
   'management processing application applications technology performance control'
  ).split(' '));

/* ------------------------------------------------------------------ 工具 */

function tokenize(s) {
  return new Set(String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter(t => t.length > 2));
}
function isSubset(a, b) {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
function hasCJK(s) { return /[\u4e00-\u9fff]/.test(String(s)); }
function phrase(s) { return '"' + String(s).replace(/"/g, '') + '"'; }

/** 并发池：一次全发会被限流 */
async function pool(items, limit, worker, onTick, isAborted) {
  const out = new Array(items.length);
  let idx = 0, done = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (idx < items.length) {
      if (isAborted && isAborted()) return;
      const i = idx++;
      out[i] = await worker(items[i], i);
      done += 1;
      if (onTick) onTick(done, items.length, items[i]);
    }
  }));
  return out;
}

/* ------------------------------------------------------------------ 引擎 */

function createScreener(userOpts) {
  const opt = Object.assign({}, DEFAULTS, userOpts || {});
  const dict = opt.angleDict;
  if (!dict) throw new Error('createScreener 需要 angleDict（见 web/angles.js）');
  const doFetch = opt.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new Error('运行环境没有 fetch，请传 fetchImpl');

  // 缓存：默认内存；浏览器可传 localStorage 包装，Node 可传文件包装
  const cache = opt.cache || new Map();
  const cGet = k => (cache instanceof Map ? cache.get(k) : cache.get(k));
  const cSet = (k, v) => (cache instanceof Map ? cache.set(k, v) : cache.set(k, v));

  let aborted = false;
  let lastQuota = null;

  /** 计数 URL（group_by=1 credit）。只能看到数字，不能看到论文。 */
  function buildURL(mode, ph) {
    return API_BASE + '?filter=' + mode + '.search:' +
      encodeURIComponent(ph) + '&group_by=publication_year';
  }

  /** 论文列表 URL（行查询=10 credit）。引擎【不主动请求】它，只生成给用户点，
   *  所以不消耗本次扫描的额度。这是"可复核"真正落地的地方 ——
   *  只看计数无法判断这些论文是否真的相关：实测
   *  fulltext:"PCB defect detection" "graph neural network" 的 21 篇里，
   *  就混着《Multi-attention fusion transformer for single-image super-resolution》。 */
  /** 生成第三方学术搜索引擎的人类可读网页链接 */
  function buildWebSearchURLs(ph) {
    // 去掉外层用于API的双引号转义，供URL编码
    const cleanPh = ph.replace(/\"/g, '"');
    return {
      openalexWeb: 'https://openalex.org/works?search=' + encodeURIComponent(cleanPh),
      googleScholar: 'https://scholar.google.com/scholar?q=' + encodeURIComponent(cleanPh),
      semanticScholar: 'https://www.semanticscholar.org/search?q=' + encodeURIComponent(cleanPh),
    };
  }

  /** 获取具体论文列表并格式化为人类可读结构 */
  async function fetchPaperList(mode, ph, perPage) {
    const listUrl = buildListURL(mode, ph, perPage || 15);
    try {
      const res = await doFetch(listUrl);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      const papers = (d.results || []).map(w => ({
        id: w.id,
        title: w.display_name || 'Untitled',
        year: w.publication_year,
        citedBy: w.cited_by_count || 0,
        doi: w.doi,
        topic: (w.primary_topic && w.primary_topic.display_name) || 'Unknown',
        openalexUrl: w.id,
      }));
      return { ok: true, count: d.meta.count, papers, listUrl };
    } catch (e) {
      return { ok: false, error: String(e.message || e), listUrl };
    }
  }

  function buildListURL(mode, ph, perPage) {
    return API_BASE + '?filter=' + mode + '.search:' + encodeURIComponent(ph) +
      '&per-page=' + (perPage || 25) +
      '&select=' + encodeURIComponent(
        'id,display_name,publication_year,doi,primary_topic,cited_by_count');
  }

  /** 一次原子查询。返回 {count, byYear, url, at, cached?, error?} */
  async function query(mode, ph) {
    const url = buildURL(mode, ph);
    const listUrl = buildListURL(mode, ph);
    const hit = cGet(url);
    if (hit) return Object.assign({}, hit, { url, listUrl, cached: true });

    let lastErr = null;
    for (let i = 0; i < opt.retries; i++) {
      if (aborted) return { count: null, byYear: {}, url, error: 'aborted' };
      try {
        const res = await doFetch(url);
        // OpenAlex 通过 access-control-expose-headers 暴露 X-RateLimit-*
        if (res.headers && res.headers.get) {
          const rem = res.headers.get('X-RateLimit-Remaining');
          if (rem !== null && rem !== undefined) {
            lastQuota = Number(rem);
            if (opt.onQuota) opt.onQuota(lastQuota);
          }
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const byYear = {};
        (data.group_by || []).forEach(g => { byYear[g.key] = g.count; });
        const rec = {
          count: data.meta.count,
          byYear,
          at: new Date().toISOString().slice(0, 19) + 'Z',
        };
        cSet(url, rec);
        return Object.assign({}, rec, { url, listUrl });
      } catch (e) {
        lastErr = e;
        if (i < opt.retries - 1) {
          await new Promise(r => setTimeout(r, opt.retryBaseDelay * (i + 1)));
        }
      }
    }
    return {
      count: null, byYear: {}, url, listUrl,
      error: String((lastErr && lastErr.message) || lastErr),
    };
  }

  /** 列出学科。count=词典条数；effective=实际会扫的角度数（并入通用层并去重后，
   *  不含自反剔除，因为那依赖具体 topic）；generalMerged=是否并入通用层 */
  /** 按任意维度分组查询（如 primary_topic.id）。同为 1 credit。 */
  async function queryGroup(mode, ph, dim) {
    const url = API_BASE + '?filter=' + mode + '.search:' +
      encodeURIComponent(ph) + '&group_by=' + dim;
    const hit = cGet(url);
    if (hit) return Object.assign({}, hit, { url, cached: true });
    try {
      const res = await doFetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const groups = (data.group_by || []).map(g => ({
        id: String(g.key).split('/').pop(), name: g.key_display_name, count: g.count,
      }));
      const rec = { groups, at: new Date().toISOString().slice(0, 19) + 'Z' };
      cSet(url, rec);
      return Object.assign({}, rec, { url });
    } catch (e) {
      return { groups: null, url, error: String(e.message || e) };
    }
  }

  function listDisciplines() {
    return Object.keys(dict).map(d => {
      const merged = (d !== GENERAL && opt.includeGeneral && !GENERAL_BLOCK.has(d));
      const set = new Set(dict[d].map(a => String(a[0]).toLowerCase()));
      if (merged) (dict[GENERAL] || []).forEach(a => set.add(String(a[0]).toLowerCase()));
      return { name: d, count: dict[d].length, effective: set.size, generalMerged: merged };
    });
  }

  /**
   * 闸门一：主方向术语性校验。
   * 返回 {ok, level:'ok'|'warn'|'reject', count, url, at, suggestions[], reason}
   */
  async function checkTerm(topic) {
    const t = String(topic || '').trim();
    if (!t) return { ok: false, level: 'reject', reason: 'empty', suggestions: [] };
    if (hasCJK(t)) {
      return {
        ok: false, level: 'reject', reason: 'cjk', count: null, suggestions: [],
        message: '主方向含中文。OpenAlex 以英文文献为主，中文检索词命中率极低，请改用英文规范术语。',
      };
    }
    const q = await query('title_and_abstract', phrase(t));
    if (q.count === null) {
      return { ok: false, level: 'reject', reason: 'query_failed',
               error: q.error, url: q.url, suggestions: [] };
    }
    // 主题集中度：判断这是"研究方向"还是"常用词"。
    // 只看数量拦不住 harness（283,525 篇却是个动词）—— 它的 top1 主题只占 0.7%。
    let topicFocus = null, topTopic = null, topicUrl = null;
    if (q.count >= opt.termMinStrict) {
      const g = await queryGroup('title_and_abstract', phrase(t), 'primary_topic.id');
      topicUrl = g.url;
      if (g.groups && g.groups.length) {
        topicFocus = g.groups[0].count / q.count;
        topTopic = g.groups[0].name;
      }
    }
    if (topicFocus !== null && topicFocus < opt.topicFocusMinStrict) {
      return {
        ok: false, level: 'reject', reason: 'too_generic',
        count: q.count, url: q.url, at: q.at, topicFocus, topTopic,
        topicUrl, suggestions: [],
        message: '「' + t + '」有 ' + q.count + ' 篇文献，但最大主题' +
          (topTopic ? '（' + topTopic + '）' : '') + '只占 ' +
          (topicFocus * 100).toFixed(1) + '%（门槛 ' +
          (opt.topicFocusMinStrict * 100) + '%），说明它散布在几乎所有领域 —— ' +
          '这是一个通用词，不是研究方向。请加上限定语使其成为具体方向：' +
          '「材料/器件 + 研究对象」或「对象 + 任务」，' +
          '例如 wiring harness（1430 篇，6.0%）比 harness 可用。' +
          '可点主题分布链接看它到底散布在哪些领域。',
      };
    }
    // 拼凑短语的截短建议：从右侧逐步缩短（实测
    // "social media adolescent mental health"(9) -> "adolescent mental health"(16691)）
    const parts = t.split(/\s+/);
    const suggestions = [];
    for (let k = parts.length - 1; k >= 2; k--) {
      suggestions.push(parts.slice(parts.length - k).join(' '));
    }
    if (q.count < opt.termMinStrict) {
      return {
        ok: false, level: 'reject', reason: 'not_a_term',
        count: q.count, url: q.url, at: q.at, suggestions,
        message: '「' + t + '」作为精确短语只有 ' + q.count + ' 篇（门槛 ' +
          opt.termMinStrict + '）。这很可能不是领域内的规范术语，而是多个概念的拼接；' +
          '继续扫描会让几乎所有角度落入「可划掉」组，结果不可用。',
      };
    }
    const tooFew = q.count < opt.termMinWarn;
    const looseTopic = topicFocus !== null && topicFocus < opt.topicFocusMinWarn;
    const msgs = [];
    if (tooFew) msgs.push('方向体量仅 ' + q.count + ' 篇（建议 ≥' + opt.termMinWarn +
      '）：样本偏少，请只看分组，不要据比值做角度间对比。');
    if (looseTopic) msgs.push('最大主题只占 ' + (topicFocus * 100).toFixed(1) +
      '%：该词偏宽泛，跨领域文献会混入计数，结果需谨慎解读。');
    return {
      ok: true, level: (tooFew || looseTopic) ? 'warn' : 'ok',
      count: q.count, byYear: q.byYear, url: q.url, listUrl: q.listUrl, at: q.at,
      topicFocus, topTopic, topicUrl,
      suggestions: tooFew ? suggestions : [],
      message: msgs.length ? msgs.join(' ') : null,
    };
  }

  /** 取角度集：并入通用层（按学科白名单）+ 自反剔除（子集判定） */
  function prepareAngles(discipline, topic) {
    let list = (dict[discipline] || []).slice();
    let generalUsed = false, generalBlocked = false;
    if (discipline !== GENERAL && opt.includeGeneral) {
      if (GENERAL_BLOCK.has(discipline)) generalBlocked = true;
      else { list = list.concat(dict[GENERAL] || []); generalUsed = true; }
    }
    const seen = new Set(), uniq = [];
    for (const a of list) {
      const k = String(a[0]).toLowerCase();
      if (!seen.has(k)) { seen.add(k); uniq.push(a); }
    }
    const tt = tokenize(topic);
    const kept = [], dropped = [];
    for (const [en, zh, cat] of uniq) {
      const at = tokenize(en);
      const core = new Set([...at].filter(x => !STOP_WORDS.has(x)));
      if (at.size && isSubset(at, tt)) {
        dropped.push({ en, zh, cat, overlap: [...at] });
      } else if (core.size && isSubset(core, tt)) {
        dropped.push({ en, zh, cat, overlap: [...core] });
      } else {
        kept.push({ en, zh, cat });
      }
    }
    return { kept, dropped, generalUsed, generalBlocked };
  }

  /**
   * 完整扫描。
   * @returns {Promise<Object>} 见 README 的 report 结构
   */
  async function scan(topic, discipline, runOpts) {
    const o = Object.assign({}, opt, runOpts || {});
    aborted = false;
    const t = String(topic || '').trim();

    const term = await checkTerm(t);
    if (!term.ok) return { ok: false, topic: t, term, groups: null, isComplete: false };

    const focusTotal = term.count;
    const gapThreshold = Math.max(o.gapMinMention,
      Math.floor(focusTotal * o.gapRatio));
    const prep = prepareAngles(discipline, t);

    if (o.onProgress) o.onProgress({ phase: 'scan', done: 0, total: prep.kept.length });

    const rows = await pool(prep.kept, o.concurrency, async (a) => {
      const ph = phrase(t) + ' ' + phrase(a.en);       // ← 双短语 AND
      const f = await query('title_and_abstract', ph);
      const m = await query('fulltext', ph);
      // ph 必须一起返回：它在本闭包内定义，下面的分类循环是另一个作用域，
      // 直接引用会抛 "ph is not defined"（已修，并由 mock scan 测试守住）
      return { angle: a, phrase: ph, focusQuery: f, mentionQuery: m };
    }, (done, total, a) => {
      if (o.onProgress) o.onProgress({ phase: 'scan', done, total, current: a });
    }, () => aborted);

    const A = [], B = [], C = [], D = [], failed = [];
    for (const r of rows) {
      if (!r) continue;
      const f = r.focusQuery, m = r.mentionQuery;
      if (f.count === null || m.count === null) {
        failed.push({ angle: r.angle, reason: f.error || m.error || 'query_failed' });
        continue;
      }
      const focus = f.count, mention = m.count;
      const ph = r.phrase;
      const item = {
        en: r.angle.en, zh: r.angle.zh, category: r.angle.cat,
        focusCount: focus, mentionCount: mention,
        mfr: focus > 0 ? mention / focus : null,
        lowConfidence: focus > 0 && focus < o.minFocusForCrowded,
        evidence: {
          // countUrl 复现数字（1 credit）；listUrl 看实际论文（10 credit，用户点才消耗）
          focus: { url: f.url, listUrl: f.listUrl, count: focus, at: f.at,
                   cached: !!f.cached, phrase: ph, mode: 'title_and_abstract',
                   webUrls: buildWebSearchURLs(ph) },
          mention: { url: m.url, listUrl: m.listUrl, count: mention, at: m.at,
                     cached: !!m.cached, phrase: ph, mode: 'fulltext',
                     webUrls: buildWebSearchURLs(ph) },
        },
      };
      // method 类必须在【计算时】排除出 C 组，不能只在展示层拦
      const isGap = focus === 0 && mention >= gapThreshold &&
        !NO_GAP_CATEGORIES.has(r.angle.cat);
      if (isGap) { item.group = 'C'; C.push(item); }
      else if (focus === 0) { item.group = 'D'; D.push(item); }
      else if (focus < o.minFocusForCrowded) { item.group = 'B'; B.push(item); }
      else { item.group = 'A'; A.push(item); }
    }

    C.sort((x, y) => y.mentionCount - x.mentionCount);
    D.sort((x, y) => y.mentionCount - x.mentionCount);
    B.sort((x, y) => (y.mfr || 0) - (x.mfr || 0));
    A.sort((x, y) => y.focusCount - x.focusCount);

    const queriesRun = 1 + rows.filter(Boolean).length * 2;
    return {
      ok: true,
      topic: t,
      discipline,
      term,
      focusTotal,
      byYear: term.byYear || {},
      topicQuery: { url: term.url, at: term.at },
      gapThreshold,
      gapRatio: o.gapRatio,
      minFocusForCrowded: o.minFocusForCrowded,
      angleCount: prep.kept.length,
      generalUsed: prep.generalUsed,
      generalBlocked: prep.generalBlocked,
      groups: { A, B, C, D },
      dropped: prep.dropped,
      failed,
      isComplete: failed.length === 0 && !aborted,
      aborted,
      queriesRun,
      quotaRemaining: lastQuota,
      // 对外必须原样传达的限制，不得省略（PLAN.md §11）
      disclaimer: [
        'C 组（待核实线索）人工标注实测严格命中率约 37%，不同方向波动 15%~100%：这是线索，不是新颖性保证。',
        'A 组（已有研究）只说明有人做过，不代表你不能做；红海判错的代价比空位判错更大，会劝退真方向。',
        '只覆盖 OpenAlex 收录的英文文献；中文期刊、专利、未收录会议不在计数内。',
        '分母为全文索引子集（实测覆盖率 15%~36%），比值只能相对比较，跨方向与跨学科均不可比。',
        '术语别名会使「已有研究」被低估（如 few-shot / low-shot / one-shot 分散计数）。',
        '不提供卷度排名：该比值在小方向区分度仅 1.6 倍，大方向会被方法类词汇占据榜首。',
      ],
    };
  }

  return {
    listDisciplines, checkTerm, scan, buildURL, buildListURL, buildWebSearchURLs, fetchPaperList, query, queryGroup,
    abort() { aborted = true; },
    get quotaRemaining() { return lastQuota; },
    constants: { GENERAL, GENERAL_BLOCK, NO_GAP_CATEGORIES, STOP_WORDS, DEFAULTS },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createScreener, tokenize, isSubset, phrase, pool, DEFAULTS };
}
