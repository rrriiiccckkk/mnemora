# 单次装配证据与人工来源关联

v1.31.12 补齐“哪次装配附加了哪一版记录”的证据边界，不是自动用途分类器。
它只覆盖 standalone ContextEngine 的统一检索中 `memory-document`、`belief`、
`decision` 候选；不覆盖图谱补充、ReasoningMemory 独立投递或所有宿主路径。

## 开启与读取

配置位于 `plugins.entries.mnemora.config.unifiedRetrieval.attachmentEvidence`：

```json
{ "enabled": true, "retentionDays": 30 }
```

默认关闭，保留期 1–365 天。统一检索和所选 ContextEngine 也须已启用。
不为启用此功能修改用户生产配置；Mac agent 先核对宿主 schema lookup 和授权。
无状态或被排除会话不记录新凭据；候选没有实际附加、超预算或记录异常也不产生凭据。
记录失败不影响宿主上下文，缺失凭据不等于从未附加。
一批候选中任一已快照版本漂移会舍弃该批凭据，不保留看似完整的部分结果。

在已有 **schema 84** 的授权快照上，用现有只读命令读取：

```sh
MNEMORA_DB=/authorized/workspace/snapshot.db node dist/cli.js cognition feedback evidence "$TARGET_REF" --scope "$SCOPE"
```

`review.individualAttachments` 列出最近窗口内仍有效的凭据与人工关联。
读取不创建数据库、不迁移、不清理数据；不要用生产 SQLite/WAL/SHM 补材料。

## 身份、版本与限制

- `assembly:<uuid>` 是独立装配 ID，不是宿主 turn/session ID。重复装配同一问题可有两个 ID，不能据此认为两轮回答受益。
- `targetVersion` 是读取时目标完整记录的 SHA-256 指纹，不是原文，也不是不可回滚的全局修订号。记录先快照，异步工作后再核对；同毫秒的实际字段变更也可识别。
- `projectionHash` 只指向候选 excerpt，非整个 prompt；没有保存原文、问题或会话名。调用 API 的可信操作者须仅在实际装配成功后 `record`，它不是密码学投递证明。
- 来源仅快照同 scope 的上述三类目标或可读 user-chat `conversation-event`。belief/decision 另读取底层直接证据，不能把检索展示截断到三条误当完整。URL、其他种类、不可读或不可用来源使 `incompleteSources=true`；引用另一个记录也标为不完整，因为本入口不声称封闭追踪它的递归来源。不能把未追踪的来源当成有效完整证据。
- 来源遗忘、正文被 retention 清空、已记录来源版本变化、目标归档/失效或记录版本变化后，相应凭据不参与审查。关联来源被遗忘/更改时标签退出。底层引用审计记录可留到凭据期限，原文从未复制进新表。
- 哈希和 canonical 引用不是匿名数据；只留在授权工作区，不公开引用 ID 或低熵内容指纹。

## 人工 preview / confirm

公共模块 `dist/index.js` 导出 `RecallAttachmentEvidenceService`。从授权工作区的
已有 `GraphologyStore` 连接构造服务，写入明确选择 `{ enabled: true }`，完成后关闭连接。
不要为了调用 API 打开生产库或默认库。

```js
const service = new RecallAttachmentEvidenceService(store.db, { enabled: true });
const input = { scope, receiptId, targetRef, sourceRef, signal: "user_confirmation" };
const preview = service.previewReview(input);
// 人工检查 sourceRef 对应的原始材料；不将原文复制到提交材料。
const result = service.confirmReview({ ...input, previewHash: preview.previewHash, confirm: true });
```

只有三种人工信号：`assistant_citation`、`user_confirmation`、`user_correction`。
助手引用只能关联助手消息，另外两种只能关联用户消息；来源须可读、同 scope、
发生于凭据之后且不晚于审查。preview 到 confirm 之间版本、生命周期或保留期
变化会拒绝确认。同一来源对同一目标/凭据的不同标签冲突会拒绝，不静默覆盖。
这些标签是 **操作者审查后的来源关联**，不是机器从 role/关键词推断，也不是独立证实。
当前不提供 CLI 写标签入口、不联动 confidence/canary，不能把本 API 当自动标注器。

## 有界保留与重放

每 scope 最多 1000 凭据，每次最多 20 个目标，每目标最多 20 个可跟踪来源，
每凭据最多 100 条人工关联。只读审查最多检查最近 200 凭据、输出 1–50 条，
窗口截断显式标记，`completeHistory=false`。不是有用率分母。

凭据仍被保留时，同 scope、同 ID、同内容重试返回 `replayed`，内容变化则拒绝。
过期已有 ID 拒绝重放；期限清理或容量淘汰后不再有该 ID 的历史防重保证，
容量上限可使凭据早于配置期限淘汰，因此不重用旧装配 ID。
新记录时清理当前 scope 的过期记录并限制总数；停止记录后可由明确授权调用
`prune(scope)` 清理过期凭据与其关联。读取只隐藏过期数据，不暗中删除。

schema 83→84 新增两张表，不把历史 usage 或提及回填为凭据。隔离库验证迁移、
数据保留、重启和新旧备份恢复；Mac 生产升级、gateway 重启仍由 Mac agent 验收。
下一步是授权真实案例审查与缺口统计。canary 接入仍须独立证据、既有人工校准门槛
以及 [v1.32 预注册实验](task-resume-preregistration.zh-CN.md)，不能靠这版记录证明收益。
