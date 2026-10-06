# Mnemora 下一轮开发交接

## v1.32.5：默认关闭的装配诊断

用户于 2026-10-06 明确授权提交发布。新增 `contextEngine.assemblyDiagnostics`，只保存最终插件交付的身份/来源/指纹及截断状态，正文不落盘，hostDelivery 始终 unknown；不改 schema84、召回排序、模型或配置预算。首版私有目录 gate 仅支持 POSIX，Windows 明确拒绝记录，不降低 ACL 隐私边界。

只在显式 scope、既有 0700 外部目录和不超过未来 24 小时的时限内记录，最多 20 次；到期/容量停止写入，不自动清理既有元数据。现有 acceptance 凭据语义独立。Mac 开发检查使用当前 Node26.5.0，不为统一版本修改机器；正式发布须最终完整验证及同提交 Windows/Linux CI 通过，不能沿用 v1.32.4 的通过记录。

首次提交 `0b85aa4` 的 Windows CI 在既有 worker-isolation 成功用例的 1 秒启动窗口超时；仅增加该成功 fixture 的 Windows 启动余量，取消测试及产品限制不变。后续修正提交必须重新获得自身双平台成功，不能沿用旧提交结果。

部署与启用未执行，发布本身不授权改生产配置或重启 Gateway。W1 原始注入与形成层仍缺失，不能声称根因已定位或总体效果改善。说明见 [装配留底单](assembly-diagnostics.zh-CN.md)，可转交 [OpenClaw agent 交接](openclaw-agent-v1.32.5.zh-CN.md)。私人现场材料/验证日志均留仓库外，不随发布提交。

## v1.32.4 维护：派生转述与原文证据分离

2026-10-06 用户授权先维护召回可信边界，不等待 Mac 注入记录。
摘要 / Episode 和压缩恢复增加 `derived_paraphrase` / `not_verified` 与
有限原文窗口；最终组装重新读取、同 scope、清洗、遗忘与预算边界保持。
详见[派生记忆说明](derived-memory-evidence.zh-CN.md)。没有语义验证、历史摘要
修复、生产库访问或付费模型调用；现场错误来源尚未定位，不能宣称已复现。
完整本地验收与同提交双平台 CI 后按既有授权提交发布 v1.32.4。

最终本地完整 `npm run verify`：Node24.19.0，1062 单测成功、1 项 POSIX 权限
测试跳过、0 失败；所有基线、插件校验、smoke 与版本一致性成功。68 项定向
测试覆盖新增边界和既有小预算验收。两路审查关闭旧候选仍带失效转述、窗口
挤掉召回、已重写短上下文绕过标记、非注入叶节点无法追溯、结构块丢失和
长结构块重复标记的问题；初次完整单测暴露的小预算回归修复后重跑最终全套。
后续仍须按实际提交核对双平台 CI / Release；不把本地验证当作 Mac 根因复现。

## v1.32.3 当前增量：无损精简 resume

用户在 Mac v1.32.2 六格回归跑通后授权开发精简载荷。只增加显式
`resume --format compact` / `renderTaskResumeMemory`，共享引用表无损还原，
默认投影、来源资格、自动召回、schema84 和正式实验 gate 不变。
小载荷按 UTF-8 字节数回退；不声称 token 或正确率收益。
四项新行为测试覆盖字段保真、缺失结果回退、分页/遗忘和 CLI opt-in。
完整验收与双平台同提交 CI 后发布 v1.32.3。

本地完整验收：Node24.19.0 `npm run verify` 成功，1055 单测通过、
1 项 POSIX 权限测试跳过、0 失败；所有基线、插件校验、smoke 和版本一致性
成功。Standards/Spec 独立审查没有待修发现。已知 OpenClaw2026.9.2 高级元数据
拒绝仍是预期 gate，不代表全面兼容。双平台 CI 与发布待按实际提交核对。

下一步仅在另获模型调用授权后进行匹配回归；复用投影而不重做形成，
新目录冻结序列化版本，分别观察输入/输出 token 和来源理解。
操作见 [compact guide](task-resume-compact.zh-CN.md)。没有新的付费调用授权，
Mac 运行结果来自用户转交，不等同为本地可核验原始材料。

v1.32.2 最终本地验收（2026-10-02）：Node 24.19.0 完整 `npm run verify` 成功，1051 单测通过、1 项 POSIX 权限测试在 Windows 跳过。完整基线、插件校验/smoke、版本一致性通过；Standards/Spec 审查关闭 regression packet 仍要求外部注册审计的发现。没有真实模型调用或 Mac 部署。仍须同一提交双平台 CI 成功后打标签发布，不用本地通过代替远端结论。

