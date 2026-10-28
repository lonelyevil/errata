# Summary Fragments——实施计划

## 目标

将 librarian 维护的摘要从零散字段（`story.summary`、`analysis.summaryUpdate`、`fragment.meta._librarian.summary`）迁移为新的 `summary` 类型的一等 fragment。收益包括：可编辑、可添加标签、可进行版本管理、可重排、可通过 `ctx.getFragment` 引用，并可按需要在侧边栏显示。保留 librarian 当前的压缩算法，但适配到 fragment 边界。

## 非目标

- 不修改 librarian 面向 LLM 的工具（`updateSummary`、`flagContradiction` 等）。工具输出仍会在 analysis 上写入 `summaryUpdate` 字符串，只是额外将其物化为 fragment。
- 不修改用户可见的标签约定。现有 `sticky` 和 `placement` 语义继续适用。
- 不重写章节标记系统。

## 数据模型

### 新 fragment 类型

在 `src/server/fragments/registry.ts` 中注册，并添加到 `schema.ts` 的内置类型列表：

- `type: 'summary'`
- 在 `src/lib/fragment-ids.ts` 中设置 `prefix: 'sm'`
- `llmTools: false`（摘要由上下文构建器直接读取，不提供按类型查询的 LLM 工具）
- 视觉样式：通过 `src/lib/fragment-visuals.ts` 使用偏暖羊皮纸色，与 character/knowledge/guideline 区分；使用书签图标
- 该类型新增 `meta` 字段：
  - `meta.chapterId?: string`——摘要所属的章节标记（era summary 为 null）
  - `meta.coverageStart?: string`——覆盖的第一个 prose fragment ID
  - `meta.coverageEnd?: string`——覆盖的最后一个 prose fragment ID
  - `meta.isEraSummary?: boolean`——压缩较早范围溢出内容时为 true
  - `meta.analysisIds?: string[]`——为该摘要做出贡献的 librarian analysis

### Schema 变更

- `src/server/fragments/schema.ts`：将 `'summary'` 添加到内置类型联合。提升 schema 版本。
- `src/lib/api/types.ts`（`StoryMeta`）：**移除** `summary: string`。**移除**故事设置中的 `summaryCompact: { maxCharacters, targetCharacters }`，改由每个 summary fragment 的字符阈值控制（见下文）。
- Analysis 记录（`src/server/librarian/storage.ts`）：保留 `summaryUpdate: string`（意图），增加 `summaryFragmentId?: string`（产物引用）。
- 新故事设置：`summaryOverflowThreshold: number`（默认 2000），控制章节摘要何时拆分。

### 列表隐藏约定

在 fragment 类型 registry 条目中增加 `hiddenFromList?: boolean` 标志。`FragmentList` 和侧边栏查询据此过滤。Summary fragment 设置 `hiddenFromList: true`。插件以后也可选择启用。

## 迁移

**一次性硬切换**，在加载故事时运行：

1. `src/server/fragments/storage.ts`——添加 `migrateStoryToSummaryFragments(dataDir, storyId)`：
   - 如果 `story.summary` 非空且不存在 `summary` 类型 fragment，则创建一个 summary fragment，设置 `content = story.summary`、`name = 'Story summary'`、`meta.isEraSummary = true`、`meta.chapterId = null`。
   - 将 `story.summary` 清空为 `''`（或在 schema 升级后完全删除该字段）。
   - 记录迁移结果。
2. 在 `getStory()` 内调用，或在路由层打开故事时一次性调用；该操作应是幂等的。
3. 现有 analysis 保留其 `summaryUpdate` 字符串；旧 analysis 无需回填（它们引用旧的逐 fragment 缓存，这些缓存也会被移除，见下文）。
4. 删除 `fragment.meta._librarian.summary` 缓存（摘要成为 fragment 后已冗余）。迁移方式：升级后首次运行 librarian 时，遍历现有 prose fragment 并清理该 key。这不是关键步骤，旧缓存无害。

## Librarian 变更

### `src/server/librarian/agent.ts` 中的新流程

替换 `applyDeferredSummaries` 中的延迟摘要应用逻辑（约第 480–607 行）：

1. 对每个已分析的 prose fragment，沿 Prose Chain 向前查找最近的章节标记，以确定其**章节**。辅助函数：`src/server/chapters/` 中的 `findChapterForProse(proseId)`。
2. 为每个章节查找或创建**当前活跃的章节 summary fragment**：
   - 查询满足 `meta.chapterId === chapterId` 且未 archived 的 `summary` 类型 fragment。
   - 如果不存在则创建，设置 `name = chapter.name + ' summary'`。
3. 将 analysis 的 `summaryUpdate` 追加到章节 summary fragment 的 `content`，以 `\n\n` 分隔。
4. 追加后检查 `content.length > summaryOverflowThreshold`：
   - 如果是：对 fragment 内容中**最旧的 50%** 运行现有 `compactSummary()`（即 agent.ts:80 的函数）。使用压缩输出创建新的“era summary” fragment，设置 `meta.isEraSummary = true`、`meta.coverageEnd = <50% 边界处的 fragmentId>`。**归档**原章节 summary fragment。使用剩余（较新的）50% 创建新的章节 summary fragment。
5. 设置 `analysis.summaryFragmentId = <章节 summary fragment ID>` 并保存 analysis。

### 归档行为

归档使用现有 `Fragment.archived: boolean` 标志。上下文构建器已经（或应当，需验证）尊重该标志。已归档 summary fragment 不进入上下文，但可从归档面板恢复。

### 移除

