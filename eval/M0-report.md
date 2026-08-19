# M0 地基验证报告

> 执行日期：2026-08-19 · 口径：v3 双短语 AND · 数据：`out/*.json`（含每条查询串与 UTC 时间戳）
> 结论先说：**C 组严格命中率 37%，落在「继续但需强化」区间**。产品形态必须调整，见 §5。

---

## 1. 样本

| 方向 | 学科 | 双短语域量 | 角度数 | A/B/C/D |
|---|---|---|---|---|
| PCB defect detection | 电子信息 | 711 | 44 | 5/12/5/22 |
| bearing fault diagnosis | 机械 | 8,309 | 34 | 20/8/3/6 |
| problematic social media use | 社科 | 1,429 | 37 | 10/5/14/8 |
| ~~social media adolescent mental health~~ | 社科 | **9** | 37 | 0/3/5/29 ← **无效样本，见 §3** |

---

## 2. C 组人工标注（核心指标）

判据：该角度与主方向的组合是否构成一个**本科生可着手的真实研究方向**。
排除 `category=method` 项后统计。

### PCB defect detection —— 4/4（100%）

| 角度 | 提及 | 判定 | 理由 |
|---|---|---|---|
| imbalanced data | 37 | ✅ 真空位 | 缺陷样本天然稀少，类别不平衡是该领域核心痛点 |
| digital twin | 33 | ✅ 真空位 | 产线数字孪生 + 质检是真实工业方向 |
| active learning | 31 | ✅ 真空位 | PCB 缺陷标注昂贵，主动选样是教科书级合理组合 |
| graph neural network | 21 | ✅ 真空位 | PCB 是电路拓扑，天然图结构，理据强 |

### bearing fault diagnosis —— 1/2（50%）

| 角度 | 提及 | 判定 | 理由 |
|---|---|---|---|
| additive manufacturing | 295 | ⚠️ 弱相关 | 增材制造是生产工艺，与故障诊断关系间接 |
| precision machining | 120 | ⚠️ 弱相关 | 同上 |
| ~~meta-analysis~~ | 184 | — | method 类泄漏，见 §4 缺陷 2 |

（严格判定 0/2，宽松判定 2/2；此处按"至少一项可勉强立项"记 1/2）

### problematic social media use —— 2/13（15%）

| 角度 | 提及 | 判定 | 理由 |
|---|---|---|---|
| polarization | 197 | ✅ 真空位 | 社交媒体极化与问题性使用的交叉是真实方向 |
| algorithmic bias | 65 | ✅ 真空位 | 推荐算法如何加剧成瘾，理据强 |
| migration | 278 | ⚠️ 弱 | 移民群体的媒介使用真实，但角度过宽泛 |
| collective action / public trust / aging society / generative model | 77/75/32/15 | ⚠️ 弱 | 交叉薄弱 |
| **active learning** | 134 | ❌ 无关 | 机器学习术语误入社科；且在教育学另有"主动学习法"含义，歧义 |
| **transfer learning / digital twin / graph neural network** | 25/18/16 | ❌ 无关 | 通用层的 ML 角度被错套到社科方向 |
| urbanization / social mobility | 106/41 | ❌ 无关 | — |
| ~~ethnography~~ | 331 | — | method 类泄漏 |

### 汇总

```
严格命中率 = (4 + 1 + 2) / (4 + 2 + 13) = 7/19 = 37%
```

对照 `BUILD.md` M0 验收门槛：**30%~50% 区间 → 继续，但须强化**。

---

## 3. 🚨 最重要的发现：v3 有一个未写明的前置条件

主方向**必须是真实存在的术语短语**，不能是多概念拼接。加引号后的域量实测：

