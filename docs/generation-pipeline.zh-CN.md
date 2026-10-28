# 生成管线

## 概述

生成端点（`POST /api/stories/:storyId/generate`）通过流式 NDJSON 响应生成 prose 后续内容。它支持由故事设置 `generationMode` 控制的两种模式：

- **Standard 模式**（默认）：writer agent 读取完整编译上下文并直接生成 prose。
- **Prewriter 模式**（`generationMode: 'prewriter'`）：两阶段管线。Prewriter agent 先分析完整上下文并生成聚焦的写作 brief，然后 writer 根据精简上下文生成 prose，该上下文仅包含近期 prose 和 brief。

## Standard 模式流程

```
作者输入
  → buildContextState()           加载 fragment，应用 prose 限制
  → beforeContext hooks            插件转换上下文状态
  → createDefaultBlocks()          构建全部上下文块
  → applyBlockConfig()             应用用户块自定义配置
  → beforeBlocks hooks             插件转换块
  → compileBlocks()                块 → ContextMessage[]
  → beforeGeneration hooks         插件转换消息
  → addCacheBreakpoints()          添加 Anthropic 缓存控制提示
  → Writer agent 流式生成 prose     带 fragment 工具的 ToolLoopAgent
  → afterGeneration hooks          插件后处理
  → 保存 fragment（版本化）         创建或添加变体
  → afterSave hooks                插件保存后操作
  → 触发 librarian                 即发即弃分析
```

Writer agent 可读取完整上下文：系统指令、工具描述、故事信息、摘要、角色、准则、知识、候选列表、Prose Chain 和作者输入。

## Prewriter 模式流程

Prewriter 模式在 `compileBlocks()` 之前使用相同的上下文构建管线，随后分流：

```
[与 standard 相同，直到 compileBlocks()]
  → 阶段 1：Prewriter
      → compileAgentContext('generation.prewriter')
      → 将完整编译上下文注入 prewriter 块
      → 设置模式专用的规划请求
      → Prewriter agent 流式生成 brief        ToolLoopAgent
  → 阶段 2：Writer
      → createWriterBriefBlocks()            精简上下文
      → 保留：自定义块、系统 fragment、sticky guideline
      → Writer agent 流式生成 prose           ToolLoopAgent
  → [与 standard 相同：hooks → 保存 → librarian]
```

### 为什么使用两个阶段？

Prewriter 将完整上下文压缩为聚焦的 brief。这意味着：

- Writer 的上下文窗口更小、更聚焦
- 角色声音、场景细节和准则是提炼后的内容，而不是原始全文
- Brief 可按每次生成自定义（prewriter 会适配 generate/regenerate/refine 模式）

## Prewriter Agent

Prewriter 在 agent block registry 中注册为 `generation.prewriter`。

### 默认块

| 块 ID | 角色 | 内容 |
|---|---|---|
| `instructions` | system | 从 `generation.prewriter.system` 指令 key 解析 |
| `full-context` | user | 占位符——运行时替换为完整编译上下文 |
| `planning-request` | user | 占位符——替换为模式专用提示词 |

### 模式专用提示词

`planning-request` 块的内容随生成模式变化：

| 模式 | 提示词摘要 |
|---|---|
| `generate` | “The author wants to CONTINUE the story. Their direction: ...” |
| `regenerate` | “The author wants to REGENERATE the latest passage. Their direction: ...” |
| `refine` | “The author wants to REFINE/EDIT the latest passage. Their direction: ...” |

### 工具访问

Prewriter 可使用与 writer 相同的 fragment 工具（只读 + 插件工具），从而在规划时查询指定 fragment。可通过块编辑器按 agent 禁用工具。

### 自定义

Prewriter 块可通过 Agent Context 面板自定义（块编辑器位于 `generation.prewriter`）。用户可以 Add Context Blocks、覆盖指令内容或重排块。

## Writer Brief 上下文

在 prewriter 模式下，writer 读取精简上下文，而不是完整上下文：

| 块 ID | 角色 | 内容 |
|---|---|---|
| `instructions` | system | 从 `generation.writer-brief.system` 解析 |
| `tools` | system | 工具描述 + `generation.writer-brief.tools-suffix` |
| `prose` | user | 近期 prose fragment（用于保持连续性） |
| `writing-brief` | user | Prewriter 的输出 |

此外，还会从 standard 上下文保留以下块：

- 自定义块（`source: 'custom'`）
- 放在 system 位置的 fragment（`system-fragments` 块）
- Sticky guideline 块（ID 以 `gl-` 开头）
- Prewriter 的 agent 块配置中的自定义块

### Standard 与 Prewriter 对比

| 上下文元素 | Standard 模式 | Prewriter 模式 |
|---|---|---|
| 系统指令 | 完整 `generation.system` | 精简的 `generation.writer-brief.system` |
| 角色 | 完整角色卡 | 提炼到 brief 中 |
| 准则 | 全部 sticky + 候选 | 保留 sticky，其余提炼到 brief 中 |
| 知识 | 全部 sticky + 候选 | 提炼到 brief 中 |
| 摘要 | 滚动摘要块 | 提炼到 brief 中 |
| Prose | 完整 chain（在限制内） | 仅近期 prose |
| 作者输入 | 直接提供 | 嵌入 brief 的 planning request |
| 工具 | 完整访问 | 完整访问（仍可查询 fragment） |

