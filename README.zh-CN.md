# Mnemora

[English](README.md)

> 面向长期 OpenClaw Agent 的本地优先、证据优先记忆运行时。

Mnemora 让 Agent 保留真正有用的长期上下文，但不会把每一段被召回的文本都当作事实。它把持久化记忆保留在本地，为每条内容保存来源，并在进入 Agent 上下文前执行 scope、时效性、置信度和安全策略。

```text
对话 / 笔记 / 公开 Provider
           │
           ▼
Journal + 带来源的记忆 + 知识图谱
           │
           ▼
作用域检索、压缩与可信策略
           │
           ▼
OpenClaw ContextEngine
```

## Mnemora 整合了什么

Mnemora 是独立实现，设计上借鉴了 `lossless-claw` 与
`memory-lancedb-pro` 的公开思路：

- 借鉴 lossless 类系统的持久会话捕获、有界压缩、可恢复摘要和最近上下文保护；
- 借鉴向量记忆系统的本地语义/词法检索、相关性排序、rerank 和记忆生命周期控制；
- 在此之上整合并改进为：带来源的图谱证据、严格 scope 隔离、Journal/Episode/Artifact/Memory 的统一检索、可解释的上下文、显式更正与遗忘，以及 preview/confirm 治理流程。

它不复制、不 vendor、不读取或修改这两个项目的私有代码、数据库或宿主状态。外部系统只能通过已文档化的公开能力和显式 Provider Adapter 接入。

## 核心能力

- **唯一自动生命周期。** 仅在被选为 OpenClaw ContextEngine 时，Mnemora 才使用公开的 `afterTurn` 与上下文组装生命周期；不会额外注册 `before_prompt_build` 或 `agent_end` hook。
- **本地优先记忆。** 本地 SQLite 保存 Journal、带来源摘要、Episode、Artifact、记忆文档、图谱证据、Belief、Decision 和审计元数据。
- **有界相关召回。** 统一的词法、语义与混合检索结合 scope 过滤、分数下限、多样性、时效性、token 预算和 provenance 去重。
- **证据与可信度。** 图谱 observation 保留来源、时间、置信度和验证状态。LLM 可以提出候选，但不能成为记忆权威。
- **可安全演化。** 更正、冲突、保留与遗忘都有审计链；高影响操作均通过 preview/confirm 执行。
- **可运维、可解释。** 本地 Inspector 和 `mnemora` CLI 提供诊断、召回解释、trust 操作和质量评估。

## 快速开始

Mnemora 需要 OpenClaw `2026.6.11+` 和 Node.js `24`。

```bash
git clone https://github.com/rrriiiccckkk/mnemora.git
cd mnemora
npm ci
npm run build
```

按你的 OpenClaw 插件安装方式安装构建产物，然后在宿主配置中启用 Mnemora 并选择其 ContextEngine slot：

```json5
plugins: {
  entries: {
    mnemora: {
      enabled: true,
      config: {
        conversationJournal: { enabled: true },
        contextEngine: { enabled: true },
        episodicMemory: { enabled: true },
        unifiedRetrieval: {
          enabled: true,
          shadowMode: true, // 记录有界、脱敏的自动召回遥测
          tokenBudget: 800,
          maxItems: 8,
          diversityLambda: 0.75
        }
      }
    }
  },
  slots: { contextEngine: "mnemora" }
}
```

这是刻意要求显式开启的：在宿主选中准确 slot 前，Mnemora 保持仅手动模式。可用以下命令检查本地部署状态：

```bash
mnemora standalone status
mnemora standalone guide
```

### 自动召回精度

手动搜索可以为了探索返回较宽的候选集；自动上下文则更严格。Mnemora 在附加本地
记录或图谱补充前，要求候选中存在非通用 query 锚点，或图谱语义分数至少为 `0.72`。
图谱最多使用一个 seed（加一跳有证据的邻域），本地记录再经过确定性的 MMR 去重，
避免近重复内容。因而像“这个 memory system 如何工作？”这类泛化问题，不会只因
公司描述中包含 “memory” 就注入该公司；没有可证明相关候选时，保持空注入才是安全
结果。

`unifiedRetrieval.shadowMode` 为显式 opt-in，只保存 query hash 以及本地/图谱候选、
抑制和附加的有界计数；不会保存 prompt、候选正文、ID、来源或证据。可与现有的
adaptive-recall 指标一起查看：

```bash
mnemora recall metrics --scope default
```

