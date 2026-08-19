# 选题体检站 · 核心功能

科研选题筛查引擎。输入一个研究方向，把几十个可能的切入角度分成四组，
**先帮你划掉不用看的**，而不是给一个可疑的评分。

数据源 OpenAlex（免费、无需 API key、开放 CORS），**纯前端可直连，零后端**。

---

## 文件

| 路径 | 说明 |
|---|---|
| `web/engine.js` | **核心引擎**。纯逻辑，无 DOM 依赖，浏览器 + Node 双环境 |
| `web/angles.js` | 角度词典（366 角度 / 27 学科），由 CSV 自动生成 |
| `web/index.html` | 最小验证页。**只调用引擎、不重写逻辑**，界面自己另做 |
| `data/angle_dict.csv` | 词典源文件。改这个，然后跑 `python tools/gen_angles.py` |
| `test/run.js` | 引擎自检，31 个用例（`--offline` 跳过联网部分） |
| `tools/make_preview.js` | 跑一次真实扫描 → 生成自包含预览页 `out/preview.html`，之后反复看渲染不再消耗额度 |
| `probe/scan.py` | 同机制的 Python 版（先于 JS 实现，用于验证与批量实验） |
| `PLAN.md` | 方案设计 + 全部实测证据 + 对抗审查记录（§14） |
| `BUILD.md` | 施工图 |
| `eval/M0-report.md` | 地基验证报告（构念效度人工标注） |

---

## 跑起来

```bash
# 引擎自检（联网，约 130 次 OpenAlex 查询）
node test/run.js

# 只跑纯逻辑用例，不联网
node test/run.js --offline

# 指定方向实跑
node test/run.js "cyberbullying" 社科

# 浏览器：直接打开 web/index.html（file:// 即可，无需起服务）

# 生成离线预览页（调界面时用它，避免反复消耗 OpenAlex 额度）
node tools/make_preview.js "PCB defect detection" 电子信息
# -> out/preview.html（内联真实数据，打开即渲染，不发请求）
```

Python 版：

```bash
python probe/scan.py --list
python probe/scan.py "PCB defect detection" --discipline 电子信息
```

---

## 集成方式

```js
const screener = createScreener({
  angleDict: ANGLE_DICT,        // 必填
  cache: myCache,               // 可选，需实现 {get(k), set(k,v)}；默认内存 Map
  concurrency: 4,               // 可选，并发上限。过高会被 OpenAlex 限流
  onQuota: n => {},             // 可选，剩余额度回调
});

// 只做术语校验（便宜，1 次查询）
const t = await screener.checkTerm('PCB defect detection');
// -> { ok, level:'ok'|'warn'|'reject', count, url, at, suggestions[], message }

// 完整扫描
const r = await screener.scan('PCB defect detection', '电子信息', {
  onProgress: p => console.log(p.done + '/' + p.total),
});

screener.abort();               // 中止（结果会带 isComplete:false）
```

### 返回结构

```jsonc
{
  ok: true,
  topic, discipline,
  focusTotal,            // 方向体量（主方向短语的精确命中数）
  byYear,                // 分年趋势，零额外成本顺带取得
  gapThreshold,          // C 组门槛 = max(10, focusTotal × 1%)
  angleCount,
  generalUsed,           // 是否并入了通用层
  generalBlocked,        // 该学科是否被禁止并入通用层
  groups: {
    A: [...],   // 已经有人做了（专研 ≥ 5）
    B: [...],   // 文献极少 · 低置信（0 < 专研 < 5）
    C: [...],   // 待核实线索（专研 0 且提及 ≥ 门槛，非 method 类）
    D: [...],   // 可以直接划掉（专研 0 且提及不足门槛）
  },
  dropped: [...],        // 被剔除的自反角度
  failed: [...],         // 查询失败的角度
  isComplete,            // false 时结果残缺，不得当全量用
  queriesRun, quotaRemaining,
  disclaimer: [...],     // 必须一并展示给用户，不可省略
}
```

每个角度项：

```jsonc
{
  en, zh, category,      // category ∈ emerging|mainstream|task|method|deployment|quality
  focusCount,            // 分子：以此为主题的论文数
  mentionCount,          // 分母：领域内正文提及数
  mfr,                   // 比值，仅供参考，不要用它排名（见下）
  lowConfidence,
  group,
  evidence: {            // 铁律：没有查询串+命中数+时间戳的结论不准进报告
    // url     = 计数链接（group_by，1 credit），复现数字
    // listUrl = 论文列表链接（行查询，10 credit），看实际论文
    //           引擎不主动请求它，只生成 URL；用户点了才消耗他自己 IP 的额度
    focus:   { url, listUrl, count, at, cached },
    mention: { url, listUrl, count, at, cached },
  }
}
```

