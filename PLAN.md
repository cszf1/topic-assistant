# 选题体检站 · 产品方案

> 平台无关方案。核心逻辑是纯数据 + prompt 规范，任何前端/后端/低代码平台都能落。
> 版本 v1 · 2026-08-18 · 所有数字均为本地实测，可用 `probe/scan.py` 复现

---

## 0. Goal

**做一个能对「还没定死的研究方向」给出可复核体检结论的工具，面向本科生，敢说"这题你别做"。**

判定成功的三条标准：

1. 每个结论都能点开看到**原始查询串 + 命中数 + 抓取时间**，任何人可重跑
2. 输出**不是**一个综合评分，而是分维度级别 + 一个明确的 go / 改造后可做 / no-go
3. 一次体检在 30 秒内完成，成本 < $0.01

---

## 1. 一句话定义

> 输入一个研究方向和你的真实条件，告诉你这个方向还剩哪些空地、你的条件够不够、以及哪些角度别碰。

**不做**：不写开题报告、不写文献综述、不精读论文、不跑实验。这些都有成熟工具，且是红海。

---

## 2. 差异化（已被反证修正过的版本）

### ⚠️ 原说法已被推翻

调研时逆向克隆了三个标杆仓库逐文件核实，发现原本打算写的"这个空位没人占"是错的：

| 已存在的东西 | 出处 |
|---|---|
| "innovation/feasibility scoring" + **"prior work density"** | `ai4s-skills/skills/research-explorer/SKILL.md` |
| 面向学生的选题决策框架（基于 Fischbach & Walsh, *Cell* 2024） | `openscience/backend/cli/skills/research/scientific-problem-selection/SKILL.md` |
| OpenAlex 接入（"No API key required - OpenAlex is completely open"） | `openscience/backend/cli/skills/databases/openalex-database/SKILL.md` |

选题评估、可行性打分、OpenAlex 接入——**三个零件都已经有人做了**。

### ✅ 真正的缺口：三个零件没有焊在一起

交叉验证证据：

- grep `novelty|research gap|saturat|crowded field|under-explored` 在 `research/` 与 `databases/openalex-database/` **双侧均不命中**
- `scientific-problem-selection` 全文**不出现 openalex**（它的文献校验用 PubMed，且是 validation 而非 counting）
- `research-explorer` 的 feasibility 来自 Step 3 的七维 **WebSearch 印象**，**全文无任何计数步骤**，SKILL.md 自认 `heuristic`、`not guaranteed novel`

于是差异化只剩两条，但这两条足够硬：

> **一、分数可复核。** 现有工具的可行性分是模型自述（low/medium/high + 一句理由）。我们的每个数字都附可重跑的查询串。
>
> **二、敢出否决。** `research-explorer` Step 4 只有 "which 1–3 the user should pursue"（只推荐不否决）；`integrity-auditor` 明写 "never verdicts"。**没有一个工具会说"这题你别做"。**

写进对外文档的标准表述（抗质询版，禁止简化）：

> research-explorer 已做候选题生成与启发式可行性打分、scientific-problem-selection 已做对话式选题策略教练、scholar-evaluation 已做成稿质量加权评分；三者共同的缺口是**分数不可复核**（无计数、无查询串、无原始约束枚举）与**不出否决结论**，本作品补的正是这两点。

---

## 3. 核心机制：提及/专研比（MFR）

### 3.1 原理

OpenAlex 同一个概念有两种检索口径，量级差异巨大：

| 口径 | filter 参数 | 含义 |
|---|---|---|
| **专研**（分子） | `title_and_abstract.search` | 真正以此为主题的论文 |
| **提及**（分母） | `fulltext.search` | 正文/参考文献里出现过该词的论文 |

```
v1  MFR = 提及数 / 专研数                       ← 有领域漂移缺陷（3.8）
v2  MFR = 锚定提及数 / 专研数                   ← 加领域锚，但仍产出 7/7 假空位
v3  MFR = 提及数 / 专研数，检索式用【双短语 AND】  ← 现行主指标
        分子 title_and_abstract.search:"<主方向>" "<角度>"
        分母 fulltext.search:"<主方向>" "<角度>"
        两侧同口径同短语；领域锚已被实测证明冗余，默认关闭
```

> ⚠️ 引号是关键。无引号时 OpenAlex 按 token-AND 匹配，
> `PCB defect detection semantic communication` 退化为「正文含 {PCB,defect,detection,semantic,communication}」，
> 这是 v1/v2 大批假空位的根源。详见 §14。

- **低 MFR** → 提及与专研齐平 → 这个角度已被正面攻克 → **红海**
- **高 MFR** → 领域反复提及，却几乎无人正面研究 → **候选空位**

### 3.2 关键：MFR 顺带解决了 `count=0` 的二义性

这是整个方案的枢纽。单看命中数，`0 篇` 有两种截然相反的解释，无法区分：

| 专研 | 提及 | 判读 |
|---|---|---|
| 0 | 1408 | **金矿** — 相关性已被 1408 篇背书，但无人正面做 |
| 0 | 0 | **无意义组合** — 该领域根本没人提过，慎入 |

**加一个分母，二义性自动消解。** 三个标杆项目都没有这个概念。

### 3.3 实测证据（PCB defect detection，主方向专研 1769 篇）

| 角度 | 专研 | 提及 | MFR | 判读 |
|---|---|---|---|---|
| graph neural network | 1 | 1997 | **1997x** | 真空位 |
| neural architecture search | 0 | 1408 | **∞** | 绝对空白但相关性已背书 |
| domain adaptation | 5 | 1945 | 389x | 真空位 |
| diffusion model | 16 | 3644 | 228x | 真空位 |
| federated learning | 2 | 445 | 222x | 真空位 |
| self-supervised | 14 | 2319 | 166x | 真空位 |
| few-shot | 18 | 1557 | 86x | 偏空 |
| anomaly detection | 59 | 3051 | 52x | 中等 |
| edge deployment | 54 | 2621 | 49x | 中等 |
| transformer | 115 | 2256 | 20x | 偏红 |
| knowledge distillation | 21 | 420 | 20x | 偏红 |
| **lightweight** | **311** | **2707** | **9x** | **红海** |