## 步数预算

总步数预算来自 `story.settings.maxSteps`（默认 10），并在两个阶段之间分配：

- **Prewriter**：`floor(maxSteps / 2)` 步（最少 1 步）
- **Writer**：`maxSteps - prewriterStepCount` 步（最少 1 步）

Prewriter 未使用的步数会返还给 writer。例如，如果 `maxSteps` 为 10，prewriter 在分配的 5 步中只使用 2 步，则 writer 可使用 8 步。

## 流式事件

生成端点流式返回 NDJSON（每行一个 JSON 对象）。事件类型：

| 事件类型 | 字段 | 说明 |
|---|---|---|
| `phase` | `phase: 'prewriting' \| 'writing'` | 阶段切换（仅 prewriter 模式） |
| `prewriter-text` | `text: string` | Prewriter 文本增量（仅 prewriter 模式） |
| `text` | `text: string` | Writer 文本增量 |
| `reasoning` | `text: string` | 模型 reasoning/thinking 增量 |
| `tool-call` | `id`、`toolName`、`args` | 工具调用 |
| `tool-result` | `id`、`toolName`、`result` | 工具执行结果 |
| `finish` | `finishReason`、`stepCount`、`stopped?` | 流结束 |

在 prewriter 模式下，事件顺序为：`phase:prewriting` → prewriter 事件（`prewriter-text`、`reasoning`、`tool-call`、`tool-result`）→ `phase:writing` → writer 事件（`text`、`reasoning`、`tool-call`、`tool-result`）→ `finish`。

## 生成日志

每次生成都会将一个 `GenerationLog` 持久化到 `data/stories/<storyId>/generation-logs/`。

### 标准字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 唯一日志 ID（例如 `gen-m2abc`） |
| `createdAt` | `string` | ISO 时间戳 |
| `input` | `string` | 作者输入文本 |
| `messages` | `Array<{role, content}>` | 发送给 writer 的编译上下文消息 |
| `toolCalls` | `ToolCallLog[]` | 生成期间的工具调用 |
| `generatedText` | `string` | 最终输出文本 |
| `fragmentId` | `string \| null` | 保存的 fragment ID |
| `model` | `string` | 解析后的模型 ID |
| `durationMs` | `number` | 总生成时间 |
| `stepCount` | `number` | Writer agent 步数 |
| `finishReason` | `string` | 生成停止的原因 |
| `stepsExceeded` | `boolean` | 是否达到步数上限 |
| `totalUsage` | `TokenUsage?` | 输入/输出 token 数 |
| `reasoning` | `string?` | Writer reasoning 文本 |

### Prewriter 专用字段

以下字段仅在使用 prewriter 时存在：

| 字段 | 类型 | 说明 |
|---|---|---|
| `prewriterBrief` | `string` | Prewriter 生成的写作 brief |
| `prewriterReasoning` | `string?` | Prewriter reasoning 文本 |
| `prewriterMessages` | `Array<{role, content}>` | Prewriter 的编译上下文 |
| `prewriterDurationMs` | `number` | Prewriter 执行时间 |
| `prewriterModel` | `string` | Prewriter 解析后的模型 ID |
| `prewriterUsage` | `TokenUsage?` | Prewriter token 用量 |

## 生成模式

`mode` 参数控制 prose 的创建和保存方式：

### Generate（默认）

继续故事。创建新的 prose fragment，并作为新分节追加到 Prose Chain。

### Regenerate

为现有段落创建备选版本。需要 `fragmentId`。现有 fragment 会从上下文中排除，因此模型看不到要替换的内容。结果保存为新 fragment，并作为同一 Prose Chain 分节的**变体**添加。

### Refine

根据指令编辑现有段落。需要 `fragmentId`。现有内容会包含在带优化请求的提示词中。与 regenerate 一样，结果保存为变体。

对于 regenerate 和 refine，上下文构建器会接收 `excludeFragmentId`、`proseBeforeFragmentId` 和 `summaryBeforeFragmentId`，确保模型看到的是目标 fragment *之前*的上下文。

## 文件参考

| 文件 | 用途 |
|---|---|
| `src/server/llm/prewriter.ts` | `runPrewriter()`、`createPrewriterBlocks()`、`createWriterBriefBlocks()` |
| `src/server/llm/agents.ts` | Generation agent 注册（writer + prewriter 块、默认指令） |
| `src/server/llm/instruction-texts.ts` | 生成指令的提示词文本常量 |
| `src/server/routes/generation.ts` | `POST /stories/:storyId/generate` 端点 |
| `src/server/llm/context-builder.ts` | `buildContextState()`、`createDefaultBlocks()`、`compileBlocks()`、`addCacheBreakpoints()` |
| `src/server/llm/writer-agent.ts` | `createWriterAgent()`——`ToolLoopAgent` 包装器 |
| `src/server/llm/generation-logs.ts` | `GenerationLog` 接口、`saveGenerationLog()`、`listGenerationLogs()` |
