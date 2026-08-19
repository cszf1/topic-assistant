/* 离线全流程测试：用 mock fetch 跑通 scan()，不消耗任何 OpenAlex 额度。
 *
 * 存在的理由：`ph is not defined` 这个 bug 之所以漏到用户面前，
 * 是因为改了 scan() 核心路径后只跑了 --offline（当时不覆盖 scan），
 * 而联网测试因额度耗尽跑不了。有了本文件，核心路径任何改动都能立即验证。
 *
 * 用法: node test/offline-scan.js
 */
'use strict';
const path = require('path');
const { ANGLE_DICT } = require(path.join(__dirname, '..', 'web', 'angles.js'));
const { createScreener } = require(path.join(__dirname, '..', 'web', 'engine.js'));

let pass = 0, fail = 0;
function ck(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
const hr = t => console.log('\n' + '='.repeat(72) + '\n' + t + '\n' + '='.repeat(72));

/* ---------------------------------------------------------- mock fetch */
// 按 URL 造确定性的假数据，覆盖 A/B/C/D 四组 + 失败 + method 泄漏 + 通用词
function makeMock(opts) {
  const o = opts || {};
  let calls = 0;
  return async function mockFetch(url) {
    calls++;
    const dec = decodeURIComponent(url);
    const isFulltext = dec.includes('fulltext.search');
    const isTopicGroup = dec.includes('group_by=primary_topic.id');
    const isList = dec.includes('per-page=');

    if (o.failOn && o.failOn(dec, calls)) {
      return { ok: false, status: 500, headers: { get: () => null } };
    }

    // 主题集中度分组查询
    if (isTopicGroup) {
      const focus = o.topicFocusRatio == null ? 0.8 : o.topicFocusRatio;
      const total = o.topicTotal == null ? 1000 : o.topicTotal;
      return json({
        meta: { count: total },
        group_by: [
          { key: 'https://openalex.org/T111', key_display_name: 'Mock Primary Topic',
            count: Math.round(total * focus) },
          { key: 'https://openalex.org/T222', key_display_name: 'Other', count: 1 },
        ],
      });
    }

    // 论文列表（行查询）
    if (isList) {
      return json({
        meta: { count: 21 },
        results: [
          { id: 'https://openalex.org/W1', display_name: 'Mock Paper A',
            publication_year: 2024, cited_by_count: 10, doi: 'https://doi.org/10.1/a',
            primary_topic: { display_name: 'Mock Topic' } },
          { id: 'https://openalex.org/W2', display_name: 'Mock Paper B',
            publication_year: 2023, cited_by_count: 5, doi: null,
            primary_topic: null },
        ],
      });
    }

    // 主方向自身
    const m = dec.match(/search:"([^"]+)"(?:\s+"([^"]+)")?/);
    const topic = m ? m[1] : '';
    const angle = m ? m[2] : null;

    if (!angle) {
      return json({ meta: { count: o.topicTotal == null ? 1000 : o.topicTotal },
                    group_by: years(o.topicTotal == null ? 1000 : o.topicTotal) });
    }

    // 角度：按名字派发到四组
    const plan = (o.anglePlan || {})[angle] || o.defaultAngle || { focus: 8, mention: 90 };
    const n = isFulltext ? plan.mention : plan.focus;
    return json({ meta: { count: n }, group_by: years(n) });
  };

  function years(total) {
    return [
      { key: '2025', key_display_name: '2025', count: Math.round(total * 0.3) },
      { key: '2024', key_display_name: '2024', count: Math.round(total * 0.25) },
      { key: '2023', key_display_name: '2023', count: Math.round(total * 0.2) },
    ];
  }
  function json(body) {
    return {
      ok: true, status: 200,
      headers: { get: k => (k === 'X-RateLimit-Remaining' ? '999' : null) },
      json: async () => body,
    };
  }
}

