# Mnemora

[English](README.md)

> 本地优先、证据优先的 OpenClaw 持久 agent 记忆插件。

Mnemora 把 agent 的对话记录到本地 SQLite journal，在每次新提问时，自动附上最相关的几条历史记录，并带上来源。agent 因此可以跨会话接续工作，说明某条记忆从哪里来，并在被更正或要求遗忘后不再使用它。被召回的内容只是参考资料，不是指令，也不是自动核实过的事实。

Mnemora 是独立实现，参考了 `lossless-claw` 和 `memory-lancedb-pro` 公开的设计思路，不读取其他插件的私有存储。

## 能做什么

- **跨会话召回**：在 token 预算内自动附上相关的历史对话，每条都带来源引用和记录时间。
- **agent 互相隔离**：默认按 agent 隔离记忆，一个 agent 看不到另一个 agent 的记录。
- **接续任务**：查看已完成的工作、失败的尝试、阻塞点和下一步，附来源链接，不确定的地方明确标出。
- **检查记忆内容**：本地 Inspector 展示证据、待确认候选、过期记录和冲突。
- **有意识地更正和遗忘**：按范围更正和遗忘，影响较大的修改先预览再确认；被遗忘的文本同时从检索索引和向量中删除。

## 召回如何工作

1. **记录**：完成的对话轮次经 ContextEngine 写入 journal，切成相互重叠的分块，建立 bm25 全文索引（中文先分词）。
2. **可选的语义索引**：开启本地 embedding 后，每轮结束由你的 Ollama 模型为新分块生成向量。
3. **检索**：对提问做词面匹配，有向量时同时做语义匹配，再按相关度、来源可信度和新旧程度排序。
4. **过滤**：只与提问共享常见词的记录会被丢弃。有向量时，词面命中还必须在语义上接近；语义足够接近的记录即使没有共同词也可以注入。
5. **注入**：在 `tokenBudget` 内最多注入 `maxItems` 条，放在非权威的引用信封里。同一话题较早的记录会标注 `newer_related` 指向较新的记录，模型可以据此判断哪条陈述是当前的。

## 快速开始

需要 OpenClaw `2026.9.2+`，Node.js 需为 24.x 上的 `24.15.0+`，或 `25.9.0+`（包括 Node 26）。本地默认使用 Node 26.5.0，不需要降级到 Node 24。CI 在 Linux 和 Windows 上验证 Node 24.19.0 与 26.5.0。兼容性细节见[使用指南](docs/usage-guide.zh-CN.md)。

### 安装