2026-10-02 新任务：用户授权开发一键日常三臂联调，区分 regression 与正式实验。完整技术更新按 v1.32.2 交付，仍按既有授权完成验收、提交推送及同提交双平台 CI 后发布。regression 不要求外部事前记录或人工标签；事实报告及 AI 初评不能进入 measured 或放行 v1.33。只运行已形成且授权的载荷，不自动付费抽取/裁判；额度一次冻结、未知费用不重试。使用[一键交接](task-resume-regression.zh-CN.md)。当前实现及定向验证中，不从 Mac 两例 AI 自评报告宣称效果或人工验收通过。

v1.32.1 工具包最终本地验收（2026-10-01）：Node 24.19.0 完整 `npm run verify` 成功，1043 单测通过、1 项 POSIX 权限测试在 Windows 跳过；全部基线、插件校验/smoke 与版本一致性通过。Standards/Spec 两路审查关闭计时边界、输出 token 上限、密钥空白回显、标注口径冻结和完整历史取证发现。之前运行随审查修复已失效，只有最终完整验收作为成功证据。发布须等当前提交双平台 CI；未执行 Mac 部署或真实付费实验，v1.33 gate 仍关闭。

当前接手入口（2026-10-01）：先核对实际 HEAD 与工作区，以 [roadmap](roadmap.md) 为当前方向；新增测试、排查数据库/配置或升级时，读取 [维护经验与操作边界](maintenance-lessons.zh-CN.md)。下文是 **2026-09-10 的历史交接**，其“未提交/待验证”和版本状态不代表当前工作区。当前已发布基线为 v1.32.0（`c41f791`，双平台 CI `36856873736`、正式 Release `36858385777` 已核对）；正式三臂实验另见 [预注册说明](task-resume-preregistration.zh-CN.md)。不重新创建此前移除的未跟踪 AGENTS.md。

用户授权的新开发：三臂 runner、自动验包与 [Mac 短执行交接](task-resume-experiment-runner.zh-CN.md)。首版 controlled-memory，通过显式 `--execute` 调用冻结的 HTTPS 模型接口；不访问生产库、不替用户执行真实付费实验、不声称 autoRecall 或生产端到端证据。材料、请求、原始响应、usage 与独立人工标签留在仓库外授权目录；未知费用/未决 start 不自动重试。旧预注册与判决政策不变。用户明确授权完整工具包作为 **v1.32.1** 发布：完成验收、提交推送并取得同提交双平台 CI 成功后发布，不启用 v1.33 试点。当前仍在定向验收，未声称全量或远端 CI 成功。

用户最新决策（2026-10-01）：直接完整交付 **v1.32.0**，不再拆分零碎 v1.31 补丁版本。将必要修复、完整验收、正式实验报告合并到该里程碑；仍在同一提交双平台 CI 成功后正式发布。不要仅改版本号或用合成回归宣称完成真实效果评估。当前仍缺正式实验的外部事前记录、足额未见样本与完整审计；由有访问权限的 Mac agent 按现有执行交接采集，本地不得访问生产库补齐。已有四案例报告和新收到的 12 案例包只能保留为探索/回归研究。

v1.32 发布文档要求（用户已确认）：正式发布前同步精简 `README.md` 与 `README.zh-CN.md`，随 v1.32 一起交付，不单独发布小版本。将 README 改为项目入口，目标各约 150–200 行：定位与核心价值、最小可用快速开始、常用操作、安全与边界、分类文档导航、开发与许可证。高级配置、内部实现、详细验收和实验协议移至对应文档；保留可运行的安装配置及真实效果尚未证明的边界，明确已发布与开发中能力，不用折叠区隐藏原有长文。

2026-10-01 新收到脱敏探索包：36 行、6+6 案例；当前 gate 重算与随包 decision 一致，为 fail，真实政策仍是 20+100。已发现样例真值引用续接点后的记录、将升级请求与版本替代混淆；尚缺两份 audit 和各臂原始载荷/输出。v1.32 本地开发新增独立 `source_evidence` 可读摘录，不自动填充接受状态；实现契约、包核对与 Mac 回归交接见[可读来源证据说明](task-resume-source-evidence.zh-CN.md)。未经修订审计和复测不能宣称模型效果改善；正式注册与未见样本仍缺，不发布零碎补丁替代。

