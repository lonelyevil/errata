# 摘要与故事记忆

本文说明 Errata 如何维护长期故事记忆、延迟摘要应用的工作方式，以及摘要压缩如何防止摘要无限增长。

## 概述

Errata 使用滚动的 `story.summary` 字符串，作为已经移出当前 prose 上下文窗口的内容的记忆。

管线如下：

1. 生成/保存 prose fragment，或手动重新分析。
2. Librarian 分析该 fragment，生成 `summaryUpdate` 和可选的 `structuredSummary` 信号。
3. 延迟摘要应用将符合条件的 `summaryUpdate` 条目追加到 `story.summary`。
4. 必要时执行摘要压缩，使 `story.summary` 保持有界。

关键实现文件：

- `src/server/librarian/agent.ts`——分析运行器和延迟摘要应用
- `src/server/librarian/blocks.ts`——librarian 分析上下文的 agent 块定义

## 数据模型

故事设置包括：

```ts
disableLibrarianAutoAnalysis: boolean
disableLibrarianDirections: boolean
disableLibrarianSuggestions: boolean
enableHierarchicalSummary: boolean
summaryCompact: {
  maxCharacters: number
  targetCharacters: number
}
```

默认值：

- `maxCharacters: 12000`
- `targetCharacters: 9000`
- `disableLibrarianAutoAnalysis: false`
- `disableLibrarianDirections: false`
- `disableLibrarianSuggestions: false`
- `enableHierarchicalSummary: false`

Schema 来源：

- `src/server/fragments/schema.ts`

API 设置 PATCH 支持：

- `src/server/api.ts`
- `src/lib/api/settings.ts`

## 延迟摘要应用

函数：

- `src/server/librarian/agent.ts` 中的 `applyDeferredSummaries(...)`

输入：

- `state.summarizedUpTo`（水位线）
- 当前活跃的 Prose Chain 顺序
- `summarizationThreshold`
- 每个 prose fragment 最新的 librarian analysis（`summaryUpdate`）

### 最新 Analysis 去重

重新分析可能为同一 prose fragment 创建多条 analysis 记录。延迟应用现在会先解析每个 `fragmentId` 对应的最新 analysis，再使用去重后的集合应用摘要。

选择规则：

- 优先选择最新的 `createdAt`
- 时间戳相同时，选择字典序较大的 analysis `id`

实现：

- `src/server/librarian/storage.ts` 中的 `selectLatestAnalysesByFragment(...)`
- `src/server/librarian/agent.ts` 中的延迟摘要应用使用该函数

### 阈值语义

`summarizationThreshold` 定义最近的多少个 prose 位置*尚未并入*滚动摘要。

给定 `proseIds.length = N`，应用截断点为：

- `cutoffIndex = max(0, N - summarizationThreshold)`

只有 `[startIndex, cutoffIndex)` 范围内的 prose 会成为候选，其中：

- `startIndex = indexOf(summarizedUpTo) + 1`

### 连续水位线行为

应用必须连续进行。算法在遇到第一个缺口时停止：

- 某个 prose ID 缺少 analysis；或
- analysis 存在，但 `summaryUpdate` 为空或仅包含空白字符。

这保证 `summarizedUpTo` 不会跳过缺失数据。

停止时输出的诊断日志：

- `gapFragmentId`
- `gapReason`（`missing_analysis` | `empty_summary_update`）

### 状态更新规则

如果应用了一个或多个连续更新：

- 将连接后的更新追加到 `story.summary`
- 将 `state.summarizedUpTo` 推进到最后一个已应用的 prose ID

如果没有可应用的更新：

- 不追加摘要
- 水位线保持不变

## 分析触发与控制

Librarian 分析可通过三种方式启动：

1. Prose 生成后自动启动
2. 通过 prose 块的 `Analyze` 操作手动启动
3. 对 prose 进行实质性编辑后，间接触发重新分析

设置以下任一标志时，生成后的自动分析会禁用：

- `story.settings.disableLibrarianAutoAnalysis`
- `agent-blocks/librarian.analyze.json` 中设置 `disableAutoAnalysis: true`

也可以缩小分析行为，而不完全禁用记忆：

- `disableLibrarianDirections` 保留摘要/连续性分析，但跳过方向卡片
- `disableLibrarianSuggestions` 保留摘要/连续性分析，但跳过 fragment 创建/更新建议

## 摘要压缩

压缩函数：

