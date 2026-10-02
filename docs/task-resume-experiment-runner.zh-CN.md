# 三臂实验工具包：交给 Mac 上的 OpenClaw agent

只做日常联调时，改用[一键 regression 入口](task-resume-regression.zh-CN.md)，
无需外部事前记录或人工标签。下文继续适用于正式实验，不豁免其要求。

你负责材料采集与调用固定工具，不自由改写三组提示或判决规则。先用流程案例验收，再做旧案例匹配回归；正式实验仍按[预注册规则](task-resume-preregistration.zh-CN.md)使用新样本。下面的工具只支持 **controlled-memory**：固定载荷的单轮模型对照，不是 ContextEngine 自动注入或生产任务执行测试。

## 先准备什么

在 Mac 授权目录准备一个 `bundle.json`，参照[合成格式示例](../fixtures/task-resume-experiment-bundle-v1.json)。示例的历史、模型、端点和全零提交只是占位，不得当真实材料。

- `kind` 只能在材料确属已授权真实案例时用 `authorized_real`；流程测试保留 `synthetic`。
- `implementationRef` 记录实际构建的完整 Git SHA；记录 Node、OpenClaw 和 Mnemora 入口版本。不要把旧扩展目录误当新发布。
- `protocol` 固定同一模型、历史/任务集合、总 token 和推理耗时预算；`splits` 互不重叠，案例按 tuning 后 test 的 ID 顺序排列。
- `settings` 固定 HTTPS 模型端点、temperature、maxTokens 和 simpleTopK。请求模型名必须与供应商实际返回的 `model` 一致；不静默切换模型、别名或 fallback。
- 每例提供过去的 `cutoffAt`（Unix 毫秒）、`cutoffSourceId`（事件边界，须为截断历史最后一项的 ID）、当时当前会话 `currentContext`、同一 `question`、带 ID/时间/正文的截断 `history`、独立 `truth` 及其来源 ID。同一毫秒仍按已核对的事件顺序截断，不能只靠时间筛选。
- 每例 `mnemora` 提供公共接口生成的载荷 `text`、来源 ID、形成过程/隔离入口日志引用 `producer`，以及实际输入历史的 `historySha256`。哈希算法是 UTF-8 `JSON.stringify(history, null, 2) + "\n"` 的 SHA-256。空召回可用空文本与空来源列表，不猜测补齐。

只从获授权的 OpenClaw/Mnemora 公共接口取得材料，不读生产 SQLite/WAL/SHM。形成 Mnemora 记忆使用独立环境，输入限于同一案例的截断历史；保存形成日志、接口参数、源 ID 映射和模型用量。哈希只能绑定声明，不能证明形成过程中没看到未来信息；这项必须人工审计。

原文、真值、请求、输出、计量与标签理由都留在本机受控目录，不能提交到公开仓库。工具禁止在仓库内创建实验工作区；POSIX 权限不能替代 Mac 实际授权和 Windows ACL 检查。

runner 工作区是它管理的扁平文件目录，不放符号链接、日志子目录或其他工具的临时产物。形成日志与授权原始材料另放受控目录，通过 `producer` 和审计说明引用；不要为通过路径检查改读生产库。

## 固定操作顺序

以下从已构建的 Mnemora 仓库执行。`<...>` 替换成授权工作区中的实际绝对路径；输出目录必须尚不存在。

```bash
node scripts/task-resume-experiment.mjs prepare <bundle.json> <new-private-dir>
node scripts/task-resume-experiment.mjs register <new-private-dir>
```

`prepare` 不联网，只冻结材料、公共提示、三组配置、实际 runner/传输/判决编译产物哈希和 planned plan；同版本号的代码变化也会拒绝续跑。`register` 复用现有政策写入 `registration.json`。在第一条模型运行之前，将注册文件/承诺哈希留到有独立时间依据、获授权的记录中。未经授权不向 GitHub 提交或发送材料。

另外准备 `external-record.json`：

```json
{"reference":"<获授权的独立事前记录引用>","recordedAt":1234567890000}
```

必须使用真实记录及 Unix 毫秒时间，时间在注册之后、首次调用之前。工具只能检查字段和顺序，不能独立验证外部记录真实性。