本批 v1.32 开发验收：Node 24.19.0 最终完整 `npm run verify` 成功，1007/1007 单测（新增 12 项来源/评估边界、11 项会话写策略与检索路径、1 项 Inspector 浏览器回归），所有基线、插件校验/smoke 和版本一致性检查通过。两路审查已关闭 NUL 限定语丢失、清洗空窗口影响状态、来源替代状态断言、异常日期渲染发现项；旧库正文不自动修复。统一召回写策略修复保留读取与默认强化行为，schema84、模型、锁文件和原有配置限额不变。官方兼容性 gate 是确认 OpenClaw 2026.9.2 simple-tool 对 advanced metadata 的已知拒绝，不是所有宿主兼容性成功。两个较早验收在新发现/新修改后中断，只有最终完整运行作为成功证据。当前未提高发布版本或打新标签，远端 CI 仍需按提交核对；Mac 真实复测、正式审计与足额未见样本待交付。

v1.31.12 发布核对：`76f58254140427a209fba50762cb7c3705e69fe7` 的双平台 CI `36805156418` 成功（Windows 15m08s / Linux 9m21s）；Release workflow `36806431830` 成功，正式 v1.31.12 非 draft/prerelease，标签指向该提交。Mac 部署与真实实验未执行。

v1.31.8 已以 `c9c2cce` 完成双平台 CI 并正式发布。此版本起，文件型 fixture 的定向测试用 `node scripts/run-unit-tests.mjs tests/<name>.test.mjs`，完整验收用 `npm run verify`；下文历史 `node --test` 命令不是当前受管理的清理入口。

已发布增量 v1.31.12：[单次装配证据](recall-attachment-evidence.zh-CN.md) 定义默认关闭的凭据、记录版本/投影指纹和人工 preview/confirm 来源关联。接手涉及记录或标签时先读该说明：装配 ID 不是 host turn ID，用户确认不是独立证实，引用窗口不能算有用率。新增 schema84 两表，不回填旧 usage；同 scope 的重放、源遗忘/更改、目标失效和 retention 均须验收。下一步先审查授权真实凭据/来源案例与覆盖缺口，再决定是否接 canary；自动标签与 canary 集成未实现。[用途证据边界](recall-usefulness-review.zh-CN.md) 和 [阈值说明](recall-threshold-evaluation.md) 保持独立，真实三臂实验仍待授权材料。完整本地验收及同一提交 Windows/Linux CI 后发布；串行测试、产品限额和模型身份不变，不为补材料访问 Mac 或生产库。

v1.31.9 最终本地验收：Node 24.19.0 下完整 `npm run verify` 通过，单测 943/943（新增 23 项），性能基线、插件校验与 smoke 均通过。正式发布状态核对对应 GitHub Release，不从本地通过推断远端 CI。

v1.31.10 最终本地验收：Node 24.19.0 完整 `npm run verify` 通过，单测 954/954（新增 11 项），六档阈值合成回归、现有全部基线、插件校验与 smoke 均通过。同步操作不能由事件循环计时器强制中断，但返回后的超时结果已被拒绝；不能把本地通过推断为双平台 CI 或 Mac 部署成功。

v1.31.11 最终本地验收：Node 24.19.0 完整 `npm run verify` 通过，单测 964/964（新增 10 项），现有基线、插件校验与 smoke 均通过。引用后缀、Unicode 相邻字符、捕获/多段消息截断及选项前置不建库都有回归；两路审查已复核修复。真实自动标签与 canary 集成未实现，不从这次审查 view 推断用途收益；正式发布状态仍核对对应提交的双平台 CI 与 Release。

2026-10-01 发布收尾记录：`fe6adbe` 的 Linux CI 成功；Windows 的完整 `npm run verify` 也成功，但 setup-node 收尾压缩 npm 缓存耗尽 20 分钟任务时限，整个 CI 未成功，因此未打发布标签。后续仅关闭 Windows 可选 npm 缓存（保留 Linux 缓存、双平台全部检查及原时限），新提交必须重新取得双平台 CI 成功后才能发布 v1.31.11；不能把原任务的测试成功当作正式 CI 成功。

v1.31.11 后续发布核对：`c414abb` 的 Windows/Linux CI `36757620149` 成功（14m17s / 5m59s），Release `36759476309` 成功；正式标签指向该提交，非 draft/prerelease。缓存修复没有删除检查。

