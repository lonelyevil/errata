# Fragments 与 Prose Chain

Errata 中的一切都是 **fragment**——prose、角色、准则、知识、图片、图标和章节标记。Fragment 是原子数据单位。**Prose Chain** 将 prose fragment 按顺序组织为可读的故事时间线，并支持变体和分支。

本文涵盖编写导入器或以编程方式集成 Errata 所需的完整数据模型和 API。

## Fragment Schema

每个 fragment 都是符合该 schema 的 JSON 对象。来源：`src/server/fragments/schema.ts`。

| 字段 | 类型 | 默认值 | 约束 | 说明 |
|---|---|---|---|---|
| `id` | `string` | — | `/^[a-z]{2,4}-[a-z0-9]{4,12}$/` | 带类型前缀的唯一 ID。见 [Fragment ID](#fragment-id)。 |
| `type` | `string` | — | 至少 1 个字符 | Fragment 类型（例如 `prose`、`character`、`guideline`）。 |
| `name` | `string` | — | 最多 100 个字符 | 人类可读名称。 |
| `description` | `string` | — | 最多 250 个字符 | 简短描述。 |
| `content` | `string` | — | — | 主要内容（prose 文本、角色简介、知识条目等）。 |
| `tags` | `string[]` | `[]` | — | 用于组织的自由形式标签。 |
| `refs` | `string[]` | `[]` | 每项都匹配 fragment ID 格式 | 对其他 fragment ID 的引用。 |
| `sticky` | `boolean` | `false` | — | 为 `true` 时始终包含在 LLM 上下文中。 |
| `placement` | `"system" \| "user"` | `"user"` | — | 放置 fragment 的 LLM 消息角色。 |
| `createdAt` | `string` | — | ISO 8601 日期时间 | 创建时间戳。 |
| `updatedAt` | `string` | — | ISO 8601 日期时间 | 最后修改时间戳。 |
| `order` | `integer` | `0` | — | 类型组内的排序。 |
| `meta` | `Record<string, unknown>` | `{}` | — | 任意元数据，用于生成信息、导入来源、视觉引用等。 |
| `archived` | `boolean` | `false` | — | 软删除标志。已归档 fragment 默认不出现在列表中。 |
| `version` | `integer` | `1` | 最小 1 | 当前版本号，每次内容变更时递增。 |
| `versions` | `FragmentVersion[]` | `[]` | — | 版本历史快照，见下文。 |

### FragmentVersion

`versions` 中的每个条目记录一个先前状态：

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | `integer` | 此快照的版本号。 |
| `name` | `string` | 快照时的名称。 |
| `description` | `string` | 快照时的描述。 |
| `content` | `string` | 快照时的内容。 |
| `createdAt` | `string` | 记录该版本的 ISO 8601 日期时间。 |
| `reason` | `string?` | 可选原因（例如 `"manual-update"`、`"revert-to-2"`）。 |

通过 API 的 `PUT` 端点更新 fragment 时，先前状态会自动快照到 `versions`，并递增 `version`。

## Fragment 类型

内置类型在 `src/server/fragments/registry.ts` 中注册。每种类型定义前缀、默认 sticky 值以及在 LLM 上下文中的渲染方式。

| 类型 | 前缀 | 默认 Sticky | 上下文渲染 | LLM 工具 |
|---|---|---|---|---|
| `prose` | `pr` | `false` | 原样内容 | 无 |
| `character` | `ch` | `false` | `## {name}\n{content}` | 无 |
| `guideline` | `gl` | `true` | `**{name}**: {content}` | 无 |
| `knowledge` | `kn` | `false` | `### {name}\n{content}` | 无 |
| `image` | `im` | `false` | `[image:{id}] {name} - {description}` | 无 |
| `icon` | `ic` | `false` | `[icon:{id}] {name} - {description}` | 无 |
| `marker` | `mk` | `false` | *（空——marker 是结构，不是内容）* | 无 |

插件可通过 `FragmentTypeRegistry` 使用自定义前缀注册额外类型。

### 类型语义

- **prose**——故事文本，由 Prose Chain 排序。不通过 fragment 列表直接进入上下文；Prose Chain 控制哪些 prose fragment 出现在上下文中。
- **character**——角色定义，包括简介、个性和外貌。Sticky character 始终位于上下文中；非 sticky character 出现在候选列表中，LLM 可通过工具查询。
- **guideline**——写作指令，默认 sticky，即始终位于上下文中。用于风格规则、语气指导、应做/不应做事项。
- **knowledge**——世界观事实、背景设定和规则。默认非 sticky；LLM 可看到候选列表，并通过工具读取完整条目。
- **image** / **icon**——媒体引用。内容通常是 base64 data URL 或外部 URL。
- **marker**——章节标记。插入 Prose Chain 以划分章节，不向 LLM 上下文渲染内容，但会组织故事时间线。

## Fragment ID

来源：`src/lib/fragment-ids.ts`。

### 格式

```
{prefix}-{6 consonant-vowel alternating chars}
```

示例：`pr-bakife`、`ch-gomazu`、`gl-tivone`、`kn-dubera`、`mk-sanoti`

### 生成规则

1. 从类型 → 前缀映射中查找前缀。如果类型不在映射中，使用类型名称的小写前 4 个字符。
2. 后缀为 6 个字符，辅音和元音交替（位置 0、2、4 为辅音；1、3、5 为元音）。
3. 辅音池：`bdfgkmnprstvz`（13 个字符）。
4. 元音池：`aeiou`（5 个字符）。
5. 每个类型前缀约可产生 274k 个唯一 ID。

### 前缀映射

| 类型 | 前缀 |
|---|---|
| `prose` | `pr` |
| `character` | `ch` |
| `guideline` | `gl` |
| `knowledge` | `kn` |
| `image` | `im` |
| `icon` | `ic` |
| `marker` | `mk` |

Schema 强制执行的 ID 正则为：`/^[a-z]{2,4}-[a-z0-9]{4,12}$/`

编写导入器时，可以自行生成 ID，只要符合该模式并在故事内唯一。辅音-元音交替是约定，正则并不强制。

## Prose Chain

Prose Chain 是组成故事的 prose 分节有序序列。来源：`src/server/fragments/prose-chain.ts`，schema 位于 `src/server/fragments/schema.ts`。

### Schema

```json
{
  "entries": [
    {
      "proseFragments": ["pr-bakife"],
      "active": "pr-bakife"
    },
    {
      "proseFragments": ["pr-gomazu", "pr-tivone"],
      "active": "pr-tivone"
    }
  ]
}
```

### 概念

- **Entry**——故事中的一个分节/位置，包含一个或多个 prose fragment ID。
- **`proseFragments`**——该位置所有 fragment ID 的数组。重新生成或优化分节时，新 fragment 会与原 fragment 一起添加到这里。这些就是分节的“变体”或“改写版本”。
- **`active`**——该位置当前选中的 fragment ID，即读者看到并进入 LLM 上下文的内容。必须是 `proseFragments` 中的一个 ID。

### 工作方式

Prose Chain 是**故事时间线**。按顺序读取每个 entry 的 `active` 字段，即可得到当前故事文本：

```
entry[0].active → "Once upon a time..."
entry[1].active → "The hero set out on a journey..."
entry[2].active → "They arrived at the castle..."
```

作者生成新 prose 时会追加新 entry。重新生成现有分节时，会创建新 fragment 并作为变体添加到该 entry（新 fragment 成为 `active`）。作者可通过 `switchActiveProse` 在变体之间切换。

Prose UI 还支持：

- 在此前重新生成的版本之间快速切换变体
- 由 librarian 对内联 prose fragment 进行手动分析
- 从任意 prose 分节分叉时间线
- 通过大纲面板重排分节

### Marker entry

章节标记（`marker` 类型）也是 Prose Chain 中的 entry。它们像 prose 分节一样位于 chain 中的某个位置，但其 fragment 不渲染文本，用于组织章节和摘要。

### 操作

| 函数 | 说明 |
|---|---|
| `initProseChain(dataDir, storyId, fragmentId)` | 创建包含一个 entry 的新 chain。 |
| `addProseSection(dataDir, storyId, fragmentId)` | 在末尾追加新 entry。 |
| `insertProseSection(dataDir, storyId, fragmentId, position)` | 在指定索引处插入。 |
| `addProseVariation(dataDir, storyId, sectionIndex, fragmentId)` | 向现有 entry 添加变体（并设为 active）。 |
| `switchActiveProse(dataDir, storyId, sectionIndex, fragmentId)` | 修改哪个变体处于 active 状态。 |
| `removeProseSection(dataDir, storyId, sectionIndex)` | 删除 entry，返回其中的 fragment ID。 |
| `findSectionIndex(dataDir, storyId, fragmentId)` | 查找包含指定 fragment ID 的 entry。 |
| `getActiveProseIds(dataDir, storyId)` | 按顺序获取所有 active fragment ID（当前时间线）。 |
| `getFullProseChain(dataDir, storyId)` | 获取包含全部变体的完整 chain。 |

## 存储布局

Errata 使用文件系统存储，不使用数据库。所有数据位于 `DATA_DIR`（默认 `./data`）下。来源：`src/server/fragments/storage.ts`、`src/server/fragments/branches.ts`。

### 目录树

```
data/
├── config.json                              # 全局配置（provider、默认值）
└── stories/
    └── {storyId}/
        ├── meta.json                        # 故事元数据（StoryMeta）
        ├── branches.json                    # 分支索引
        └── branches/
            └── {branchId}/                  # “main”为默认分支
                ├── prose-chain.json         # Prose Chain
                ├── associations.json        # 标签/引用索引
                ├── fragments/
                │   ├── pr-bakife.json       # 独立 fragment 文件
                │   ├── ch-gomazu.json
                │   ├── gl-tivone.json
                │   └── ...
                ├── generation-logs/
                │   └── gen-xxxxx.json
                ├── block-config.json        # 分支级 generation 块配置
                ├── agent-blocks/
                │   └── generation.writer.json
                ├── character-chat/
                │   └── conversations/
                └── librarian/
                    ├── state.json
                    └── analyses/
                        └── ...
```

### 关键细节

- **Story ID** 是根据故事名称生成并附加时间戳的 URL 安全 slug：`my-story-lk5abc`。
- **分支感知路径**：内容（fragment、Prose Chain、association、librarian 数据、块配置、agent 块配置、角色聊天）位于 `branches/{branchId}/` 下。默认分支始终为 `main`。`branches.json` 跟踪当前活跃分支。
- **Fragment 文件**以 `{fragmentId}.json` 命名，包含完整 fragment 对象。
- **`prose-chain.json`** 存储活跃分支的 chain。
- **`meta.json`** 和 `branches.json` 位于故事根目录，不属于分支级数据。

### Fragment 文件示例（`pr-bakife.json`）

```json
{
  "id": "pr-bakife",
  "type": "prose",
  "name": "[Continuation] The story begins",
  "description": "The story begins with a dark and stormy night.",
  "content": "It was a dark and stormy night. The wind howled through the empty streets...",
  "tags": [],
  "refs": [],
  "sticky": false,
  "placement": "user",
  "createdAt": "2025-01-15T10:30:00.000Z",
  "updatedAt": "2025-01-15T10:30:00.000Z",
  "order": 0,
  "meta": {
    "generatedFrom": "Begin the story with a dark and stormy night"
  },
  "archived": false,
  "version": 1,
  "versions": []
}
```

### prose-chain.json 示例

```json
{
  "entries": [
    {
      "proseFragments": ["pr-bakife"],
      "active": "pr-bakife"
    },
    {
      "proseFragments": ["pr-gomazu", "pr-dubera"],
      "active": "pr-dubera"
    },
    {
      "proseFragments": ["mk-sanoti"],
      "active": "mk-sanoti"
    },
    {
      "proseFragments": ["pr-tivone"],
      "active": "pr-tivone"
    }
  ]
}
```

在此示例中，entry 1 有两个变体（`pr-gomazu` 是原文，`pr-dubera` 是当前 active 的重新生成版本）。Entry 2 是章节标记。

## API 参考

所有端点以 `/api` 为前缀。请求/响应体均为 JSON。

### Stories

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| `POST` | `/stories` | `{ name, description, coverImage? }` | `StoryMeta` |
| `GET` | `/stories` | — | `StoryMeta[]` |
| `GET` | `/stories/:storyId` | — | `StoryMeta` |
| `PUT` | `/stories/:storyId` | `{ name, description, summary?, coverImage? }` | `StoryMeta` |
| `DELETE` | `/stories/:storyId` | — | `{ ok: true }` |
| `PATCH` | `/stories/:storyId/settings` | 部分设置对象 | `StoryMeta` |

与 prose 生成和记忆相关的重要故事设置包括：

- `generationMode: 'standard' | 'prewriter'`
- `maxSteps`
- `disableThinking`
- `contextCompact: { type: 'proseLimit' | 'maxTokens' | 'maxCharacters', value }`
- `summarizationThreshold`
- `summaryCompact: { maxCharacters, targetCharacters }`
- `enableHierarchicalSummary`
- `disableLibrarianAutoAnalysis`
- `autoApplyLibrarianSuggestions`
- `disableLibrarianDirections`
- `disableLibrarianSuggestions`

### Fragments

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| `POST` | `/stories/:storyId/fragments` | `{ type, name, description, content, tags?, meta? }` | `Fragment` |
| `GET` | `/stories/:storyId/fragments` | 查询：`?type=prose&includeArchived=true` | `Fragment[]` |
| `GET` | `/stories/:storyId/fragments/:fragmentId` | — | `Fragment` |
| `PUT` | `/stories/:storyId/fragments/:fragmentId` | `{ name, description, content, sticky?, order?, placement?, meta? }` | `Fragment` |
| `PATCH` | `/stories/:storyId/fragments/:fragmentId` | `{ oldText, newText }` | `Fragment`（内容查找替换） |
| `DELETE` | `/stories/:storyId/fragments/:fragmentId` | — | `{ ok: true }`（必须先归档） |

`PUT` 端点自动创建版本快照。`PATCH` 端点对 fragment 内容执行字符串查找替换。

删除前必须先归档 fragment，否则返回 422 错误。

### Fragment 生命周期

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| `POST` | `/stories/:storyId/fragments/:fragmentId/archive` | — | `Fragment` |
| `POST` | `/stories/:storyId/fragments/:fragmentId/restore` | — | `Fragment` |
| `POST` | `/stories/:storyId/fragments/:fragmentId/revert` | — | `Fragment`（回退到先前版本） |

### Fragment 版本

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| `GET` | `/stories/:storyId/fragments/:fragmentId/versions` | — | `{ versions: FragmentVersion[] }` |
| `POST` | `/stories/:storyId/fragments/:fragmentId/versions/:version/revert` | — | `Fragment` |

### 标签

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| `GET` | `/stories/:storyId/fragments/:fragmentId/tags` | — | `{ tags: string[] }` |
| `POST` | `/stories/:storyId/fragments/:fragmentId/tags` | `{ tag }` | `{ ok: true }` |
| `DELETE` | `/stories/:storyId/fragments/:fragmentId/tags` | `{ tag }` | `{ ok: true }` |

### 引用

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| `GET` | `/stories/:storyId/fragments/:fragmentId/refs` | — | `{ refs: string[], backRefs: string[] }` |
| `POST` | `/stories/:storyId/fragments/:fragmentId/refs` | `{ targetId }` | `{ ok: true }` |
| `DELETE` | `/stories/:storyId/fragments/:fragmentId/refs` | `{ targetId }` | `{ ok: true }` |

### Sticky 与 placement

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| `PATCH` | `/stories/:storyId/fragments/:fragmentId/sticky` | `{ sticky: boolean }` | `{ ok: true, sticky }` |
| `PATCH` | `/stories/:storyId/fragments/:fragmentId/placement` | `{ placement: "system" \| "user" }` | `{ ok: true, placement }` |

### 重排

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| `PATCH` | `/stories/:storyId/fragments/reorder` | `{ items: [{ id, order }] }` | `{ ok: true }` |

### Fragment 类型

| 方法 | 路径 | 响应 |
|---|---|---|
| `GET` | `/stories/:storyId/fragment-types` | `[{ type, prefix, stickyByDefault }]` |

### Prose Chain

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| `GET` | `/stories/:storyId/prose-chain` | — | `{ entries: [{ proseFragments: [...], active }] }`（fragment 会展开为 id、name、description、createdAt、generationMode） |
| `POST` | `/stories/:storyId/prose-chain` | `{ fragmentId }` | `{ ok: true }`（追加分节） |
| `POST` | `/stories/:storyId/prose-chain/:sectionIndex/switch` | `{ fragmentId }` | `{ ok: true }`（切换 active 变体） |
| `DELETE` | `/stories/:storyId/prose-chain/:sectionIndex` | — | `{ ok: true, archivedFragmentIds }`（删除分节并归档 fragment） |

### 生成

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| `POST` | `/stories/:storyId/generate` | `{ input, saveResult?, mode?, fragmentId? }` | 流式 NDJSON/text 响应，包含 `text`、`reasoning`、`tool-call`、`tool-result`、`phase`、`finish` 和可选 prewriter 事件 |
| `POST` | `/stories/:storyId/suggest-directions` | `{ count? }` | `{ suggestions }` |

生成模式：

- `generate`——追加新 prose 分节
- `regenerate`——向现有分节添加新变体
- `refine`——根据优化指令重写现有 prose fragment

生成后的自动 librarian 分析可通过故事设置（`disableLibrarianAutoAnalysis`）或 `librarian.analyze` agent 配置中的 `disableAutoAnalysis` 标志禁用。

### Prose 视图使用的 Librarian 后续端点

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| `GET` | `/stories/:storyId/librarian/analysis-index` | — | `{ [fragmentId]: analysisId }` |
| `POST` | `/stories/:storyId/librarian/analyze` | `{ fragmentId }` | `{ ok: true, fragmentId }` |

Prose Chain 视图使用这些端点显示 prose 块是否已有分析，并从块操作菜单触发手动重新分析。

### 章节

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| `POST` | `/stories/:storyId/chapters` | `{ name, description?, content?, position }` | `{ fragment }`（创建 marker 并插入 chain） |
| `POST` | `/stories/:storyId/chapters/:fragmentId/summarize` | — | `{ summary, reasoning, modelId, durationMs }` |

### 分支

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| `GET` | `/stories/:storyId/branches` | — | `BranchesIndex` |
| `POST` | `/stories/:storyId/branches` | `{ name, parentBranchId, forkAfterIndex? }` | `BranchMeta` |
| `PATCH` | `/stories/:storyId/branches/active` | `{ branchId }` | `{ ok: true }` |
| `PUT` | `/stories/:storyId/branches/:branchId` | `{ name }` | `BranchMeta` |
| `DELETE` | `/stories/:storyId/branches/:branchId` | — | `{ ok: true }` |

### 故事导出/导入

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| `GET` | `/stories/:storyId/export` | 查询：`?includeLogs=true&includeLibrarian=true` | ZIP 文件（二进制） |
| `POST` | `/stories/import` | 带 `file` 字段的 `multipart/form-data` | `StoryMeta` |

## 导入/导出格式

Errata 的剪贴板和文件导出使用 JSON 外层格式。来源：`src/lib/fragment-clipboard.ts`。

### 单 Fragment 导出

```json
{
  "_errata": "fragment",
  "version": 1,
  "source": "uuid-of-source-instance",
  "exportedAt": "2025-01-15T10:30:00.000Z",
  "fragment": {
    "type": "character",
    "name": "Elena Vasquez",
    "description": "A retired detective drawn back into one last case.",
    "content": "Elena is 52, sharp-eyed, with silver-streaked hair...",
    "tags": ["protagonist", "detective"],
    "sticky": false
  },
  "attachments": [
    {
      "kind": "image",
      "name": "Elena portrait",
      "description": "Character portrait",
      "content": "data:image/png;base64,...",
      "boundary": { "x": 0, "y": 0, "width": 512, "height": 512 }
    }
  ]
}
```

`_errata` 字段标识格式。单 fragment 为 `"fragment"`，多 fragment 包为 `"fragment-bundle"`。

### 打包导出

```json
{
  "_errata": "fragment-bundle",
  "version": 1,
  "source": "uuid-of-source-instance",
  "exportedAt": "2025-01-15T10:30:00.000Z",
  "storyName": "The Last Case",
  "fragments": [
    {
      "type": "character",
      "name": "Elena Vasquez",
      "description": "A retired detective.",
      "content": "Elena is 52...",
      "tags": ["protagonist"],
      "sticky": false
    },
    {
      "type": "guideline",
      "name": "Noir tone",
      "description": "Maintain noir atmosphere.",
      "content": "Write in a hardboiled noir style...",
      "tags": ["style"],
      "sticky": true
    }
  ]
}
```

### 通过 API 导入

导出格式是客户端便利格式。要以编程方式导入，请直接使用 fragment CRUD 端点：

1. `POST /api/stories`——创建故事。
2. `POST /api/stories/:storyId/fragments`——创建每个 fragment。
3. `POST /api/stories/:storyId/prose-chain`——按顺序将 prose fragment 添加到 chain。

## 移植指南：SillyTavern / TavernAI 到 Errata

本节介绍 SillyTavern 概念与 Errata fragment 的映射，以及导入会话历史的步骤。

### 概念映射

| SillyTavern | Errata | 说明 |
|---|---|---|
| 消息（assistant） | Prose Chain 中的 `prose` fragment | 每条 assistant 消息成为一个 prose fragment。 |
| 消息（user） | Prose Chain 中的 `prose` fragment | User 消息也成为 prose fragment，可按需添加角色/用户名称前缀。 |
| 角色卡 | `character` fragment | 名称、描述、个性进入 content。 |
| 角色卡——system prompt | `sticky: true` 的 `guideline` fragment | System prompt 映射为始终启用的 guideline。 |
| 角色卡——scenario | `knowledge` fragment | 场景/背景成为世界知识。 |
| 角色卡——first message | Chain 中的第一个 `prose` fragment | 问候语成为开头的 prose entry。 |
| 角色卡——example messages | `guideline` fragment | 示例对话成为风格/声音 guideline。 |
| World Info / Lorebook 条目 | `knowledge` 或 `guideline` fragment | 每个 lorebook 条目成为一个 fragment。类型根据 `constant`/`position` 字段推断（见 [lorebook 推断规则](#lorebook-条目类型推断规则)）。激活 `keys` 成为 fragment 标签。UI 导入对话框允许逐条覆盖推断类型。 |
| Author's Note | `sticky: true` 的 `guideline` fragment | 应始终位于上下文中的作者注释。 |
| System prompt（全局） | `sticky: true`、`placement: "system"` 的 `guideline` fragment | 使用 `placement: "system"` 放入 system 消息。 |

### 分步导入

#### 1. 创建故事

```bash
curl -X POST http://localhost:7739/api/stories \
  -H "Content-Type: application/json" \
  -d '{"name": "Imported Chat", "description": "Imported from SillyTavern"}'
```

保存返回的 `id`（例如 `imported-chat-lk5abc`）。

#### 2. 导入角色卡

```bash
curl -X POST http://localhost:7739/api/stories/imported-chat-lk5abc/fragments \
  -H "Content-Type: application/json" \
  -d '{
    "type": "character",
    "name": "Elena",
    "description": "A retired detective drawn back into one last case.",
    "content": "Elena is 52, sharp-eyed, with silver-streaked hair. She speaks in clipped sentences and never fully trusts anyone.",
    "tags": ["protagonist"]
  }'
```

如果角色卡包含 system prompt，请创建 sticky guideline：

```bash
curl -X POST http://localhost:7739/api/stories/imported-chat-lk5abc/fragments \
  -H "Content-Type: application/json" \
  -d '{
    "type": "guideline",
    "name": "System Prompt",
    "description": "Imported system prompt from character card.",
    "content": "You are roleplaying as Elena. Stay in character at all times. Write in third person.",
    "tags": ["imported", "system-prompt"]
  }'
```

Guideline 默认会是 sticky（服务器应用类型 registry 中的 `stickyByDefault`）。

#### 3. 导入 World Info / Lorebook

```bash
curl -X POST http://localhost:7739/api/stories/imported-chat-lk5abc/fragments \
  -H "Content-Type: application/json" \
  -d '{
    "type": "knowledge",
    "name": "The City of Ashvale",
    "description": "Setting information for the noir city.",
    "content": "Ashvale is a sprawling coastal city perpetually shrouded in fog...",
    "tags": ["setting", "ashvale"]
  }'
```

#### 4. 将消息历史导入为 Prose Fragment

对会话中的每条消息，创建一个 prose fragment 并添加到 chain：

```bash
# First message (the character's greeting / first_mes)
curl -X POST http://localhost:7739/api/stories/imported-chat-lk5abc/fragments \
  -H "Content-Type: application/json" \
  -d '{
    "type": "prose",
    "name": "Opening",
    "description": "Elena greeting.",
    "content": "Elena sat at the bar, nursing a whiskey. She looked up as the door opened. \"You must be the one they sent,\" she said, not bothering to stand."
  }'
# Returns { "id": "pr-bakife", ... }

# Add to prose chain
curl -X POST http://localhost:7739/api/stories/imported-chat-lk5abc/prose-chain \
  -H "Content-Type: application/json" \
  -d '{"fragmentId": "pr-bakife"}'

# Second message
curl -X POST http://localhost:7739/api/stories/imported-chat-lk5abc/fragments \
  -H "Content-Type: application/json" \
  -d '{
    "type": "prose",
    "name": "Response",
    "description": "User response to Elena.",
    "content": "I pulled up a stool next to her. \"Word travels fast in this town. I hear you'\''re the best.\""
  }'
# Returns { "id": "pr-gomazu", ... }

curl -X POST http://localhost:7739/api/stories/imported-chat-lk5abc/prose-chain \
  -H "Content-Type: application/json" \
  -d '{"fragmentId": "pr-gomazu"}'
```

对每条消息重复上述操作。Prose Chain 保留插入顺序，每次 `POST` 都追加到末尾。

#### 5. 可选：添加章节标记

如果希望将导入的会话拆分为章节：

```bash
curl -X POST http://localhost:7739/api/stories/imported-chat-lk5abc/chapters \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Chapter 2: The Investigation",
    "position": 5
  }'
```

`position` 是 marker 插入 Prose Chain 的索引（从 0 开始，后续 entry 会后移）。

### 角色卡导入（PNG + JSON）

Errata 内置 TavernAI / SillyTavern 角色卡导入器（`src/lib/importers/tavern-card.ts`）。支持 PNG 和原始 JSON 格式，包括 `character_book`（lorebook/world book）条目。

#### 支持的格式

| 格式 | 规范 | 工作方式 |
|---|---|---|
| PNG（`.png`） | V2 `chara` / V3 `ccv3` | JSON 以 base64 嵌入 PNG `tEXt` chunk |
| JSON（`.json`） | V2 / V3 | 包含 `data.name` + 角色卡字段的原始 JSON，或包含 `spec` 字段 |

两种格式都可包含具有 lorebook 条目的 `character_book` 对象。

#### 导入内容

导入器根据角色卡构建**可导入项**列表。每项映射到一个 Errata fragment：

| 角色卡字段 | Errata 类型 | Sticky | Placement | 说明 |
|---|---|---|---|---|
| 主角色（`name` + `description` + `personality`） | `character` | 否 | `user` | 始终存在、始终启用 |
| `scenario` | `knowledge` | 否 | `user` | 仅在非空时导入 |
| `first_mes` | `prose` | 否 | `user` | 导入时添加到 Prose Chain |
| `system_prompt` | `guideline` | 是 | `system` | 仅在非空时导入 |
| `character_book` 条目 | 推断 | 视情况而定 | 视情况而定 | 见下文推断规则 |

#### Lorebook 条目类型推断规则

根据属性为每个 lorebook 条目分配 Errata fragment 类型：

- `constant: true` 或 `position: "before_char"` → **guideline**（sticky，system placement）
- 否则 → **knowledge**

用户可在导入前通过导入对话框逐条覆盖建议类型。

#### Lorebook 条目映射

| Lorebook 字段 | Errata 字段 | 说明 |
|---|---|---|
| `name` 或 `comment` 或前 3 个 `keys` | Fragment `name` | 按顺序回退 |
| `content` | Fragment `content` | 完整文本 |
| `content`（截断至 250 字符） | Fragment `description` | 自动截断 |
| `keys` | Fragment `tags` | 激活关键词成为标签 |
| `constant: true` | `sticky: true` | 始终位于上下文中 |
| `position: "before_char"` | `placement: "system"` | 放入 system 消息 |
| `enabled` | UI 中预先勾选 | 禁用条目默认不勾选 |
| `insertion_order`、`priority`、`selective`、`secondary_keys` | Fragment `meta` | 保留供参考 |

#### UI 导入流程

**拖放到故事上：**
- 不含 lorebook 的 PNG → 简单角色卡导入（头像 + character fragment）
- 含 lorebook 的 PNG → 完整导入对话框，包含分组项列表和头像缩略图
- JSON 文件 → 完整导入对话框，包含分组项列表

**拖放到首页（没有故事）：**
- 自动根据角色名称创建新故事
- 进入该故事并打开导入对话框

**URL 获取：**
- 将原始 JSON URL（GitHub gist、CDN 等）粘贴到导入对话框
- 获取并解析角色卡，显示所有条目供选择

导入对话框按来源对项目分组（Character、Card Extras、Lorebook），支持逐条覆盖类型、全选/取消全选，并显示内容预览和标签徽标。

#### 编程 API

```ts
import {
  // PNG functions
  extractTavernCards,
  importTavernCard,
  isTavernCardPng,
  extractParsedCard,
  // JSON functions
  parseCardJson,
  isTavernCardJson,
  // Shared
  buildImportableItems,
  inferEntryType,
} from '@/lib/importers/tavern-card'

// PNG character card (simple — character fragment only)
const buffer: ArrayBuffer = await file.arrayBuffer()
if (isTavernCardPng(buffer)) {
  const character = importTavernCard(buffer)
  // character.type === 'character'
  // character.name, .description, .content, .tags, .meta
}

// PNG character card (full — with lorebook items)
const parsed = extractParsedCard(buffer)
if (parsed) {
  // parsed.card — TavernCardData (name, description, characterBook, etc.)
  // parsed.book — CharacterBook | null (lorebook entries)
  // parsed.items — ImportableItem[] (all items ready for import)
}

// JSON character card
const text = await file.text()
const parsed = parseCardJson(text)
if (parsed) {
  // Same shape as extractParsedCard result
  // parsed.card, parsed.book, parsed.items
}

// Quick detection
isTavernCardJson(jsonString) // true if valid card JSON
isTavernCardPng(arrayBuffer) // true if valid card PNG
```

### 编写批量导入脚本

以下是使用 Node.js/Bun 脚本导入 SillyTavern 聊天导出的一般模式：

```ts
const BASE = 'http://localhost:7739/api'

async function importChat(storyName: string, messages: Array<{ role: string; content: string }>) {
  // 1. Create story
  const story = await fetch(`${BASE}/stories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: storyName, description: 'Imported from SillyTavern' }),
  }).then(r => r.json())

  // 2. Create prose fragments and build chain
  for (const msg of messages) {
    const fragment = await fetch(`${BASE}/stories/${story.id}/fragments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'prose',
        name: `[${msg.role}] ${msg.content.slice(0, 80)}`,
        description: msg.content.slice(0, 250),
        content: msg.content,
      }),
    }).then(r => r.json())

    await fetch(`${BASE}/stories/${story.id}/prose-chain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fragmentId: fragment.id }),
    })
  }

  return story
}
```

### 导入器提示

- **Fragment 名称**最多 100 个字符，请截断较长的消息预览。
- **Fragment 描述**最多 250 个字符。
- **Fragment ID** 由 API 自动生成，使用 HTTP 端点时无需自行生成。
- **Sticky 默认值**由服务器根据 fragment 类型应用。Guideline 默认 `sticky: true`。如果需要非 sticky guideline，请在创建后通过 `PATCH /sticky` 更新。
- **顺序很重要**，请按时间顺序将 fragment 添加到 Prose Chain。
- **分支是可选的**。所有内容都从 `main` 分支开始，之后可通过 API 创建分支。
- **Archived fragment** 不会出现在普通列表中。被替代的内容应归档，而不是删除。
- API 在创建时返回完整 fragment 对象，因此下一步始终可以使用生成的 `id`。

## 文件参考

| 文件 | 用途 |
|---|---|
| `src/server/fragments/schema.ts` | Fragment、ProseChain、StoryMeta、Branches 的 Zod schema |
| `src/server/fragments/storage.ts` | 故事和 fragment 的文件系统 CRUD |
| `src/server/fragments/prose-chain.ts` | Prose Chain 读写操作 |
| `src/server/fragments/registry.ts` | Fragment 类型 registry（内置类型 + 插件类型） |
| `src/server/fragments/branches.ts` | 分支管理、内容根目录解析 |
| `src/server/fragments/associations.ts` | 标签和引用索引管理 |
| `src/lib/fragment-ids.ts` | 使用前缀映射和辅音-元音交替生成 ID |
| `src/lib/fragment-clipboard.ts` | 导入/导出 JSON 外层格式 |
| `src/lib/importers/tavern-card.ts` | TavernAI / SillyTavern 角色卡解析器（PNG + JSON、lorebook） |
| `src/components/fragments/CharacterCardImportDialog.tsx` | 用于含 lorebook 条目角色卡的导入对话框 |
| `src/components/fragments/TavernCardImportDialog.tsx` | 简单 PNG 角色卡导入对话框（无 lorebook） |
| `src/server/api.ts` | API 应用组装（挂载所有路由模块） |
| `src/server/routes/` | 各路由模块（fragments、prose-chain、generation、librarian 等） |
