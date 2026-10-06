# 可选装配留底单

v1.32.5 新增，默认关闭。它记录插件本次交付给宿主的记忆身份与内容指纹，**不保存正文，不证明宿主已发送给模型，更不验证事实**。没有生产启用或现场根因结论。

首版仅支持 Mac/Linux 的 POSIX 私有目录。Windows 缺少可验证的私有 ACL 实现，因此即使显式开启也停止记录，原有上下文仍正常返回。

配置入口：`contextEngine.assemblyDiagnostics`。必须显式设置 `enabled: true`、已有私有目录的规范绝对路径 `directory`、允许记录的 `scopes`，以及不超过未来 24 小时的毫秒时间戳 `expiresAt`。目录必须由当前用户拥有且权限 0700；不要使用仓库、生产扩展、共享目录或 symlink 路径。示例形状：

```json
{"enabled": false, "directory": "/absolute/private/diagnostic-window", "scopes": ["project:authorized"], "expiresAt": 1234567890000}
```

示例未启用，时间戳是占位值。仅在明确授权的环境配置有效未来时间。本功能不修改宿主配置或自动创建目录。

每个目录最多 20 个记录，每条最多 64 KiB；到期、容量满或写失败会停止记录，返回上下文保持原样。无状态、忽略和 excluded-agent 会话不写。记录文件权限 0600；同步排他锁阻止多进程超过容量，进程异常留下的锁不会自动删除或恢复，由授权操作者核对后处理。

内容：独立 assembly ID、插件版本、时间/scope、HMAC 会话关联、最终 unified-retrieval 本地候选的 kind/contextRef/来源、摘录指纹、最终渲染块的字节数与指纹、原文窗口省略/截断信息。外部 URL 和跨 scope 来源不保存，标记缺失数量；超出来源上限显式标截断。summary/Episode 候选包含在内。压缩恢复的 system 文本块保存 summaryRef、指纹及 plugin-projection/host-message 来源；新投影另记实际展示的来源窗口/预算省略，旧 host-message 的来源窗口和正文截断状态为 unknown，不宣称 host-message 中的 ID 经独立验证。独立 reasoning 只保留块指纹，图谱不保存逐项来源，覆盖缺口写入记录。

`stage=plugin_handoff`，`hostDelivery=unknown`，`hostTurnId=null`。宿主日志截断状态是 unknown；来源窗口截断与元数据截断分别标记。元数据无法判断对象名是否写错，仍需另获授权的局部正文才能定位语义变化。HMAC 指纹涵盖返回块的文本，不涵盖 provider 请求序列化、宿主后续改写或完整 system prompt。

目录内 `.assembly-diagnostic-key` 是本地随机 HMAC 密钥，权限 0600，仅用于诊断指纹，绝不读取模型密钥。引用和 scope 仍可能泄露私人身份；不要提交或公开这些文件。停止记录/到期不会删除已有元数据；授权操作者自行处理该独占目录，不扫描清理其他路径。无原文副本，因此不会通过这项功能恢复被遗忘正文；旧元数据仍存在不能用于当前事实或自动注入。

既有 attachmentEvidence 的 acceptance/人工审查语义保持独立，未扩展其目标类别；不增加数据库 schema，不改变模型、召回排序、prompt 预算或注入文本。当前没有形成过程 capture、正文 capture 或宿主发送回执。

给 OpenClaw agent 的最短交接见 [v1.32.5 交接](openclaw-agent-v1.32.5.zh-CN.md)。
