# Mnemora 开发交接：可靠捕获与跨会话任务续接

更新日期：2026-09-07。审查基线：`v1.27.0`，提交 `eeee47e`。

本文供接手开发的 Codex 使用。目标是先修复已复现的生命周期缺陷，再交付有来源、可更新、可验证的跨会话任务续接。本文包含实施规格和验收条件；创建本文这一步没有修改运行时代码，也没有授权发布、部署或操作真实记忆数据库。

## 1. 接手入口与范围

先读根目录 [AGENTS.md](../AGENTS.md)、[README.md](../README.md) 和 [package.json](../package.json)，检查当前 HEAD 与工作区状态。若代码已前进，先核对以下问题是否仍存在，不要重做已完成的修复。审查时工作区只有用户提供的未跟踪 `AGENTS.md`；保留接手时遇到的用户修改。

按以下顺序交付，每阶段记录实际证据，不把后续探索混入当前修复：

| 阶段 | 交付 | 完成条件 |
| --- | --- | --- |
| A | durable turn 去重、agent 排除、首次验收与运行要求修复 | A1–A4 的行为测试通过，相关检查完成 |
| B | 最小跨会话任务续接 | 显式 operator 入口可输出有来源的任务状态，覆盖 B 的验收场景 |
| C | 任务级评估 | 固定数据、预算及基线，可重跑并输出分类结果 |
| 后续研究 | 更正传播、条件化经验、宿主互操作 | 依据 C 的失败案例另定范围，不自动实施 |

阶段 B 默认先做显式读取和检查，不改变自动召回、PPR 或 ReasoningMemory delivery 默认策略。若实现需要修改这些策略，先缩小实现到本阶段目标；策略变更属于独立工作。

## 2. 当前状态与验证证据

已完成，不应重新列为待开发功能：

- Inspector 支持同一对实体的多条关系。
- 备份登记先持久化候选清单，再更新内存，使用临时文件替换清单。
- Inspector 客户端已纳入类型检查，并有 scope 记忆工作台、来源入口和显式遗忘流程。
- `/mnemora verify` 已存在，但其跨会话成功判定还不充分。
- 1.27 已引入 schema v78、durable `commitTurn` 和 advancement receipts。

2026-09-07 的验证结果：

- 类型检查和构建通过。
- Node 24.19 下，context-engine、plugin、standalone、inspector-browser、inspector-operations、backup-restore 六个文件共 108 项测试通过。
- 两个额外最小复现仍发现 A1、A2。测试通过不代表这两类输入已覆盖。
- 系统默认 Node 24.14 被 OpenClaw 2026.9.2 的 SQLite 安全检查拒绝；这是运行时版本问题，不是上述测试断言失败。
- `scripts/official-plugin-gate.mjs` 的成功表示确认了官方 simple-tool gate 对高级插件元数据的**已知拒绝**，不是官方验证器接受了插件。
- 未完成全量 `npm run verify` 或双平台 CI 验证。

项目规范以 AGENTS.md 为准。只使用临时数据库，不读取或改动仓库根目录的真实数据库及 WAL/SHM；不以读取宿主私有数据库解决协议问题。运行时只通过公开 SDK 契约接入。

## 3. 阶段 A：先修复可靠性

### A1 / P1：不带消息 ID 时重复捕获

主要入口：[engine.ts](../src/context-engine/engine.ts) 的 `commitTurn`、`afterTurn`、`hasCommittedTurn`、`correlation`，以及 [journal/repository.ts](../src/journal/repository.ts)。

**已复现：** `hasCommittedTurn` 从最后一条消息的 `id` 查 terminal entry，但宿主 entry anchor 与消息对象是不同层次的身份。OpenClaw 的 closed-turn reader 返回 `event.message`，不会保证把 envelope 的 entry ID 合并到消息对象。

复现输入形状：

```js
const messages = [
  { role: "user", content: "Remember the project code Cedar.", timestamp: 1 },
  { role: "assistant", content: "Recorded.", timestamp: 2 }
];
const admission = {
  logicalTurnId: "review-turn", agentId: "main", sessionId: "review-session",
  sessionKey: "agent:main:review", storePath: "host.sqlite",
  generation: "gen-1", entryId: "entry-user", activeMessagePosition: 0
};
const terminal = {
  agentId: "main", sessionId: "review-session", sessionKey: "agent:main:review",
  storePath: "host.sqlite", generation: "gen-1",
  entryId: "entry-assistant", activeMessagePosition: 1
};
await engine.commitTurn({
  advancementKey: "review-turn", admission, terminal,
  sessionId: "review-session", sessionKey: admission.sessionKey, messages
});
await engine.afterTurn({
  sessionId: "review-session", prePromptMessageCount: 0, messages
});
```

