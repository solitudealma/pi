---
name: worker-orchestration
description: Use for Worker delegation, Fast/Normal/Deep routing, parallel task splitting, file boundaries, review, rework, and acceptance.
---

# Worker 编排

自主委派边界清晰、可独立验收且值得分担的调查、实现、测试或 Review，不先征求用户许可。主 Agent 负责最终 diff、验证和交付。少量读取、明确的小改动、纯解释或需连续用户反馈的工作直接完成；代码事实尚不明确时先 scout，不凭猜测实施。Worker 不得继续委派。

## 会话与路由

每项任务显式填写 `sessionMode`，由主 Agent 自主选择，不询问用户；用户明确指定时遵循要求：

- `fork`：默认选择，继承批次启动时活动分支快照，保留当前对话的澄清、设计和排查过程。
- `new`：仅在上下文交接很少、简短契约即可完整说明任务时使用，如简单独立查询或机械修改；不确定时用 fork。
- 同批可混用；fork 不代替契约、不扩大权限、不隔离共享工作区。省略时默认 fork。

`preset` 按难度选择：

- `fast`：明确、局部、易验证的搜索、机械修改、简单测试、常规追加 Review。
- `normal`：普通功能、Bug、重构和测试；不确定时选此档。
- `deep`：根因不明、并发/一致性、资源生命周期、复杂架构或重要 Review；文件多不等于困难。
- `auto`：自动从三档中选择。模型与 thinking 由 `worker-settings.json` 配置；thinking 高度与任务档位不同，须模型支持。

## 任务契约

提供明确的 `mode`、`objective`、必要的 `context`、`relevantFiles`、可验证的 `acceptanceCriteria`、`verificationCommands` 和 `outputRequirements`，不要只说“做好这个功能”。

- 写任务必须声明非空 `allowedPaths`，敏感范围用 `forbiddenPaths` 排除。
- 写入与排除路径均相对 `task.cwd`：文件用精确路径（可为新文件），目录后代用 `dir/**`。裸目录和 `dir/` 在启动前拒绝；新目录也用 `dir/**`，不存在的裸路径不会自动扩成子树。
- `relevantFiles` 仅是读取提示，可为绝对路径或 cwd 外路径，不授予写权限。`cwd` 本身只能是主工作区内的相对子目录。
- 路径 guard 只拦截 edit/write，不是 bash 或其他工具的沙箱；所有操作仍须遵守契约。

## 并行与生命周期

每会话仅一个未完成批次；并行任务放在一次 `tasks` 中，不用多个启动或 `Promise.all`：

- 启动：`worker({task})` 或 `worker({tasks:[...]})`，可选 `manual`。
- 续等：`worker({batchId})`。
- 取消：`worker({batchId,cancel:true})`。

启动与控制字段不得混用。第二次启动返回 `activeBatchId`；先续等或取消。启动/续等等待整批完成，不轮询；结果按输入顺序，单项失败不取消兄弟任务。交付前完成或取消所有批次。

只有独立任务才并行。运行时保守检查全部 `allowedPaths` 与 cwd；只读/写入混合、祖先后代路径、重叠 glob、符号链接或不能证明独立的范围都会串行，`forbiddenPaths` 不缩小调度边界。共享接口、生成文件、锁文件或前后依赖应顺序执行，必要时由主 Agent 明确创建独立 Git worktree。

任务保留槽位和路径锁直到进程清理及结果校验结束；主 Agent 自己的工具不受锁拦截，不要修改 Worker 的路径。任务期限固定。取消或中断正在执行的启动/续等调用会等待清理；调用返回后中断旧 signal 无效。权限/范围变化须取消、等待回收，再创建新任务。

缺少信息、决策或授权时 Worker 返回 `blocked` 并释放资源。主 Agent 处理 blocker，必要时用 `ask_question`，再按新契约派发；不自动重试，不把取消当授权。

## 验收与返工

小任务和普通任务由主 Agent 直接验收；困难任务可采用实现 → 独立 Deep Review → 定向 Fix → 主 Agent 验收。实现后自动追加的常规 Review 默认 fast，重要审查用 deep；不要让小任务都走完整流程。

检查实际 diff、原有修改是否保留、验证是否真实执行、逐条验收证据、blocker、越界、模型降级/不匹配及未解析输出。`blocked`/`failed` 不得当成功。Review finding 须含文件、位置、证据、影响、建议、置信度；只修已确认的问题。

并行写任务的 `changed_files` 可能按声明范围归属；`observed_changed_files` 保留完整 Git 观测。共享 worktree 无法确定范围外改动来源，必须检查整批 diff，不能只信 Worker 报告。需要时定向返工或独立 Review。

运行时配置、UI、历史及故障细节见 `README.md`，仅排障时读取。
