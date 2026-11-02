# Librarian 聊天：服务端持有状态与轮询快照

本文说明 Librarian 聊天的新执行模型：**服务端拥有持久化状态和运行生命周期，浏览器只提交一次 prompt，然后轮询完整快照**。HTTP 连接断开不会取消运行；只有显式取消才会向 provider 发送 `AbortSignal`。

## 1. 共享契约

类型定义在 `src/lib/librarian-chat.ts`，前后端共同使用：

```ts
type LibrarianChatStatus = 'running' | 'done' | 'cancelled' | 'error' | 'interrupted'

interface LibrarianChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  toolCalls?: Array<{ id: string; toolName: string; args: Record<string, unknown>; result?: unknown }>
  runId?: string
  status?: LibrarianChatStatus
  error?: string
}

interface LibrarianChatSnapshot {
  branchId: string
  revision: number
  updatedAt: string
  messages: LibrarianChatMessage[]
  activeRun: { runId: string; status: 'running' | 'cancelling' } | null
}

interface LibrarianChatStartInput {
  runId: string
  prompt: string
  branchId: string
  expectedRevision: number
  maxSteps?: number
}
```

`start`、`cancel`、`chat-state` 都直接返回同一个 `LibrarianChatSnapshot`，没有额外的包装层。

## 2. 路由

默认聊天（老 UI 的全局 Librarian chat）：

- `GET /api/stories/:storyId/librarian/chat-state?branchId=...`
- `POST /api/stories/:storyId/librarian/chat-runs`（body 为 `LibrarianChatStartInput`）
- `POST /api/stories/:storyId/librarian/chat-runs/:runId/cancel?branchId=...`

具名会话：

- `GET /api/stories/:storyId/librarian/conversations/:conversationId/chat-state?branchId=...`
- `POST /api/stories/:storyId/librarian/conversations/:conversationId/chat-runs`
- `POST /api/stories/:storyId/librarian/conversations/:conversationId/chat-runs/:runId/cancel?branchId=...`

旧的流式端点和会话 CRUD/list/history 仍然保留，并接受可选的 `branchId` 查询参数：

- `GET|DELETE|POST /api/stories/:storyId/librarian/chat`
- `GET|POST /api/stories/:storyId/librarian/conversations`
- `DELETE /api/stories/:storyId/librarian/conversations/:conversationId`
- `GET|POST /api/stories/:storyId/librarian/conversations/:conversationId/chat`

省略 `branchId` 时使用当前活动分支，因此旧客户端行为不变。传入的 `branchId` 必须存在于该 story 的分支索引中，分支 ID 还会做安全字符校验，避免通过查询参数拼出文件路径。不存在 story/分支/会话时返回 404。

## 3. 持久化布局与原子性

每个作用域只有**一个规范历史文档**：

- 默认聊天：`<branch content root>/librarian/chat-history.json`
- 具名会话：`<branch content root>/librarian/chat-<conversationId>.json`

文档在原 `messages`/`updatedAt` 基础上扩展了可选字段：

- `revision`：单调递增的快照版本号；旧文档缺失时按 `0` 处理。
- `branchId`：写入时的实际分支。
- `activeRun`：当前运行（内部含 prompt、messageId 等元数据；快照只暴露 `runId` 和 `status`）。
- `runs`：按 `runId` 保存的永久运行账本，含 prompt、分支、`maxSteps`、消息 ID、状态和错误等。用于跨重启去重，而不是只记住最后一个 active run。

一次 `POST /chat-runs` 在返回 ack 之前会原子完成：

1. 追加 user prompt；
2. 追加空 assistant placeholder（`status: 'running'`）；
3. 写入 `runs[runId]` 与 `activeRun`。

之后后台才开始消费模型流。所有写入都经过同一把进程内文档锁，并通过临时文件 + rename 原子替换，避免读到半截 JSON。

旧历史读取器只读 `messages`/`updatedAt`，因此仍然工作。

## 4. 后台消费与 checkpoint

运行生命周期完全由服务端后台 reader 持有：

- 后台直接读取 `agent.eventStream`，与 HTTP 请求/响应无关。
- 文本、reasoning、tool-call、tool-result 会聚合到 assistant 消息。
- checkpoint 合并窗口为 **250ms**（`LIBRARIAN_CHAT_CHECKPOINT_MS`）。事件先更新内存 partial，再按固定间隔排队落盘；写入链串行执行，保证顺序。
- `GET /chat-state` 只返回**已经提交到磁盘**的状态，不返回尚未落盘的内存 partial。
- 正常结束、显式取消或错误时，会先等待在途 checkpoint，再强制写入终态（`done`/`cancelled`/`error`）并把 `activeRun` 置空，之后才认为运行报告完成。
- provider 以 AI SDK `fullStream` 的 `{ type: 'error', error }` 分片报告失败时，会和迭代器抛错走同一条失败路径，保留已提交 partial 并标记 `error`，不会伪装成空成功。流结束时若还有无换行的尾部 NDJSON，也会被消费；completion 的 rejection 不会被静默吞掉。
- 客户端停止轮询、关闭页面或中断 `GET` 都不会取消运行。运行只由显式 `POST .../cancel` 中止。

## 5. 模型输入来自服务端历史

后台运行不信任客户端传来的历史。它从规范文档构造模型消息：

