# 召回用途证据审查

这是现有反馈通路的只读审查入口，不是自动标注器，也不是“记忆有用率”评估。
它把一个 `target_ref` 的累计附着记录、可读消息中的准确引用和人工明确反馈分开展示。
v1.31.11 的聚合审查不新增表；v1.31.12 新增默认关闭的单次装配凭据和人工来源关联。
两者都不保存推断标签、不改变排序、事实置信度或 canary 校准。

## 在授权快照上运行

先构建，再显式选择已有、当前 schema 兼容的隔离快照（v1.31.12 为 84）：

```sh
MNEMORA_DB=/authorized/workspace/snapshot.db node dist/cli.js cognition feedback evidence "$TARGET_REF" --scope "$SCOPE" --limit 20
```

`TARGET_REF` 是同 scope 的 canonical `memory-document`、`belief` 或 `decision` 引用。
`--limit` 为 1–50，默认 20。PowerShell 先设置 `$env:MNEMORA_DB`。
命令不使用默认库，不新建数据库，不迁移旧 schema；不接受 `--confirm` 等变更参数。
它与阈值扫描共享 native 只读连接和单次读事务，跳过普通 Store 初始化。
不为补材料访问生产 SQLite/WAL/SHM；本工作区没有连接 Mac。

## 如何解读

| 字段 | 能说明什么 | 不能说明什么 |
| --- | --- | --- |
| `attachment` | 现有 ContextEngine 在实际装配成功后记录的累计次数与首末时间 | 不含单次投递、session、turn 或版本 ID；缺失为 `null`，不是证明从未投递 |
| `assistant_citation` | 可读 user-chat 助手消息里出现了有完整边界的准确 canonical 引用 | 引用、反驳和引用中的引文都不等于赞同，更不是独立证实 |
| `user_mention_needs_review` | 用户消息提及同一准确引用，供人工查看来源 | 仅凭 role/关键词不能判定确认、更正、讽刺或转述 |
| `reviewedFeedback` | 最新写入时间之后的现有明确反馈计数，如 `helpful`、`user_corrected` | 这些是操作者声明，历史表没有逐条证据关联，不能称为已验证标签 |
| `corroboration` | 固定为 `unmeasured` | 不用 0 或 false 代替未知，不推测“后来被证实” |

`turnAttribution="unavailable"`：不能从累计投递和后来的提及，反推出某一轮注入帮助了回答。
`versionAttribution="timestamp_window_only"`：本次提及与反馈只取目标最新 `updated_at`
之后、不晚于审查时刻的材料，但时间戳不是不可变版本身份；累计 attachment 仍包含历史。
同毫秒的编辑和旧版本反馈无法严格区分，也不能据此自动校准。

目标须仍可用，这不宣布内容已验证；已删除/归档文档、失效 belief 或待证据复核的 decision 返回
`targetStatus="unavailable"`，不再附带其历史用途细节。已遗忘或 retention 清空正文的
消息不参与提及判断。报告保留可追溯来源引用，不返回正文、标题、会话名或路径。
这些引用可能含敏感 ID，**不是可随意公开的匿名 telemetry**，只留在授权工作区。

## 覆盖与截断

只检查可读、未删除的 user-chat 用户/助手消息，不分析 tool、system、background 或
hash-only 内容。取最近最多 200 条符合时间与可读条件的消息；单条分析最多 16000
UTF-16 字符，累计分析文本预算 1 MiB UTF-8。消息数、提及数或文本预算受限时显示
`coverage.truncated=true`；字段 `scannedEvents`、`possiblyClippedTexts` 和
`ambiguousBoundaries` 说明已查看的窗口和不确定边界。

canonical 引用必须有明确闭合边界，建议 `[来源](mnemora://...)` 形式。长 URI 后缀、
query/fragment、非 canonical 编码和嵌入标识符不算这个目标的准确引用。
行尾/文本末尾的裸引用可能是捕获阶段截断的前缀；多段消息的拼接换行也不能证明
原始引用完整，因此按边界不确定处理。这是保守的审查窗口，可能漏掉真实提及。

`coverage.completeHistory=false` 始终成立。即使 `truncated=false`，也不保证拥有完整
原始历史、全部注入路径或完整用途证据。输出没有有效率、收益分或自动准入结论；
`mutation="none"`、`calibrationAction="not_performed"`。

## 后续闭环的验收条件

v1.31.12 的 `individualAttachments` 提供独立装配凭据、目标记录版本、投影指纹和
人工关联来源，见 [单次装配证据](recall-attachment-evidence.zh-CN.md)。聚合字段的
`turnAttribution` 和 `corroboration` 含义不变：宿主逐轮身份与独立证实仍不可推断。
下一步先用授权真实案例审查这些关联，不把引用或用户确认等同独立证实。

canary 校准仍须人工审查、有足够独立案例和既有 preview/confirm 边界；当前 view
不能替代 [v1.32 预注册三臂实验](task-resume-preregistration.zh-CN.md)。
