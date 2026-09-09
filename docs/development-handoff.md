# Mnemora 下一轮开发计划

更新：2026-09-10。基线：v1.28.2，HEAD `1ed48ca`。

本文替代此前 v1.27 的交接计划。接手 Codex 应按阶段一 → 二 → 三完成实现与验证，不重复开发已经存在的任务续接、首次验收和 Inspector 入口。

## 开工指令

直接执行本文尚未完成的开发项。先读 [AGENTS.md](../AGENTS.md)、[README.md](../README.md) 和 [package.json](../package.json)，检查当前 HEAD、工作区和相关实现；若代码已更新，复现后判断哪些任务仍需处理。保留用户修改。

先为阶段一的缺陷添加能失败的行为测试，再修复；阶段二围绕现有 Episode、Decision、TaskOutcome 完善状态投影；阶段三补齐离线评估与对照实验入口。每阶段更新本文末尾的交付表，记录实际结果、未完成项和限制。

常规实现选择自行决定，缺少真实数据不阻塞功能测试和评估框架开发。涉及真实数据、付费模型或外部系统时按具体授权范围执行，不把缺失输入替换成虚构实验结果。本任务不包含发布、部署、修改真实记忆数据库或更换系统 Node。

## 目标与边界

最终让用户在新会话中可靠回答：目标是什么、已经完成什么、哪些决定当前有效、还有什么阻塞、接下来应做什么，以及每项状态的依据。

- 保留 scope 隔离、证据来源、时效性、候选与接受状态的区别，以及现有 preview/confirm 机制。
- 使用临时数据库验证，不改动根目录真实 SQLite 数据及 WAL/SHM。
- 任务续接保持显式 operator/Inspector 入口。当前范围不调整 PPR、词表、默认自动召回或 ReasoningMemory delivery，不增加自动执行任务的能力。
- “下一步”提供工作上下文，不构成执行授权。
- 优先复用既有服务和引用体系；只有现有数据无法表达验收场景时才增加最小结构或迁移。

## 当前已完成的基础

这些功能已存在，应在其上修复和扩展：

- 平行边图谱渲染、备份登记原子替换、前端类型检查。
- durable commit、schema v79 的消息位置、schema v80 的首次验收 marker 账本。
- admission 身份排除，但兼容回调仍有遗漏，见阶段一。
- Node `>=24.15.0 <25` 与 OpenClaw `2026.9.2+` 的项目要求。
- `TaskResumeService`、`mnemora resume`、Inspector Task resume、24 条离线功能评估案例。
- `toolResult` 识别、当前轮工具交互保留和有条件的宿主压缩回退。

2026-09-10 本地验证：Node 24.19 下类型检查、构建、完整 unit suite、任务续接 benchmark、advanced plugin validation 和 smoke 均通过；官方 simple-tool gate 仍按已知的 2026.9.2 不兼容性确定性拒绝 advanced metadata。未完成全量双平台 verify。不要把本地通过结果视为跨平台 CI 已验证。

## 阶段一：生命周期可靠性

### 1.1 / P1：消息位置复用导致新一轮被丢弃

入口：[journal/repository.ts](../src/journal/repository.ts) 的 `hasCommittedTurnAdvancement`，以及 [context-engine/engine.ts](../src/context-engine/engine.ts) 的 `hasCommittedTurn`、`afterTurn`。

当前判重条件是 terminal ID 相同，或者 admission/terminal 消息位置相同。即使新的 terminal ID 明确不同，位置相同也会跳过捕获。压缩或 delta 形式的兼容回调会使位置不再能独立代表身份。

最小复现：

1. 同一 session，使用 `commitTurn` 提交位置 0–1、entry IDs 为 first-user/first-assistant 的两条消息。
2. 使用 `afterTurn` 输入另外两条消息：ID 为 new-user/new-assistant、内容和 timestamp 都不同，`prePromptMessageCount: 0`。
3. 当前事件数仍为 2、派生回调为 1；预期事件数为 4、每个合法逻辑轮只处理一次。

实现和验收：

- 明确的 entry ID 差异不能被位置匹配覆盖。
- 无 ID 时的判重必须有可信范围/代际依据，不能把位置或相同内容视为永久唯一身份。核对目标 SDK 的公开字段，不能依赖读取宿主私有存储。
- 保留同一 durable turn 后兼容回调不重复写入的行为。
- 覆盖进程重启重试、压缩后位置复用、delta 回调、不同 session、相同文本的不同轮，以及 key 相同但 payload 改变时拒绝。