14 个角度 × 双口径 = 28 次查询，**总成本 $0.0028**。

### 3.4 跨学科复测：普适性成立，但阈值不可硬编码

六个方向、四大学科实测：

| 主方向 | 学科 | 方向体量 | MFR 区间 | 区分跨度 |
|---|---|---|---|---|
| perovskite solar cell stability | 材料/化学 | 25,404 | **5x ~ 69x** | 13 倍 |
| PCB defect detection | 电子信息 | 1,769 | 9x ~ 1997x | 229 倍 |
| bearing fault diagnosis | 机电 | 17,848 | 10x ~ 73x | 7 倍 |
| EEG emotion recognition | 生物电子 | 6,232 | 14x ~ 177x | 12 倍 |
| gut microbiome depression | 医学/生物 | 2,417 | 51x ~ 601x | 12 倍 |
| social media adolescent mental health | 社会科学 | 5,500 | **168x ~ 957x** | 6 倍 |

**三条结论：**

1. ✅ **MFR 学科无关** — 六个方向均产生 6–229 倍的可用区分度，机制不依赖工科
2. 🚨 **绝对阈值跨学科完全反转** — 社科的**红海**是 168x，而材料的**空位**是 69x。任何全局阈值都会在某个学科上系统性出错
3. 🔍 成因：**学科引用文化差异**。社科论文正文讨论面宽，全文命中率天然高；材料论文更聚焦。这与方向体量是两个独立因素

#### 最强证据：同一角度跨方向结论完全反转

`domain adaptation` 在两个方向的实测结果：

| 主方向 | 专研 | 提及 | MFR | 判读 |
|---|---|---|---|---|
| PCB defect detection | 5 | 1,945 | **389x** | 候选空位 ✅ |
| bearing fault diagnosis | 954 | 9,407 | **10x** | 红海 ❌ |

**同一个技术角度，结论完全相反。** 因此唯一合法的用法是：

> **只做方向内相对排序 / 分位数，永不输出跨方向或跨学科的 MFR 比较。**

界面上也不得展示裸 MFR 数值而不标方向，防止用户自行跨方向对比。

### 3.5 🐞 自反陷阱（实现时必须处理）

实测发现：`PCB defect detection × defect detection` → 专研 1769 / 提及 16557 / MFR 9x。

**这个 1769 就是主方向自身的总量** —— 角度词与主方向词重叠时，MFR 退化成主方向自身的 MFR，结论无意义，且会污染红海榜单（实测中"缺陷检测"确实挤进了红海 top3）。

**必须实现的过滤规则（已按对抗测试修正）：**

1. ❌ **错误做法**：分词取交集，交集非空即剔除。
   实测灾难：主方向 `machine learning for defect detection` 会误杀 **10 个**角度——机器学习/迁移学习/联邦学习/强化学习/自监督学习/小样本学习/主动学习/持续学习（全因 `learning` 重叠）+ 目标检测/异常检测（因 `detection`）。而含 `learning`、`detection` 这类通用词的主方向极其常见。
2. ✅ **正确做法：子集判定**。仅当「角度词集 ⊆ 主方向词集」时剔除。
   - `few-shot learning` {few,shot,learning} ⊄ 主方向 → 保留 ✓
   - `defect detection` {defect,detection} ⊆ 主方向 → 剔除 ✓
3. 补充一道停用词过滤：去掉 `learning/detection/analysis/system/network/model/method/...` 等通用词后仍被完全包含的，也算自反。
4. 修正效果实测：`machine learning for defect detection` 剔除数 10 → **1**；`PCB defect detection` 剔除数 3 → **1**（异常检测、目标检测被正确保留）。
5. 剔除后必须在界面说明原因，不要静默丢弃（否则用户以为漏了）。

### 3.6 附带洞察：通用热门技术 vs 新兴技术

跨方向对比暴露出稳定规律：

- `transformer` / `lightweight` / `domain adaptation` → 在多方向**均为低 MFR**：通用热门技术，已被系统性铺开
- `contrastive learning` / `self-supervised` / `diffusion model` / `few-shot` → 在多方向**均为高 MFR**：新兴技术，尚未铺开

> **新兴技术 × 成熟应用领域 = 系统性的空位来源。** 这是产品可以主动推荐的搜索策略。

### 3.7 🚨 方法类词汇的系统性偏差（假空位）

实测发现：`social media adolescent mental health × meta-analysis` = 专研 185 / 提及 166,352 / **899x**，排在空位榜第二。

**但这是假空位。** `meta-analysis` 是研究**方法**，几乎每篇论文正文都会提到它，其巨大分母是**背景噪声**而非领域相关性。同类高危词：`machine learning`、`systematic review`、`randomized controlled trial`、`qualitative`。

这是 MFR 的**真实缺陷**：分母假设了"被提及 = 领域相关"，而方法类词汇违反这个假设。

**缓解措施（不能消除，只能隔离）：**

1. 角度词强制带 `category`：`emerging` / `mainstream` / `task` / `method` / `deployment`
2. **`method` 类只在同类内排序**，不与技术角度混排，不进"候选空位"榜
   - ⚠️ 实现时注意：「绝对空白」榜是独立分支，**同样必须排除 method 类**。实测原实现在此泄漏，把 `randomized controlled trial`（专研0/提及86）当成了推荐给学生的空位