使用现有测试工厂和一次性数据库构造 `engine`。当前结果：4 个 events、2 个 commits、2 次 completed-turn 回调。期望：2 个 events、1 个 commit、1 次派生生命周期。

实施要求：

- 基于宿主公开的 durable 身份和本地 receipt 设计兼容回调的判重。先核对安装版本 SDK 的实际字段，不强制使用本文预设的数据结构。
- 不要求宿主向消息额外注入 `id`，不以内容相同等同于同一轮。
- 不能简单跳过某个 session 后续全部 `afterTurn`；仍需保留合法的 legacy/fallback 捕获。
- 相同 advancement key、相同 payload 重试返回 duplicate；key 相同而 payload 改变继续拒绝。
- 覆盖跨重启重试、两轮内容完全相同但 key 不同、不同 session、legacy-only，以及 commit 后兼容回调。
- 保留事件、receipt、派生任务入队的事务边界；派生处理失败不能撤销已接受的宿主 turn。

主要测试：[context-engine.test.mjs](../tests/context-engine.test.mjs)、[plugin.test.mjs](../tests/plugin.test.mjs)、[journal.test.mjs](../tests/journal.test.mjs)。

### A2 / P1：durable admission 中的 agent 排除失效

主要入口：`captureRequired`、`activeAgentId`、`completedTurn`、`commitTurn`，均位于 [engine.ts](../src/context-engine/engine.ts)。

**已复现：** 配置 `recall.excludedAgentIds: ["worker"]`，在 A1 输入中把 admission、terminal 和 sessionKey 的 agent 改为 worker，消息不带 `agentId`。只调用 `commitTurn`，当前仍产生 2 个 events、1 次 commit、1 次派生回调。

实施要求：

- durable 路径使用经过验证的宿主 agent 身份执行排除策略；消息对象的可选字段不能覆盖宿主身份。
- 被排除 agent 不产生事件、派生任务、抽取或其他该轮持久化内容，按既有 no-op 契约回应宿主。
- 排查 assemble 与兼容生命周期是否存在同类问题；只有 SDK 提供可信身份时才使用，不从自由文本推测身份。
- 覆盖缺失消息级身份、消息级身份与 admission 冲突、正常非排除 agent 和 legacy 输入。保留现有身份规范化约定。

### A3 / P2：首次验收不能证明跨会话召回

入口：[first-use.ts](../src/standalone/first-use.ts)、[operator-command.ts](../src/operator-command.ts)、Journal activity 与 unified recall telemetry。

**已复现的判定缺口：** `events > 0`、`sessions >= 2`、`attachedRuns > 0` 即可返回 4/4。这允许会话 A 内的一次召回，加上完全无关的会话 B，通过“跨会话验收”。也没有限定证据来自本次验收。

实施要求：

- 将基础运行检查与跨会话端到端验收明确区分；聚合统计只能证明前者。
- 为显式验收建立短期、scope 隔离的关联：验收开始、会话 A 写入、后续会话 B 的实际附加必须对应同一验收目标。
- 验证实际附加，不能拿手动检索结果或预测的 policy trace 代替。
- 采用随机验收内容或不透明标识，默认 telemetry 继续只存有界脱敏信息；不为了证明效果持久化用户原始 prompt 或候选正文。
- 未启用必要观测、找不到关联或安全空召回时，显示 pending/不可验证及下一步，不显示通过。
- 覆盖只有同会话召回、历史成功记录、不同 scope、目标无关的附加、过期验收和一次真正的跨会话成功。

### A4 / P2：运行要求与宿主契约同步

入口：[README.md](../README.md)、[README.zh-CN.md](../README.zh-CN.md)、[package.json](../package.json)、[CI](../.github/workflows/ci.yml)、[official-plugin-gate.mjs](../scripts/official-plugin-gate.mjs)。

- package 的宿主最低版本已是 `2026.9.2`，英文 README 仍写 `2026.6.11+`；同步两种语言和相关安装说明。
- 不再笼统写任意 Node 24 都可用。依据目标宿主和 SQLite 检查确定项目支持的补丁范围，补充包元数据或轻量启动检查，给出可执行的升级提示。
- 禁止绕过宿主 SQLite 安全检查来使测试变绿。
- 保持“已知官方验证器限制”与“真实插件加载、工具调用、生命周期成功”两类证据分开。优先用公开契约完成集成验证。