从安全的凭据环境提供 `MNEMORA_EXPERIMENT_API_KEY`，不把密钥写进 bundle、参数、交接文档或日志。只有下面含 `--execute` 的操作会调用模型并产生费用：

```bash
node scripts/task-resume-experiment.mjs run <private-dir> <registration.json> <external-record.json> --execute
node scripts/task-resume-experiment.mjs check <private-dir>
```

运行严格串行，按预先固定的轮转平衡三组顺序；每例生成同样的 system/currentContext/question，仅 `longTermMemory` 不同。无记忆为空；简单检索固定 CJK 二元组/英文词项重合计分、top-k、原历史顺序解平局、零命中为空；Mnemora 使用已冻结的来源载荷。没有工具调用、历史会话继承或 agent 间交流进入模型请求。

每格在调用前独占写入并同步 start，随后保存实际请求、原始模型 JSON、usage 和计时。完成格续跑前重新校验，不重复调用。未知费用、未决 start、损坏记录、空/截断输出、错误模型、缺失用量或预算违规会阻断整批；保留证据，不删文件“重新开始”，不自动重试。

如果出现残留 `.run.lock`，先检查进程是否仍在运行及供应商侧调用状态；不要直接清锁重跑。首版没有人工重试或自动恢复未决调用入口。应提交具体未决格、已检查的运行日志及下一步所需决定；新的独立尝试仍需显式授权和保留旧记录。

## 标注与验包

全部格合规后：

```bash
node scripts/task-resume-experiment.mjs review <private-dir>
```

将 `annotation-packet.json` 和 `labels-template.json` 交给获授权的独立标注者，尽量不给运行目录、组名与原结果。包包含完整截断历史正文、时间、事件边界、真值及注册前冻结的四项定义与裁决规则；标注以包内 `rubric` 为准，注册后不得更换口径。包隐藏组名并调整顺序，但文字风格仍可能透露条件，不宣称完全盲评。历史证据不进入模型请求。

标注者逐项核对实际输入/记忆/输出与续接点真值：填写四项布尔标签、依据引用、理由及 `adjudication="resolved"`；未计时就省略 `manualReviewMs`，不用 0 代替未知。采集审计须明确确认时点、形成输入、授权/去标识化和独立注册记录已核对，并填写审查者去标识 ID 与说明。模板默认未确认，不能直接导出。

```bash
node scripts/task-resume-experiment.mjs export <private-dir> <completed-labels.json>
```

导出复用现有 comparison/value gate，不降低样本、预算或安全门槛。缺格、标签缺失/重复、待裁决、错误来源、旧包标签、审计缺失或篡改均拒绝生成合格 measured 输入。生成 `measured-plan.json`、decision、采集与标注审计；详细审计仍属受控材料，不能直接公开。

对外只交获授权的去标识化 measured plan、判决和审计摘要。报告实际案例/调用数、成功与未决格、独立注册引用、已执行版本、材料路径和具体缺口，不只交一张结论表。完整数据包通过结构检查，不代表真值或标签已经被独立证明。

## 计量与结论边界

- token 使用供应商实际 `prompt_tokens`、`completion_tokens`、`total_tokens`，核对加总、输出上限与总预算；不按字符估算，不重复累加 cached/reasoning 明细。供应商仍可能在事后报告超限费用，工具不能保证提前精确控制输入 token。
- `latencyMs` 使用单调时钟，边界为 **模型请求分派到完整响应校验完成**。历史形成、预计算 Mnemora 投影、提示准备与证据文件写入不计入；因此不是生产链路 end-to-end latency。形成/检索用量、耗时和执行/标注 agent 成本须另留日志，不能用此结果声称完整系统成本优势。
- 时间戳、来源 ID、历史哈希和审计确认只做结构核验，不自动判定“请求已完成”、排除语义上的未来信息或证明外部事前注册。
- 旧 12 例只作匹配回归；正式政策仍为 20 tuning / 100 新 test。小样本、已看过的案例和 synthetic 不能放行 v1.33。正式比较的延迟口径必须事前审查并冻结，不混用生产链路指标。