3. 界面对 `method` 类结果固定提示："方法类词汇的提及数含背景噪声，MFR 偏高不代表空位"

### 3.8 🚨 最严重的缺陷：分母的领域漂移（及修正）

#### 问题

`fulltext.search` 是全库全文匹配，**不限定领域**。实测 `generative AI in higher education × multimodal fusion` 得到 4968x，看似极强空位。但查分母命中的主题分布：

```
448  Artificial Intelligence in Healthcare and Education
357  Topic Modeling
257  Multimodal Machine Learning Applications
234  Emotion and Mood Recognition
141  AI in cancer detection                                ← 与教育无关
132  Generative Adversarial Networks and Image Synthesis   ← 与教育无关
```

分母里混入了大量**领域外文献**（癌症检测、图像生成），它们只是正文里恰好同时出现了那几个词。

> 这直接动摇 MFR 的根本假设——分母本应表征"**该领域内**的相关度"，实际却包含了全库噪声。

#### 修正：用主方向的 primary_topic 做领域锚

```
1. 查主方向的 top-5 主题：
   filter=title_and_abstract.search:<topic>&group_by=primary_topic.id
2. 取 topic id 作为领域锚（例 T11636|T11122|T12128|T10883|T11902）
3. 分母加过滤：
   filter=fulltext.search:<topic angle>,primary_topic.id:<锚>
```

#### 实测效果（generative AI in higher education）

| 角度 | 专研 | 原始提及 | 锚定提及 | 原 MFR | **锚定 MFR** |
|---|---|---|---|---|---|
| multimodal fusion | 2 | 9,935 | 935 | 4968x | **468x** |
| graph neural network | 5 | 22,137 | 2,131 | 4427x | 426x |
| few-shot learning | 7 | 18,938 | 2,959 | 2705x | 423x |
| STEM identity | 8 | 19,149 | 2,490 | 2394x | 311x |
| dropout prediction | 4 | 6,595 | 845 | 1649x | 211x |
| intelligent tutoring system | 219 | 16,125 | 6,088 | 74x | 28x |
| learning analytics | 712 | 78,056 | 14,225 | 110x | 20x |
| educational equity | 294 | 23,977 | 5,458 | 82x | **19x** |

**三条结论：**

1. 锚定后 MFR 普降至约 1/10，但**空位/红海的大格局保持** — 说明原指标方向正确
2. 但**红海端排序发生实质变化**：`educational equity` 从 82x（第2）变 19x（第1）— 锚定不只是缩放，确实修正了偏差
3. 锚定后数值回落到**与其他学科可比的量级**（19x~468x，接近 PCB 9x~1997x、医学 51x~601x），缓解但**未消除** 3.4 的跨学科不可比问题

**代价**：每个角度由 2 次查询变 3 次（+50% 成本）。实测 35 角度 ≈ 105 credits ≈ $0.0105，仍远低于额度上限。**值得。**

#### ⚠️ 实现陷阱：锚定失败绝不可静默回退

对抗测试发现的真实 bug（原 `scan.py:220`）：

```python
if av is not None:      # ← 锚定查询失败时, anchored 保持等于未锚定的 mention
    anchored = av
```

后果：该角度的 MFR 用**未锚定分母**计算，虚高约 10 倍，直接被排到「候选空位」榜首——**静默混用两种口径产生假空位**，且用户无从察觉。

**规则：锚定查询失败时作废该角度并显式告警，不得回退到未锚定值。** 宁可少一个角度，不可混口径。

#### 领域锚的语法已验证

- `primary_topic.id:T11636|T11122` 的 `|` 确实是 OR：单锚 2755 → 双锚 3698（实测）
- 非法 topic id 返回 **HTTP 400**，不会静默给出错误结果（实测）

#### 附带实测：分母只覆盖 15–36% 的文献

`has_fulltext:true` 的占比（PCB defect detection）：2012年 4% → 2020 33% → 2022 **36%**（峰值）→ 2025 **19%**；材料方向同样在 15–25% 区间。

两条推论：

1. MFR 的分母是**有偏子样本**计数，不是真实"提及率"，故 MFR 绝对值无直接语义，只能相对比较（再次印证 3.4）
2. ✅ **但"新论文全文更全→新兴角度分母虚高→MFR 虚高"这个攻击不成立** —— 覆盖率并非随年份单调上升，最新的 2025 反而最低（19%），因为新论文的全文尚未被索引

残留风险：若某角度的论文集中在无全文索引的期刊/会议，分母会被系统性低估 → MFR 偏低 → 误判为红海。

#### ⚠️ 锚定的代价：区分度被压缩

同一方向（PCB defect detection）锚定前后的方向内跨度：

| 口径 | MFR 区间 | 区分跨度 |
|---|---|---|
| 未锚定 | 9x ~ 1997x | **229 倍** |
| 锚定 | 6x ~ 90x | **14 倍** |

锚定在修正漂移的同时**显著削弱了区分能力**（229 → 14 倍）。这是真实的 trade-off，不是纯粹的改进：

- 保留锚定：结论更可信，但角度之间的差异变小，排序对噪声更敏感
- 取舍建议：**以锚定值作判断依据，同时展示未锚定值供对照**；两者排序差异大的角度需人工复核（这类角度往往正是领域漂移最严重的）
- `scan.py` 已同时输出 `mfr`（锚定）与 `mfr_raw`（未锚定）

### 3.9 🐞 低计数时 MFR 不稳定

实测（gut microbiome depression）：

| 角度 | 专研 | 锚定提及 | MFR | 问题 |
|---|---|---|---|---|
| 机器学习 | 70 | 1,472 | 21x | 样本足，可信 |
| 小样本学习 | **1** | 31 | 31x | **1 篇论文决定一切** |
| 多模态融合 | **3** | 73 | 24x | 同样脆弱 |

