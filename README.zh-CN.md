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

所有模型或网络调用都有输入/输出上限、超时和取消处理。默认安装不会开启额外自动写入、严格验证、模型压缩或外部 Provider。

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