## 4. 阶段 B：跨会话任务续接 MVP

### 用户场景

会话 A 讨论部署迁移，已确认使用方案 B，完成配置检查，还没有执行迁移，等待上游合并。重启后，在会话 B 询问“继续这个项目”，系统返回正确的目标、已确认决定、进度、阻塞条件与下一步，并能打开各项依据。

**任务状态**是对某个任务当前工作情况的有来源投影，不能仅凭“最近发生过什么”就断言当前进度。暂定最小输出：

- 稳定任务标识、所属 scope、目标及最后验证时间。
- 已完成事项、待完成事项、阻塞条件和下一步。
- 已确认决定与约束；候选或待确认内容单独呈现。
- 相关产物引用，以及每项状态的来源引用。
- 已过时、证据失效或无法确认的状态。

### 实现边界

优先复用 [episodes](../src/episodes/)、[decisions](../src/cognition/decisions.ts)、[outcomes](../src/cognition/outcomes.ts)、[context-compiler](../src/cognition/context-compiler.ts)、[context-ref](../src/context/context-ref.ts) 和 [personal-memory](../src/personal-memory/service.ts)。不要先引入第二套通用图谱或任务调度系统。

- 先交付显式 operator 读取入口和 Inspector 视图。可以采用 `resume` 语义的命令，最终命名遵循现有 CLI 约定；本文没有要求增加 agent tool。
- 写入、候选形成与用户确认复用既有机制。模型可以提议状态变化，不能自行把候选升级为用户决定、完成状态或执行授权。
- 同一 scope 内多个任务不能混合；任务不明确时返回可选择的有界候选，而非自动串接最近记录。
- 只返回当前调用者可见 scope 中的依据。跨 scope 共享不属于本阶段。
- 控制输出 token 与条目数量，支持逐项展开来源。旧状态保留历史，当前投影不使用已撤销或失效的证据。
- 若需要新增表，采用增量迁移，并覆盖备份恢复、引用完整性、遗忘和重启；如果现有记录即可表达，则保持派生视图。
- “下一步”是建议和上下文，不触发外部动作或调度；历史授权不自动变为当前执行许可。

### 必须通过的场景

1. 会话 A 记录任务，会话 B 在进程重启后正确续接；答案包含准确来源。
2. 旧决定 A 被确认替换为 B，续接只把 B 作为当前决定，同时能查询 A 的历史。
3. 同一项目有两个任务，系统按任务身份区分；不确定时给出候选。
4. 另一个 scope 有相似项目，当前结果不出现其内容或引用。
5. 来源被遗忘或失效后，依赖状态不再作为有效事实；需要重新确认的内容明确标记。
6. 工具失败或任务中断后，不把计划、尝试或部分执行写成已完成。
7. 没有足够记忆时说明缺失，不编造进度、约束或下一步依据。
8. MVP 未被显式调用时，不改变现有自动注入、PPR 或 delivery 行为。

## 5. 阶段 C：任务级评估

复用 [evaluation](../src/evaluation/) 与 `package.json` 中已有 harness；先建立可在 CI 离线重跑的确定性场景。建议从 20–30 条多会话序列起步，覆盖正常续接、决定更新、歧义、隔离、遗忘、失败和空结果。

每个案例明确输入历史、查询、有效状态、允许引用、禁止输出及预期 abstention。按案例固定期望，避免仅验证实现返回的字段形状。

分开报告两层指标：

| 层次 | 指标 | 能证明什么 |
| --- | --- | --- |
| 本地功能测试 | 状态准确、来源完整、隔离、过期与遗忘处理、幂等 | 实现遵守规格 |
| 任务效果实验 | 续接成功、重复失败、旧事实误用、token、延迟、审查耗时 | 记忆是否改善实际工作 |

后续效果实验比较“无长期记忆”“简单文件/检索基线”“Mnemora”，固定模型、任务、历史与预算，预留独立测试集，不在测试集上调策略。模型调用、真实数据和费用需在该实验的授权范围内；没有实验结果时不要宣称改善了任务成功率。

## 6. 后续方向：保留为研究队列

只有实际失败案例支持时，再独立设计：

- **更正与失效传播：** 从遗忘扩展为事实替换、生效时间与依赖失效；审计摘要、决策和策略是否继续引用旧依据。不要把本次抽查未覆盖的路径写成已确认缺陷。
- **条件化经验：** 扩展已有 ReasoningMemory 的环境条件、成功与失败证据、验证时间、失效和回滚。评估跨任务迁移，继续保留人工准入和默认关闭投递。
- **宿主互操作：** 明确 ContextEngine、宿主 memory 与 Mnemora 的捕获/召回职责，通过公开 API 和显式导出迁移，避免重复生命周期。

