# Instruction Registry

## 概述

Instruction Registry 集中管理所有 LLM 提示词指令。系统提示词不再硬编码在 agent 模块中，而是为每条指令注册一个以点号分隔的 key，并在运行时解析。

> **已移除：**模型专用覆盖层（`data/instruction-sets/*.json`、`modelMatch`、`loadOverridesSync`、`InstructionSetSchema`）已不存在。每个 agent 的块配置（Agent Context 面板）已取代该机制，请改为在那里自定义提示词。`data/instruction-sets/` 中遗留的文件会被忽略；服务器发现这些文件时，会在启动日志中记录警告。

## API

单例 `instructionRegistry` 从 `src/server/instructions/index.ts` 导出。

| 方法 | 签名 | 说明 |
|---|---|---|
| `registerDefault` | `(key: string, text: string) => void` | 为指令 key 注册默认文本，在模块初始化时调用。 |
| `resolve` | `(key: string, modelId?: string) => string` | 返回已注册的默认值。为兼容调用方而接受 `modelId` 参数，但会忽略它。key 未注册时抛出错误。 |
| `getDefault` | `(key: string) => string \| undefined` | 返回默认文本；未知 key 返回 undefined。 |
| `listKeys` | `() => string[]` | 列出所有已注册的指令 key。 |
| `clear` | `() => void` | 重置所有默认值，供测试使用。 |

## 已注册的指令 Key

全部 19 个 key 按模块分组：

### Generation（5 个）

| Key | 注册位置 | 说明 |
|---|---|---|
| `generation.system` | `src/server/llm/agents.ts` | 主 writer 系统提示词 |
| `generation.tools-suffix` | `src/server/llm/agents.ts` | 追加到 writer 上下文中的工具描述之后 |
| `generation.writer-brief.system` | `src/server/llm/agents.ts` | writer 接收 prewriter brief 时使用的系统提示词 |
| `generation.writer-brief.tools-suffix` | `src/server/llm/agents.ts` | brief 模式 writer 的工具后缀 |
| `generation.prewriter.system` | `src/server/llm/agents.ts` | Prewriter agent 系统提示词 |

### Librarian（6 个）

| Key | 注册位置 | 说明 |
|---|---|---|
| `librarian.analyze.system` | `src/server/librarian/agents.ts` | 后台分析系统提示词 |
| `librarian.chat.system` | `src/server/librarian/agents.ts` | 交互式 librarian 聊天系统提示词 |
| `librarian.refine.system` | `src/server/librarian/agents.ts` | Fragment 优化系统提示词 |
| `librarian.optimize-character.system` | `src/server/librarian/agents.ts` | 角色优化系统提示词（深度方法论） |
| `librarian.prose-transform.system` | `src/server/librarian/agents.ts` | Prose 选区转换系统提示词 |
| `librarian.summary-compaction` | `src/server/librarian/agents.ts` | 摘要压缩提示词模板 |

### Character Chat（5 个）

| Key | 注册位置 | 说明 |
|---|---|---|
| `character-chat.system` | `src/server/character-chat/agents.ts` | 角色聊天系统提示词（使用 `{{characterName}}`） |
| `character-chat.instructions` | `src/server/character-chat/agents.ts` | 角色扮演行为指令 |
| `character-chat.persona.character` | `src/server/character-chat/agents.ts` | 指定角色的 persona（使用 `{{personaName}}`、`{{personaDescription}}`） |
| `character-chat.persona.stranger` | `src/server/character-chat/agents.ts` | 匿名陌生人 persona |
| `character-chat.persona.custom` | `src/server/character-chat/agents.ts` | 自定义 persona（使用 `{{prompt}}`） |

### Directions（2 个）

| Key | 注册位置 | 说明 |
|---|---|---|
| `directions.system` | `src/server/directions/agents.ts` | 故事方向建议系统提示词 |
| `directions.suggest-template` | `src/server/directions/agents.ts` | 建议提示词模板 |

### Chapters（1 个）

| Key | 注册位置 | 说明 |
|---|---|---|
| `chapters.summarize.system` | `src/server/chapters/agents.ts` | 章节摘要系统提示词 |

## 自定义指令

按模型设置 JSON 覆盖的方式已改为 **agent 块**：每个 agent 的提示词都由块组装，可在 Agent Context 面板中按故事覆盖、重排、禁用或扩展这些块。要自定义某条指令，请为相关 agent 覆盖承载该指令的块（通常是 `instructions` 块）。参见 `docs/context-blocks.md` 和 `docs/adding-agents.md`。

## 模板变量

某些指令 key 包含 `{{placeholder}}` 标记，它们在调用处被替换，而不是由 registry 替换。Registry 保存原始模板文本。

| Key | 变量 | 替换位置 |
|---|---|---|
| `character-chat.system` | `{{characterName}}` | `src/server/character-chat/chat.ts` |
| `character-chat.persona.character` | `{{personaName}}`、`{{personaDescription}}` | `src/server/character-chat/chat.ts` |
| `character-chat.persona.custom` | `{{prompt}}` | `src/server/character-chat/chat.ts` |
| `directions.suggest-template` | （由调用方决定） | `src/server/directions/suggest.ts` |

## 集成

指令通过 `instructionRegistry.resolve(key)` 进入 agent 上下文：

1. Agent 块定义在 `createDefaultBlocks()` 函数中调用 `resolve()`。
2. 指令文本成为某个上下文块的内容（通常是 `instructions` 块）。
3. 用户通过 Agent Context 面板按故事自定义该块（块覆盖），而不是通过 registry。

## 文件参考

| 文件 | 用途 |
|---|---|
| `src/server/instructions/registry.ts` | `InstructionRegistry` 类和单例 |
| `src/server/instructions/index.ts` | 重新导出 |
| `tests/instructions/registry.test.ts` | 完整测试套件 |
