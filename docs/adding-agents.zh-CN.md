# 添加新 Agent

本指南介绍如何向 Errata 添加新 agent，涵盖文件结构、注册系统、上下文组装、流式处理、模型解析、UI 集成和测试。文中以 `librarian.optimize-character` agent 为例，该 agent 使用创意写作方法论重写角色卡。

## 概述

Agent 是驱动 Errata LLM 功能的后端工作单元，包括 prose 分析、librarian 聊天、fragment 优化、角色聊天等。每个 agent 都具有：

- 一个**定义**（名称、输入 schema、run 函数）
- **上下文块**（系统提示词 + 根据故事数据组装的用户上下文）
- 一个**模型角色**（决定使用哪个 LLM provider/model）
- 一个**指令 key**（允许用户按模型覆盖系统提示词）
- 一个**块定义**（支持通过 UI 自定义上下文）

Agent 在启动时自动发现。唯一约定是从 `src/server/<namespace>/agents.ts` 导出 `register` 函数。

## 文件结构

每个 agent namespace 都遵循相同模式：

```
src/server/<namespace>/
├── agents.ts              # 注册中心（自动发现）
├── blocks.ts              # 系统提示词和上下文块构建器
├── <runner>.ts            # 运行时逻辑（例如 chat.ts、refine.ts）
└── ...                    # 按需添加的其他文件
```

optimize-character agent 涉及以下文件：

| 文件 | 用途 |
|---|---|
| `src/server/librarian/agents.ts` | 注册（修改——与其他 librarian agent 共享） |
| `src/server/librarian/blocks.ts` | 系统提示词 + 块构建器 + 预览上下文（修改） |
| `src/server/librarian/optimize-character.ts` | 运行时逻辑（新增） |
| `src/components/agents/AgentContextPanel.tsx` | UI 排序（修改） |

如果要创建全新 namespace，而不是添加到 `librarian` 等现有 namespace，请在 `src/server/` 下创建新目录。

## 第 1 步：定义系统提示词

系统提示词是 agent 的核心指令。在 `blocks.ts` 中将其定义为导出常量。

```ts
// src/server/librarian/blocks.ts

export const OPTIMIZE_CHARACTER_SYSTEM_PROMPT = `You are a character optimization agent...

## Methodology
...

## Instructions
1. Read the target character fragment using the appropriate get tool.
2. Read relevant prose fragments to understand how the character behaves.
3. Analyze gaps between the current sheet and the methodology.
4. Rewrite the character sheet with depth and causality.
5. Use updateFragment to save the improved version.
6. Explain what you changed and why.`
```

提示词应当自包含，因为 LLM 会将其作为 system 消息接收。它定义了 *agent 做什么* 以及 *应如何行动*。

## 第 2 步：编写块构建器

块构建器组装 agent 接收的上下文。每个构建器接受 `AgentBlockContext`，并返回 `ContextBlock` 对象数组。

### 使用可组合的块辅助函数

大多数 agent 可以使用 `src/server/agents/block-helpers.ts` 中可复用的块辅助函数组装。每个辅助函数生成一个 `ContextBlock`；数据为空时生成 `null`。使用 `compactBlocks()` 过滤 null：

```ts
import {
  instructionsBlock,
  storyInfoBlock,
  recentProseBlock,
  stickyFragmentsBlock,
  allCharactersBlock,
  targetFragmentBlock,
  compactBlocks,
} from '../agents/block-helpers'

export function createOptimizeCharacterBlocks(ctx: AgentBlockContext): ContextBlock[] {
  return compactBlocks([
    instructionsBlock('librarian.optimize-character.system', ctx),
    storyInfoBlock(ctx),
    recentProseBlock(ctx),
    stickyFragmentsBlock(ctx),
    allCharactersBlock(ctx),
    targetFragmentBlock(ctx,
      'character to optimize',
      'No specific instructions provided. Optimize this character for depth, causality, and friction using the methodology.',
    ),
  ])
}
```

这相当于约 40 行手动块构建代码。可用辅助函数：