专研 = 1 时，MFR 完全由那一篇论文决定；再收录一篇就会让 MFR 腰斩。把它和专研 70 篇的角度放在同一尺度排序是错的。

**实现规则：**

1. `focus_count < 5` 的角度标注 **低置信**，不进"红海"榜（红海判断需要足够样本量才成立）
2. 低置信角度仍可进"候选空位"榜（本来就是找少的），但必须显示 `专研 N 篇` 原始值，让用户自己看清样本量
3. 报告里对低置信项固定附一句："该角度文献量过少（N 篇），MFR 波动大，仅作线索"

### 3.10 本科生的最优区不是绝对空白（受众定位关键）

`bearing fault diagnosis × self-supervised` = 专研 162 篇，MFR 73x。绝对数不小，但相对该方向 17,848 的体量是空位。

对本科生而言这**优于** 0 篇的荒地：

| 区域 | 特征 | 对本科生 |
|---|---|---|
| 绝对空白（0 篇） | 无 baseline、无人指路、可能是死路 | ⚠️ 危险 |
| **相对空位（高 MFR，几十~几百篇）** | 有足够参考文献，但未被做透 | ✅ **最优区** |
| 红海（低 MFR） | 卷、难出增量 | ❌ 避开 |

这条直接把受众从 grad/PI 区分开来——`scientific-problem-selection` 全文无一处涉及本科生的一学期 / 无 GPU / 无标注数据这类可枚举约束。

---

## 4. 设计铁律（四条，违反即失去可信度）

### 铁律 1：不做加权总分

> `Severity is not vote count … headline severity is the maximum level present, not the average and not the sum`
> — `ai4s-skills/skills/integrity-auditor/references/04-evidence-grading.md`

**总体级别 = 各维度中的最高风险级别**，不是平均、不是加权求和。理由：12 个小瑕疵 ≠ 1 个致命问题。

⚠️ **避坑**：`openscience/backend/cli/skills/scholar-evaluation/scripts/calculate_scores.py` 已经是一个加权维度打分器（`DEFAULT_WEIGHTS` + `QUALITY_LEVELS` 分档）。若本作品做成"多维加权求和 + 分档"，会被直接认定为 ScholarEval 换了打分对象。

### 铁律 2：证据准入门槛

> `A finding without source-artefact pointer … is not reviewable. Reject it from the report.`
> — 同上

**没有查询串 + 命中数 + 抓取时间戳的结论，不准进报告。** 宁可少一条，不要一条不可复核的。

### 铁律 3：三级标注，默认降级

每个数字必须归入且仅归入三级之一（改造自 `paper-writer/references/06-experiment-provenance.md` 的 measured/simulated/illustrative）：

| 标注 | 含义 | 必须携带 |
|---|---|---|
| 🔵 **实测** | OpenAlex 返回 | 查询串原文 + 命中数 + `fetched_at` |
| 🟡 **推断** | 模型基于实测数据推理 | 它依据的实测条目 id 列表 |
| ⚪ **未核实** | 模型先验知识，无数据支撑 | 显式标注"未核实" |

**默认降级规则**：分不清一个数字哪来的，一律按更低可信度处理并如实披露。

**披露落在条目级**（每个 finding 旁边），不是只在页脚放一句总免责。

### 铁律 4：取证据诚实支持的最低级别

> `Use the lowest level that the evidence honestly supports`

宁可低估风险等级，不可为了效果拔高。

---

## 5. 风险级别与否决

| 级别 | 判据 | 动作 |
|---|---|---|
| **L1** 值得注意 | 轻微不利，可绕开 | 记录 |
| **L2** 明确不利 | 有实测数据支撑的负面信号 | 提示改造方案 |
| **L3** 严重风险 | 需补充信息才能判断 | 明确告知"要补什么才能下结论" |
| **L4** 否决级 | **硬条件直接不满足** | **输出 no-go + 理由 + 替代方向** |

L4 是三个标杆都不敢做的动作。触发 L4 的必须是**可枚举的硬条件冲突**，例如：

- 方向刚性依赖大规模标注数据，而用户勾选"无数据集且无标注人力"
- 方向刚性依赖多卡训练，而用户勾选"仅笔记本 CPU"
- 方向的最小实验周期（实测文献中位周期推断）> 用户可投入周期

⚠️ L4 只允许陈述**条件冲突**，不允许对研究价值本身下判决。措辞禁用"这个方向没价值/没前途"，只能写"以你当前条件不可完成"。

---

## 6. 交互流程（四段）

### S0 结构化澄清

照抄 DeepTutor 的硬约束（`deeptutor/tools/ask_user.py` + `hints/en/ask_user.yaml`）：

- **最多 4 个问题**（`MAX_QUESTIONS=4`）
- **每问最多 8 个选项**（`MAX_OPTIONS=8`）
- 选项是 `{label, description}` 对：label 1–5 词，**description 说明"选它意味着什么"**
- 每条消息**最多一个** ask_user
- 推荐项排首位并标 `(Recommended)`
- **禁止模型自造 "Other"**
- **不得把 ask_user 当作回合结束**；禁止用它问"要继续吗？"

问什么（4 问，全部可枚举）：

1. 研究方向（自由输入 or 从预置方向选）
2. 算力：无 GPU / 单卡消费级 / 实验室多卡 / 云上按需
3. 数据：已有标注数据 / 有原始数据无标注 / 只能用公开数据集 / 无数据且无采集条件
4. 周期与目标：一学期毕设 / 一年 / 竞赛 3 个月；要不要发论文

### S1 复述确认 + 报价（结构可回传）

两件事同屏：