输出中的 `unified` 是真实 ContextEngine 附加路径的遥测，不会改变检索或注入。
设为 `diversityLambda: 1` 可保留纯分数排序；保留默认 `0.75` 则启用适度、确定性的
多样化。

### 图谱卫生与本地 embedding 健康状态

通过 `kg_review` 的 `kind: "hygiene"` 可读取 scope 隔离的 `related_to` 过度使用、
可疑自链接与三档拓扑评估。评估对比当前 PPR 权重、0.3× 降权和完全移除，并报告
连通性及代表性 top-k 的变化；它绝不会修改实际 PPR 或遍历策略。新的 `related_to`
必须保留直接证据，默认置信度阈值为 `0.85`。传入 `scan: true` 时，只执行一个有界的
重复实体候选扫描切片；不会合并实体、删除边或修改证据。只有需要每周在 durable turn
后自动执行该审查时，才显式开启：

```json5
quality: {
  hygiene: {
    enabled: true,
    intervalHours: 168,
    maxDuplicateScanNodes: 100
  }
}
```

该诊断**不会**自动改变拓扑策略。若某条历史 `related_to` 的原始证据直接表达了结构事实，
可通过 `kg_review` 的 `kind: "related_edge_refinements"` 并传入 `scan: true` 发起单独的
人工审查。它只会基于同 scope、置信度 `≥ 0.85` 的直接证据，提出 `depends_on`、`part_of`
或 `instance_of` 候选。必须先 preview，再用匹配的显式 confirm 才会复制证据、仅退休被审查
的那一条 fallback 边并写入审计回执；不会调用 LLM、不会依据宽泛共现，也不会自动改图。

若原文是直接的语义陈述、但仍需保留连通骨架，可改用 `kind: "related_edge_semantics"`。
它会从既有词表中提出 `uses`、`develops`、`works_at`、`supplies` 等标签；preview/confirm
接受后，仅让该标签可被显式语义关系查询返回。原 `related_to` 边会保留，PPR、遍历、
observation 与图权重都不会改变。

使用 `kg_review` 的 `kind: "worklist"` 可以在同一 scope 内分页查看只读的待处理
自链接、已拒绝候选，以及已变为 `invalidated` 的待处理候选。`invalidated` 是持久化的
审查元数据：候选所依赖的精确 fallback 边或证据已不再匹配，因此不能再 preview 或
confirm。读取 worklist 最多会记录这一失效状态；不会删除边、证据、候选或审查回执。
应重新运行对应的 refinement 或 semantic scan，让当前证据生成新的候选。

`kg_stats` 的 `embedding_health` 是已观察到的本地状态，不会为读取状态发起 Provider
探测。`healthy`/`degraded` 只取决于有界 embedding 成功或类别化失败；`hybrid` 搜索会
确定性地退回词法结果，显式 `semantic` 搜索则返回有界的不可用错误。

### 可选服务

- `embeddings.enabled`：使用本地 Ollama 的语义检索，默认关闭。
- `quality.hygiene.enabled`：在 durable turn 后调度有界、只审查的重复实体扫描，默认关闭；实体合并仍需 preview/confirm。
- `extraction.enabled`：有边界的 OpenAI-compatible 关系抽取，默认关闭。
- `contextEngine.compaction.enabled`：带来源的模型压缩，默认关闭。
- `cognition.admission.mode: "enforce"`：确定性候选策略；Belief 和 enforcement 仍需各自显式开启。
- `cognition.reasoningRuntime.shadowMode`：只记录安全的策略检索聚合遥测；ReasoningMemory 投递仍默认关闭，必须由 operator 校准并为精确 scope 显式开启 canary。
- `cognition.reasoningRuntime.semantic.enabled`：只有同时开启 `embeddings.enabled` 时，才启用独立的本地 ReasoningMemory 语义索引。默认关闭；Provider 失败时自动退回确定性词法检索。
- `cognition.reasoningRuntime.verification.enabled`：在 durable completed turn 后运行有界、本地、确定性的策略验证。默认关闭；不会开启投递，也不会让策略成为权威事实。
- `cognition.reasoningCuration`：可选地在 durable turn 后使用 host 公开提供的 runtime LLM，生成来源关联的决策/结果候选、策略候选并定期审查已有策略。全部默认关闭；不会自动创建用户事实、准入策略或改变投递状态。

所有模型或网络调用都有输入/输出上限、超时和取消处理。默认安装不会开启额外自动写入、严格验证、模型压缩或外部 Provider。

### 受治理的推理 intake、积累与审查