| 辅助函数 | 块 ID | 角色 | 顺序 | 说明 |
|---|---|---|---|---|
| `instructionsBlock(key, ctx)` | `instructions` | system | 100 | 从 instruction registry 解析 |
| `systemFragmentsBlock(ctx)` | `system-fragments` | system | 200 | 标记为进入系统提示词的 fragment |
| `storyInfoBlock(ctx)` | `story-info` | user | 100 | 故事名称、描述、摘要 |
| `recentProseBlock(ctx)` | `prose` | user | 200 | 近期 prose 的完整内容 |
| `proseSummariesBlock(ctx, header)` | `prose-summaries` | user | 200 | 截断/摘要后的 prose（用于聊天） |
| `stickyFragmentsBlock(ctx)` | `sticky-fragments` | user | 300 | Sticky guideline、knowledge、character |
| `allCharactersBlock(ctx)` | `all-characters` | user | 350 | 全部角色 ID + 名称 + 描述 |
| `shortlistBlock(ctx)` | `shortlist` | user | 400 | 非 sticky 的相关 fragment |
| `targetFragmentBlock(ctx, label, default)` | `target` | user | 400 | 目标 fragment + 用户指令 |

所有条件辅助函数（`recentProseBlock`、`stickyFragmentsBlock` 等）在数据为空时返回 `null`，因此 `compactBlocks` 可以安全移除它们。

### 手动构建块

对于上下文结构特殊的 agent（例如 analyze agent 的逐 fragment character/knowledge 列表，或 prose-transform 的 operation/selection 块），请手动构建块：

```ts
export function createLibrarianAnalyzeBlocks(ctx: AgentBlockContext): ContextBlock[] {
  const blocks: ContextBlock[] = []

  blocks.push(instructionsBlock('librarian.analyze.system', ctx))

  // Unique block shape — not covered by helpers
  blocks.push({
    id: 'story-summary',
    role: 'user',
    content: ['## Story Summary So Far', ctx.story.summary || '(No summary yet)'].join('\n'),
    order: 100,
    source: 'builtin',
  })

  // ... more custom blocks

  return blocks
}
```

可以在同一个构建器中自由混用辅助函数和手动块。

### 块的组成

每个块包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 在该 agent 内唯一。用户在覆盖配置中引用此 ID。 |
| `role` | `'system' \| 'user'` | System 块组成 system 消息；user 块组成 user 消息。 |
| `content` | `string` | 块的文本内容。 |
| `order` | `number` | 角色组内的排序。以 100 为间隔（100、200、300……），为自定义块预留插入空间。 |
| `source` | `'builtin'` | 默认块始终为 `'builtin'`。 |

### 约定

- 第一个块应始终为 `id: 'instructions'`、`role: 'system'`，并从 instruction registry 解析。
- 使用 `instructionRegistry.resolve(key, ctx.modelId)`（或 `instructionsBlock` 辅助函数），不要直接使用原始常量，这样才能支持按模型覆盖。
- `AgentBlockContext` 是超集类型。只使用 agent 需要的字段。如果需要新字段，请添加到 `agent-block-context.ts` 的接口。
- 编译输出中 system 块位于 user 块之前。每个角色内部按 `order` 排序。

### 预览上下文

定义 `buildPreviewContext` 函数，返回带有合理占位值的 `AgentBlockContext`，为 Agent Context 面板的“Preview”按钮提供数据。

使用 `buildBasePreviewContext()` 获取每个预览上下文都需要的 8 个公共字段，然后展开并添加 agent 专用字段：

```ts
import { buildBasePreviewContext } from '../agents/block-helpers'

export async function buildOptimizeCharacterPreviewContext(
  dataDir: string,
  storyId: string,
): Promise<AgentBlockContext> {
  const base = await buildBasePreviewContext(dataDir, storyId)
  const allCharacters = await listFragments(dataDir, storyId, 'character')
  return {
    ...base,
    allCharacters,
    targetFragment: undefined,
    instructions: '(Preview — actual instructions will appear during optimization)',
  }
}
```

`buildBasePreviewContext` 处理 `story`、`proseFragments`、所有 sticky/shortlist 字段以及 `systemPromptFragments: []`。如果 agent 需要加载系统提示词 fragment，请使用 `loadSystemPromptFragments()`：

