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
        unifiedRetrieval: { enabled: true, tokenBudget: 800, maxItems: 8 }
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

### 可选服务

- `embeddings.enabled`：使用本地 Ollama 的语义检索，默认关闭。
- `extraction.enabled`：有边界的 OpenAI-compatible 关系抽取，默认关闭。
- `contextEngine.compaction.enabled`：带来源的模型压缩，默认关闭。
- `cognition.admission.mode: "enforce"`：确定性候选策略；Belief 和 enforcement 仍需各自显式开启。
- `cognition.reasoningRuntime.shadowMode`：只记录安全的策略检索聚合遥测；ReasoningMemory 投递仍默认关闭，必须由 operator 校准并为精确 scope 显式开启 canary。
- `cognition.reasoningRuntime.semantic.enabled`：只有同时开启 `embeddings.enabled` 时，才启用独立的本地 ReasoningMemory 语义索引。默认关闭；Provider 失败时自动退回确定性词法检索。
- `cognition.reasoningRuntime.verification.enabled`：在 durable completed turn 后运行有界、本地、确定性的策略验证。默认关闭；不会开启投递，也不会让策略成为权威事实。
- `cognition.reasoningCuration`：可选地在 durable turn 后使用 host 公开提供的 runtime LLM，生成可审阅的策略候选并定期审查已有策略。两条路径默认关闭；都不能自动创建、准入、保留或退役策略。

所有模型或网络调用都有输入/输出上限、超时和取消处理。默认安装不会开启额外自动写入、严格验证、模型压缩或外部 Provider。

### 受治理的策略积累与审查

`AGENTS.md` 适合人工编写、相对静态的指令。Mnemora 的可选 curation
路径则用于有来源、会演化的操作策略：它把已确认 outcome、有界的模型候选、
审查状态与后续每一次人工决定一起保存在本地数据库中。

只有在配置好 ContextEngine 后才建议显式开启。Curation 只会在一次
*durable completed turn* 之后、且 OpenClaw 公开提供了 runtime LLM 时机会性运行；
它不会读取 host 私有模型状态或凭据。

```json5
cognition: {
  reasoningCuration: {
    formation: { enabled: true }, // 每个 turn 最多一个有 outcome 支撑的候选
    review: { enabled: true, intervalHours: 168 } // 每周一次咨询性审查
  }
}
```

Formation 只从置信度足够的、人工确认过的 TaskOutcome 开始。模型输出会以
`pending_review` 保存，不会直接成为 ReasoningMemory。operator 必须先提升候选，
再执行既有的独立准入步骤，它才可能进入检索。定期审查只能建议 `retain`、`retire`
或 `needs_review`；最终仍由人处理。`retire` 是可追溯的生命周期状态，不会破坏性删除。

```bash
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