---

## 做界面时不要破坏的十条

每条都由实测得出，违反会让产品输出不可信。依据在 `PLAN.md` §14 与 `eval/M0-report.md`。

1. **不要做 MFR 排行榜。** 小方向区分度仅 1.6 倍（10.6x~16.8x）；大方向榜首会被
   `meta-analysis` 126x、`systematic review` 105x 这类方法词占据。`mfr` 字段只供调试参考。
2. **重心放在 D 组。** 它基于"分母趋零"这个强信号，是四组里最可靠的。
   产品的价值叙事是「先帮你划掉不用看的」，不是「帮你找到金矿」。
3. **C 组必须叫「待核实线索」**，不能叫金矿/蓝海/空位。人工标注严格命中率仅 **37%**
   （PCB 4/4、bearing 1/2、社科 2/13），并须提示"需你自己判断组合是否讲得通"。
4. **免责必须双侧。** 除了"线索不是新颖性保证"，还必须说
   **"红海判定可能误伤真方向"** —— C 组判错只是浪费一次查证，A 组判错会劝退一个真方向。
5. **不要称"领域内分位"。** 分位是相对当前词典算的，加 20 个红海词所有分位都会变。
   正确措辞：「在本次扫描的 N 个角度中排第 k」。
6. **`isComplete:false` 必须醒目提示**，不能只放在角落。残缺结果被当全量用是最危险的失效。
7. **不要跨方向/跨学科比较数值。** 实测社科红海 168x > 材料空位 69x。
8. **术语校验不可跳过，两道闸都要。**
   - 太窄：拼凑短语（`social media adolescent mental health` 精确匹配仅 9 篇）会让结果整体归零
   - 太宽：`harness` 有 283,525 篇但最大主题只占 0.7%，是常用动词不是研究方向
   引擎已内置双向拦截（<100 篇拒绝、主题集中度 <5% 拒绝）+ 改写建议。
9. **`disclaimer` 数组要原样展示**，不要挑着显示。
10. **证据必须能看到论文，不能只给计数。** 用 `evidence.*.listUrl`（行查询）作主链接，
    `url`（计数）作副链接。只给计数时用户无法判断相关性 —— 实测
    `"PCB defect detection" "graph neural network"` 的 21 篇里混着《单图超分辨率》论文，
    不打开列表根本发现不了。`listUrl` 已带 `primary_topic`，噪声一眼可见。

---

## 机制要点（改引擎前必读）

```
分子 = title_and_abstract.search:"<主方向>" "<角度>"
分母 = fulltext.search:"<主方向>" "<角度>"
```

- **双引号是关键。** 无引号时 OpenAlex 按 token-AND 匹配，
  `PCB defect detection semantic communication` 会退化为
  「正文含 {PCB,defect,detection,semantic,communication}」。
  早期版本因此产出 **7/7 全假**的"金矿榜"（语义通信 × PCB缺陷检测之类）。
  加引号后这些假空位的分母从 154/81/451 塌到 2/1/0，被自动划入 D 组。
- **一律 `group_by=publication_year`**：1 credit，行查询要 10 credit；且顺带拿到趋势曲线。
- **领域锚已被证明冗余**：双短语下加 `primary_topic.id` 锚只让分母缩 20~40%，
  排序完全不变，反而引入偏差。已移除。
- **自反剔除用子集判定**，不是交集非空 —— 后者会因 `learning`/`detection`
  这类通用词误杀 10 个角度。
- **`method` 类在计算时排除出 C 组**，不能只在展示层拦，否则数据里仍标记为空位。
- **通用层按学科白名单并入**：社科/法学/传播/语言/教育/心理/管理 默认不并入，
  因为通用层的 ML 角度会在这些方向制造大批无关"空位"。

---

## 额度

OpenAlex 按 IP 计：1000 credits / 0.1 USD，重置是**固定时间点**而非滚动窗口。

- 单方向约 90 次查询 ≈ $0.009
- 纯前端直连的好处：每位访客用自己 IP 的额度，天然分摊，多人同时访问不会互相挤
- 引擎会把 `X-RateLimit-Remaining` 通过 `onQuota` 回调出来，建议显示给用户

---

## 已知未解决

- **构念效度样本仍小**：只标注了 3 个方向、19 个 C 组项，单人标注无一致性检验（`eval/M0-report.md` §6）
- 已证伪 / 顺带引用 / 统计巧合三类假线索，机制层仍无区分手段
- `aliases` 别名合并未实现，"已有研究"数被别名分散低估（如 few-shot / low-shot / one-shot）
- LLM 两端（按学科生成角度、C 组语义复核）未实现，见 `BUILD.md` M3