```ts
export async function buildChatPreviewContext(dataDir: string, storyId: string): Promise<AgentBlockContext> {
  const base = await buildBasePreviewContext(dataDir, storyId)
  const systemPromptFragments = await loadSystemPromptFragments(dataDir, storyId, getFragmentsByTag, getFragment)
  return { ...base, systemPromptFragments }
}
```

## 第 3 步：编写运行时逻辑

Agent 在运行时文件中实际执行。大多数流式 agent 遵循相同的 14 步管线：验证故事、解析模型、构建上下文、编译块、创建工具、流式输出结果。`createStreamingRunner` 工厂封装了完整管线，你只需提供变化部分。

### 使用 Runner 工厂（推荐）

```ts
// src/server/librarian/optimize-character.ts

import { getFragment, listFragments } from '../fragments/storage'
import { createStreamingRunner } from '../agents/create-streaming-runner'
import type { AgentStreamResult } from '../agents/stream-types'

export interface OptimizeCharacterOptions {
  fragmentId: string
  instructions?: string
  maxSteps?: number
}

export type OptimizeCharacterResult = AgentStreamResult

export const optimizeCharacter = createStreamingRunner<OptimizeCharacterOptions>({
  name: 'librarian.optimize-character',
  readOnly: false,

  validate: async ({ dataDir, storyId, opts }) => {
    const fragment = await getFragment(dataDir, storyId, opts.fragmentId)
    if (!fragment) throw new Error(`Fragment ${opts.fragmentId} not found`)
    if (fragment.type !== 'character')
      throw new Error(`Fragment ${opts.fragmentId} is type "${fragment.type}", expected "character"`)
    return { fragment }
  },

  contextOptions: (opts) => ({ excludeFragmentId: opts.fragmentId }),

  extraContext: async ({ dataDir, storyId, validated, opts }) => ({
    allCharacters: await listFragments(dataDir, storyId, 'character'),
    targetFragment: validated.fragment,
    instructions: opts.instructions,
  }),
})
```

只需 31 行即可完成一个流式 agent：验证输入、解析模型、构建上下文、编译块、创建支持写入的 fragment 工具并流式输出结果。手动方式则约需 100 行。

### 工厂配置参考

`createStreamingRunner<TOpts, TValidated>(config)` 接受：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `name` | `string` | 必填 | Agent 名称（用于日志、模型角色、块编译） |
| `role` | `string` | `name` | 模型角色 key（与 agent 名称不同时覆盖） |
| `maxSteps` | `number` | `5` | 默认最大工具循环步数 |
| `toolChoice` | `'auto' \| 'none'` | `'auto'` | 传给 agent 的工具选择 |
| `buildContext` | `boolean` | `true` | 是否调用 `buildContextState`。不需要故事上下文的 agent 设置为 `false` |
| `readOnly` | `boolean \| 'none'` | `true` | `true` = 只读工具，`false` = 读写工具，`'none'` = 不使用工具 |
| `validate` | `(params) => Promise<TValidated>` | `() => {}` | 验证输入，返回供后续钩子使用的数据。抛出错误则中止 |
| `contextOptions` | `(opts) => Record<string, unknown>` | `() => {}` | 传给 `buildContextState` 的选项（例如 `excludeFragmentId`） |
| `extraContext` | `(params) => Partial<AgentBlockContext>` | `() => {}` | 合并到块上下文中的 agent 专用上下文 |
| `tools` | `(params) => ToolSet` | 使用 fragment 工具 | 自定义工具集（接收预构建的 `fragmentTools` 以便合并） |
| `messages` | `(params) => Array<{role, content}>` | 单条 user 消息 | 自定义消息数组（用于会话历史） |
| `afterStream` | `(result) => void` | 无 | 用于日志或清理的流后钩子 |

### 按模式划分的工厂示例

**只读 agent**（角色聊天——使用会话历史）：

