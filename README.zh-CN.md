# Mnemora

[English](README.md)

> 面向长期 OpenClaw Agent 的本地优先、证据优先记忆。

Mnemora 帮助 Agent 跨会话接着做事，找到记忆的来源，并在用户更正或遗忘后更新行为。
记忆保存在本地 SQLite；召回文本是参考材料，不是指令，也不会自动成为已验证事实。

## 你能用它做什么

- **继续任务**：查看已完成动作、失败尝试、阻塞和下一步，保留来源与不确定性。
- **检查记忆**：用本地 Inspector 审查证据、待确认候选、过时记录和冲突。
- **主动更正与遗忘**：按 scope 操作，重要变更通过 preview/confirm 确认。
- **控制召回范围**：结合词法与语义检索、时效性、安全检查和 token 预算。

Mnemora 是借鉴 `lossless-claw` 与 `memory-lancedb-pro` 公开思路的独立实现，不读取其他插件的私有存储。

## 快速开始

需要 OpenClaw `2026.9.2+` 与 Node.js `24.15.0+`，使用 Node 24（`>=24.15.0 <25`）。
Node 24.14 不受支持；请升级并重启宿主，不绕过其检查。
开发与 CI 使用 Node 24.19.0；兼容性细节见[使用指南](docs/usage-guide.zh-CN.md)。

### 构建

```bash
git clone https://github.com/rrriiiccckkk/mnemora.git
cd mnemora
npm ci
npm run build
```

按你的 OpenClaw 插件安装流程安装构建产物，然后将以下内容合并到宿主配置：

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
          shadowMode: true,
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

重启加载插件的 OpenClaw 进程。自动捕获与上下文组装要求宿主选中 Mnemora 的
ContextEngine slot；仅启用插件并不够。
Mnemora 只使用这一套 ContextEngine 生命周期，不额外注册 `before_prompt_build` 或 `agent_end` hook。

### 验收运行中的安装

在构建后的插件目录运行：

```bash
node dist/cli.js standalone status
node dist/cli.js standalone guide
```

在对话中运行 `/mnemora verify start`，把它给出的精确标记放进一条简短事实；
在另一个对话中询问这个标记，实际附加记忆后运行 `/mnemora verify`。
它检查运行时激活、持久化捕获和跨会话附加，不能只靠历史记录数量通过验收。
完整流程见[首次使用验收](docs/usage-guide.zh-CN.md#验收首次使用)。

## 日常使用

在构建后的插件目录运行：

```bash
MNEMORA_DB=~/.openclaw/mnemora.db node dist/cli.js stats
node dist/cli.js inspect
node dist/cli.js resume "部署任务" --scope project-a
```

CLI 默认连接 `~/.openclaw/mnemora.db`；部署使用其他路径时，显式设置 `MNEMORA_DB`。
OpenClaw 安装扩展不一定创建全局 `mnemora` 命令，上面的直接调用不需要全局命令。

任务续接是只读操作，不会执行计划或确认候选。任务不明确时先给候选，不拼接多任务状态。
v1.32 为明确选择的任务增加有界的 `source_evidence` 可读摘录，但不会把摘录升级为已接受状态。
字段边界与复测要求见[可读来源证据说明](docs/task-resume-source-evidence.zh-CN.md)。

## 安全与边界

- **来源不等于确认**：用户请求不是完成证据，助手自述不是独立验证。
- **作用域与生命周期有效性重要**：失效或被遗忘的来源不能让已接受工作复活；不确定证据保持明确标记。
- **本地优先不等于完全离线**：配置的模型、embedding 或 Provider 集成可能发起外部调用。
- **ReasoningMemory 投递仍属实验，默认关闭**：需要显式治理，参考内容不能成为 prompt 指令。
- **测试通过不等于效果已证明**：v1.32 尚未证明续接正确率优于简单检索；真实对照评估与 v1.33 试点门槛仍待完成。

攻击面与防护边界见[威胁模型](docs/threat-model.md)。

## 文档导航

完整配置、首次验收、更正流程与运维命令见[使用指南](docs/usage-guide.zh-CN.md)。

- **任务续接**：[评估说明](docs/task-resume-evaluation.md)、
  [来源证据](docs/task-resume-source-evidence.zh-CN.md)、
  [Mac 实验交接](docs/task-resume-mac-openclaw-handoff.zh-CN.md)、
  [一键日常联调](docs/task-resume-regression.zh-CN.md)与
  [正式三臂工具包](docs/task-resume-experiment-runner.zh-CN.md)。
- **召回与证据**：[阈值评估](docs/recall-threshold-evaluation.md)、
  [装配凭据](docs/recall-attachment-evidence.zh-CN.md)、
  [用途证据边界](docs/recall-usefulness-review.zh-CN.md)。
- **ReasoningMemory**：[审查与治理](docs/reasoning-curation.md)、
  [验证说明](docs/reasoning-verification.md)。
- **开发规划**：[roadmap](docs/roadmap.md)、
  [实验预注册](docs/task-resume-preregistration.zh-CN.md)、
  [v1.32 发布说明](docs/releases/v1.32.0.md)。

部分详细文档目前仅有英文版。

## 开发

新增 fixture、修改存储或配置、升级部署前，先读[维护经验与操作边界](docs/maintenance-lessons.zh-CN.md)。

```bash
npm run check
npm run verify:fast
npm run test:host
npm run dogfood:mnemora
npm run verify
```

完整验收包含串行单测、构建、浏览器检查、基线评估、插件校验、smoke 与 SDK 兼容性预期检查。
发布标签必须对应 Windows、Linux CI 均成功的同一提交。

隔离宿主与项目试用见[本地开发指南](docs/development.md)。完整验证只构建一次；
快速验证可指定测试文件。项目试用使用独立的 `project:mnemora` 数据库，
通过日常 Gateway 的公开无会话接口复用模型。

## 许可证

[MIT](LICENSE)

持久项目记忆助手：`npm run dev:memory -- status` 查看状态，
`npm run dev:memory -- ask --message "继续当前开发任务"` 接续决定。
使用方法和边界见[开发指南](docs/development.md#persistent-project-memory-adviser)。
项目调用会私下记录实测耗时；供应商 token 用量不可用时明确记为缺失，
不使用代理测试占位数代替。

Journal 召回支持 ASCII 技术标识符的大小写匹配；明确匹配任务标识符的详细记录
不会仅因篇幅较长而降权，可信度、来源、scope 和 token 预算约束继续生效。