/* ---------------------------------------------------------- 用例 */
(async () => {
  hr('离线全流程 scan()（mock fetch，零额度消耗）');

  // 造一个能命中四组的方案：域量 1000 -> C 组门槛 = max(10, 10) = 10
  const anglePlan = {
    // A 组：专研 >= 5
    'machine learning':        { focus: 32, mention: 493 },
    'transfer learning':       { focus: 12, mention: 202 },
    // B 组：0 < 专研 < 5
    'few-shot learning':       { focus: 3,  mention: 39 },
    'reinforcement learning':  { focus: 1,  mention: 61 },
    // C 组：专研 0 且提及 >= 10（非 method）
    'graph neural network':    { focus: 0,  mention: 21 },
    'digital twin':            { focus: 0,  mention: 33 },
    // method 类且专研 0 提及高 —— 必须落 D，不得进 C
    'meta-analysis':           { focus: 0,  mention: 184 },
    'systematic review':       { focus: 0,  mention: 86 },
    // D 组：专研 0 且提及 < 10
    'federated learning':      { focus: 0,  mention: 2 },
  };

  const S = createScreener({
    angleDict: ANGLE_DICT,
    fetchImpl: makeMock({ topicTotal: 1000, topicFocusRatio: 0.8, anglePlan,
                          defaultAngle: { focus: 0, mention: 1 } }),
    concurrency: 3,
  });

  let ticks = 0;
  const r = await S.scan('PCB defect detection', '电子信息', {
    onProgress: p => { if (p.done) ticks = p.done; },
  });

  ck('scan 不抛异常且 ok=true', r.ok === true, JSON.stringify(r.term || {}).slice(0, 120));
  if (!r.ok) { hr('结果: ' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }

  ck('进度回调被调用', ticks > 0);
  ck('域量取自主方向查询', r.focusTotal === 1000);
  ck('C 组门槛 = max(10, 域量×1%)', r.gapThreshold === 10, String(r.gapThreshold));

  const find = (grp, en) => r.groups[grp].find(x => x.en === en);
  ck('A 组：machine learning(32篇)', !!find('A', 'machine learning'));
  ck('B 组：few-shot learning(3篇)', !!find('B', 'few-shot learning'));
  ck('C 组：graph neural network(0/21)', !!find('C', 'graph neural network'));
  ck('C 组：digital twin(0/33)', !!find('C', 'digital twin'));
  ck('D 组：federated learning(0/2)', !!find('D', 'federated learning'));

  // 回归：method 类不得进 C（曾在展示层拦、数据层泄漏）
  ck('method 类落 D 不落 C（meta-analysis）',
     !find('C', 'meta-analysis') && !!find('D', 'meta-analysis'));
  ck('method 类落 D 不落 C（systematic review）',
     !find('C', 'systematic review') && !!find('D', 'systematic review'));
  ck('C 组整体不含 method', r.groups.C.every(x => x.category !== 'method'));

  // 回归：ph 作用域 —— 本次线上报错 "ph is not defined" 的守门测试
  const all = [].concat(r.groups.A, r.groups.B, r.groups.C, r.groups.D);
  ck('每条都带 evidence.focus.phrase（ph 作用域回归）',
     all.every(x => typeof x.evidence.focus.phrase === 'string' &&
                    x.evidence.focus.phrase.includes('"')));
  ck('phrase 是双短语形式 "主方向" "角度"',
     all.every(x => (x.evidence.focus.phrase.match(/"/g) || []).length === 4),
     all.length ? all[0].evidence.focus.phrase : '');
  ck('每条都带 webUrls 三个外链',
     all.every(x => x.evidence.focus.webUrls &&
                    x.evidence.focus.webUrls.googleScholar &&
                    x.evidence.focus.webUrls.semanticScholar &&
                    x.evidence.focus.webUrls.openalexWeb));
  ck('每条都带 listUrl（能看论文）',
     all.every(x => x.evidence.mention.listUrl.includes('per-page')));
  ck('mention 的 mode 标注正确',
     all.every(x => x.evidence.mention.mode === 'fulltext' &&
                    x.evidence.focus.mode === 'title_and_abstract'));

  ck('四组 + 失败 = 角度数',
     r.groups.A.length + r.groups.B.length + r.groups.C.length +
     r.groups.D.length + r.failed.length === r.angleCount);
  ck('isComplete=true（无失败）', r.isComplete === true);
  ck('disclaimer 含红海判错警示',
     r.disclaimer.some(s => s.includes('红海判错')));

  /* ---- fetchPaperList ---- */
  hr('fetchPaperList（页面内展开论文用）');
  const pl = await S.fetchPaperList('fulltext', '"PCB defect detection" "graph neural network"');
  ck('fetchPaperList ok', pl.ok === true, pl.error);
  ck('返回论文数组含标题/年份/被引/主题',
     pl.papers.length === 2 && pl.papers[0].title === 'Mock Paper A' &&
     pl.papers[0].year === 2024 && pl.papers[0].citedBy === 10 &&
     pl.papers[0].topic === 'Mock Topic');
  ck('无 doi/无 topic 时有兜底不崩',
     pl.papers[1].doi === null && pl.papers[1].topic === 'Unknown');

  /* ---- 通用词拦截（主题集中度） ---- */
  hr('通用词拦截（主题集中度，离线）');
  const S2 = createScreener({
    angleDict: ANGLE_DICT,
    fetchImpl: makeMock({ topicTotal: 283525, topicFocusRatio: 0.007 }),
  });
  const generic = await S2.checkTerm('harness');
  ck('主题集中度 0.7% 被拒为 too_generic',
     generic.ok === false && generic.reason === 'too_generic', generic.reason);
  ck('拒绝时给出主题分布链接', !!generic.topicUrl);
  const g2 = await S2.scan('harness', '电子信息');
  ck('通用词 scan 直接返回 ok=false 且不扫角度',
     g2.ok === false && (!g2.groups || g2.groups === null));

  /* ---- 拼凑短语拦截 ---- */
  const S3 = createScreener({
    angleDict: ANGLE_DICT,
    fetchImpl: makeMock({ topicTotal: 9 }),
  });
  const junk = await S3.checkTerm('social media adolescent mental health');
  ck('域量 9 被拒为 not_a_term',
     junk.ok === false && junk.reason === 'not_a_term', junk.reason);
  ck('给出截短建议', junk.suggestions.length > 0);

  /* ---- 查询失败不谎称完整 ---- */
  hr('查询失败处理（不得静默截断）');
  const S4 = createScreener({
    angleDict: ANGLE_DICT,
    retries: 1, retryBaseDelay: 1,
    fetchImpl: makeMock({
      topicTotal: 1000, topicFocusRatio: 0.8, anglePlan,
      defaultAngle: { focus: 8, mention: 90 },
      // 让含 "machine learning" 的角度查询失败
      failOn: dec => dec.includes('"machine learning"') && !dec.includes('per-page'),
    }),
    concurrency: 2,
  });
  const r4 = await S4.scan('PCB defect detection', '电子信息');
  ck('有失败时 isComplete=false', r4.ok && r4.isComplete === false);
  ck('failed 列出失败角度', r4.failed.length > 0 &&
     r4.failed.some(f => f.angle.en === 'machine learning'),
     JSON.stringify(r4.failed.map(f => f.angle.en)));
  ck('失败角度不出现在任何分组',
     ![].concat(r4.groups.A, r4.groups.B, r4.groups.C, r4.groups.D)
        .some(x => x.en === 'machine learning'));

  /* ---- 中止 ---- */
  const S5 = createScreener({
    angleDict: ANGLE_DICT, concurrency: 1,
    fetchImpl: makeMock({ topicTotal: 1000, topicFocusRatio: 0.8, anglePlan }),
  });
  const p5 = S5.scan('PCB defect detection', '电子信息');
  S5.abort();
  const r5 = await p5;
  ck('中止后不谎称完整', r5.ok === false || r5.isComplete === false);

  hr('结果: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