- 所有非空 user 消息进入上下文。
- 仍在运行的 assistant placeholder 被排除。
- 内容为空且没有工具证据的 assistant 消息被排除。
- 之前 `interrupted` 的 assistant 部分内容会连同说明一起进入上下文，例如“Previous response was interrupted before completion. The text above is partial, unconfirmed output.”，让模型知道这不是完整回答。
- `cancelled` 和 `error` 的部分内容同样带说明进入上下文。
- 只有工具调用、没有文本的 assistant 消息会以“使用了哪些工具”的摘要进入上下文。

## 6. 去重、revision 与 409

`POST /chat-runs` 的判定顺序：

1. **先去重**：如果 `runs[runId]` 已存在且整个请求与首次请求一致，直接返回当前快照，不重新调用模型；即使之后又发生了多轮对话，或在进程重启后重试丢失响应的请求，也保持不变。这里比较的是完整 payload：`prompt`、`branchId`、`expectedRevision`、`maxSteps`（缺省 `maxSteps` 与缺省视为相同）。`expectedRevision` 必须等于首次请求中的原值，而不是当前 revision；同一 `runId` 在后续回合后用新 revision 重试会被视为 changed payload 并返回 **409**。任一 payload 字段改变均返回 **409**。
2. 如果存在其他 active run，返回 **409**。
3. 如果 `expectedRevision` 不等于当前 `revision`，返回 **409**。
4. 否则接受运行：原子写入 prompt、placeholder、运行元数据和 activeRun，返回新快照。

`revision` 会在接受、每次 checkpoint、终态写入时递增。客户端应把最新快照的 `revision` 作为下一次提交的 `expectedRevision`。

取消语义：

- 对 active run 取消会先把 `activeRun.status` 置为 `cancelling` 并持久化该状态，然后向 provider 发送 `AbortSignal`。取消请求本身不会额外写入当前内存中的 partial；最近已提交的 checkpoint 保持不变。
- 后台随后写入 `cancelled` 终态，此时会等待在途 checkpoint 并强制落盘当前内存 partial，因此最终保留取消时已产生的部分文本/reasoning/tool 信息。
- 已结束的 run 再取消是幂等的，返回当前快照；若同一作用域正在运行另一个 run，则返回 409。
- 取消不会重放或重新执行任何工具。

## 7. 分支固定与并发

- 接受运行时解析并校验实际 `branchId`，整个后台生命周期（包括流读取、checkpoint、终态写入）都固定在同一个分支作用域内。
- 运行过程中切换活动分支不会影响已接受的运行；响应快照的 `branchId` 始终是实际作用域。
- 每个“分支 + 会话”作用域最多一个 active run。不同具名会话可以并行运行，互不影响。
- 会话索引的读改写也已串行化，因此并行会话的 `updatedAt`/新建/删除不会互相覆盖。

## 8. 崩溃/重启边界

持久化只保证到**最近一次已提交的 checkpoint**：

- 崩溃最多丢失最后一个 checkpoint 窗口（约 250ms）以及尚未写盘的在途增量。
- 模型或工具在崩溃前已经产生的副作用（例如已经改写的 fragment）**不会自动重放**。系统不会在重启后重新调用 LLM，也不会重新执行工具。
- 重启后首次访问该作用域时，如果磁盘上仍有 `activeRun` 但本进程没有对应 runtime，会把它原子标记为 `interrupted`，保留最新已提交的部分内容，并把 `activeRun` 置空。这个过程不调用 LLM。
- `flushLibrarianChatRuns()` 提供 best-effort 关闭前落盘；它不中止 provider，也不支持重启后继续原 provider 流。
- 运行账本会持续保留以支持去重。目前没有自动清理策略，长期使用会缓慢增长；删除具名会话会一并删除其账本。

## 9. 其他安全/兼容行为

- `runId` 限制为 1–128 个安全字符（字母、数字、`_`、`-`、`.`、`:`，并拒绝 `.`/`..`），prompt 上限 100,000 字符，`maxSteps` 限制在 1–100，`expectedRevision` 必须是非负整数。分支和会话 ID 使用更严格的路径安全字符集。
- 任意作用域存在 active run 时，旧的流式发送、清空默认历史、删除具名会话都会返回 409。清空/删除的 active 检查在存储的历史锁内再次执行，与运行接受使用同一把锁，因此不会出现“检查后、删除前接受了新 run”导致任务丢失的窗口。
- legacy 流式完成写历史时也会在历史锁内检查 active run，并携带请求开始时的 `revision` 作为 fence；如果之后已有新的服务端回合提交，旧完成会被丢弃，不会覆盖更晚的消息。
- 删除会话后，晚到的 legacy `saveConversationHistory` 不会再创建历史文件，避免“已删除会话复活”。
- 清空默认聊天会清空 transcript，但保留运行账本，以便丢失响应的重试仍然去重。
- 进程内锁只覆盖单进程；多进程共用同一个 `DATA_DIR` 时不在本实现保证范围内。

## 10. 验证

后端测试：

```bash
bun run test -- tests/librarian/chat-state.test.ts tests/librarian/chat.test.ts tests/api/librarian-routes.test.ts
```

`tests/librarian/chat-state.test.ts` 使用确定性 gated mock stream 覆盖：POST 先于完成返回、无轮询仍完成、富 partial（文本/reasoning/tool）与磁盘一致、完整请求去重（含 maxSteps/expectedRevision）、revision/active 409、轮询断开不 abort、显式取消保留 partial、迭代器错误与 provider error 分片均保留 partial、pre-stream 失败释放 active agent、分支固定、重启 orphan 标记 interrupted、存储锁内拒绝清空/删除/legacy 覆盖、legacy revision fence 以及并行会话索引安全。
