# v1.32 三臂实验：预注册与判决

这份说明供获授权的实验执行者（包括 Mac 上的 OpenClaw agent）在**下一批正式三臂运行开始前**使用。实现入口为 `TaskResumeValueGate`；固定政策 `task-resume-value.v1.32.v1` 位于 `src/task-resume/preregistration.ts`，文档不另设一套可漂移的阈值。

现有 2026-09-24 四案例结果已被查看，属于探索性证据。可保留为回归或调参材料，不能补做注册后把它们重新称为未见过的 held-out test。26 条合成 harness 仍只验证契约。

## 固定判决规则

主比较是 **Mnemora 对 simple_retrieval**；no_long_term_memory 保留为第三臂，完整报告其结果，不用它替换一个更难击败的简单检索基线。所有效用门槛只使用预先冻结的 test 案例。

| 检查 | 必须满足 |
| --- | --- |
| 续接正确率 | 绝对提高至少 10 个百分点；不是相对提高 10% |
| 过期事实误用率 | 至多为简单检索的 0.5 倍 |
| 总模型 token | 同一 test 案例集合上的 token 总量至多为简单检索的 1.2 倍 |
| 重复步骤与无关注入 | 两项发生次数均不得高于简单检索 |
| 预算 | 每次运行仍须遵守计划中的 token / latency 上限；越界记录不进入有效 measured 输入 |
| 覆盖 | 至少 20 个 tuning 案例、100 个新 held-out test 案例；全部三臂、全部案例完整覆盖 |
| 安全性支持 | 简单检索在 test 中至少有 10 次过期事实误用，才能据此作“减半”判决 |
| 标注与计量 | 全部 tuning/test 行都有无关注入标签；实际模型 token 为正数；未知计量不能填 0 |

这些样本下限是事前工程决策护栏，不是统计功效计算，也不保证显著性。若无法获得这么多授权材料，不伪造或重复案例凑数：保留小样本探索结果，门槛保持关闭。案例采样规则、标签定义与实际模型/采样参数在运行前冻结；不能看过结果再挑有利任务、修改简单检索或扩充 test 到刚好通过。

基线过期误用为零时，0→0 只说明本批未观察到错误，不能证明“减少一半”。这种情况不把比值填成 0，不事后换一个基线；缺少支持时判 `inconclusive`。任一已可判检查不达标判 `fail`。只有全部检查满足才判 `pass`，而 `eligibleForPilotReview=true` 仅表示可以提交人工复核，**不会启用 v1.33、写入 calibration 或证明总体效果**。v2.0 仍需独立的安全不变量、复现与真实自动注入证据。

## 注册材料与冻结范围

复用既有 comparison plan（version 1），补充一个 `evidence` 对象：

```json
{
  "kind": "authorized_real",
  "caseManifestSha256": "<实际案例清单与采样规则文件的64位小写SHA-256>",
  "rubricSha256": "<实际真值与标注口径文件的SHA-256>",
  "commonPromptSha256": "<实际公共提示模板文件的SHA-256>",
  "armConfigSha256": {
    "no_long_term_memory": "<实际该臂配置文件的SHA-256>",
    "simple_retrieval": "<实际该臂配置文件的SHA-256>",
    "mnemora": "<实际该臂配置文件的SHA-256>"
  }
}
```

占位符不能通过校验。合成测试必须使用 `kind="synthetic"`，其判决不放行。哈希对应材料留在授权工作区；不要读取生产 SQLite 来填补缺失材料，也不把历史原文、逐条提示、私密路径、凭据或个人信息塞进 plan/registration。

arm 配置应固定实际模型版本、temperature、max_tokens、检索算法/阈值/候选上限、记忆库构造规则、代码版本、运行顺序、重试策略和空输出处理规则。公共提示除了记忆块外逐字节一致；所有差异与三臂隔离要在 collection audit 中核验。调参准备可以先使用 tuning 材料，但之后须冻结最终配置并注册，正式比较的 tuning/test 全部三臂行再按该配置运行；注册后不再改变配置，test 材料保持未见。

注册会冻结计划 ID、model/history/task set ID、每次预算、tuning/test ID 列表、三臂、上述材料哈希与固定政策。语义字段不放在未知额外字段里；必要参数写入被哈希的配置材料。注册输入须为 `status="planned"`，不能已含测量结果或 `runStartedAt`。

## 执行与交付

1. 在这次正式比较的任何模型运行前执行：

   ```bash
   mnemora evaluate task-resume-register planned-plan.json
   ```

   将输出 JSON 的 **`result` 对象**单独保存为 `registration.json`。它包含快照、注册时间、政策与 `commitmentSha256`，不包含模型结果。

2. 在第一条模型运行之前，将 registration 及其承诺哈希提交到可独立核对时间的记录（例如已推送的 Git 提交或获授权的时间戳记录）。只把文件留在本机不够。保留该外部记录引用与实际执行日志。

3. 按冻结配置完成三臂运行；全部原始输出、真实提示、附着记忆与 provider usage/墙钟计量仍留授权工作区。记录首次实际运行开始的 Unix 毫秒时间为 measured plan 顶层 `runStartedAt`。它必须晚于 `registeredAt`，且不得使用未来时间。所有失败/违例留在审计中；不得静默删掉不利结果或只重跑一条有利 cell。

4. 完成既有 labeling handoff 要求后执行：

   ```bash
   mnemora evaluate task-resume-decision measured-plan.json registration.json
   ```

   输入的 protocol/splits/arms/evidence 必须与注册快照一致。报告同时给出旧 comparison 指标和逐项 decision；比较失败是有效结论，不是需要“修到成功”的测试。

5. 交付 `registration.json`、外部事前记录引用、去标识化 measured plan、collection/annotation audit 和 decision 输出。人工复核外部时间先后、真实材料授权、标签依据、参数一致性、协议违例与重试；全部可核对且 decision 为 pass 才讨论 v1.33。

这三个 task-resume 文件命令不打开或初始化记忆数据库、不调用模型、不更改自动召回。没有 registration 时，旧 `task-resume-comparison` 仍可输出描述性指标，但它没有 v1.33 放行判决。

## 证明边界

SHA-256 能检查材料是否变化，**不能单独证明事前注册**。使用者可以重写整个文件并重新计算哈希；CLI 也不能验证自报运行时间、标签、provider usage 或 `authorized_real` 的真实性。没有可核对的外部事前记录时，即使数值通过，也不能称为预注册成功或启动试点。这个人工证据门槛不能用 `eligibleForPilotReview` 替代。

后续若需改变门槛，先发布新政策版本、冻结新实验，使用新的未见 test；不重算本批旧结果以获得放行。