- `compactSummary(...)`（使用 LLM 压缩，失败时回退为截断）

策略：

- 如果 `summary.length <= maxCharacters`，保持不变。
- 如果 `summary.length > maxCharacters`，使用 librarian 模型执行一次压缩，目标长度为 `targetCharacters`。
- 如果模型压缩失败或返回空输出，回退逻辑保留摘要文本的最新尾部（以 `... ` 为前缀）。

行为效果：

- 即使故事很长，记忆也保持有界。
- 压缩优先保留对连续性至关重要的事实，并提供确定性的回退行为。

### 限制条件

运行时约束：

- 两个值最小均为 100
- `targetCharacters <= maxCharacters`

## 与上下文构建器的交互

滚动摘要以 `Story Summary So Far` 的形式出现在提示词上下文中，除非专用流程通过 `excludeStorySummary` 等选项将其排除。

构建 `summaryBeforeFragmentId` 时，上下文重建同样使用最新 analysis 去重，避免采用重新分析前的旧摘要。

相关文件：

- `src/server/llm/context-builder.ts`

启用 `enableHierarchicalSummary` 后，章节标记摘要也会作为中间记忆层，位于滚动摘要和近期 prose 窗口之间。

## Analysis 索引

Prose 视图使用轻量级 fragment-to-analysis 索引，跟踪哪些 prose fragment 具有当前 librarian analysis。

- 路由：`GET /stories/:storyId/librarian/analysis-index`
- 手动触发：`POST /stories/:storyId/librarian/analyze`

该索引驱动 prose 块上的已分析圆点，以及 prose 块菜单中的手动 `Analyze` 操作。

## 测试

主要测试：

- `tests/librarian/agent.test.ts`

重要覆盖：

- 连续应用不会跳过缺口
- 压缩会限制摘要长度
- 超出预算时使用 LLM 压缩
- 延迟应用使用每个 fragment 的最新 analysis
- 摘要文本为空时，librarian 可从结构化信号推导 `summaryUpdate`

相关上下文测试：

- `tests/llm/context-builder.test.ts`

## 运维说明

- 对于短故事，默认值通常足够。
- 对于长期项目，可在 Settings 中调整 `summaryCompact`：
  - 增大 `maxCharacters`，以更高 token 成本保留更丰富的记忆
  - 降低 `targetCharacters`，进行更积极的压缩
- 如果摘要停止推进，请检查延迟应用输出的缺口日志。

## Agent 块系统集成

Librarian analyze agent 使用 **agent 块系统**组装上下文。系统提示词和用户上下文（摘要、角色、知识、新 prose）在 `src/server/librarian/blocks.ts` 中定义为块，并通过 `compileAgentContext()` 编译。这意味着：

- 可通过 agent 块覆盖按故事自定义 librarian 的系统提示词（Settings > Agent Context）。
- 标记为 `pass-to-librarian-system-prompt` 的 fragment 会加载到块上下文中，并追加到 system 消息。
- 可添加自定义块，注入额外指令或上下文。

`librarian.chat`、`librarian.refine` 和 `librarian.prose-transform` agent 也使用相同的块系统。

## 方向建议

每次分析后，librarian 都可以生成**方向建议**，即故事可能的下一步。`directions.suggest` agent 使用完整故事上下文生成带标题的建议卡片，每张卡片都包含描述和可直接使用的写作指令。

- Agent 模块：`src/server/directions/suggest.ts`
- 块定义：`src/server/directions/blocks.ts`
- Librarian 工具：`src/server/librarian/analysis-tools.ts` 中注册的 `suggestDirections`
- 最新分析中的方向建议会显示在生成输入的 **guided mode** 中

当 librarian 分析跨多个步骤时，提及和 fragment 建议会在多轮工具调用之间去重，避免重复条目。

## Fragment 建议与更新

Librarian 的分析工具使用 `fragmentSuggestions`（由 `knowledgeSuggestions` 更名）建议创建或更新 character 和 knowledge fragment。`suggestFragment` 工具收集建议；`updateFragment` 工具允许 librarian 根据 prose 中的新信息直接更新现有 fragment。读取时的向后兼容迁移会处理旧字段名。

## 已知限制

- LLM 压缩质量取决于配置的 librarian 模型及其遵循提示词的能力。
- 结构化摘要信号是可选的，其质量取决于模型/工具调用的规范性。
- 必须先在 marker fragment 上创建章节摘要，分层摘要模式才能发挥作用。
