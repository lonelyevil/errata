# Context Block 系统

Context Block 系统为 LLM 提示词提供结构化、可操作地表示。生成管线不再以命令式方式拼接提示词字符串，而是创建离散的**块**，在编译为最终消息前，可以查找、替换、删除、重排和扩展这些块。

## 概述

生成管线按阶段工作：

```
buildContextState() → beforeContext hooks → createDefaultBlocks() → applyBlockConfig() → beforeBlocks hooks → compileBlocks() → expandMessagesFragmentTags() → beforeGeneration hooks → streamText()
```

1. **`buildContextState()`** 从存储中加载 fragment，形成带类型的状态对象。
2. **`beforeContext`** 钩子允许插件修改状态（添加/删除 fragment、修改作者输入）。
3. **`createDefaultBlocks()`** 将状态转换为 `ContextBlock` 对象数组。
4. **`applyBlockConfig()`** 应用用户的块配置——自定义块、内容覆盖、重排和禁用。
5. **`beforeBlocks`** 钩子允许插件操作各个块（替换指令、注入分节、重排）。
6. **`compileBlocks()`** 添加 `[@block=id]` 标记，按角色分组、按 order 排序，并连接为 `ContextMessage[]`。
7. **`expandMessagesFragmentTags()`** 展开编译后消息内容中的 fragment 引用标签。
8. **`beforeGeneration`** 钩子处理最终消息字符串。

## ContextBlock

```ts
interface ContextBlock {
  id: string                    // 'instructions', 'tools', 'prose', etc.
  name?: string                 // optional human-readable name (used in block markers)
  role: 'system' | 'user'      // which LLM message this block belongs to
  content: string               // text content (no [@block] marker — added by compileBlocks)
  order: number                 // sort key within role group
  source: 'builtin' | string   // 'builtin' for core blocks, plugin name for custom
}
```

## 来源标记

`compileBlocks()` 在编译时会自动为每个块的内容添加 `[@block=...]` 前缀。块内容本身**不应**包含该标记。编译输出中的块之间以空行分隔。

使用两种标记格式：

- `[@block=id]`——用于没有 `name` 或 `name` 与 `id` 相同的块（大多数内置块）
- `[@block=slug src=id]`——用于 `name` 与 `id` 不同的命名块；`slug` 是名称的小写、连字符分隔形式

```
[@block=instructions]
You are a creative writing assistant...

[@block=tools]
## Available Tools
...

[@block=my-style-guide src=cb-a1b2c3]
Write in present tense, third person limited.
```

块内容中使用的其他标记类型：

- `[@section=Label]`——块内的子分节（例如 `system-fragments` 或 `user-fragments` 中的 Guidelines/Knowledge/Characters 分组）
- `[@fragment=id]`——单个 fragment 内容
- `[@plugin=name]`——插件贡献的工具描述

## 默认块

`createDefaultBlocks()` 生成以下块。空分节会被省略。

| 块 ID | 角色 | 顺序 | 内容 |
|---|---|---|---|
| `instructions` | system | 100 | 写作助手指令 |
| `tools` | system | 200 | 可用工具列表 |
| `system-fragments` | system | 300 | 放在 system 位置的 sticky fragment |
| `story-info` | user | 100 | 故事名称 + 描述 |
| `summary` | user | 200 | 故事摘要（为空时省略） |
| `user-fragments` | user | 300 | 放在 user 位置的 sticky fragment |
| `shortlist-guidelines` | user | 400 | 非 sticky guideline 候选列表 |
| `shortlist-knowledge` | user | 410 | 非 sticky knowledge 候选列表 |
| `shortlist-characters` | user | 420 | 非 sticky character 候选列表 |
| `prose` | user | 500 | 近期 Prose Chain |
| `author-input` | user | 600 | 作者指令 |

顺序值以 100 为间隔，便于在现有块之间插入自定义块。

## 块操作

`@tealios/errata-plugin-sdk` 导出六个工具函数。它们都是纯函数，并返回新数组：