**a) 复述确认。** 把理解复述成结构体让用户**改写**，不是点确认。
> 关键不是"看一眼点确认"，是结构本身可回传 —— `deeptutor/api/routers/book.py` 的 `confirm-proposal` / `confirm-spine` 都接收 `edited_proposal`。

**b) 报价。** 借鉴 `deeptutor/book/estimate.py`：
> `The reader deserves to know roughly what they are approving before they approve it`

显示"将执行 N 次查询 / 预计 X 秒 / 消耗 $Y"。
实现要点：后端只返回**单位成本**，前端本地累加 —— 用户增删角度时估算实时更新而**不发请求**。

### S2 增量扫描

三条 invariant（`ai4s-skills/skills/literature-survey/references/00-incremental-execution.md`）：

1. **立刻落盘** —— 每查完一个角度就写存储
2. **进度靠存储可见，不靠内存**（`Progress is observable via filesystem, not memory`）
3. **每批小到能成功，原子到能重试**

界面表现：逐格点亮的热力表，中断可续，刷新不丢。

### S3 体检报告

- findings 数组，一行一条，每条带级别 + 证据指针
- 总体级别 = 最高级
- 结尾固定携带："没有发现不等于没有风险"

---

## 7. 数据结构（平台无关）

```jsonc
// 一次原子查询 —— 唯一的实测事实来源
scan_query {
  id, topic, angle,
  mode: "title_and_abstract" | "fulltext" | "fulltext_anchored",
  anchor_topic_ids,   // mode=fulltext_anchored 时的领域锚
  count, by_year: {年: 数},
  query_url,          // 完整可重跑 URL（证据核心）
  fetched_at          // UTC 时间戳
}

// 角度得分（由两条 scan_query 计算，纯派生，不存模型意见）
angle_score {
  topic, angle,
  focus_count,        // 专研（分子）
  mention_count,      // 原始提及
  mention_anchored,   // 锚定提及（分母，主用）
  mfr,                // = mention_anchored/focus，focus=0 时 null
  mfr_raw,            // 未锚定版，仅供对比
  is_absolute_gap,    // focus==0 && mention_anchored>阈值
  percentile_in_topic // 方向内分位（严禁跨方向硬编码阈值）
}

// 一条结论
finding {
  id, level: "L1"|"L2"|"L3"|"L4",
  dimension,          // crowding | timing | feasibility | resource | novelty_gap
  statement,
  provenance: "measured" | "inferred" | "unverified",
  evidence_refs: [scan_query.id],   // provenance=measured 时非空，否则拒收
  what_would_raise_confidence       // "要补什么才能提高置信度"
}

// 报告
report {
  id, topic, conditions {算力,数据,周期,目标},
  angle_scores[], findings[],
  overall_level,      // = max(findings.level)，非加权
  verdict: "go" | "conditional" | "no-go",
  disclaimer
}

// 角度词典（唯一需要预先准备的资产）
angle_dict { discipline, angle_en, angle_zh, category, aliases[] }
```

---

## 8. 角度来源：模型生成 + 数据验证（学科无限制）

### 为什么不能靠手工词典

手维护每个学科的角度词典不可持续，也把产品锁死在单一学科。

### 自动发现路线已验证为不可行 ❌

实测 `group_by=topics.id` / `keywords.id` / `concepts.id`（perovskite solar cell stability），返回的是：

```
Materials science 24846 / Perovskite (structure) 22673 / Optoelectronics 18796 / Chemistry 14757
```

这些是**领域分类标签**（"它属于哪个领域"），而不是**技术角度**（"可以从哪些角度切入"）。无法直接用作角度集。

### ✅ 正确分工：模型生成候选，数据判定拥挤

```
模型：给定主方向 → 列出 20~30 个候选角度（带 category 与英文检索词）   → ⬜ 未核实
数据：逐个算 MFR + 方向内分位                                    → 🔵 实测
模型：解释高 MFR 项是真空位还是无意义组合（必须引用实测条目）   → 🟡 推断
```

这个分工有两个额外好处：

1. **学科无限制** — 任何学科模型都能生成候选角度，不需预先维护
2. **数据层天然过滤模型幻觉** — 模型编的不存在的术语，会得到 `专研0 / 提及0`，被 3.2 的规则自动判为"无意义组合"剔除。幻觉不会进报告

### 词典的新定位：种子 + 先验标注

`data/angle_dict.csv` 不再是唯一来源，而是：

- 模型生成失效时的兵底
- 携带实测得出的先验标注（哪些词在多方向稳定为红海/空位）
- `category` 字段的权威来源（用于 3.7 的 `method` 类隔离）

---

## 9. 数据与模型的职责边界（不许越界）

这是保证"分数可复核"的结构性前提：

| 环节 | 谁做 | 输出标注 |
|---|---|---|
| 拥挤度、MFR、趋势、分位 | **纯数据计算**，模型不参与 | 🔵 实测 |
| 高 MFR 角度是真空位还是无意义组合 | **模型判断**，必须引用实测条目 | 🟡 推断 |
| 条件冲突检测（L4 触发） | **规则判定**，可枚举 | 🔵 实测 + 规则 |
| 研究背景、技术路线建议 | 模型生成 | ⚪ 未核实 |

> 一句话：**数据负责"有多少"，模型负责"这意味着什么"，规则负责"你能不能做"。** 三者产物永不混标。

---

## 10. 工程约束（实测得出）

### 额度

OpenAlex 按 IP 信用额度制（响应头 `X-RateLimit-*`）：

- `X-RateLimit-Limit: 1000` credits / `X-RateLimit-Limit-USD: 0.1`
- ⚠️ 重置是**固定时间点**而非滚动窗口：`X-RateLimit-Reset` 两次观测为 43516s 与 82778s（该值是"距下次重置的剩余秒数"），故最坏情况下可用窗口不足一天，排演示/评审时段要留余量
- ⚠️ `mailto` 参数**不提升**额度（实测 remaining 继续递减）