v1.31.12 最终本地验收（2026-10-01）：Node 24.19.0 完整 `npm run verify` 成功，983/983 单测（新增 16 项行为、3 项迁移），全部基线、插件校验/smoke 和发布版本检查通过。两路审查已关闭发现项：双配置 schema、哈希 primitive 类型、清洗后投影指纹、去重先于来源限额和来源有效期；两项旧默认值断言同步后定向 43/43 与全量均成功。自动用途标签、逐轮因果归因和 canary 集成仍未实现；双平台 CI 与正式发布须按同一提交另行核对。

v1.32 技术发布收尾（2026-10-01）：用户在确认 `3d9e62a` 的双平台 CI 成功后授权创建发布，并要求 README 同步交付。版本元数据统一为 1.32.0；中英文入口精简，高级内容保留在双语 usage guide。此次技术发布不代表原“Measured task-resume value”里程碑达标；正式实验与审计仍待完成，v1.33 gate 保持关闭。发布收尾提交必须取得自身双平台 CI 成功，不沿用 `3d9e62a` 的通过结果打新提交标签。

v1.32 README 发布契约修正：首次收尾提交 `93cce83` 的 CI `36855986801` 因 5 项 README/插件文档契约断言失败而停止，Release `36856019187` 未创建正式版本。恢复短入口中的公开项目署名、最低 Node/24.14 提醒、显式数据库调用和唯一 ContextEngine/无 legacy hooks 说明；未删除断言。定向发布与插件测试 55/55、advanced validator 成功。后续修正提交须双平台 CI 成功后再更新尚未正式发布的 v1.32.0 标签，不能把旧标签失败当作已发布。

## 历史交接（2026-09-10）

更新：2026-09-10。已发布基线：v1.29.1，标签 `v1.29.1` 指向 `e3bca58`；功能修复提交为 `8259cae`，随后以 `e3bca58` 同步 schema v83 的全套测试断言。

下一阶段围绕“任务跨多次会话，经历失败、更正和重启后，仍能给出有依据且不重复已完成工作的下一步”继续验收。三个已复现缺陷和 v1.29.1 的双平台验证已经完成；当前工作区把离线契约从实际执行的 24 条扩展为 26 条，并新增端到端长序列。完成该增量的完整验证与发布后，再用真实任务对照决定后续投入。

## 接手与范围

当时以 [README.md](../README.md) 和 [package.json](../package.json) 核对实现，已发布基线为 `v1.29.1`。该阶段的未提交工作与验收状态仅作为历史记录，当前接手以本文顶部入口为准。

当前未提交增量仅涉及长序列 task-resume 回归、离线评估数据/契约和本文；`AGENTS.md` 仍未跟踪且不属于发布内容。继续使用临时数据库；不得修改真实 SQLite/WAL/SHM，也不得把离线评估当作真实模型效果证据。

产品边界沿用 README：scope 隔离、证据来源、时效性、候选与接受状态的区别、preview/confirm 均须保留。OpenClaw 生命周期变更先核对公开 SDK 与当前插件实现，保留被选中 ContextEngine 的 assembly/afterTurn 生命周期，不增加重复摄取的 legacy hooks。

## 已有基础与本轮证据

以下能力已经存在，直接在其上修复：

- durable commit、首次使用验收、显式 CLI/Inspector 任务续接。
- schema v81 的短期排除协调记录，不保存被排除消息正文；schema v83 为缺少 ID 的兼容回调加入一方向指纹。
- schema v82 的 TaskOutcome → Decision 动作关联，以及尝试、部分完成、完成、失败、取消和替代状态。
- 决策生效时间检查、来源失效后的待确认处理、约束与阻塞的分开展示。
- 26 条独立合成多会话评估序列，以及无长期记忆、简单检索、Mnemora 三组对照契约和报告入口。前 24 条是此前实际执行的基线；另一个既有重启序列和本轮新增长序列现在也被 runner 执行。

v1.29.1 验证：Node 24.19.0 下 `npm run check`、focused ContextEngine/task-resume 回归 59/59、task-resume benchmark 4/4、插件校验与 smoke、完整 unit runner 均通过；GitHub Actions 对 `e3bca58` 的 Linux 和 Windows `npm run verify` 均通过，Release workflow 随后成功发布标签。当前未提交长序列增量已在 Node 24.19.0 下通过 task-resume、evaluation 和 comparison 测试共 14/14；尚未重跑完整 verify。真实任务效果实验仍未执行。

## 已交付：三个已复现缺陷