### 1.2 / P1：排除 agent 经 afterTurn 再次被写入

入口：[engine.ts](../src/context-engine/engine.ts) 的 `commitTurn`、`captureRequired`、`afterTurn`。

最小复现：配置 `recall.excludedAgentIds: ["worker"]`；admission/terminal 中 agent 为 worker，消息只有 role/content/timestamp，没有 agentId。先 `commitTurn`，再对同轮调用 `afterTurn`。

当前 durable 路径正确跳过，但兼容回调写入 2 条事件并触发 1 次派生处理。预期整轮不捕获、不派生。

实现和验收：

- 把经验证的排除结果贯穿同一轮生命周期；兼容消息缺少 agentId 时不得重新获得捕获资格。
- 不为了记录排除结果保存被排除消息正文；若需要最小协调状态，明确保留周期和重启行为。
- 覆盖 commit → afterTurn、缺失/冲突消息身份、重试与重启，以及同一宿主中正常 agent 不受误伤。
- 不从自由文本推断 agent 身份，不把未知的所有 legacy session 一律禁用。

### 1.3 / P2：未来生效决定被列为当前下一步

入口：[task-resume/service.ts](../src/task-resume/service.ts) 的 `linkedDecisions` 与 `project`。

最小复现：通过现有 preview/confirm 创建关联 task episode 的决定，`validFrom = now + 1 day`，chosenAction 为“切换生产环境”。在 now 调用 resume，当前返回 ready，并将该动作放入 next_steps。

实现和验收：

- 统一检查生效开始与结束时间，定义并测试边界时刻的包含关系。
- 未生效决定可作为计划信息查看，不进入当前有效决定或可执行下一步。
- 如果它是唯一决定，不显示无条件就绪；区分“等待生效”与“需要人工重新确认”。
- 使用可注入时钟覆盖生效前、恰好生效、有效期内、过期和替代版本，避免真实等待。

## 阶段二：任务状态准确性

主要参考：[task-resume/service.ts](../src/task-resume/service.ts)、[decisions.ts](../src/cognition/decisions.ts)、[outcomes.ts](../src/cognition/outcomes.ts)、[episodes](../src/episodes/)、[context-ref.ts](../src/context/context-ref.ts)。

当前实现会把有效决定的 chosenAction 放进 next_steps。选过方案并不证明该动作仍待执行。下一阶段要表达“当前还需要做什么”，同时保留历史依据。

### 最小行为契约

- 给动作与结果建立明确关联，区分计划、尝试、部分完成、完成、失败、取消和替代。优先检查现有 Decision/Outcome 引用能否表达，不先新建通用任务系统。
- 一个任务可以有多个子动作；某个子动作成功不等于整个任务完成。禁止靠自由文本相似就认定完成。
- 已确认完成、取消或替代的动作不再推荐执行。失败历史保留，明确修复/解除后的失败不继续作为当前阻塞。
- 阻塞条件与普通约束区分：遵循某项规范并不等于任务无法继续。解除阻塞必须有明确记录或依据。
- 关联不足、相互冲突或证据失效时，返回不确定状态和待确认项，而非推测当前进度。
- 候选状态更新由模型提出时，沿用已有确认机制；模型不能把尝试升级为完成。
- 若增加持久化字段或表，覆盖增量迁移、备份恢复、引用和遗忘行为。

### 用户界面

复用现有 CLI 和 Inspector，呈现一份“继续工作”结果：目标、当前进度、有效决定、未解除阻塞、下一步及依据、待确认项。历史与当前状态要可区分。每项可展开引用；保持有界输出、scope 隔离和只读续接入口。

### 端到端验收

建立可在重启后的真实服务实例上运行的链路：捕获 → 接受状态 → 重启 → 续接 → 更正 → 再续接。

至少覆盖：

1. 会话 A 接受方案 B，完成配置检查，迁移尚未执行；会话 B 不再推荐重复检查。
2. 迁移尝试失败，后续明确恢复并完成；历史保留失败，当前不再显示旧阻塞。
3. 一个子动作成功、另一个仍待处理；整体不能被标为完成。
4. 决定未生效、已过期、被替代或动作取消，不被列为当前可执行下一步。
5. 来源被遗忘或失效，依赖状态退出有效投影或进入重新确认；不得继续给出旧依据支持的动作。
6. 同一项目存在多个同名/近似任务，返回歧义；另一 scope 的相似任务不泄露。
7. 只有计划、没有接受结果，或者完全无记忆时，不编造完成状态。
8. 未显式调用 resume 时，现有自动召回和投递行为保持不变。

