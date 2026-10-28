# 时间线

时间线让你探索不同的故事发展方向，同时不会丢失此前的工作。每条时间线都是故事内容的完整独立副本，包括 prose、fragment、librarian 状态和全部元数据，可独立编辑。

在内部，时间线称为“branch”（分支）。面向用户的术语是“Timelines”（时间线）。

## 概述

每个故事都从一条名为 **Main** 的时间线开始。创建新时间线时，Errata 会将父时间线的整个分支内容目录复制到新目录。此后两条时间线完全独立：一条时间线中的编辑、生成、librarian 分析、角色聊天和分支级提示词配置，都不会影响另一条。

当前活跃时间线决定所有操作加载的内容。切换时间线会更换活跃内容根目录，后续读取、写入和生成都使用该时间线的数据。

## 数据结构

```
data/stories/{storyId}/
  meta.json                    # 故事元数据（跨时间线共享）
  branches.json                # 时间线索引：分支列表 + 活跃分支 ID
  branches/
    main/
      prose-chain.json
      block-config.json
      agent-blocks/
      character-chat/
      fragments/
      associations.json
      generation-logs/
      librarian/
    {branchId}/
      prose-chain.json
      block-config.json
      agent-blocks/
      character-chat/
      fragments/
      associations.json
      generation-logs/
      librarian/
```

故事级元数据（`meta.json`）由所有时间线共享。`branches/{id}/` 下的所有内容均为时间线专用。

## Schema

### BranchMeta

```ts
interface BranchMeta {
  id: string               // "main" or "br-{12-char-alphanumeric}"
  name: string             // User-facing name (max 100 chars)
  order: number            // Display order
  parentBranchId?: string  // Parent timeline (for lineage tracking)
  forkAfterIndex?: number  // Prose section index where the fork occurred
  createdAt: string        // ISO 8601 datetime
}
```

### BranchesIndex

```ts
interface BranchesIndex {
  branches: BranchMeta[]   // All timelines for the story
  activeBranchId: string   // Currently active timeline
}
```

## 内容根目录解析

所有 fragment、Prose Chain 和 librarian 操作都通过 `getContentRoot(dataDir, storyId)` 获取当前活跃时间线的目录路径。这一关键抽象让时间线隔离对代码库其他部分保持透明。

```ts
// Returns: data/stories/{storyId}/branches/{activeBranchId}
const root = await getContentRoot(dataDir, storyId)
```

需要操作特定时间线时（例如创建分支），还可使用 `getContentRootForBranch(dataDir, storyId, branchId)`。

## 迁移

时间线系统推出前创建的故事，其内容位于故事根目录。首次访问时，`migrateIfNeeded()` 会检测这种布局，将全部内容移动到 `branches/main/`，然后创建初始 `branches.json`。该迁移对每个故事只运行一次，并在内存中缓存。

迁移的内容包括：

- `prose-chain.json`
- `fragments/`
- `associations.json`
- `generation-logs/`
- `librarian/`

分支级文件（如 `block-config.json`、`agent-blocks/` 和 `character-chat/`）会在首次使用时在分支内创建，后续复制分支时会自动继承。

## 创建时间线

`createBranch(dataDir, storyId, name, parentBranchId, forkAfterIndex?)` 执行以下步骤：

1. 生成唯一分支 ID（`br-{12-char-alphanumeric}`）
2. 递归复制父时间线的整个目录
3. 如果提供 `forkAfterIndex`，将 Prose Chain 截断为 `entries.slice(0, forkAfterIndex + 1)`
4. 将新分支元数据写入 `branches.json`
5. 将新分支设为活跃分支

`forkAfterIndex` 支持从故事中段分叉。例如，Prose Chain 有 5 个分节，在索引 2 处分叉时，新时间线会保留分节 0–2，并可从该点创作不同的后续内容。由于会先复制整个分支目录，分叉还会继承父分支截至该点的 librarian 数据、生成日志、角色聊天历史以及分支级块/agent 配置。

## 从 Prose 分叉

Chain 视图中的每个 prose 分节都有 **Split from here** 操作（git-branch 图标）。点击后：

1. 提示输入时间线名称
2. 以该分节索引作为 `forkAfterIndex` 调用 `createBranch()`
3. 切换到新时间线
4. 用户随后可以从分叉点生成，创建不同的故事路径

这是用户创建不同故事线的主要方式。

## 切换时间线

`switchActiveBranch()` 更新 `branches.json` 中的 `activeBranchId`。后续所有操作（fragment 读取、Prose Chain 访问、生成、librarian）都会自动使用新时间线的内容目录。

## 删除时间线

`deleteBranch()` 会完全删除分支目录并清理 `branches.json`。如果删除的是当前活跃时间线，则回退到 `main`。`main` 时间线不能删除。

## 重命名时间线

`renameBranch()` 更新 `branches.json` 中的分支名称。

## Librarian 集成

每条时间线都有独立的 `librarian/` 目录，其中包含：

- Librarian 状态（最近分析的 fragment、最近提及、时间线事件）
- Analysis 记录
- 聊天历史

创建时间线时，父时间线的 librarian 数据会随其他内容一起复制。此后，librarian 分析和聊天会话在各时间线中相互独立。

## API 端点

所有端点均位于 `/api/stories/:storyId/branches` 下。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/branches` | 列出全部时间线和当前活跃时间线 ID |
| `POST` | `/branches` | 创建新时间线（请求体：`{ name, parentBranchId, forkAfterIndex? }`） |
| `PATCH` | `/branches/active` | 切换活跃时间线（请求体：`{ branchId }`） |
| `PUT` | `/branches/:branchId` | 重命名时间线（请求体：`{ name }`） |
| `DELETE` | `/branches/:branchId` | 删除时间线 |

## UI 组件

### TimelineTabs

Prose 编辑器顶部的水平标签栏，仅在存在多条时间线时显示。每个标签显示时间线名称和 git-branch 图标（Main 除外），当前活跃标签会高亮。包括：

- 点击标签切换时间线
- 活跃标签上的 `...` 菜单：Rename、Delete（Main 禁用）
- `+` 按钮，从当前时间线创建新时间线
- Eye-off 按钮，隐藏标签栏（可通过设置重新显示）

可见性由 **Settings > Interface > Timeline bar** 中的 UI 偏好控制。

### TimelineManagerPanel

侧边栏面板，显示完整时间线列表、父子关系信息（例如“from Main at section 2”）和操作按钮。以更详细的布局提供与 TimelineTabs 相同的操作，可从故事侧边栏的 Management 区域打开。

## 文件参考

| 文件 | 用途 |
|---|---|
| `src/server/fragments/branches.ts` | 核心分支逻辑：迁移、CRUD、内容根目录解析。在 agent 和生成代码中使用 `withBranch()` 实现分支感知存储。 |
| `src/server/fragments/schema.ts` | `BranchMetaSchema`、`BranchesIndexSchema` |
| `src/lib/api/branches.ts` | 前端 API 客户端 |
| `src/lib/api/types.ts` | `BranchMeta`、`BranchesIndex` TypeScript 类型 |
| `src/lib/fragment-ids.ts` | `generateBranchId()` |
| `src/components/prose/TimelineTabs.tsx` | 顶部标签栏组件 |
| `src/components/sidebar/TimelineManagerPanel.tsx` | 侧边栏管理面板 |
| `src/components/prose/ProseBlock.tsx` | Prose 分节的“Split from here”操作 |
| `src/routes/story.$storyId.tsx` | 路由集成、查询钩子、可见性状态 |
| `tests/fragments/branches.test.ts` | 分支 CRUD 和隔离测试 |