### P1：历史累积使已完成动作重新进入待办（v1.29.1 已修复）

入口：[task-resume/service.ts](../src/task-resume/service.ts) 的 `project`，以及 [cognition/outcomes.ts](../src/cognition/outcomes.ts) 的 `forTask`。

复现：接受一个 Decision，确认关联动作 `completed`，随后为同一任务追加 21 条结果。旧完成结果被 `MAX_ITEMS + 1` 的查询上限排除，动作因找不到关联结果重新进入 `next_steps`。用 `supersedesId` 把后续结果形成历史链时，还会返回 `ready`、`truncated=false`，掩盖读取不完整的问题。

修复与验收：

- `TaskOutcomeService.allForTask` 和无上限的关联决策读取先确定完整有效状态，最后才限制展示；`forTask` 仍是有界交互列表。
- 已覆盖完成状态被 21 条后续结果挤出时不复活。当前未提交的长序列另覆盖替代决策、部分完成→失败→恢复、取消、24 条后续记录、`limit: 1`、重启和遗忘证据。
- 剩余工作是把相同的长历史/分页不变量扩展到多个阻塞、约束和冲突组合；它们尚未作为已发现缺陷关闭。

### P1：缺少 sessionKey 的兼容回调绕过 worker 排除（v1.29.1 已修复）

入口：[journal/repository.ts](../src/journal/repository.ts) 的 `hasExcludedTurnSuppression`，以及 [context-engine/engine.ts](../src/context-engine/engine.ts) 的 `commitTurn`、`afterTurn`。

复现：配置 `recall.excludedAgentIds: ["worker"]`，durable admission/terminal 明确属于 worker，消息只有 role/content。先 `commitTurn`，再对同轮调用省略 `sessionKey` 的 `afterTurn`；消息同时没有 ID、agentId。抑制查询直接返回 false，最终写入 2 条本应排除的事件。

修复与验收：

- durable admission 的已验证排除身份经由 schema v83 的指纹延续到缺少 `sessionKey` 和消息 ID 的兼容回调；协调记录仍不保存被排除正文。
- focused 回归覆盖重启后的无 `sessionKey` 回调不捕获、不派生，以及同一会话内容不同的后续正常轮次仍可捕获。

### P2：无消息 ID 时，五分钟位置匹配仍吞掉新轮次（v1.29.1 已修复）

入口：[journal/repository.ts](../src/journal/repository.ts) 的 `hasCommittedTurnAdvancement`，以及 engine 的兼容判重调用。

v1.29.0 已修复“明确不同 terminal ID 被位置覆盖”的路径，但无 ID 路径仍只按 session、位置和五分钟时间窗口匹配。

复现：提交位置 0–1 的 durable turn；五分钟内在同一 session 调用 `afterTurn`，`prePromptMessageCount: 0`，消息没有 ID，内容是压缩后的另一轮请求与回复。预期共 4 条事件，实际仍为 2 条。

修复与验收：

- 兼容判重现在要求同一 session、有限位置范围和一方向公共消息指纹，位置复用但内容不同的新轮次会被捕获；terminal ID 仍是更强的身份依据。
- 同一 durable turn 的兼容回调仍幂等；key 相同但 payload 改变仍被拒绝。
- 边界必须明确：五分钟内同一位置、同一公开内容且没有 ID/sessionKey 的两个回调本身不可区分。实现不把该启发式等同为严格宿主身份，也不读取私有宿主存储补身份。

## 当前优先级：长期使用的状态验收

在上述修复上扩展现有行为测试与 [离线评估](task-resume-evaluation.md)，避免只测试各状态的孤立快照。当前工作区已增加一条真实重启的端到端回归，并把离线 runner 从此前实际执行的 24 条扩展为 26 条；该增量先完成完整 verify 和发布，再继续增加组合。

核心序列：捕获 → 接受方案 → 部分完成 → 失败 → 更正/恢复 → 重启 → 追加大量历史 → 续接 → 遗忘来源 → 再续接。当前长序列已经覆盖替代决策、取消动作、24 条历史记录和 `limit: 1`；每步检查当前状态、有效引用、禁止重复的动作与应保留的历史。

必须守住：

- 完成、取消或替代的动作不因历史增长而复活；明确恢复后的旧失败不继续构成当前阻塞。
- 子动作成功不等于整个任务完成；模型提出或尝试过不等于用户已接受结果。
- 来源失效后，依赖状态退出有效投影或进入待确认。
- 排除内容不入库，正常新轮次不被旧轮身份吞掉。
- 不同 scope 不泄露；同名任务有歧义时不擅自选择。
- 任务状态与来源判断不受展示分页或 `limit` 影响。

