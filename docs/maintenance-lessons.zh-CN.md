# Mnemora 维护经验与操作边界

记录：2026-09-29；代码核对基线：`b36569a`（v1.31.7）。供开发 agent 在新增测试、排查写入故障、升级和调整配置时读取。产品方向与发布门槛以 [roadmap](roadmap.md) 为准，命令与依赖以当前 `package.json` 和实际宿主接口为准。

下列故障经过来自用户的 Mac/OpenClaw 实操记录，本工作区未访问该 Mac 或生产数据库。标为“代码已核对”的是当前仓库事实；部署数值与历史事故不能直接当作产品默认值或已在本分支修复的证据。

## 测试卫生

- 新增或迁移 fixture 使用 `tests/helpers/temp.mjs` 的统一临时目录接口，在 `os.tmpdir()` 下以 `mkdtemp` 建立本次运行独占目录，不写 `repo/.tmp/`。用户报告历史泄漏累计 2583 个目录、约 5.7 GB；这是实操报告，不是本工作区测量。
- 统一 helper 应让 `scripts/run-unit-tests.mjs` 在子进程正常结束或失败后都调用 `clearTempRoot()`；smoke 也要兜底清理。各测试仍先关闭 SQLite、HTTP、浏览器与其他句柄，再清理自己的目录；收尾失败不能吞掉原始测试失败，也不能悄悄报告成功。
- 保留 `--test-concurrency=1`。当前 runner 串行运行，共享 SQLite/native fixture 要保持确定性，不因提速改成并发。
- 清理只作用于本次运行拥有、已核对绝对路径的临时目录，不扫描并删除整个系统 temp、其他进程目录或旧 `.tmp`。历史目录清理另行核对归属和授权。

**同步状态：**当前 `main` 尚无 `tests/helpers/temp.mjs`，unit runner 没有 `clearTempRoot()`，smoke 仍写 `.tmp`，多个旧测试也仍如此。用户报告今晚已修复，但该补丁尚未出现在此代码基线；先核对补丁/提交再复用或实现，不把这里的目标规则说成已完成。新增 fixture 前先同步或建立统一 helper，不能用各自清理代替 runner 的统一兜底。

## 数据库与迁移

- `no such table` 涉及 `mnemora`/`mnemos` 前缀时，除了目标表，也检查获授权数据库的 `sqlite_master` 中 `type='trigger'` 的对象及其 SQL。用户报告拼错名的 `trg_mnemos_...` 挂在 `AFTER INSERT` 上，正确 trigger 同时存在，结果所有写入仍失败。
- 不按名称相似或报错猜测直接删 trigger。先确认所属表、事件和引用目标，在隔离副本复现并与迁移代码比较；生产修改与恢复要走相应授权流程。
- 迁移目标以代码为准。已核对 `src/store.ts` 的 `migrateReasoningVerificationV65()`：给 `mnemora_reasoning_memories` 加 `verification_json`，不是 `kg_nodes`。
- `SUPPORTED_SCHEMA_VERSION` 在本基线为 **83**，权威来源是 `src/schema.ts`。没有 schema 变更的升级不要提高版本或追加迁移；有变更须同时验收旧库升级、数据保留与重启。
- 用户报告 `corpus_status=ready` 时仍因 lifecycle 表缺失而 `store` 失败。ready 不能替代写路径验收：在隔离库走公共 store→read 与 lifecycle 回归；生产写入探针须有单独授权，不为检查擅自写入日常记忆。

## 配置与 CLI

- `consolidation` 位于 `plugins.entries.mnemora.config` 顶层，不在 `cognition` 下；`src/config.ts` 与 `openclaw.plugin.json` 已核对。用户报告错误层级导致 `InvalidConfigError` 和 gateway 崩溃循环。改配置前通过实际宿主的 `gateway config.schema.lookup` 核对层级；先确认该版本接口可用，不假定这里的接口名称就是所有版本的 CLI 语法。
- 从复制安装的扩展目录执行 CLI 时，不假定有全局 bin；先确认实际执行入口的版本，必要时直接调用该目录的 `node dist/cli.js`。
- “CLI 默认连错库”是历史故障，**v1.30.1 已修复**：当前 `src/identity.ts` 默认 `~/.openclaw/mnemora.db`，新建持久库时提示实际路径。排查和升级仍显式给 `MNEMORA_DB`，核对路径与目标安装，不能从全零指标直接判断数据丢失。旧全局入口可能仍带旧行为。
- 不为补材料读取生产 SQLite/WAL/SHM，评估使用授权材料与隔离环境；任务续接文件评估命令从 v1.31.7 起不打开记忆库。