| 主方向 | 加引号 | 无引号 | 性质 |
|---|---|---|---|
| `perovskite solar cell` | 47,078 | — | ✅ 真实术语 |
| `cyberbullying` | 23,536 | — | ✅ |
| `gut brain axis` | 15,263 | — | ✅ |
| `bearing fault diagnosis` | 8,309 | 17,868 | ✅ |
| `problematic social media use` | 1,429 | — | ✅ |
| `PCB defect detection` | 711 | 1,774 | ✅ |
| **`social media adolescent mental health`** | **9** | 5,506 | ❌ 拼凑 |
| **`gut microbiome depression`** | **8** | 2,417 | ❌ 拼凑 |
| `social media teenager depression anxiety` | **0** | — | ❌ 拼凑 |

两条推论：

1. **拼凑短语会让 v3 整体归零**。`social media adolescent mental health` 的 37 个角度里 29 个落入 D 组、A 组为空——不是社科不适用，是主方向不是真实术语。
2. **v1/v2 无引号口径掩盖了这个问题**。`gut microbiome depression` 在 v2 下报 2,417 篇，看着完全正常；v3 加引号后暴露真身只有 8 篇。**此前基于该方向的所有 v2 结论都不可信。**

### → 必须新增的产品功能：主方向术语性校验

```
域量 ≥ 500        → 可用
100 ≤ 域量 < 500  → 可用但警告样本偏少，只给分类不给对比
域量 < 100        → 拒绝执行，提示"这不是一个规范的领域术语"
                    并给出改进路径：逐步截短测试子短语，或让 LLM 生成该领域规范术语候选后逐个测域量
```

实测该功能可行：`social media adolescent mental health`(9) → `social media mental health`(133) → `adolescent mental health`(16,691)，截短即可找到可用表述。

---

## 4. 新发现的两个缺陷

| # | 缺陷 | 证据 | 修法 |
|---|---|---|---|
| 1 | **通用层不应无条件并入** | 社科方向 C 组的 6 个"无关"项全部来自通用层的 ML 角度（active learning / transfer learning / digital twin / GNN / generative model）。它们提及数不低（15–134），因跨学科文献常提及，于是伪装成空位 | 通用层按学科白名单并入；社科/人文默认不并入 ML 技术角度。或改由 LLM 按学科生成（`BUILD.md` M3） |
| 2 | **`is_absolute_gap` 计算时未排除 method 类** | 只在打印层过滤了，JSON 里仍为 `true`。bearing 的 `meta-analysis`、社科的 `ethnography` 都这么漏出来 | 在**计算时**排除，不要只在展示层拦 |

另需注意：A 组按 MFR 降序时，社科方向榜首被方法词全面占据——mixed methods 126x、RCT 110x、meta-analysis 92x、systematic review 67x、longitudinal study 48x。**再次印证 MFR 排序不可用**（`PLAN.md` §14.7）。

---

## 5. 裁决与方案调整

**裁决：继续，但产品形态按下列三条调整（不是可选项）。**

| # | 调整 | 依据 |
|---|---|---|
| 1 | **LLM 对 C 组的二次筛从「可选」升为「必须」** | 严格命中率仅 37%，直接展示 C 组会向学生推荐大量无关组合 |
| 2 | **C 组措辞降级**：不叫"候选空位/金矿"，叫**"待核实线索"**；界面强制显示"需你自己判断这个组合是否讲得通" | 同上 |
| 3 | **新增主方向术语性校验，作为流程第一道闸** | §3，这是 v3 的前置条件，缺了会整体归零 |

**D 组仍是最可靠的输出**，且价值不减：PCB 22/44、bearing 6/34、社科 8/37 被自动排除，含全部假金矿。产品叙事的重心应放在这里——**"先帮你划掉不用看的"**，而不是"帮你找到金矿"。

---

## 6. 仍未做（诚实标注）

- 只标注了 3 个有效方向、19 个 C 组项，样本仍小；医学/材料/计算机学科未用 v3 口径实测（额度受限，`X-RateLimit-Remaining` 剩 ~215）
- 标注由单人（AI 助手）完成，非领域专家，无双人一致性检验
- "弱相关"与"无关"的边界带主观性，严格/宽松命中率相差较大（37% vs 74%）
- `aliases` 别名合并仍未实现，分子仍被低估（`PLAN.md` 3.11）