```ts
export const characterChat = createStreamingRunner<CharacterChatOptions>({
  name: 'character-chat.chat',
  role: 'character-chat.chat',
  readOnly: true,

  validate: async ({ dataDir, storyId, opts }) => {
    const character = await getFragment(dataDir, storyId, opts.characterId)
    if (!character || character.type !== 'character')
      throw new Error(`Character ${opts.characterId} not found`)
    // ... load persona character if applicable
    return { character, personaCharacterName, personaCharacterDescription }
  },

  contextOptions: (opts) => ({
    proseBeforeFragmentId: opts.storyPointFragmentId ?? undefined,
    summaryBeforeFragmentId: opts.storyPointFragmentId ?? undefined,
  }),

  extraContext: async ({ opts, validated, modelId }) => ({
    character: validated.character,
    personaDescription: buildPersonaDescription(opts.persona, validated.personaCharacterName, ...),
  }),

  // Override messages to pass conversation history instead of compiled user message
  messages: ({ opts }) =>
    opts.messages.map((m) => ({ role: m.role, content: m.content })),
})
```

**无工具 agent**（prose 转换——单次执行，不构建上下文）：

```ts
export const transformProseSelection = createStreamingRunner<ProseTransformOptions>({
  name: 'librarian.prose-transform',
  role: 'librarian.prose-transform',
  maxSteps: 1,
  toolChoice: 'none',
  buildContext: false,      // Skip buildContextState entirely
  readOnly: 'none',         // No tools at all

  validate: async ({ dataDir, storyId, opts }) => {
    const fragment = await getFragment(dataDir, storyId, opts.fragmentId)
    // ... validate fragment, resolve guidance
    return { sourceContent, selectedText, guidance }
  },

  extraContext: async ({ opts, story, validated }) => ({
    operation: opts.operation,
    guidance: validated.guidance,
    selectedText: validated.selectedText,
    sourceContent: validated.sourceContent,
    contextBefore: opts.contextBefore,
    contextAfter: opts.contextAfter,
  }),

  afterStream: (result) => {
    result.completion.then((c) => {
      transformLogger.info('Prose transform completed', {
        stepCount: c.stepCount, finishReason: c.finishReason,
      })
    }).catch(() => {})
  },
})
```

### 何时不应使用工厂

工厂适用于遵循标准流式管线的 agent。以下情况不要使用：

- Agent 使用 **inline tools** 或 **插件集成**（librarian chat 两者都有）
- Agent **不流式输出**，而是收集结果并返回解析后的 JSON（directions suggest）
- Agent 使用**不同的上下文模型**（generation 直接使用 `ContextBuildState`，而不是 `AgentBlockContext`）

这些情况请手动编写管线。最复杂的手动示例参见 `src/server/librarian/chat.ts`。

### 手动管线参考

需要完全手动控制的 agent 可使用以下 14 步管线：

```ts
import { getModel } from '../llm/client'
import { getStory, getFragment } from '../fragments/storage'
import { buildContextState } from '../llm/context-builder'
import { createFragmentTools } from '../llm/tools'
import { createToolAgent } from '../agents/create-agent'
import { createEventStream } from '../agents/create-event-stream'
import { compileAgentContext } from '../agents/compile-agent-context'
import { withBranch } from '../fragments/branches'

export async function myAgent(dataDir, storyId, opts): Promise<AgentStreamResult> {
  return withBranch(dataDir, storyId, async () => {
    // 1. Validate story
    const story = await getStory(dataDir, storyId)
    if (!story) throw new Error(`Story ${storyId} not found`)

    // 2. Validate agent-specific inputs
    const fragment = await getFragment(dataDir, storyId, opts.fragmentId)
    if (!fragment) throw new Error(`Fragment ${opts.fragmentId} not found`)

    // 3. Resolve model early (modelId needed for instruction resolution)
    const { model, modelId } = await getModel(dataDir, storyId, { role: 'my-agent' })

    // 4. Build story context
    const ctxState = await buildContextState(dataDir, storyId, '', { excludeFragmentId: opts.fragmentId })

    // 5. Assemble AgentBlockContext
    const blockContext: AgentBlockContext = {
      story: ctxState.story,
      proseFragments: ctxState.proseFragments,
      stickyGuidelines: ctxState.stickyGuidelines,
      stickyKnowledge: ctxState.stickyKnowledge,
      stickyCharacters: ctxState.stickyCharacters,
      guidelineShortlist: ctxState.guidelineShortlist,
      knowledgeShortlist: ctxState.knowledgeShortlist,
      characterShortlist: ctxState.characterShortlist,
      systemPromptFragments: [],
      targetFragment: fragment,
      modelId,
    }

    // 6. Create tools
    const allTools = createFragmentTools(dataDir, storyId, { readOnly: false })

    // 7. Compile context (block lifecycle: defaults → overrides → compile → filter tools)
    const compiled = await compileAgentContext(dataDir, storyId, 'my-agent', blockContext, allTools)

    // 8. Extract messages
    const systemMessage = compiled.messages.find(m => m.role === 'system')
    const userMessage = compiled.messages.find(m => m.role === 'user')

    // 9. Create agent
    const agent = createToolAgent({
      model,
      instructions: systemMessage?.content ?? '',
      tools: compiled.tools,
      maxSteps: opts.maxSteps ?? 5,
    })

    // 10. Stream
    const result = await agent.stream({
      messages: userMessage ? [{ role: 'user', content: userMessage.content }] : [],
    })

    return createEventStream(result.fullStream)
  })
}
```

