# Mnemora 下一轮开发交接

更新：2026-09-10。已发布基线：v1.29.1，标签 `v1.29.1` 指向 `e3bca58`；功能修复提交为 `8259cae`，随后以 `e3bca58` 同步 schema v83 的全套测试断言。

下一阶段围绕“任务跨多次会话，经历失败、更正和重启后，仍能给出有依据且不重复已完成工作的下一步”继续验收。三个已复现缺陷和 v1.29.1 的双平台验证已经完成；当前工作区把离线契约从实际执行的 24 条扩展为 26 条，并新增端到端长序列。完成该增量的完整验证与发布后，再用真实任务对照决定后续投入。

## 接手与范围

先读 [AGENTS.md](../AGENTS.md)、[README.md](../README.md) 和 [package.json](../package.json)，核对当前 HEAD、工作区及实现。以 `v1.29.1` 为已发布基线；未提交工作必须同已发布版本和本文记录的验收状态明确区分。

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