下一组组合测试应集中在多个并存的 blocker/constraint/冲突状态，以及替代链超过展示上限时 `truncated` 与当前状态的独立性。不要为了覆盖而放宽 scope、证据或 accepted-state 的约束。

复用现有 CLI/Inspector 的“继续工作”视图，集中呈现目标、已完成、阻塞、下一步和待确认项，来源与历史可展开。后续体验改进应区分“等待生效”“证据不足”和“需要用户决定”；未来决定已不会进入当前下一步，但目前仍进入重新确认列表，不应把等待时间一律变成人工审批。该体验改进在缺陷修复后进行。

## 第三优先级：真实任务收益评估

复用 [task-resume-evaluation.md](task-resume-evaluation.md) 和 [对照计划](../fixtures/task-resume-comparison-plan-v1.json)，不重建已有入口。合成序列证明功能契约，真实任务对照评估续接收益，两者分别报告。

选择一小组获授权、去标识化的跨会话任务；固定模型、输入历史、任务、token/延迟预算，隔离调参集与测试集，比较无长期记忆、简单文件/检索基线和 Mnemora。重点报告续接正确率、重复步骤、旧事实误用、token、延迟，以及实际测量的人工纠正/审查时间。预先写清成功与失败判据，保留失败案例，避免只用汇总通过率判断。

缺少数据或调用授权时，继续完成离线序列和实验准备，保留 `real_effect_experiment_not_run`。现有对照入口只校验并汇总提供的测量记录，不会调用模型，也没有证明真实效果提升。后续根据实际反复出现的失败，再决定是否投入图谱、召回或 ReasoningMemory 的深化。

## 验证与交付

命令以 package.json 为准，Node 版本遵循项目要求。完成 `npm run check`、`npm test` 和受影响的 benchmark/插件检查。Windows/Linux 完整 `npm run verify` 是最终 CI 门槛，本地 focused tests 不替代它；v1.29.1 已通过该门槛，当前 26 条增量尚未通过新的提交重复验证。

本轮 review 使用的 focused tests（先构建，使用支持的 Node）：

```powershell
node --test --test-concurrency=1 --test-timeout=45000 tests/context-engine.test.mjs tests/task-resume.test.mjs tests/task-resume-evaluation.test.mjs tests/task-resume-comparison.test.mjs tests/task-outcomes.test.mjs tests/decision-memory.test.mjs
```

官方插件 gate 的已知预期拒绝与实际宿主加载验证分开报告；不得跳过安全检查或把已知拒绝表述成全面兼容。后续交付注明检查对应的提交或工作区状态、运行环境和未验证项。

完成表分别记录实现、边界验收、双平台验证；仅新增测试或有限样例通过不能关闭缺陷。

| 工作项 | 实现状态 | 边界验收证据/剩余工作 | Windows/Linux verify |
| --- | --- | --- | --- |
| 已完成动作受历史上限影响 / P1 | v1.29.1 已修复 | 全量状态读取后限制展示；focused 回归通过 | 已通过（e3bca58） |
| 缺少 sessionKey 的 worker 排除 / P1 | v1.29.1 已修复 | v83 指纹协调；重启/无 key 回归通过 | 已通过（e3bca58） |
| 无 ID 位置复用 / P2 | v1.29.1 已修复 | 内容不同的无 ID 位置复用回归通过；相同公开内容仍是不可判定边界 | 已通过（e3bca58） |
| 决策生效时间 | 已实现 | 相关既有测试通过；等待与人工确认的体验区分待改进 | 已通过（e3bca58） |
| 显式动作关联与状态投影 | 已实现并扩展验收中 | 当前长序列 14/14 通过；多个 blocker/constraint/冲突组合待补 | 当前增量待验证 |
| 26 条合成序列与对照入口 | 扩展完成，待发布 | 26 条离线评估与 comparison 契约通过；实际效果实验仍未执行 | 当前增量待验证 |
| 真实任务效果实验 | 入口已实现，实验未执行 | 待数据与调用条件，不能宣称效果提升 | 不适用 |

## 暂缓事项

PPR 调优、扩大词表、默认自动策略投递、通用任务调度、新的多 agent 共享机制。当前优先完成可靠续接与真实收益验证，不增加自动执行任务的能力；下一步建议本身不构成执行授权。