人工编写、相对静态的指令文件适合保存这类内容。Mnemora 的可选 curation
路径则用于有来源、会演化的操作策略：它把已确认 outcome、有界的模型候选、
审查状态与后续每一次人工决定一起保存在本地数据库中。

只有在配置好 ContextEngine 后才建议显式开启。Curation 只会在一次
*durable completed turn* 之后、且 OpenClaw 公开提供了 runtime LLM 时机会性运行；
它不会读取 host 私有模型状态或凭据。

```json5
cognition: {
  reasoningCuration: {
    intake: { enabled: true }, // 每个 turn 最多两个决策/结果候选
    formation: { enabled: true }, // 每个 turn 最多一个有 outcome 支撑的候选
    review: { enabled: true, intervalHours: 168 } // 每周一次咨询性审查
  }
}
```

Intake 会先创建有来源的 `pending_review` 候选，不会自行创建 decision、outcome、
belief、事实、profile 或策略。operator 审阅后只能确认或丢弃；确认产生的 decision
仍是 `operator_confirmed`，不会被自动断言为用户事实。确认的 outcome 才会在后续
durable turn 中成为 formation 的输入。

Formation 只从置信度足够的、人工确认过的 TaskOutcome 开始。模型输出会以
`pending_review` 保存，不会直接成为 ReasoningMemory。operator 必须先提升候选，
再执行既有的独立准入步骤，它才可能进入检索。定期审查只能建议 `retain`、`retire`
或 `needs_review`；最终仍由人处理。`retire` 是可追溯的生命周期状态，不会破坏性删除。

```bash
mnemora cognition reasoning intake candidates --scope project:alpha
mnemora cognition reasoning intake confirm <candidate-id> --scope project:alpha
# 使用返回的 preview hash，再加 --preview-hash <hash> --confirm 执行。
mnemora cognition reasoning intake discard <candidate-id> --scope project:alpha

mnemora cognition reasoning curation formations --scope project:alpha
mnemora cognition reasoning curation promote <formation-proposal-id> --scope project:alpha
# 使用返回的 preview hash，再加 --preview-hash <hash> --confirm 执行。
mnemora cognition reasoning admit <reasoning-memory-id> --scope project:alpha

mnemora cognition reasoning curation reviews --scope project:alpha
mnemora cognition reasoning curation resolve-review <review-proposal-id> retire --scope project:alpha
# 使用返回的 preview hash，再加 --preview-hash <hash> --confirm 执行。
```

关于失败、重试、scope 与审查语义，见[受治理的 Reasoning curation](docs/reasoning-curation.md)。

### 实验性 ReasoningMemory 投递

ReasoningMemory 把可复用的操作策略与个人事实分开保存。即使策略已经准入，运行时投递仍默认关闭。先开启 shadow 收集并检查 readiness，再只对一个精确 scope 显式校准、开启 canary：

```json5
cognition: {
  reasoningRuntime: {
    shadowMode: true,
    scopes: ["project:alpha"],
    delivery: {
      enabled: true,
      scopes: ["project:alpha"],
      itemRetentionDays: 30
    }
  }
}
```

每次投递的策略都会被包裹为 `non_authoritative_reference`，并获得一条短期回执。operator 可以把回执标为 helpful/neutral/harmful；或由 operator 确认的任务 outcome 显式引用回执，形成确定性反馈。harmful 信号只会抑制该 scope 下的这一条策略。`effectiveStatus` 只表示最新回执信号，不代表可以重新投递；memory circuit 必须由 operator 显式 reset 才会关闭，处于关闭前状态的 item 会标出 `requiresOperatorReset`。reset 会新增一条仅追加的 item correction，保留原有 harmful 历史。它不会把策略变成 belief、事实或图谱边，也不会自动关闭整个 canary。

配置过的 scope 已在 shadow 模式运行后，应先查看一份 readiness 报告再创建 calibration。报告会使用最新的 live runtime policy snapshot，因此 operator 无需在 CLI 中重建插件配置。snapshot 只保存有界的策略控制项和聚合计数，绝不保存 prompt、策略正文、memory ID、证据、来源或 Provider 凭据。

```bash
mnemora cognition reasoning runtime-diagnostics --scope project:alpha
mnemora cognition reasoning runtime-calibrate --scope project:alpha
# 使用返回的 preview hash 加 --confirm 再执行一次，然后才可开启精确 scope 的 canary。
```

