# 任务续接三组对照：标注 Agent 交接单

这份交接单用于给 Mnemora v1.32 的真实任务续接对照实验标注结果。你的交付物是**经核对的标注数据**，不是效果结论。评估程序只汇总你提供的记录，不运行模型，也不核实标注是否真实。字段定义和入口见 [任务续接评估说明](task-resume-evaluation.md)。

## 先确认输入

向委托方取得以下已授权、已去标识化的材料。缺一项就列出缺口，等待补齐，不填写猜测值。

1. 实验计划：固定的 `modelId`、`historySetId`、`taskSetId`、`tokenBudget`、`latencyBudgetMs`，以及互不重叠的 tuning/test 案例 ID。可从 [`fixtures/task-resume-comparison-plan-v1.json`](../fixtures/task-resume-comparison-plan-v1.json) 复制结构，但其中的 `synthetic-*` 名称和案例 ID 只是示例，不能充当真实实验。
2. 每个案例的历史、续接点与可核对的当前状态：已完成动作、失败尝试、阻塞、约束、下一步，以及更正、替代、过期、拒绝或遗忘的来源记录。
3. 同一案例在三组条件下的实际模型输出，以及模型看到的提示和所附记忆：`no_long_term_memory`、`simple_retrieval`、`mnemora`。三组使用计划中同一模型、任务和预算；记忆条件之外的差异要记录并提交复核。
4. 每次运行实际记录的总模型 token 数与端到端耗时。人工复核耗时仅在有计时记录时提供。

原始历史、提示和模型输出只留在获授权的工作区。可提交的测量 JSON 使用去标识化 ID，不包含原文、私密路径、密钥、个人信息或逐条提示。不要读取生产 SQLite 数据库来补全缺失材料。

## 标注顺序

先用 tuning 案例统一下面的判定口径，再固定口径标注 test 案例。每个案例的每个 arm 各标一行；test 案例的结果不能反过来修改口径或实验计划。证据不足时，在交付说明里记下待裁决的案例和缺失依据，暂不生成完整的 `measured` 文件。

| 字段 | 判定标准 |
| --- | --- |
| `continuationCorrect` | 输出准确说明当前任务状态，并给出与有效证据一致的下一步；任务身份或状态不明确时，正确请求澄清也算正确。凭空确定任务、忽略阻塞或给出错误下一步则为 `false`。 |
| `staleFactUsed` | 输出依赖已更正、替代、过期、拒绝或遗忘的信息来判断状态或建议行动时为 `true`。明确指出该信息失效并避免使用，不算误用。 |
| `repeatedStep` | 输出建议或执行历史中已经完成的同一动作时为 `true`。有证据表明必须重新验证或重做时，按实际任务要求判断，不仅因措辞相似就判重复。 |
| `irrelevantMemoryInjected` | **查看实际附加给模型的记忆**：只要其中一项与当前任务状态或下一步行动无实质关系，就标 `true`；否则为 `false`。`no_long_term_memory` 必须为 `false`。不能只从模型回答推断注入内容。 |
| `tokens` / `latencyMs` | 从运行日志抄录总模型 token 数和端到端毫秒数，使用非负整数；不得估算。任何一行超过计划预算都属于协议违例，不能作为有效 `measured` 输入。 |
| `manualReviewMs` | 仅在人工复核实际计时时填入非负整数毫秒；未计时就省略，不用 `0` 代替“未知”。 |

布尔字段只填 JSON 的 `true` 或 `false`。`irrelevantMemoryInjected` 应在 **全部** tuning/test × 三组记录中填写；若确实无法测量，就在全部记录中省略，报告会明确写“未测量”。部分填写会被拒绝。

## 交付格式与验收

交付两个文件：

- `measured-plan.json`：以计划为基础，`status` 改为 `"measured"`，保留 `version: 1`、固定的 `protocol`、`splits` 和三组 `arms`，在 `results` 中为每个案例 × 每组写一条记录。每条必须含 `caseId`、`split`、`arm`、三个必需布尔标签、`tokens`、`latencyMs`；按上述规则填写可选字段。案例 ID 只能用小写字母、数字、`.`、`_`、`:`、`-`，最多 80 字符。若材料不足，**不要**交付伪装完整的 `measured` 文件。
- `annotation-audit.md`：仅用去标识化案例 ID 与 arm 记录标签所依据的来源引用、分歧和待裁决项；不要复制原始历史或提示。另记实际模型版本、三组运行配置和计量来源，供人工复核同条件性。

完成标准：tuning 与 test 各至少一个案例；`results` 恰好有 `(tuning 数 + test 数) × 3` 行，无重复或跨 split 的 ID；所有数值来自运行日志；所有布尔标签能追溯到证据；无待裁决案例。用 Node 24.19.0 构建后，在一次性内存库中验证 JSON：

```powershell
npm run build
$env:MNEMORA_DB = ':memory:'
$planPath = 'C:\path\to\measured-plan.json' # 换成实际文件路径
node dist/cli.js evaluate task-resume-comparison $planPath
```

命令返回的 `result.status` 应为 `"measured"`；如果全部提供了相关性标签，三组指标中应有 `irrelevant_injection`。输出只含聚合指标，不应出现案例原文。即使验证通过，也只表示格式和计算通过；真实效果是否优于简单检索，仍需对照结果与人工复核共同判断。