## 阶段三：评估实际收益

复用 [task-resume/evaluation.ts](../src/task-resume/evaluation.ts)、[离线 fixtures](../fixtures/task-resume-evaluation-v2.json) 和 [evaluation](../src/evaluation/)。

### 本轮必须完成：离线功能评估

- 扩展为 20–30 条独立多会话工作序列；不同查询或 limit 变体可以保留，但不能冒充独立工作场景。
- 每条序列定义历史、重启点、查询、当前有效状态、允许引用、禁止动作/内容和预期不确定性。
- 加入阶段一、二的边界，按类别输出通过/失败和原因；建立明确的测试或 benchmark 入口并接入适当 gate。
- 检查结果语义和来源有效性，不只计算引用数量或断言 JSON 字段存在。

### 对照实验入口与条件性执行

提供可重跑的比较路径：无长期记忆、简单文件/检索基线、Mnemora。固定模型、输入历史、任务与预算，并隔离测试集和调参集。

分别报告续接正确率、旧事实误用、重复步骤/失败、token、延迟；人工审查耗时只有实际测量后才报告。功能测试结果与模型完成任务的效果分开呈现。

若没有经授权的脱敏真实任务或模型调用条件，先完成离线合成数据、实验入口和报告格式，明确标记“真实效果实验未运行”；不要读取生产对话、发起付费调用或声称已证明收益。真实数据和费用条件齐备后再执行对应实验。

## 验证与交付

以 package.json 为命令权威；使用支持的 Node。完成 `npm run check`、`npm test` 及行为相关的 benchmarks/插件检查。最终要求 Windows/Linux 的完整 `npm run verify`，无法运行远端 CI 时报告未完成，不以本地测试代替。

定位共享测试进程问题时，可在构建后使用独立进程与超时运行相关测试：

```powershell
npm run build
node --test --test-concurrency=1 --test-timeout=45000 tests/context-engine.test.mjs tests/task-resume.test.mjs tests/task-resume-evaluation.test.mjs tests/standalone.test.mjs tests/inspector-browser.test.mjs tests/plugin.test.mjs
```

官方插件 gate 的预期拒绝与实际宿主加载成功须分别记录。不要为了让检查通过跳过安全检查、删除失败测试或把已知拒绝写成全面兼容。

每阶段交付：实现与测试、必要的 README/roadmap 更新、实际验证结果。无需预先指定版本号，不自动发布；不要把后续研究方向混入本轮。

| 工作项 | 当前状态 | 完成证据/限制 |
| --- | --- | --- |
| 1.1 位置复用误判重复 | 已完成 | terminal entry ID 优先于位置；覆盖位置复用的新轮、delta 回调和重试。 |
| 1.2 排除结果贯穿回调 | 已完成 | schema v81 只持久化短期协调标识，不保存被排除消息正文；覆盖重启后的 afterTurn。 |
| 1.3 决定生效时间 | 已完成 | `validFrom`/`validUntil` 均为包含边界；未来决定进入 planned 与重新确认，epoch 0 也已覆盖。 |
| 2 任务状态与端到端链路 | 已完成 | schema v82 让 TaskOutcome 显式关联同一 task 的 Decision 动作状态；续接区分约束、阻塞、当前状态和历史，覆盖重启、更正、遗忘、scope 和迁移。 |
| 3 离线序列与对照入口 | 已完成 | 24 条独立合成多会话序列由 `npm run benchmark:task-resume` 执行并通过；三组对照契约有本地报告入口，未调用模型。 |
| 真实任务效果实验 | 待具备数据/调用条件 | 不阻塞前述开发，不宣称效果提升 |
| 完整双平台 verify | 待验证 | 本地 Node 24 已通过 `npm run check`、`npm test`、`npm run benchmark:task-resume`、`npm run plugin:validate` 和 `npm run plugin:official:compat`；未运行 Windows/Linux CI 矩阵。 |

## 暂缓事项

PPR 调优、扩大词表、自动策略投递、通用任务调度、新的多 agent 共享机制。完成上述评估后，再依据反复出现的失败决定是否深化条件化 ReasoningMemory。
