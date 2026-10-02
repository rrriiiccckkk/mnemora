# 无损精简 resume 载荷

显式选择精简格式，默认 resume / Inspector / 自动召回不变。
此功能只序列化已完成资格检查的 resume 投影，不新增证据、不改变状态、
不把历史报告或未验证来源升级为已接纳完成结果。

## 获取载荷

在隔离实验库中，显式给出库路径：

```bash
MNEMORA_DB=/absolute/private/experiment.db node dist/cli.js resume \
  --task-ref '<authorized-task-ref>' --scope '<case-scope>' --format compact
```

CLI 保持 `{ok, command, result}` 包装。用于实验 bundle 的记忆文本应为
`JSON.stringify(output.result)`，而不是整段终端输出。
不要为形成实验载荷读取生产库；已有投影可直接使用公开函数：

```js
import { renderTaskResumeMemory } from './dist/task-resume/memory.js';
const memoryText = renderTaskResumeMemory(alreadyAuthorizedResumeResult, 'compact');
```

## 格式与保真

精简结果是 `format="task_resume_compact.v1"` 的 JSON，包含 `references`
引用表、`reference_encoding` 说明及 `result` 投影。仅 `task_ref`、
`source_ref`、`source_refs`、`artifact_refs` 中的引用替换为引用表的零起始索引。
还原这些字段即可得到完整原投影；正文中的引用字符串不改写。

所有章节、空数组、顺序、重复引用、状态、来源角色、时间、截断标志、
记忆覆盖字段和限定语均保留。来源正文仍是 `unverified_source`，不是指令。
编码不产生新的 scope 或授权；引用索引不是新的可授权 context ref。
若精简结果 UTF-8 字节数不小于原投影，返回原格式，因此消费方须支持两者。

## 下一轮回归

复用已授权的同案例投影，只改变记忆的序列化格式；保持形成版本、历史哈希、
来源 ID、模型、提示、预算与其他两臂不变。记录新的序列化版本和 bundle，
新建私有回归目录，再使用[一键回归入口](task-resume-regression.zh-CN.md)。
不要改旧材料、覆盖已冻结工作区或将已看案例当作全新 held-out。

这次开发只验证无损还原及字节体积。实际输入/输出 token、延迟与续接质量
须由另获授权的模型运行测量；字节下降不等于 token 下降，不保证模型能正确
理解引用索引。报告输入与输出 token，语义审查关注完成证据、失效状态和来源
限定语。AI 初评仍不是人工复核，v1.33 gate 不变。