### 关键优化：一律用 `group_by` 查询（省 10 倍）

| 查询方式 | credits | cost_usd |
|---|---|---|
| `per-page=1`（行查询） | 10 | 0.001 |
| `select=id&per-page=1` | 10 | 0.001（**select 不省钱**） |
| **`group_by=publication_year`** | **1** | **0.0001** |

单 IP 每 12 小时：用 group_by 可跑 **1000 次**，用行查询仅 **100 次**。

而且 `group_by=publication_year` 一次同时拿到 `meta.count` 与分年趋势 —— **省钱和拿趋势图是同一个动作**，不是妥协。

**行查询只在用户点开某一格要看代表论文时才发。**

### 其他

- `Access-Control-Allow-Origin: *` —— 浏览器可直连，无需服务端代理。**好处**：每个访客用自己 IP 的额度，天然分摊，多人同时访问不互相挤
- 缓存：`(topic, angle, mode)` → 查询结果，带 `fetched_at`；同组合不重复查
- 兜底：预采种子方向数据，限流时展示缓存并**明确标注数据时间**

---

## 11. 边界与局限（必须写进产品界面，不是藏在文档里）

照抄范本句式（`research-explorer/SKILL.md` Important rules）：

- **候选空位是提示，不是新颖性保证** —— 使用者必须在投入前自行核实原创性
- 🚨 **红海判定同样可能出错，且代价更大**。空位判错只是浪费一次查证；红海判错会**劝退一个真金矿**。凡输出"这个角度已很卷"，必须同时提示："本判定基于 OpenAlex 英文文献计数，若你有导师认可的切入点，不应因本工具的红海判定而放弃。"
- **不得称"领域内分位"**。分位数是相对**当前词典**算的，往词典加 20 个红海词，所有角度的分位都会变。正确措辞是"在本次扫描的 N 个角度中排第 k"。
- **可行性判断是启发式的** —— 相关处显式标注不确定性
- **本工具核查的是可复核性，不是正确性**（改自 `traceability-review`："You verify traceability … not truth"）
- **没有发现不等于没有风险**

诚实列出已知局限：

1. 只覆盖 OpenAlex 收录的**英文文献**；中文期刊、专利、未收录会议不在计数内
2. **同义词不对称是真实缺陷（分子受损更重）**。实测 `PCB defect detection` 的分子：`few-shot`=18、`low-shot`=7、`one-shot`=4、`meta-learning`=6 —— 别名分散使分子被低估约 2 倍，而分母基数大（1560）受同等影响的相对幅度小，**净效应是 MFR 虚高 → 制造假空位**。
   - 好消息：OpenAlex 忽略连字符（`few-shot` 与 `few shot` 返回完全相同的 18/1560），消除了一部分风险
   - ⚠️ **词典的 `aliases` 列目前尚未被 `scan.py` 使用**，这是已知实现缺口；正式实现必须对分子做别名合并（去重后取并集）
3. `fulltext.search` 覆盖率依赖 OpenAlex 的全文索引比例，不同年份不均匀
4. **MFR 是相对指标，跨方向与跨学科均不可直接比较**（见 3.4：社科红海 168x > 材料空位 69x）
5. **方法类词汇会产生假空位**（见 3.7：`meta-analysis` 在社科报 899x），已用 `category` 隔离但未根除
6. 高 MFR 只说明"被提及多但被专研少"，**不能证明该方向有研究价值** — 可能已被证伪或不可行
7. **领域锚只能缓解、不能消除分母漂移**（见 3.8）；锚本身依赖 OpenAlex 主题分类质量，跨学科交叉方向可能被锚错
8. **低计数时 MFR 不稳定**（见 3.9：专研 1 篇的角度，MFR 由单篇论文决定）
9. 概念验证阶段，专家在环不可替代（`AI-generated research artefacts can be confidently wrong; an expert in the loop is non-negotiable`）

---

## 12. 实施路线

### 阶段 1：最小闭环（核心价值全部在此）

必须做完的五件事：

1. 角度词典（见 `data/angle_dict.csv`：366 个角度 / 27 个学科分组 + 通用层）
2. 领域锚获取（`group_by=primary_topic.id` 取 top-5）
3. 三口径扫描 + **锚定 MFR** 计算 + 方向内分位排序
4. 三条过滤规则：自反剔除、`method` 类隔离、无意义组合过滤
5. 热力表可视化（可点开看查询串）+ findings 三级标注 + 最高级别制

> 这五件做完，产品已能独立成立。以下都是增强。

### 阶段 2：增强

5. S0 结构化澄清（4 问）+ L4 条件冲突规则
6. 趋势图（`by_year` 已在阶段 1 顺带取得，零额外成本）
7. 缓存层 + 报价
8. 代表论文点开（行查询，按需）

### 阶段 3：可选

9. 12 周可行性排期建议
10. 多方向对比
11. 报告导出

---

## 13. 待验证项（诚实标注）

| 项 | 状态 |
|---|---|
| MFR 跨方向普适性 | ✅ 六方向已验 |
| MFR 跨学科普适性（工/医/社科/材料） | ✅ 四学科已验 |
| 高 MFR 角度经人工审阅的真空位命中率 | ❌ 未测（**最该补**：抽 10 个高 MFR 角度人工核实） |
| 模型生成角度的可用率与幻觉率 | ❌ 未测（第 8 章新路线） |
| `method` 类隔离后是否仍有假空位漏网 | ❌ 未测 |
| `fulltext.search` 索引覆盖率的年份偏差 | ❌ 未测 |
| DeepTutor arXiv:2604.26962 正文 Limitations | ❌ 只核到 README 与源码 |

---

## 14. 对抗审查结论（v2 → v3 的修正）