- 针对 `story.summary` 字符串的 `compactSummary()` 调用（agent.ts:576–583）——由上述按 fragment 压缩替代。
- agent.ts:437–439 的 `_librarian.summary` meta 写入——不再需要。
- 截断 `story.summary` 的 summary-compaction 工具——移除。

## 上下文构建器变更

`src/server/llm/context-builder.ts`：

1. 移除根据 `story.summary` 组装的“## Story Summary So Far”块。
2. 在 `buildSummaryBeforeFragment()`（context-builder.ts:131–154 的调用）中：查询未 archived 的 summary fragment，按 `meta.coverageStart` 稳定排序。包含全部 era summary 和当前活跃章节 summary。每个摘要使用 fragment 的 `name` 和 `content`，渲染为单独的 `[@block=sm-…]` 条目。
3. **自动放置**：默认情况下，summary fragment 渲染为位于 prose 块之前的 system 块。如果用户显式设置 summary fragment 的 `placement` 和 `sticky` 字段，则覆盖默认值。该逻辑位于 `createDefaultBlocks()`——summary fragment 与 guideline 类似，会被合成为块列表中的条目，并保留覆盖点。
4. 尊重 `sticky`：如果用户将 summary fragment 标为 sticky，无论当前位于哪个 prose 分节，它都会保留在上下文中。

## UI 变更

### Fragment 列表

- `src/components/fragments/FragmentList.tsx`：默认过滤 `type === 'summary'` 的 fragment。可通过开关或显式筛选显示它们。
- 由类型 registry 新增的 `hiddenFromList` 标志驱动，因此未来其他隐藏类型也能自动生效。

### Librarian 面板

- `src/components/sidebar/LibrarianPanel.tsx`：添加“Summaries”区域（可折叠，查看故事状态时默认展开）。
- 每个 summary fragment 渲染为卡片：名称、字符数、章节标签、适用时的“(era summary)”标记，以及快捷操作（编辑、归档、取消归档、跳转到所覆盖 prose）。
- 点击摘要会在 `FragmentEditor` 中打开，现有 fragment 编辑界面可直接使用。

### 归档面板

- `src/components/sidebar/ArchivePanel.tsx`：通用过滤器已经会显示已归档 summary fragment。将它们按章节分组到“Summaries”子区域，避免归档面板过于杂乱。

### Analysis 详情

- 在 analysis PATCH 路由编辑摘要的位置（此前为内联摘要编辑添加的路由）：如果设置了 `summaryFragmentId`，则将“Save”操作改为更新所引用 summary fragment 的内容。UI 中 analysis 记录的 `summaryUpdate` 字符串变为只读（它现在表示意图，而不是事实来源）。

## 测试计划

在 `tests/librarian/summary-fragments.test.ts` 中新增测试：

- 创建新 prose fragment 会创建/更新章节 summary fragment。
- 同一章节的第二个 prose 会追加到同一个 summary fragment。
- 超过溢出阈值会触发：归档旧章节摘要、使用压缩内容创建 era summary、使用较新的一半创建新章节摘要。
- 后续 librarian 运行会保留用户对 summary fragment 的编辑（librarian 追加到用户编辑后的内容）。
- 已归档摘要不进入上下文，但可以恢复。
- 迁移：`story.summary` 非空的故事会生成一个 summary fragment，并清空该字段。
- `ctx.getFragment(summaryId)` 可在脚本块中使用。

更新现有 `tests/librarian/agent.test.ts`：

- 删除关于 `story.summary` 字符串修改的断言。
- 改为断言 summary fragment 的创建。

更新 `tests/llm/context-builder.test.ts`：

- 将旧故事摘要块的断言替换为 summary fragment 块的断言。

## 执行顺序

四个阶段。每个阶段都以 `bun run test` 全部通过作为结束条件。

**阶段 1——基础设施：**
- 注册 `summary` fragment 类型（registry + prefix + schema）。
- 在类型 registry 中添加 `hiddenFromList` 标志。
- 编写迁移函数（独立、幂等）。
- 从 `StoryMeta` 删除 `story.summary` 及其写入方。此处测试失败可以接受，将在阶段 2 修复。

**阶段 2——重写 librarian（依赖阶段 1）：**
- 重写 `applyDeferredSummaries`，生成 summary fragment。
- 在 analysis 记录中添加 `summaryFragmentId`。
- 调整 `compactSummary`，使其处理 fragment 最旧的一半。
- 移除 `_librarian.summary` 写入。

**阶段 3——上下文构建器 + UI 过滤（依赖阶段 2）：**
- 更新 `buildSummaryBeforeFragment` + `createDefaultBlocks`。
- 在 `FragmentList` 中隐藏摘要。
- 修复阶段 1 删除字段导致的测试失败。

**阶段 4——librarian 面板 UI + analysis 编辑重定向（依赖阶段 3）：**
- 在 `LibrarianPanel` 中添加“Summaries”区域。
- 将内联摘要编辑重定向到 fragment，而不是 analysis。

## 实施时需要确认的问题

1. **章节检测 API**：是否已有 `getChapterForProse(proseId)` 辅助函数，还是 librarian 当前自行遍历 chain？如果没有，在阶段 1 提取该函数。
2. **上下文中的归档过滤**：验证 `buildContextState` 当前是否过滤 archived fragment。如果没有，请添加过滤；无论如何这都是一项正确性修复。
3. **溢出阈值作为故事设置还是硬编码**：先硬编码为 2000，仅在用户提出需求时提升为故事设置。
4. **Summary `placement` 默认值**：计划写的是放在 prose 之前的“system”位置。值得尝试使用“user”（位于 user 消息内），比较生成时哪种效果更好。