### 管线中的关键决策

| 步骤 | 原因 |
|---|---|
| `withBranch()` | 在分支隔离中执行，以便跟踪 fragment 写入 |
| 提前解析模型 | `compileAgentContext` 调用 `createDefaultBlocks`，而后者调用 `instructionRegistry.resolve(key, modelId)`，因此必须已有 `modelId` |
| `excludeFragmentId` | 防止目标 fragment 在上下文中出现两次；agent 改为通过工具读取 |
| `compileAgentContext` | 处理完整块生命周期：加载块定义 → `createDefaultBlocks()` → `applyBlockConfig()`（用户覆盖）→ `compileBlocks()` → 按 `disabledTools` 过滤工具 |
| `createEventStream` | 将 AI SDK 的 `fullStream` 转换为 NDJSON `ReadableStream<string>` + `completion` Promise |

### 只读工具与可写工具

对于只读取数据的 agent（分析、建议），向 `createFragmentTools()` 传入 `{ readOnly: true }`，或在工厂配置中设置 `readOnly: true`。对于修改 fragment 的 agent（refine、optimize、chat），传入 `{ readOnly: false }`。写入工具包括 `updateFragment`、`editFragment`、`createFragment`、`deleteFragment` 和 `editProse`。

### 返回类型

所有流式 agent 返回 `AgentStreamResult`：

```ts
interface AgentStreamResult {
  eventStream: ReadableStream<string>   // NDJSON lines
  completion: Promise<AgentStreamCompletion>
}
```

`eventStream` 发出 `AgentStreamEvent` 类型的事件：

```ts
type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; id: string; toolName: string; result: unknown }
  | { type: 'finish'; finishReason: string; stepCount: number }
```

## 第 4 步：注册全部内容

所有注册都在 `agents.ts` 中受保护的 `register()` 函数内完成。如果添加到现有 namespace（例如 `librarian`），修改现有文件；如果创建新 namespace，则创建 `src/server/<namespace>/agents.ts`。

### 4a. 输入 Schema

为 agent 输入定义 Zod schema。使用 `zod/v4`，整数使用 `z.int()`，不要使用 `z.number().int()`。

```ts
const OptimizeCharacterInputSchema = z.object({
  fragmentId: z.string(),
  instructions: z.string().optional(),
  maxSteps: z.int().positive().optional(),
})
```

### 4b. Agent 定义

关联名称、schema 和 run 函数。

```ts
const optimizeCharacterDefinition: AgentDefinition<typeof OptimizeCharacterInputSchema> = {
  name: 'librarian.optimize-character',
  description: 'Optimize a character sheet using depth-focused writing methodology.',
  inputSchema: OptimizeCharacterInputSchema,
  run: async (ctx, input) => {
    return optimizeCharacter(ctx.dataDir, ctx.storyId, input)
  },
}
```

`allowedCalls` 字段控制该 agent 可通过 `ctx.invokeAgent()` 调用哪些其他 agent。省略时表示不允许调用子 agent。

### 4c. 注册调用

在 `registerLibrarianAgents()`（或你自己的 `register()` 函数）中：