优先使用 [GitHub Releases](https://github.com/rrriiiccckkk/mnemora/releases) 中的 `mnemora-<version>.tgz`，不要用源码压缩包。每个发布包都经过干净重建、解包验证后才上传，并附有 `SHA256SUMS`。从源码构建：

```bash
git clone https://github.com/rrriiiccckkk/mnemora.git
cd mnemora
npm ci
npm run build
```

每次更新源码后都要重新构建；`npm run release:pack` 会生成经过验证的安装包。仅凭版本号无法证明 `dist/` 是最新的。

### 配置

按 OpenClaw 的插件流程安装构建好的插件，然后把下面的配置合并进宿主配置：

```json5
plugins: {
  entries: {
    mnemora: {
      enabled: true,
      config: {
        conversationJournal: { enabled: true },
        contextEngine: { enabled: true },
        episodicMemory: { enabled: true },
        unifiedRetrieval: { enabled: true, tokenBudget: 800, maxItems: 8 },
        // 可选：通过 Ollama 开启本地语义召回
        // embeddings: { enabled: true, provider: "ollama", model: "all-minilm" }
      }
    }
  },
  slots: { contextEngine: "mnemora" }
}
```

重启加载该插件的 OpenClaw 进程。自动记录和上下文组装要求宿主把 ContextEngine 槽位指向 Mnemora，只启用插件是不够的。Mnemora 只使用一套 ContextEngine 生命周期，不注册 `before_prompt_build` 或 `agent_end` 钩子。

开启语义召回：执行 `ollama pull all-minilm`（中文历史建议用 `bge-m3` 这类多语言模型），打开 `embeddings`，再为已有历史一次性生成向量：

```bash
MNEMORA_DB=~/.openclaw/mnemora.db node dist/cli.js journal embed --model all-minilm
```

### 验证运行中的安装

在构建好的插件目录中执行：

```bash
node dist/cli.js standalone status
node dist/cli.js standalone guide
```

在聊天中执行 `/mnemora verify start`，把它给出的标记原样写进一条简短事实，在另一个会话里询问这个标记，确认记忆确实被注入后再执行 `/mnemora verify`。这一步检查运行时激活、持久记录和跨会话注入；只看事件数量不能证明插件在工作。详见[首次使用验收](docs/usage-guide.zh-CN.md#验收首次使用)。

## 日常使用

在构建好的插件目录中执行：

```bash
MNEMORA_DB=~/.openclaw/mnemora.db node dist/cli.js stats
node dist/cli.js health
node dist/cli.js inspect
node dist/cli.js resume "deployment task" --scope project-a
```

`health` 列出最近 7 天失败过的可选操作（召回、embedding、压缩等失败时都会 fail-open，宿主照常工作）。CLI 默认使用 `~/.openclaw/mnemora.db`。如果部署使用其他路径，请显式设置 `MNEMORA_DB`。OpenClaw 安装扩展时不一定会创建全局 `mnemora` 命令，上面的直接调用方式不依赖它。

任务续接是只读的：不会执行计划，也不会确认候选。有歧义的任务在被选中前保持分开；选中的任务可以附带有长度上限的 `source_evidence` 原文摘录，但不会因此升级为已接受的任务状态。见[来源证据与复跑](docs/task-resume-source-evidence.zh-CN.md)。

需要按时间截断历史时，使用 `INTENT=exact_history RECORDED_BEFORE=<Unix 毫秒> node dist/cli.js retrieve "query"`。它只返回原始记录，绝不会恢复已遗忘的数据。

## 关键配置

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `scope.isolation` | `"agent"` | 每个 agent 使用独立范围 `agent:<id>`；默认 agent（`scope.defaultAgentId`，即 `main`）沿用 `scope.default`。设为 `"shared"` 时所有 agent 共用一个范围。 |
| `toolSurface` | `"core"` | 10 个日常记忆工具。`"research"` 增加分析和保存的查询；`"full"` 开放全部 32 个。 |
| `unifiedRetrieval.tokenBudget` / `maxItems` | 800 / 8 | 每次提问注入记忆的上限。 |
| `unifiedRetrieval.minQueryMatch` | 有向量时 0.15，否则 0 | 记录至少要覆盖的提问词比例（按稀有度加权）。 |
| `embeddings.enabled` | `false` | 用本地 Ollama embedding 做语义召回。 |
| `unifiedRetrieval.semantic.minSimilarity` / `gateSimilarity` | 0.45 / 0.2 | 余弦阈值，在 `all-minilm` 上校准；换模型需要重新校准。 |

压缩、抽取、认知层、信任层等其余配置见[使用指南](docs/usage-guide.zh-CN.md)。

## 召回质量

在 [LongMemEval_S](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) 上，走真实的自动注入路径，预算 800 token、最多 8 条。"会话命中"指注入的记录来自包含答案的会话；"轮次命中"指注入的记录就是答案所在的轮次。"无关提问"借用其他测试题的问题，其证据不在被检索的历史中。

| 版本 | 会话命中 | 轮次命中 | 偏好类问题 | 无关提问仍注入记忆 |
|---|---|---|---|---|
| 1.32.18 | 9.8% | 5.5% | — | — |
| 1.33.0 | 93.8% | 83.2% | 56.7% | 90.6% |
| 1.34.0，纯词面 | 93.6% | 82.6% | 53.3% | 90.6% |
| 1.34.0，`all-minilm` 向量 ¹ | 82.8% | 70.7% | 73.3% | 66.7% |
| bm25 基线，相同预算 | 94.9% | 81.5% | 70.0% | — |

¹ 60 题子集（全部 30 道偏好题加随机 30 道其他题），不能与 500 题的行直接比较。同一子集上纯词面召回为 72.4% / 65.5% / 53.3% / 85.0%；非偏好题两种方式都是 92.9% 会话命中。详见[召回质量](docs/recall-quality.md)。

以上是检索层指标。复现：`npm run eval:longmemeval`。

端到端答题准确率（1.35.0）：同样 500 道题，由阅读模型根据注入的记忆作答，再由评判模型打分（均为 MiMo V2.6 Pro），预算同为 800 token。

| 题型 | 不用记忆 | bm25 基线 | Mnemora 1.35.0 |
|---|---|---|---|
| **总体** | 7.6% | 67.8% | **72.6%** |
| 单会话·用户信息 | 0% | 90.6% | 92.2% |
| 单会话·助手回复 | 12.5% | 91.1% | 91.1% |
| 单会话·偏好 | 0% | 40.0% | 43.3% |
| 跨会话 | 0% | 41.3% | 48.8% |
| 时间推理 | 0.8% | 63.0% | 68.5% |
| 知识更新 | 0% | 83.3% | 90.3% |
| 拒答 | 100% | 93.3% | 96.7% |
| 平均上下文 token | 0 | 774 | 672 |

复现：`npm run eval:longmemeval-qa`（需要一个 OpenAI 兼容接口）。

## 安全与边界

- **来源不等于确认**：用户的请求不能证明任务已完成；助手的汇报也不是独立核实。
- **范围和生命周期很重要**：失效或已遗忘的来源不能让已接受的工作复活；不确定的证据始终明确标为不确定。
- **召回内容不能发号施令**：它被放在非权威信封中引用，角色行和覆盖指令类措辞会被中和。
- **本地优先不等于完全离线**：配置的模型、embedding 或其他服务可能产生外部调用。
- **无法回答的问题仍会得到上下文**：答案不在历史中时，通常仍会注入最接近的记录，需要阅读模型自己判断它们并不能回答问题。

攻击面和防护措施见[威胁模型](docs/threat-model.md)。

## 文档

先读[使用指南](docs/usage-guide.zh-CN.md)，其中包含完整配置、首次使用检查、更正流程和运维命令。

- **召回**：[召回质量](docs/recall-quality.md)、[阈值评估](docs/recall-threshold-evaluation.md)、[注入回执](docs/recall-attachment-evidence.zh-CN.md)、[有用性边界](docs/recall-usefulness-review.zh-CN.md)、[相关度影子评估](docs/recall-relevance-shadow.md)和[相关度评估](docs/recall-relevance-evaluation.md)。
- **任务续接**：[评估](docs/task-resume-evaluation.md)、[来源证据](docs/task-resume-source-evidence.zh-CN.md)、[一键回归](docs/task-resume-regression.zh-CN.md)和[正式三臂实验](docs/task-resume-experiment-runner.zh-CN.md)。
- **可选分类器**：[语义准入分类器](docs/semantic-classifier.md)。
- **规划**：[路线图](docs/roadmap.md)和[发布说明](docs/releases/v1.35.0.md)。

## 开发

添加测试夹具、修改存储或配置、升级部署之前，请先阅读[维护经验](docs/maintenance-lessons.zh-CN.md)。

```bash
npm run check
npm run verify:fast
npm run test:host
npm run verify
```

完整验证包括串行单元测试、构建、浏览器检查、基准测试（含固定召回探针）、插件校验、冒烟测试和 SDK 兼容性门禁。发布标签要求同一提交在 Windows 和 Linux 上的 CI 全部通过。隔离宿主、项目试运行和持久项目记忆顾问见[本地开发](docs/development.md)。

## 许可证

[MIT](LICENSE)