一次独立对抗审查（只读子代理，无写权限）对 v2 给出 **verdict: fail**。以下逐条为**已复核证实**，不是转述。

### 14.1 致命缺陷：旗舰输出 7/7 全假

v2 在 PCB defect detection 方向的「绝对空白·金矿」榜，实际产出 7 项，**全部是荒谬组合**：

| 被判金矿 | 锚定提及 | 实质 |
|---|---|---|
| semantic communication | 154 | 语义通信 × PCB缺陷检测 |
| integrated sensing and communication | 139 | 通感一体化 × PCB |
| randomized controlled trial | 86 | 随机对照试验 × PCB |
| wireless power transfer | 81 | 无线电能传输 × PCB |
| radar signal processing | 67 | 雷达信号处理 × PCB |
| UAV communication | 45 | 无人机通信 × PCB |
| causal inference | 25 | 因果推断 × PCB |

产品会告诉本科生"语义通信×PCB缺陷检测是绝对空白，相关性已被 154 篇文献背书"。这不是边缘错误，是旗舰功能整体失效。

### 14.2 病因：token-AND 散射，不是 category 问题

`category=method` 隔离（3.7）抓错了病因。真正的自变量是**角度词元在正文中的通用程度**：无引号检索使 `in-memory computing` 退化为「正文含 memory ∧ computing」，几乎每篇深度学习论文都满足。`category` 只是它的弱代理。

### 14.3 分母根本不是「域内提及」

决定性反证：PCB 方向全域 1774 篇，而 `machine learning` 的 v2 锚定提及 **1192 = 全域的 67%**；教育方向全域 9388，`learning analytics` 锚定提及 **14225 = 全域的 1.5 倍**。

> 若分母真是"该领域内提及该概念的论文"，它不可能系统性超过领域论文总数。

### 14.4 领域锚注入了新偏差

PCB 的 5 个锚的域内份额实测：72.0% / **6.2%** / 2.0% / 1.1% / 0.8%。第二锚 `Advanced Neural Network Applications` 域内仅 6.2%，却是 OpenAlex 的通用超大主题——它把整个深度学习文献重新请回分母，正是 `graph neural network` 锚定 376、`in-memory computing` 锚定 451 的来源。

### 14.5 修正：双短语 AND

两侧检索式都改为 `"<主方向>" "<角度>"`（各自加引号）。实测效果：

| 角度 | v2 分母 | v3 分母 | 结果 |
|---|---|---|---|
| semantic communication | 154 | **2** | 假空位消灭 |
| in-memory computing | 451 | **0** | 假空位消灭 |
| wireless power transfer | 81 | **1** | 假空位消灭 |
| UAV communication | 45 | **0** | 假空位消灭 |
| few-shot | 361 | 98 | 真实角度保留 |
| lightweight | 822 | 564 | 仍判红海 ✓ |

PCB 方向 **22 个无意义组合被自动剔除**（含全部 7 个假金矿），绝对空白榜变为 5 项全合法（类别不平衡/数字孪生/主动学习/图神经网络）。

顺带发现：主方向不加引号时自身计数虚高 **2.5 倍**（1774 → 711）。

### 14.6 领域锚被证明冗余（三个补丁塌缩为一个修正）

双短语口径下加锚 vs 不加锚，实测排序**完全不变**，分母仅缩 20–40%：

| 角度 | 无锚 | 有锚 |
|---|---|---|
| lightweight | 3.2x | 2.8x |
| transformer | 5.6x | 5.1x |
| few-shot | 10.9x | 8.7x |
| class imbalance | 26.2x | 20.0x |

故 **锚默认关闭**（省 1/3 成本），并同时消除 14.4 的全部问题。`method` 隔离的负担也从拦 5+ 个词降到 1 个。

### 14.7 🚨 最诚实的结论：原区分度大部分来自噪声

去噪后的方向内区分跨度：

| 方向 | 双短语后域量 | v1/v2 跨度 | **v3 跨度** |
|---|---|---|---|
| PCB defect detection | 711 | 229 倍 | **2 倍**（11x~17x） |
| bearing fault diagnosis | 大 | 7 倍 | **8 倍**（9x~79x） |

必须承认：**v1 那个 229 倍的漂亮区分度，主要是 token-AND 噪声制造的**。

由此产生两条方案级调整：

1. **产品价值从「MFR 数值排序」转向「三分类」。** 分类是稳健的，排序不是。对 44 个角度，真正有用的输出是：
   - 已被系统研究（专研≥5，MFR 可比）→ 红海，避开
   - 有文献背书的空白（专研0 但提及≥域量1%）→ 值得看
   - 无意义组合（专研0 且提及不足）→ 直接排除，**这一类占比最大（PCB 22/44）且判定最可靠**
2. **方向体量下限**：双短语后域量过小（如 <1000 篇）时，多数角度落入低置信，MFR 失去区分力。此时只能给分类，不能给排序。

### 14.8 已修复的实现缺陷

| 缺陷 | 修法 |
|---|---|
| 自反剔除误杀（交集非空即剔）10 个角度 | 改子集判定 + 停用词，误杀降至 1 个 |
| 锚定失败静默回退未锚定值（MFR 虚高 10 倍） | 作废该角度并显式告警，不混口径 |
| 查询失败静默截断，残缺结果与全量不可区分 | 加 3 次退避重试；报告与 JSON 均带 `failed_angles` / `is_complete` |
| `method` 类从「绝对空白」榜泄漏 | 该分支同样过滤 `NO_GAP_CATEGORIES` |
| 绝对空白阈值硬编码 20/50（违反自家一号约束） | 改相对阈值 `max(10, 域量×1%)` |
| 红海行不打印 `tag`，警示在最需要时丢失 | 补打 `tag` |
| 中文主方向 tokenize 失效且无提示 | 加中文检测告警 |