## 升级验收与重启

用户的 Mac 升级基线为 checkout → 安装依赖 → 构建 → 全量单测 → `plugin:validate` → 重启后对比持久状态。执行前核对具体提交、安装入口、支持的 Node 与当前项目脚本，不把裸 `tsc` 当作包含 Inspector/CLI 权限处理的完整构建。

- 锁文件不变的可复现验证优先按项目 CI 使用 `npm ci`；只有确实调整依赖时更新 lock。不要把 `npm install` 造成的无关漂移混入提交。
- 升级前后记录三组同范围基线：`kg_stats` 的 nodes/edges/observations/embedding_health；corpus 的 docs/chunks；数据库文件体积。注明时间、scope、库路径/入口与采集方法，不公开私密路径。体积变化不是单独的数据完整性结论；确认重启后仍用同一目标库。
- 本工作区不能代替 Mac 上的真实 gateway 重启验收；未执行的步骤明确留待 Mac agent。
- 用户报告 gateway 的 safe restart 有 deferral 语义：pending replies/runs 可能阻挡当前重启，补发请求若不撤销，drain 后可能二次重启。编排保留单一请求身份，核对接受/延迟/取消/实际完成状态，做到幂等；若选择跳过 deferral，也必须先确认实际宿主支持和相应授权，不盲目补发或强制重启。
- 开发交付继续按既有规则提交；版本发布须等同一提交的 Windows/Linux CI 都成功，不挪用旧提交的绿灯。

## 兼容性基线：不要混淆部署与默认值

| 项目 | 用户提供的 Mac 部署基线 | 本代码基线核对结果 |
| --- | --- | --- |
| Embedding | Ollama `qwen3-embedding:4b`，2560 维 | Ollama/model 名称与配置契约一致；2560 是部署记录，不是本次调用测量。迁移测试使用小维度 fixture，不能当作生产维度证明。 |
| Journal | `maxInlineChars=16000`、`maxEventBytes=256KB`、永久 retention | `conversationJournal` 默认分别为 16000、262144 字节、`retentionDays=0`；0 表示不按天淘汰。 |
| Recall | `maxNodes=10 / maxDepth=3 / tokenBudget=1200` | 当前 `normalizeConfig().recall` 的图谱参数默认是 **5 / 1 / 800**。`recall.autoRecall` 是已退役的兼容键，不启用 prompt hook；自动注入另核对 ContextEngine/unifiedRetrieval，不能从这些图谱参数推断。 |

- 切换 embedding 模型、维度或输入版本，必须走向量身份兼容与迁移路径；保留 `tests/embedding-migration.test.mjs` 的 exact-identity 回归，不能仅改配置后继续使用旧向量。
- 不在维护工作中顺手改变 Journal/ContextEngine/recall 限额和 retention。先核对实际有效配置，区分图谱 recall、统一检索与其他投递的预算；改动要有对应行为测试，部署基线变更需明确记录。

## 仓库卫生与改名

- 提交前审查 `package-lock.json`，只保留本任务必要变化。用户报告一次撤回了 888 行无关漂移；不要因此整份覆盖锁文件并丢掉别人的改动。
- 升级脚本可能留下 `dist.bak-v*`。本基线 `.gitignore` 只忽略 `dist/`，尚未单独忽略该备份模式；备份先核对是否仍用于恢复，再选择保留并忽略或有授权地清理，不混入发布。
- 脚本、模型名、配置键、接口改名或退役时，使用 `rg` 搜索全部引用方，覆盖源码、测试、package scripts、CI、文档和已知外部运行脚本。公开入口先考虑兼容或显式错误；引用方不会自动跟随改名，验收调用链，防止静默带病运行。

## 本基线待处理

1. 核对并同步用户报告的统一 temp helper、unit/smoke 收尾补丁；验收失败路径和退出码，再迁移遗留 `.tmp` fixture。没有授权时不清理历史目录。
2. 若仓库仍产生 `dist.bak-v*`，确定归属与恢复需求后补忽略/安全清理策略。
3. 真实 Mac 的配置、2560 维身份、写路径和 gateway 升级/重启验收，仍由有访问权限的 Mac agent 执行和报告。
