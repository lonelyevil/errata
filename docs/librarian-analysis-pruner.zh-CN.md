# Librarian 历史分析清理（内置工具）

## 功能

Librarian Chat 内置 `pruneLibrarianAnalyses` 工具，用于清理同一故事、同一分支中已被同一 `fragmentId` 的更新分析替代的历史分析。它解决的是“每个 prose 保留最新一次分析”，不是按名称去重，也不删除 prose 或 summary fragment。

## 使用方式

在 Librarian Chat 中要求检查旧分析即可触发预览。工具契约：

```ts
pruneLibrarianAnalyses({
  dryRun?: boolean,     // 默认 true，仅预览
  pruneToken?: string,  // dryRun: false 时必填
})
```

1. 默认或 `dryRun: true`：只读扫描，返回候选数量、分组、保留的最新分析 ID 和 `pruneToken`。
2. 用户明确确认后，以 `{ dryRun: false, pruneToken }` 调用一次，才会删除分析。
3. 令牌绑定 dataDir、story、分支和完整分析状态（所有分析 ID + `createdAt`）。5 分钟后过期，且只能使用一次；候选变化、换分支或换故事都会要求重新预览。
4. Librarian 运行状态不是 `idle` 时，预览和执行都会被拒绝。

## 保留规则

- 每个 `fragmentId` 永远保留最新分析；同一 `createdAt` 时按 `analysis.id` 决定新旧。
- 当前分析索引 `latestByFragmentId` 指向的记录不会被删除，即使它不是扫描出的最新记录。
- `appliedSummarySequence` 引用的分析不会被删除。
- 不删除任何 fragment，包括 archived、inactive 或已脱离 prose chain 的 fragment。
- 摘要 fragment（含 archived）只清理 `meta.analysisIds` 中已删除的 ID，摘要内容和其他元数据保持不变。
- 候选按 `fragmentId`、`createdAt`、`id` 稳定排序，分组名通过包含 archived 的 fragment 列表解析。

## 并发与失败

- 使用 `withBranch` 固定分支上下文，并使用插件级 `withKeyLock` 与分析/索引共享锁 `withAnalysisLock` 串行化。
- `saveAnalysis` 与分析删除、索引重建共用同一把进程内索引锁；锁支持同一异步链内重入，避免自死锁。
- 删除、索引重建或 summary 更新失败时，返回 `failed` / `cleanupErrors`，`ok` 为 `false`，不会报告完整成功。
- 这是单进程、可信本地应用的尽力保护，不提供跨进程事务；实际删除不可恢复，启用前应备份数据目录。

## 实现与测试

- 实现：`src/server/librarian/analysis-pruner.ts`
- Chat 注册：`src/server/librarian/chat.ts`
- 提示词与工具元数据：`src/server/librarian/blocks.ts`、`src/server/librarian/agents.ts`
- 测试：`tests/librarian/analysis-pruner.test.ts`、`tests/librarian/chat.test.ts`

工具为内置功能，无需安装或配置外部插件。