```ts
export function registerMyAgents(): void {
  if (registered) return

  // 1. Instruction default — system prompt text, keyed for override lookup
  instructionRegistry.registerDefault(
    'librarian.optimize-character.system',
    OPTIMIZE_CHARACTER_SYSTEM_PROMPT,
  )

  // 2. Agent definition — name, schema, run function
  agentRegistry.register(optimizeCharacterDefinition)

  // 3. Model role (namespace-level, once per namespace — skip if namespace already exists)
  // modelRoleRegistry.register({ key: 'my-namespace', label: '...', description: '...' })

  // 4. Block definition — context assembly + UI integration
  agentBlockRegistry.register({
    agentName: 'librarian.optimize-character',
    displayName: 'Librarian Optimize Character',
    description: 'Optimizes character sheets using depth-focused writing methodology.',
    createDefaultBlocks: createOptimizeCharacterBlocks,
    availableTools: [
      'getFragment', 'listFragments', 'searchFragments', 'listFragmentTypes',
      'createFragment', 'updateFragment', 'editFragment', 'deleteFragment',
      'editProse', 'getStorySummary', 'updateStorySummary',
    ],
    buildPreviewContext: buildOptimizeCharacterPreviewContext,
  })

  registered = true
}

// Auto-discovery entry point — MUST be named exactly `register`
export const register = registerMyAgents
```

### 自动发现

`src/server/agents/register-core.ts` 使用 `import.meta.glob('../*/agents.ts')` 在启动时查找所有 agent 模块。要求只有：

1. 文件位于 `src/server/<anything>/agents.ts`
2. 以命名导出方式导出 `register`（无参数函数）

无需手动 import 或注册列表。

## 第 5 步：通过聊天开放（可选）

如果希望 librarian chat（或其他对话 agent）能够调用该 agent，请在该 agent 的运行时中将其添加为工具：

```ts
// In chat.ts
const optimizeCharacterTool = tool({
  description: 'Optimize a character sheet using depth-focused writing methodology.',
  inputSchema: z.object({
    fragmentId: z.string().describe('The character fragment ID to optimize (e.g. ch-bakumo)'),
    instructions: z.string().optional().describe('Optional specific instructions'),
  }),
  execute: async ({ fragmentId, instructions }) => {
    const result = await optimizeCharacter(dataDir, storyId, { fragmentId, instructions })
    await result.completion
    return { ok: true, fragmentId }
  },
})

const allTools = { ...fragmentTools, optimizeCharacter: optimizeCharacterTool }
```

同时更新父 agent 的注册：

- 将新 agent 名称添加到父 agent 的 `allowedCalls` 数组
- 将工具名称添加到父 agent 块定义的 `availableTools`
- 在父 agent 的系统提示词中提到该工具，让 LLM 知道它存在

## 第 6 步：UI 排序

Agent Context 面板按 namespace 前缀对 agent 分组，并在组内排序。`AgentContextPanel.tsx` 中的两个数组控制排序：

```ts
// Hierarchical groups
const AGENT_GROUPS: { label: string; prefix: string }[] = [
  { label: 'Generation', prefix: 'generation.' },
  { label: 'Directions', prefix: 'directions.' },
  { label: 'Librarian', prefix: 'librarian.' },
  { label: 'Character', prefix: 'character-chat.' },
]

// Sort order within each group
const AGENT_ORDER: string[] = [
  'generation.writer',
  'generation.prewriter',
  'directions.suggest',
  'librarian.analyze',
  'librarian.chat',
  'librarian.refine',
  'librarian.optimize-character',   // ← add new agent here
  'librarian.prose-transform',
  'character-chat.chat',
]
```

未列入 `AGENT_ORDER` 的 agent 也会显示，只是排在组末尾。前缀不匹配任何组的 agent 显示在“Other”下。创建新 namespace 时，请添加新的组条目。

## 模型解析

Agent 名称同时作为模型角色 key。解析系统使用**以点号分隔的回退链**：

```
librarian.optimize-character →
  ['librarian.optimize-character', 'librarian', 'generation']
```

该链通过逐段移除最后一段自动生成，末尾始终为 `generation`。解析时沿链查找已配置的 provider：