```ts
import {
  findBlock,
  replaceBlockContent,
  removeBlock,
  insertBlockBefore,
  insertBlockAfter,
  reorderBlock,
} from '@tealios/errata-plugin-sdk'

findBlock(blocks, 'instructions')                        // ContextBlock | undefined
replaceBlockContent(blocks, 'instructions', 'new text')  // ContextBlock[]
removeBlock(blocks, 'summary')                           // ContextBlock[]
insertBlockBefore(blocks, 'prose', newBlock)              // ContextBlock[]
insertBlockAfter(blocks, 'prose', newBlock)               // ContextBlock[]
reorderBlock(blocks, 'author-input', 450)                // ContextBlock[]
```

当 `insertBlockBefore`/`insertBlockAfter` 找不到目标 ID 时，新块会追加到数组末尾。`compileBlocks()` 时的最终位置由 `order` 字段决定，而不是数组位置。

## 插件钩子：`beforeBlocks`

插件可使用 `beforeBlocks` 钩子操作上下文块。修改指令、注入分节或改变作者输入呈现方式时，这是合适的抽象层。

钩子接收 `ContextBlock[]`，并必须返回（可能修改过的）`ContextBlock[]`。可使用 SDK 辅助函数或标准数组操作。

### 替换块内容

```ts
import { definePlugin, replaceBlockContent } from '@tealios/errata-plugin-sdk'
import type { ContextBlock } from '@tealios/errata-plugin-sdk'

export default definePlugin({
  manifest: {
    name: 'custom-instructions',
    version: '1.0.0',
    description: 'Replaces default writing instructions',
  },
  hooks: {
    beforeBlocks(blocks: ContextBlock[]): ContextBlock[] {
      return replaceBlockContent(blocks, 'instructions',
        'You are a poet. Write in iambic pentameter.'
      )
    },
  },
})
```

### 删除块并注入新块

```ts
import { removeBlock, insertBlockAfter } from '@tealios/errata-plugin-sdk'

// in hooks:
hooks: {
  beforeBlocks(blocks) {
    let result = removeBlock(blocks, 'summary')

    result = insertBlockAfter(result, 'prose', {
      id: 'narrator-voice',
      role: 'user' as const,
      content: 'The narrator speaks in second person.',
      order: 550,
      source: 'my-plugin',
    })

    return result
  },
}
```

### 钩子执行顺序

多个插件定义 `beforeBlocks` 时，会按顺序执行（顺序由插件注册决定）。每个插件接收前一个插件返回的块。

## 编译

`compileBlocks()` 生成最终 `ContextMessage[]`：