这些是产品假设，不是本次审查已经证明能带来效果的结论。

参考资料，仅在相应研究分支需要时阅读：

- [OpenClaw ContextEngine](https://docs.openclaw.ai/concepts/context-engine)：宿主生命周期、durable admission 与公开集成契约；实现以目标安装版本 SDK 为准。
- [OpenClaw Memory](https://docs.openclaw.ai/concepts/memory)：宿主已有能力和职责边界。
- [LongMemEval-V2](https://arxiv.org/abs/2605.12493)：环境状态、工作流程和常见陷阱的评估思路，研究工作仍在演进。
- [AFTER](https://arxiv.org/abs/2606.23127)：程序性经验跨任务、角色和模型的迁移评估。

## 7. 验证与交付记录

命令以当前 `package.json` 为准。修改后运行 `npm run check`、`npm test`，并根据行为选择相关 benchmarks 和插件检查。AGENTS.md 要求 Windows/Linux 完整 `npm run verify` gate；本地 focused tests 不替代它。

上次共享进程测试曾停滞。排查时可在构建后使用有界独立进程运行，但必须把它与标准测试结果分别记录：

```powershell
npm run build
node --test --test-concurrency=1 --test-timeout=45000 tests/context-engine.test.mjs tests/plugin.test.mjs tests/standalone.test.mjs tests/inspector-browser.test.mjs tests/inspector-operations.test.mjs tests/backup-restore.test.mjs
```

测试停滞时记录具体用例、Node/宿主版本和输出；只结束自己启动的测试进程，不通过删除失败用例或无限等待来处理。修复 B/C 后，按新增行为补充对应测试和评估命令。

每阶段完成后更新下面的记录，并在实际行为改变时同步 README/roadmap。不要仅因命令启动成功或某个 gate 返回零就勾选完成。提交、发布、部署和操作真实数据遵循接手任务的实际授权。

| 项目 | 状态 | 实现提交 / 测试与限制 |
| --- | --- | --- |
| A1 durable/legacy 去重 | 已完成 | schema v79 保存公开 message range；`context-engine` 44/44 覆盖重启、无 ID、相同内容的不同 range 与兼容回调 |
| A2 agent 排除 | 已完成 | durable admission 的经验证 agent 身份成为唯一排除依据；`context-engine` 44/44 覆盖缺失/冲突消息级身份 |
| A3 跨会话验收 | 已完成 | schema v80 的一小时随机 marker 账本仅保存 marker/session hash；`plugin`/`standalone` 覆盖同会话、无关附加、跨 scope、过期与实际附加关联 |
| A4 运行要求 | 已完成 | package/lock `engines`、CI 与双语 README 已同步为 OpenClaw 2026.9.2+、Node 24.15.0+；release coverage 通过 |
| B 任务续接 MVP | 已完成 | `TaskResumeService` 复用 Episode、Decision 与 TaskOutcome，提供 `mnemora resume` 和 Inspector Task resume；`task-resume` 4/4、Inspector browser 10/10 覆盖重启、替换、歧义、scope、遗忘、失败、空结果与显式入口 |
| C 任务级评估 | 已完成（功能基线） | `fixtures/task-resume-evaluation-v1.json` 的 24 条离线固定案例由 `TaskResumeEvaluationRunner` 分类报告；未运行模型或真人任务效果实验，不能据此宣称任务成功率提升 |
| 双平台完整验证 | 未完成 | Windows/Linux CI 与完整 `npm run verify` 仍是最终 gate；本机受支持 Node 24.19 已通过完整 unit runner，且 `npm run check` 通过；默认 Node 24.14 仍不满足项目 SQLite 运行要求 |

## 8. 可直接交给 Codex 的开工指令

> 阅读 `docs/development-handoff.md` 和项目 AGENTS.md，核对当前代码是否已修复文档中的问题。按 A → B → C 实施尚未完成的内容，先为 A1/A2 增加能复现问题的行为测试，再修复。复用已有数据与确认机制，保留 scope、来源和候选/接受状态的边界。完成相关验证，在文档交付表中记录结果和限制。后续研究队列不在本次实施范围。不要修改真实记忆数据库，不发布或部署；遇到环境问题先定位并继续不受影响的工作。