1. **故事 `modelOverrides`**——故事设置中的 agent 级覆盖
2. **Namespace 默认值**——例如 `librarian` 条目
3. **全局默认值**——`generation` provider
4. **错误**——没有任何配置时报错

只有 **namespace 级**角色需要在 `modelRoleRegistry` 中显式注册（例如 `librarian`、`character-chat`）。Agent 级解析自动完成。用户在 Settings 中配置 namespace 级模型，在 Agent Context 面板中配置 agent 级模型。

## 自定义指令

Instruction registry 保存每个提示词的内置默认文本。注册时：

```ts
instructionRegistry.registerDefault('librarian.optimize-character.system', OPTIMIZE_CHARACTER_SYSTEM_PROMPT)
```

`instructionRegistry.resolve(key)` 在请求时返回该默认值。用户通过 Agent Context 面板按故事自定义提示词——由该指令构建的块可以像其他 agent 块一样被覆盖、禁用或重排。（旧的 `data/instruction-sets/` 按模型 JSON 覆盖层已移除，改用 agent 块。）Key 列表参见 `docs/instruction-registry.md`。

## 测试

### 块构建器测试

测试 `createDefaultBlocks()` 在不同上下文结构下是否生成预期块，无需文件系统。

```ts
// tests/librarian/optimize-character-blocks.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { ensureCoreAgentsRegistered } from '@/server/agents'
import { agentBlockRegistry } from '@/server/agents/agent-block-registry'
import type { AgentBlockContext } from '@/server/agents/agent-block-context'

beforeEach(() => {
  ensureCoreAgentsRegistered()
})

describe('optimize-character blocks', () => {
  it('produces instructions and target blocks', () => {
    const ctx: AgentBlockContext = {
      story: makeStory(),
      proseFragments: [],
      stickyGuidelines: [],
      stickyKnowledge: [],
      stickyCharacters: [],
      guidelineShortlist: [],
      knowledgeShortlist: [],
      characterShortlist: [],
      systemPromptFragments: [],
      targetFragment: makeFragment({ id: 'ch-test', type: 'character', name: 'Hero' }),
      instructions: 'Focus on friction',
    }

    const def = agentBlockRegistry.get('librarian.optimize-character')
    const blocks = def!.createDefaultBlocks(ctx)

    expect(blocks.find(b => b.id === 'instructions')).toBeDefined()
    expect(blocks.find(b => b.id === 'target')).toBeDefined()
    expect(blocks.find(b => b.id === 'target')!.content).toContain('ch-test')
    expect(blocks.find(b => b.id === 'target')!.content).toContain('Focus on friction')
  })

  it('includes all-characters block when characters exist', () => {
    const ctx: AgentBlockContext = {
      story: makeStory(),
      proseFragments: [],
      stickyGuidelines: [],
      stickyKnowledge: [],
      stickyCharacters: [],
      guidelineShortlist: [],
      knowledgeShortlist: [],
      characterShortlist: [],
      systemPromptFragments: [],
      allCharacters: [
        makeFragment({ id: 'ch-a', name: 'Alice' }),
        makeFragment({ id: 'ch-b', name: 'Bob' }),
      ],
    }

    const def = agentBlockRegistry.get('librarian.optimize-character')
    const blocks = def!.createDefaultBlocks(ctx)

    const charBlock = blocks.find(b => b.id === 'all-characters')
    expect(charBlock).toBeDefined()
    expect(charBlock!.content).toContain('ch-a')
    expect(charBlock!.content).toContain('ch-b')
  })
})
```

### Registry 数量测试

更新 `tests/agents/agent-blocks.test.ts` 中的现有测试，将新 agent 包含进去：

```ts
it('registers all N agents', () => {
  const agents = agentBlockRegistry.list()
  const names = agents.map(a => a.agentName)
  expect(names).toContain('librarian.optimize-character')
})
```

### 集成测试

对于运行时逻辑复杂的 agent，请编写集成测试，mock `streamText`/`ToolLoopAgent` 并验证上下文组装。使用 `createTempDir()` + `createStory()` 隔离文件系统。模式参见 `tests/librarian/refine.test.ts` 和 `tests/librarian/chat.test.ts`。