1. 按 `role` 将块分为 `system` 和 `user` 组。
2. 每组按 `order` 排序（稳定排序）。
3. 为每个块的内容添加 `[@block=...]` 前缀（见[来源标记](#来源标记)）。
4. 每组内使用 `\n\n`（空行）连接渲染后的块。
5. 每个非空角色组返回一条消息。

```ts
import { compileBlocks } from '@/server/llm/context-builder'

const messages = compileBlocks(blocks)
// [
//   { role: 'system', content: '[@block=instructions]\n...\n\n[@block=tools]\n...' },
//   { role: 'user', content: '[@block=story-info]\n...\n\n[@block=prose]\n...' },
// ]
```

## 选择合适的钩子

| 目标 | 使用 |
|---|---|
| 修改加载哪些 fragment | `beforeContext`（操作 `ContextBuildState`） |
| 修改指令、注入分节、重排提示词结构 | `beforeBlocks`（操作 `ContextBlock[]`） |
| 修改最终消息字符串 | `beforeGeneration`（操作 `ContextMessage[]`） |

---

# Agent 块编辑器与自定义块

当前块编辑器位于 **Agents** 面板中。用户无需编写插件，即可完全控制每个 agent 的 LLM 上下文结构：禁用内置块、覆盖内容、创建自定义块（包括动态脚本块），以及通过拖放重排所有块。

从侧边栏 **Management > Agents** 打开，然后选择 **Writer**、**Prewriter**、**Librarian Analyze** 或 **Character Chat** 等 agent。旧的故事级 Block Editor UI 已在 agent 级配置成为事实来源后移除。独立的 **Fragment Order** 面板仍由 **Settings > Generation > Context > Fragment ordering: Custom** 控制。

## 工作方式

每次生成请求都会根据故事数据生成一组**默认块**（见上文的[默认块](#默认块)）。`generation.writer` agent 保存 agent 级**块配置**，并在每次生成时将其应用到默认块之上。配置在 `createDefaultBlocks()` 之后、插件 `beforeBlocks` 钩子之前应用，因此插件总能看到用户的自定义结果。

```
createDefaultBlocks(state) → applyBlockConfig(blocks, config, state) → beforeBlocks hooks → compileBlocks()
```

配置以 JSON 文件存储在 `data/stories/<storyId>/branches/<branchId>/agent-blocks/generation.writer.json`。

## 块配置

块配置包含三个部分：

```ts
interface BlockConfig {
  customBlocks: CustomBlockDefinition[]   // user-created blocks
  overrides: Record<string, BlockOverride> // per-block overrides (keyed by block ID)
  blockOrder: string[]                     // all block IDs in desired order
}
```

### 自定义块定义

自定义块是用户创建的内容块，会与内置块一起注入 LLM 上下文。

```ts
interface CustomBlockDefinition {
  id: string              // "cb-a1b2c3" — auto-generated, pattern: cb-{4-12 alphanumeric}
  name: string            // display name (1-100 chars)
  role: 'system' | 'user' // which LLM message this block belongs to
  order: number           // default sort position (used when blockOrder is empty)
  enabled: boolean        // can be toggled off without deleting
  type: 'simple' | 'script' // evaluation mode
  content: string         // plain text or JavaScript function body
}
```

自定义块有两种类型：

#### 简单块

将纯文本原样注入上下文。适用于静态指令、世界观笔记、风格指南或任何希望 LLM 看到的固定内容。

**示例：**

- 写作风格指令：*"Write in present tense, third person limited. Keep paragraphs short — 2-3 sentences max."*
- 世界规则：*"Magic in this world requires spoken incantations. Silent casting is impossible. All spells have a physical cost proportional to their power."*
- 语气指导：*"The tone is darkly comedic. The narrator is unreliable and occasionally breaks the fourth wall."*

#### 脚本块

在生成时执行的 JavaScript 函数体，可访问完整故事上下文。内容会按 `new Function('ctx', content)` 求值——请将其编写为接收 `ctx` 参数并**返回字符串**的函数体。

`ctx` 对象包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `ctx.story` | `StoryMeta` | 故事元数据（名称、描述、摘要、设置） |
| `ctx.proseFragments` | `Fragment[]` | 上下文包含的近期 prose fragment |
| `ctx.stickyGuidelines` | `Fragment[]` | 固定的 guideline fragment |
| `ctx.stickyKnowledge` | `Fragment[]` | 固定的 knowledge fragment |
| `ctx.stickyCharacters` | `Fragment[]` | 固定的 character fragment |
| `ctx.guidelineShortlist` | `Fragment[]` | 非固定 guideline（作为候选列表显示） |
| `ctx.knowledgeShortlist` | `Fragment[]` | 非固定 knowledge（作为候选列表显示） |
| `ctx.characterShortlist` | `Fragment[]` | 非固定 character（作为候选列表显示） |
| `ctx.authorInput` | `string` | 作者当前输入/指令 |
| `ctx.getFragment(id)` | `async (id: string) => Fragment \| null` | 按 ID 获取任意 fragment（异步——使用 `await`） |
| `ctx.getFragments(type?)` | `async (type?: string) => Fragment[]` | 列出 fragment，可按类型过滤（异步——使用 `await`） |
| `ctx.getFragmentByTag(tag)` | `async (tag: string) => Fragment \| null` | 获取第一个具有匹配标签的 fragment（异步——使用 `await`） |
| `ctx.getFragmentsByTag(tag)` | `async (tag: string) => Fragment[]` | 获取所有具有匹配标签的 fragment（异步——使用 `await`） |

**返回值：**函数必须返回 `string`。脚本可以是 `async`，runner 会 `await` 结果。如果返回非字符串、空字符串或纯空白字符串，该块会被静默省略。如果脚本抛出错误，块会以 `[Script error in custom block "name"]` 占位符包含在上下文中，让用户知道发生了错误。

**脚本示例：**

字数统计：
```js
const total = ctx.proseFragments.reduce((n, f) => n + f.content.split(/\s+/).length, 0)
return `Current story length: approximately ${total} words.`
```

动态角色提醒：
```js
const names = ctx.stickyCharacters.map(c => c.name).join(', ')
if (!names) return ''
return `Active characters in this scene: ${names}. Stay consistent with their established voices and mannerisms.`
```

按条件设置节奏提示：
```js
const proseCount = ctx.proseFragments.length
if (proseCount < 3) return 'This is early in the story. Focus on establishing setting and character.'
if (proseCount > 15) return 'The story is well underway. Begin moving toward resolution of active conflicts.'
return ''
```

感知摘要的上下文：
```js
if (!ctx.story.summary) return ''
const words = ctx.story.summary.split(/\s+/).length
return `Story summary (${words} words) is available. Avoid contradicting established events.`
```

根据输入调整格式：
```js
if (ctx.authorInput.toLowerCase().includes('dialogue')) {
  return 'The author wants dialogue. Use varied dialogue tags, show character emotion through action beats, and avoid long unbroken speeches.'
}
return ''
```

### 块覆盖

覆盖用于修改内置块（或自定义块），而无需完全替换它们，以块 ID 为 key。

```ts
interface BlockOverride {
  enabled?: boolean                                    // false to exclude from context
  order?: number                                       // override sort position
  contentMode?: 'override' | 'prepend' | 'append' | null // how to modify content
  customContent?: string                                // the content to use with contentMode
}
```

#### 内容模式

| 模式 | 效果 |
|---|---|
| `null` / 未设置 | 不修改内容——使用块的默认内容 |
| `'prepend'` | 将 `customContent` 插入块默认内容**之前**，以换行分隔 |
| `'append'` | 将 `customContent` 插入块默认内容**之后**，以换行分隔 |
| `'override'` | 使用 `customContent` **完全替换**块的默认内容 |

内容模式适合在不完全替换内置块的情况下进行调整。例如：

- 向 `instructions` **Prepend** 额外规则：*"IMPORTANT: Never use the word 'suddenly'."*
- 向 `story-info` **Append** 注释：*"This is a noir detective story set in 1940s Chicago."*
- 使用自己的系统提示词完全 **Override** `instructions`。

### 块顺序

`blockOrder` 是由块 ID 组成的扁平数组，表示期望顺序。存在该数组时，块会按照数组中的位置获得基于位置的 order 值（0、1、2……）。不在数组中的块保留默认 order 值。

由于 `compileBlocks()` 分别按 `order` 对 system 和 user 块排序，块顺序控制每个角色组内的序列。Agent 块编辑器中的拖放会更新该数组。

## 应用顺序

`applyBlockConfig()` 按以下顺序分五步处理配置：

1. **求值并插入自定义块**——对启用的自定义块求值（simple：原样内容；script：使用 `ctx` 执行）并添加到块列表。
2. **应用内容覆盖**——对每个具有 `contentMode` 覆盖的块修改内容（prepend/append/override）。
3. **应用 `blockOrder`**——`blockOrder` 中列出的块获得基于位置的 order 值。
4. **应用单个 `order` 覆盖**——每个块的 `order` 覆盖具有最终优先级。
5. **移除禁用块**——过滤具有 `enabled: false` 覆盖的块。

该顺序意味着：

- 内容覆盖应用于原始块内容，而不是重排后的内容。
- `blockOrder` 拖放排序是主要排序机制。
- 单个块的 `order` 覆盖可在拖放之外微调位置。
- 禁用最后执行，因此禁用块的内容不会参与覆盖求值。

## 旧版 Generation 块 API

旧的故事级 generation 块 CRUD API 已移除。Agent 级块配置现在位于 `/api/stories/:storyId/agent-blocks/:agentName`（见 [Agent Block 系统](#agent-block-系统)）。

剩余的 `/api/stories/:storyId/blocks` 路由是兼容工具：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/blocks/eval-script` | 根据当前故事数据求值脚本块函数体，并返回 `{ result, error }` |

故事级配置共享端点位于 `/api/stories/:storyId`：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/export-configs` | 导出所有非空 agent 块配置 |
| `POST` | `/import-configs` | 从 JSON 请求体导入并替换 agent 块配置 |

## 存储

Generation writer 块配置存储在：

```
data/stories/<storyId>/branches/<branchId>/agent-blocks/generation.writer.json
```

文件在首次写入时创建。如果不存在，所有函数返回空的默认配置（`{ customBlocks: [], overrides: {}, blockOrder: [] }`），表示不应用任何修改，默认块原样通过。

Agent 级配置的存储函数位于 `src/server/agents/agent-block-storage.ts`。

## UI：Agent 块编辑器

Agents 面板位于侧边栏 **Management** 下。选择 agent 可打开其块编辑器。编辑器显示模型设置、agent 专用开关、工具开关，以及按角色和顺序合并排序的提示词块统一列表（内置 + 自定义）。

### 块列表

每行显示：

- **Drag handle**——拖动以重排（更新 `blockOrder`）
- **Name**——内置块显示块 ID，自定义块显示自定义名称
- **Role badge**——`system`（紫色）或 `user`（蓝色）
- **Custom badge**——自定义块显示
- **Enable toggle**——启用时为绿色对勾，点击切换
- **Expand chevron**——点击展开内联编辑器

### 内置块编辑器（展开）

展开内置块时：

1. **Content preview** 显示块默认内容的前 200 个字符。
2. **Content mode selector** 可选择 None / Prepend / Append / Override。
3. 选择模式后，显示用于输入自定义内容的 **textarea**。

修改在失焦时保存，而不是每次按键都保存。

### 自定义块编辑器（展开）

展开自定义块时：

1. 显示块**类型**（simple / script）。
2. 用于编辑块内容的 **textarea**（失焦时保存）。
3. 对于 **script** 块：**live preview** 面板实时（防抖）显示求值输出。求值使用 `POST /blocks/eval-script` 端点。可折叠的 **Fragment Reference** 面板列出所有可用 fragment ID，便于复制到脚本中。
4. **Delete** 按钮用于删除块。

### 创建自定义块

点击 agent 编辑器底部的 **Add Context Block** 打开创建对话框：

- **Name**——块的显示名称
- **Role**——system 或 user（决定进入哪条 LLM 消息）
- **Type**——simple（纯文本）或 script（可访问 `ctx` 的 JavaScript）
- **Content**——块内容或脚本函数体

## 与插件的交互

块配置在插件 `beforeBlocks` 钩子**之前**应用。这意味着：

- 用户禁用内置块后，插件不会看到它。
- 用户覆盖内置内容后，插件会看到修改后的版本。
- 自定义块对插件可见，可由 `beforeBlocks` 钩子进一步修改。
- 无论用户配置如何，插件仍可添加、删除或修改任意块。

如果插件和用户配置都修改同一个块，先运行用户配置（内容覆盖），再由插件钩子处理结果。

## 常见用法

### 禁用工具列表

如果故事不需要 LLM 使用工具，请禁用 `tools` 块以节省上下文空间。

### 为特定类型覆盖指令

对 `instructions` 块使用 **Override** 内容模式，将默认写作助手提示词替换为特定类型的指令。

### 添加“previously on...”前情回顾

在 `user` 角色中创建 **script** 自定义块：
```js
if (ctx.proseFragments.length === 0) return ''
const last = ctx.proseFragments[ctx.proseFragments.length - 1]
return `Previously: ${last.content.slice(0, 200)}...`
```

### 在故事信息和 fragment 之间注入风格指南

在 `user` 角色中创建 **simple** 自定义块，然后在块列表中将其拖到 `story-info` 和 `user-fragments` 之间。

### 根据故事状态按条件包含内容

创建检查故事数据并仅在相关时返回内容的 **script** 块：
```js
const hasCharacters = ctx.stickyCharacters.length > 0
if (!hasCharacters) return 'No characters have been defined yet. Introduce new characters naturally.'
return ''
```

## 文件参考

| 文件 | 用途 |
|---|---|
| `src/server/blocks/schema.ts` | `BlockOverride`、`CustomBlockDefinition`、`BlockConfig` 的 Zod schema |
| `src/server/agents/agent-block-storage.ts` | Agent 级块配置的文件 CRUD |
| `src/server/blocks/apply.ts` | `applyBlockConfig()`——求值自定义块，应用覆盖/排序/禁用。脚本块接收通用上下文对象，不绑定 `ContextBuildState`。 |
| `src/server/routes/agent-blocks.ts` | `/stories/:storyId/agent-blocks/*` 下的 API 路由 |
| `src/lib/api/blocks.ts` | 用于脚本求值和配置包的旧版兼容客户端 |
| `src/lib/api/agent-blocks.ts` | Agent 级块 API 客户端 |
| `src/lib/api/types.ts` | TypeScript 类型（`BlockConfig`、`CustomBlockDefinition`、`BlockOverride` 等） |
| `src/components/agents/AgentConfigurePanel.tsx` | 主要 agent 级块编辑器组件 |
| `src/components/blocks/BlockCreateDialog.tsx` | 自定义块创建对话框 |
| `src/components/blocks/BlockContentView.tsx` | 上下文预览渲染器 |
| `tests/agents/agent-block-storage.test.ts` | 存储 CRUD 测试 |
| `tests/blocks/apply.test.ts` | 配置应用逻辑测试 |
| `tests/api/blocks-routes.test.ts` | 兼容路由测试 |

---

# Agent Block 系统

**Agent block 系统**将相同的块化上下文方式扩展到非 generation agent（librarian、character chat）。每个 agent 注册块定义，描述如何根据故事数据组装系统提示词和用户上下文。用户可通过与 generation 块相同的覆盖机制自定义 agent 提示词。

## 工作方式

Agent 块遵循与 generation 块相同的生命周期，但用于 agent 调用：

```
AgentBlockContext → createDefaultBlocks() → applyBlockConfig() → compileBlocks() → agent.stream()
```

1. 调用方 agent 使用相关故事数据构建 `AgentBlockContext`。
2. `compileAgentContext()` 查找 agent 注册的块定义，创建默认块，应用每个故事的配置覆盖，并编译为消息。
3. 编译后的 system/user 消息和过滤后的工具传给 `createToolAgent()`。

## AgentBlockContext

一种超集上下文对象，agent 按需填充字段：

```ts
interface AgentBlockContext {
  story: StoryMeta
  proseFragments: Fragment[]
  stickyGuidelines: Fragment[]
  stickyKnowledge: Fragment[]
  stickyCharacters: Fragment[]
  guidelineShortlist: Fragment[]
  knowledgeShortlist: Fragment[]
  characterShortlist: Fragment[]
  systemPromptFragments: Fragment[]
  // Agent-specific fields (used by block builders that need them):
  allCharacters?: Fragment[]
  allKnowledge?: Fragment[]
  newProse?: { id: string; content: string }
  character?: Fragment
  personaDescription?: string
  targetFragment?: Fragment
  instructions?: string
  operation?: string
  guidance?: string
  selectedText?: string
  sourceContent?: string
  contextBefore?: string
  contextAfter?: string
  pluginToolDescriptions?: Array<{ name: string; description: string }>
}
```

## AgentBlockDefinition

通过 `agentBlockRegistry.register()` 注册：

```ts
interface AgentBlockDefinition {
  agentName: string
  displayName: string
  description: string
  createDefaultBlocks: (ctx: AgentBlockContext) => ContextBlock[]
  availableTools: string[]
  buildPreviewContext?: (dataDir: string, storyId: string) => Promise<AgentBlockContext>
}
```

## 模型解析

Agent 名称同时作为模型角色 key。系统根据每个以点号分隔的 key 推导**回退链**，并沿链查找已配置的 provider。

### 回退链推导

算法：按 `.` 分割 key，移除最后一段，重复。如果末尾还不是 `generation`，则追加它。

```
librarian.chat       → ['librarian.chat', 'librarian', 'generation']
generation.prewriter → ['generation.prewriter', 'generation']
character-chat.chat  → ['character-chat.chat', 'character-chat', 'generation']
directions.suggest   → ['directions.suggest', 'directions', 'generation']
generation           → ['generation']
```

### 解析流程

`src/server/llm/client.ts` 中的 `getModel(dataDir, storyId, { role })` 沿回退链解析模型：

1. **故事 `modelOverrides` map**——对链中的每个 key，检查 `story.settings.modelOverrides[key]` 是否有 `providerId`/`modelId` 对。
2. **旧版字段映射**——如果没有匹配覆盖，检查旧版逐字段故事设置（例如 `librarianProviderId`、`characterChatModelId`）。见下文向后兼容。
3. **全局默认值**——如果故事没有匹配项，回退到 `globalConfig.defaultProviderId`。
4. **错误**——没有任何配置时，抛出带说明的错误。

找到的第一个非 null `providerId` 生效。如果匹配项包含 `modelId`，使用该模型；否则使用 provider 的 `defaultModel`。

### 向后兼容

两层兼容逻辑会规范化旧配置格式：

**`OVERRIDE_KEY_ALIASES`**——将 `modelOverrides` 中旧的 camelCase key 规范化为以点号分隔的 agent 名称：

| 旧 key | 规范化为 |
|---|---|
| `characterChat` | `character-chat.chat` |
| `librarianChat` | `librarian.chat` |
| `librarianRefine` | `librarian.refine` |
| `proseTransform` | `librarian.prose-transform` |
| `prewriter` | `generation.prewriter` |

如果同时存在旧版和新版 key，新版 key 优先。

**`LEGACY_FIELD_MAP`**——将回退链 key 映射到旧版故事 JSON 的逐字段属性名：

| Key | `providerId` 字段 | `modelId` 字段 |
|---|---|---|
| `generation` | `providerId` | `modelId` |
| `librarian` | `librarianProviderId` | `librarianModelId` |
| `character-chat` | `characterChatProviderId` | `characterChatModelId` |
| `librarian.prose-transform` | `proseTransformProviderId` | `proseTransformModelId` |
| `librarian.chat` | `librarianChatProviderId` | `librarianChatModelId` |
| `librarian.refine` | `librarianRefineProviderId` | `librarianRefineModelId` |
| `directions` | `directionsProviderId` | `directionsModelId` |

### Namespace 与 Agent 级

Settings 面板提供**四个 namespace 级角色**用于模型选择，作为该 namespace 中所有 agent 的默认值：

| Key | 标签 | 说明 |
|---|---|---|
| `generation` | Generation | 主要 prose 写作 |
| `librarian` | Librarian | 后台分析和摘要 |
| `character-chat` | Character Chat | 角色对话 |
| `directions` | Directions | 故事方向建议 |

**Agent 级覆盖**在 Agent Context 面板的块编辑器中配置。例如，为 `generation.prewriter` 设置模型只覆盖 prewriter，writer 仍继承 `generation`。没有 agent 级覆盖时，会依次回退到其 namespace、`generation` 和全局默认值。

## 已注册的 Agent

| Agent 名称 | 显示名称 | 说明 |
|---|---|---|
| `generation.writer` | Writer | 主要 prose 生成 agent |
| `generation.prewriter` | Prewriter | 为 writer 生成 brief 的写作规划器 |
| `librarian.analyze` | Librarian Analyze | 分析 prose fragment 的连续性信号 |
| `librarian.chat` | Librarian Chat | 具有可写工具的对话助手 |
| `librarian.refine` | Librarian Refine | 使用故事上下文优化非 prose fragment |
| `librarian.optimize-character` | Librarian Optimize Character | 使用注重深度的写作方法论优化角色卡 |
| `librarian.prose-transform` | Prose Transform | 转换选中的 prose 范围 |
| `character-chat.chat` | Character Chat | 角色对话 |
| `directions.suggest` | Directions | 根据当前上下文建议可能的故事方向 |

## 存储

Agent 块配置存储在：

```
data/stories/<storyId>/branches/<branchId>/agent-blocks/<agentName>.json
```

每个配置文件遵循相同的 `BlockConfig` schema（自定义块、覆盖、块顺序），另外还包括：

- `disabledTools: string[]`——过滤 agent 可使用的工具
- `disableAutoAnalysis?: boolean`——目前由 `librarian.analyze` 用于禁止生成后的自动分析

## API 端点

所有端点均位于 `/api/stories/:storyId/agent-blocks` 下。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/agent-blocks` | 列出所有已注册 agent 及其块定义 |
| `GET` | `/agent-blocks/:agentName/export-config` | 以可共享 JSON 外层结构导出一个 agent 的配置 |
| `POST` | `/agent-blocks/:agentName/import-config` | 导入并替换一个 agent 的配置 |
| `GET` | `/agent-blocks/:agentName` | 获取 agent 块配置、内置块和可用工具 |
| `GET` | `/agent-blocks/:agentName/preview` | 编译并预览 agent 的完整上下文 |
| `PATCH` | `/agent-blocks/:agentName/config` | 更新 agent 块配置（覆盖、blockOrder、disabledTools、`disableAutoAnalysis`） |
| `POST` | `/agent-blocks/:agentName/custom` | 为 agent 创建自定义块 |
| `PUT` | `/agent-blocks/:agentName/custom/:blockId` | 更新自定义块 |
| `DELETE` | `/agent-blocks/:agentName/custom/:blockId` | 删除自定义块 |

## UI

**Agent Configure** 面板可从侧边栏 **Management > Agents** 打开。它支持浏览已注册 agent、查看编译后的上下文、导出/导入配置、按 agent 修改 provider/model/temperature、切换工具以及自定义块覆盖。

## 文件参考

| 文件 | 用途 |
|---|---|
| `src/server/agents/agent-block-context.ts` | `AgentBlockContext` 类型定义 |
| `src/server/agents/agent-block-registry.ts` | Agent 块定义 registry |
| `src/server/agents/agent-block-storage.ts` | Agent 级块配置存储 |
| `src/server/agents/compile-agent-context.ts` | `compileAgentContext()`——从块组装消息 |
| `src/server/agents/create-agent.ts` | `createToolAgent()`——共享 `ToolLoopAgent` 包装器 |
| `src/server/agents/create-event-stream.ts` | `createEventStream()`——共享 NDJSON 流构建器 |
| `src/server/agents/stream-types.ts` | `AgentStreamEvent`、`AgentStreamResult`、`ChatResult` 类型 |
| `src/server/librarian/blocks.ts` | 所有 librarian agent 的块定义 |
| `src/server/character-chat/blocks.ts` | Character chat 的块定义 |
| `src/server/routes/agent-blocks.ts` | API 路由 |
| `src/lib/api/agent-blocks.ts` | 前端 API 客户端 |
| `src/components/agents/AgentConfigurePanel.tsx` | UI 面板 |
| `tests/agents/agent-block-storage.test.ts` | 存储测试 |
| `tests/agents/agent-blocks.test.ts` | 块注册测试 |
| `tests/agents/compile-agent-context.test.ts` | 上下文编译测试 |