在 scope 尚未进入 live runtime 前，diagnostics 会返回 `policy_not_observed`，不能让该 scope 变为 ready。只有 operator 确认 calibration 且精确 scope 的 canary 都存在时，delivery 才可能开启。

```bash
mnemora cognition reasoning runtime-delivery-items --scope project:alpha
mnemora cognition reasoning runtime-feedback-summary --scope project:alpha
mnemora cognition reasoning runtime-memory-circuit <reasoning-memory-id> --scope project:alpha
```

`mnemora cognition reasoning find` 是供 operator 审计/查看目录的命令，因此可能展示已被抑制的策略文本；需要经过 circuit 过滤的选择请使用 `retrieve`、`compile` 或 runtime delivery。

若要衡量投递是否真的改善任务结果，使用 `mnemora cognition reasoning runtime-effectiveness <file>` 运行去标识化 A/B 数据集。只有 operator 声明的随机对照且每一组至少有 20 条已判定 outcome 时，才会给出非因果的点估计和保守的 95% 区间；shadow 遥测、采用率、合成 benchmark 与旧版 v1 数据集都不能当作效果结论。

operator 还可以为待准入策略附上[有界、确定性的验证说明](docs/reasoning-verification.md)。它只会在本地 append-only ledger 中比对明确 receipt 引用与规范化工具结果；不匹配仅打开对应策略的 delivery circuit，直到 operator 显式 reset。它不会调用模型、网络或工具，也不会把策略升级为 belief 或事实。自动处理仍默认关闭：

```json5
cognition: { reasoningRuntime: { verification: { enabled: true, maxJobsPerRun: 5 } } }
```

### 可选的多语言 ReasoningMemory 检索

策略文本与运行时任务可以使用不同语言。要让中文策略能够被英文 `debug` 任务命中（反之亦然），需要同时显式开启现有本地 Ollama embedding Provider 与独立的 ReasoningMemory 语义路径：

```json5
embeddings: { enabled: true, provider: "ollama", model: "qwen3-embedding:4b" },
cognition: {
  reasoningRuntime: {
    shadowMode: true,
    scopes: ["project:alpha"],
    semantic: { enabled: true, timeoutMs: 1500, minScore: 0.35, maxCandidates: 50 }
  }
}
```

建索引是显式的本地操作：不会在策略准入或普通 prompt 组装时自动执行。`semantic-backfill` 必须确认，只保存向量字节、模型身份、输入哈希和 scope，不保存策略正文或证据。独立 CLI 也要求明确启用本地 embedding：

```bash
MNEMORA_REASONING_SEMANTIC_EMBEDDINGS=1 mnemora cognition reasoning semantic-status --scope project:alpha
MNEMORA_REASONING_SEMANTIC_EMBEDDINGS=1 mnemora cognition reasoning semantic-backfill --scope project:alpha --confirm
```

如果修改了 embedding 模型配置，请再次执行已确认的 backfill；它会识别模型身份变化并刷新本地策略索引。

shadow 报告提供聚合的 `semanticCandidates`、`unmatched` 和 `taskTypeExcluded` 计数，不会持久化 prompt、策略、memory ID 或来源内容。

## 安全模型

- 记忆是参考材料，不是指令，也不是权威来源。
- 检索和上下文组装前都会执行 scope 隔离。
- 摘要用于导航证据，不替代原始证据。
- 自动抽取产生受策略约束的候选，不能自行创建可信用户事实。
- Provider 迁移只使用公开接口，分页、preview-first 且可恢复。
- loopback Inspector 默认只读，会脱敏原始 prompt、凭据、Provider 响应和私有路径。

## 日常操作

```bash
mnemora inspect
mnemora surface core
mnemora retrieve "这个项目有哪些既有决策？"
mnemora evaluate recall-quality ./deidentified-golden.json
```

随包的 `/mnemora` 命令只提供只读状态、诊断和显式 canonical corpus 操作。可选择 `core`、`research` 或 `full` 工具面来控制 Agent 收到的工具 schema 数量；为兼容性，默认值是 `full`。

## 边界

Mnemora 是本地记忆运行时，不是会自动构建人格画像的系统。它不会把人格推断写成事实，不访问宿主/其他插件的私有存储，也不会静默跨项目 scope 召回。没有公开 inventory 的 Provider 只能使用显式 reference。

## 开发

```bash
npm run verify
```

该命令在 Node.js 24 上执行 typecheck、单元测试、构建、smoke、插件校验、兼容性校验和离线质量基准。

## 许可证

[MIT](LICENSE)