### 14.9 仍未解决（不得对外声称已解决）

1. **构念效度未验证**：高 MFR 是否真等于"值得做的空位"，仍缺人工标注 ground truth。§13 的第一条待验证项仍然是第一优先。
2. 已证伪 / 顺带引用 / 统计巧合三类假空位，v3 只削弱不消除，机制层仍无区分手段。
3. `aliases` 列仍未被使用，分子仍被别名分散低估（3.11）。
4. 分位数是「相对词典」而非「相对领域」：往词典加 20 个红海词，所有角度分位都会变。界面不得称其为"领域内分位"。
5. L4 否决与 MFR 无关（见 §5），核心指标撑起的最高级别只到 L2/L3——**"敢否决"这个卖点由条件检查表提供，不是 MFR 提供**。对外表述必须区分"条件否决"与"价值否决"。
6. 免责单侧：§11 六条 caveat 全在空位侧，**缺"红海判定可能误伤真金矿"**。误伤代价更大（劝退），必须补。

---

## 15. 使用中暴露的三个缺陷（v3.1）

用户实际点开「证据」链接后发现的问题，全部已复核并修复。

### 15.1 🚨 证据只给计数，等于半残的可复核

原设计的证据链接指向 `group_by=publication_year`，**打开只有一堆年份计数，看不到任何论文**。

后果：数字能复现，但**无法判断这些论文是否真的相关**——而这恰恰是判断空位真假的关键。

实测证明这个缺陷有多要紧。`fulltext.search:"PCB defect detection" "graph neural network"` = 21 篇，只看数字会以为很干净；打开论文列表才发现：

```
✓ Few-Shot PCB Surface Defect Detection Based on Feature Enhancement   [Industrial Vision Systems]
✓ Pcb Defect Detection in Manufacturing Using Deep Learning            [Industrial Vision Systems]
✗ Multi-attention fusion transformer for single-image super-resolution [Advanced Image Processing] ← 无关
~ Semantic information processing for interoperability in Industry     [Anomaly Detection]        ← 弱
```

**约 10~15% 是噪声**，只看计数永远发现不了。

**修法**：每格给两个链接。
- **论文↗** → 行查询 `per-page=25&select=id,display_name,publication_year,doi,primary_topic,cited_by_count`
  （10 credit，但引擎**不主动请求**，只生成 URL；用户点了才消耗他自己 IP 的额度）
- **计数** → 原 `group_by` 链接（1 credit），用于精确复现数字

`select` 里的 `primary_topic` 是关键：它让噪声一眼可见（上例中 `Advanced Image Processing` 明显不属于 PCB 领域）。

### 15.2 🚨 术语校验只有下限，没有上限

原校验只拦「太窄」（<100 篇视为拼凑短语），**完全没拦「太宽」**。于是 `harness`（283,525 篇）畅通无阻——但它是个常用动词（"harness the power of…"），不是研究方向。

**修法：主题集中度**（top1 `primary_topic` 占该方向文献的比例）。实测判据极其干净：

| 输入 | 篇数 | top1 主题占比 | 判定 |
|---|---|---|---|
| `perovskite solar cell` | 47,078 | **90.4%** | ✅ 真实方向 |
| `PCB defect detection` | 711 | **80.2%** | ✅ |
| `bearing fault diagnosis` | 8,309 | 73.3% | ✅ |
| `cyberbullying` | 23,536 | **36.6%** | ✅ 真实方向下界 |
| `cable harness` | 622 | 11.6% | ⚠️ 通过但警告 |
| `wiring harness` | 1,430 | 6.0% | ⚠️ 通过但警告 |
| **`framework`** | 7,426,671 | **0.9%** | ❌ 通用词 |
| **`harness`** | 283,525 | **0.7%** | ❌ 通用词 |
| **`novel`** | 7,710,635 | 0.3% | ❌ |
| **`approach`** | 19,188,248 | 0.3% | ❌ |

真实方向 ≥36%，通用词 ≤0.9%，中间是 5%~12% 的跨领域词（线束确实横跨 EMC/机器人/汽车）。
故设 **<5% 拒绝、<20% 警告**，安全区间很宽。

> 注意这个判据**比绝对数量上限更好**：`perovskite solar cell` 有 47,078 篇却是极正当的方向（90.4%），
> 单纯按数量设上限会把它误杀。

### 15.3 引号内的词仍会被词干化

OpenAlex 返回的 `x_query.oql` 显示 `works where title/abstract has (stemmed "harness")`。实测：

```
"harness"     -> 283,525
"harnessing"  -> 283,525     ← 完全相同
"harnessed"   -> 283,525     ← 完全相同
```

**引号只锁短语顺序，不阻止词干化。** 这对本方案是**有利的**（角度词的单复数、动名词形式自动合并，减轻了 3.11 的别名问题），但必须知道它存在：不要指望用引号做精确形态匹配。

---

## 附：可复现验证

```bash
python probe/scan.py "PCB defect detection" --top 5   # 单方向双口径扫描
python probe/scan.py "bearing fault diagnosis"        # 换方向复测
```

实测运行结果（35 角度 / 69 次查询 / **$0.0070**）：完整证据含每条查询串落盘至 `out/<topic>.json`。

最强演示素材（PCB 方向，均为实测）：

| 角度 | 专研 | 提及 | 判读 |
|---|---|---|---|
| 测试时自适应 test-time adaptation | **0** | **3,060** | 绝对空白，相关性已被 3060 篇背书 |
| 神经架构搜索 neural architecture search | 0 | 1,408 | 绝对空白 |
| 图神经网络 graph neural network | 1 | 1,997 | MFR 1997x |
| 轻量化 lightweight | 311 | 2,707 | MFR 9x → 红海 |