## Runner 安全限制

Agent runner（`src/server/agents/runner.ts`）强制执行硬限制：

| 限制 | 默认值 | 说明 |
|---|---|---|
| `maxDepth` | 3 | Agent 调用 agent 链的最大嵌套深度 |
| `maxCalls` | 20 | 单次根调用中的最大 agent 调用总数 |
| `timeoutMs` | 300,000（5 分钟） | 整个调用树的实际超时时间 |

循环检测基于调用栈，`A → B → A` 会立即抛出错误。Agent 定义中的 `allowedCalls` 白名单控制可调用哪些子 agent。

## 检查清单

添加新 agent 时：

- [ ] 在 `blocks.ts` 中编写系统提示词
- [ ] 使用可组合辅助函数（`compactBlocks([...])`）或手动方式编写块构建器
- [ ] 使用 `buildBasePreviewContext()` + 额外字段编写预览上下文
- [ ] 使用 `createStreamingRunner()` 编写运行时逻辑（复杂 agent 使用手动管线）
- [ ] 定义输入 schema（Zod v4）
- [ ] 定义 agent 定义（`AgentDefinition`）
- [ ] 在 `agents.ts` 中注册：默认指令、agent 定义、块定义
- [ ] 如果是新 namespace，注册模型角色（已有 namespace 则跳过）
- [ ] 从 `agents.ts` 导出 `register`（用于自动发现，或修改现有 `register`）
- [ ] （可选）在父 agent 中添加为工具（聊天工具、`allowedCalls`、`availableTools`、系统提示词说明）
- [ ] 添加到 `AgentContextPanel.tsx` 的 `AGENT_ORDER`
- [ ] 如果是新 namespace，添加到 `AGENT_GROUPS`
- [ ] 编写块构建器测试
- [ ] 更新 `agent-blocks.test.ts` 中的 registry 数量断言
- [ ] 运行 `bun run test`，全部测试通过

## 文件参考

| 文件 | 用途 |
|---|---|
| `src/server/agents/types.ts` | `AgentDefinition`、`AgentInvocationContext`、`AgentTraceEntry` |
| `src/server/agents/registry.ts` | Agent 定义 registry 单例 |
| `src/server/agents/agent-block-registry.ts` | Agent 块定义 registry |
| `src/server/agents/agent-block-context.ts` | `AgentBlockContext` 超集类型 |
| `src/server/agents/agent-block-storage.ts` | Agent 级块配置持久化 |
| `src/server/agents/compile-agent-context.ts` | `compileAgentContext()`——完整块生命周期 |
| `src/server/agents/create-agent.ts` | `createToolAgent()`——AI SDK `ToolLoopAgent` 包装器 |
| `src/server/agents/create-event-stream.ts` | `createEventStream()`——NDJSON 流构建器 |
| `src/server/agents/create-streaming-runner.ts` | `createStreamingRunner()`——标准管线工厂 |
| `src/server/agents/block-helpers.ts` | 可组合块辅助函数和预览上下文工具 |
| `src/server/agents/stream-types.ts` | `AgentStreamEvent`、`AgentStreamResult` 类型 |
| `src/server/agents/model-role-registry.ts` | 模型角色回退链 registry |
| `src/server/agents/register-core.ts` | 通过 `import.meta.glob` 自动发现 |
| `src/server/agents/runner.ts` | 具有深度/超时/循环限制的 agent runner |
| `src/server/instructions/registry.ts` | 用于提示词管理的 instruction registry |
| `src/server/llm/tools.ts` | `createFragmentTools()`——读/写工具生成 |
| `src/server/llm/client.ts` | `getModel()`——带回退链的模型解析 |
| `src/server/llm/context-builder.ts` | `buildContextState()`——故事上下文组装 |
| `src/server/fragments/branches.ts` | `withBranch()`——分支隔离包装器 |
| `src/components/agents/AgentContextPanel.tsx` | Agent 面板 UI 排序 |
| `docs/context-blocks.md` | Agent 块系统参考（运行时细节） |
| `docs/instruction-registry.md` | 指令覆盖系统 |
