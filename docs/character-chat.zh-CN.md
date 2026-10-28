# Character Chat

Character Chat 让你像与故事世界中的角色对话一样交流，对话受故事上下文和所选故事节点约束。

## 概述

- 会话按故事存储在磁盘上，可以列出、继续或删除。
- 存储支持分支感知，因此每条时间线都有独立的角色聊天历史。
- 聊天响应以 NDJSON 事件流式返回（`text`、`reasoning`、`tool-call`、`tool-result`、`finish`）。
- 聊天 agent 使用只读 fragment 工具，可以查询信息而不修改故事数据。
- 模型路由支持角色聊天专用的 provider/model 设置，并可回退到 namespace 和故事默认值。
- UI 以会话为中心：可以发起新聊天、继续旧聊天、切换 persona 模式，以及设置故事节点截断点。

## 数据模型

会话存储类型（`src/server/character-chat/storage.ts`）：

```ts
type PersonaMode =
  | { type: 'character'; characterId: string }
  | { type: 'stranger' }
  | { type: 'custom'; prompt: string }
```

```ts
interface CharacterChatConversation {
  id: string
  characterId: string
  persona: PersonaMode
  storyPointFragmentId: string | null
  title: string
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    reasoning?: string
    createdAt: string
  }>
  createdAt: string
  updatedAt: string
}
```

```ts
interface CharacterChatConversationSummary {
  id: string
  characterId: string
  persona: PersonaMode
  storyPointFragmentId: string | null
  title: string
  messageCount: number
  createdAt: string
  updatedAt: string
}
```

## 存储布局

角色聊天数据存储在当前活跃分支的内容根目录下：

```text
data/stories/<storyId>/
  branches/
    <branchId>/
      character-chat/
        conversations/
          cc-<timestamp>-<random>.json
```

`storyPointFragmentId` 用作上下文截断点。Agent 只能看到截至该节点的故事上下文。

## API

路由定义在 `src/server/routes/character-chat.ts`。

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/stories/:storyId/character-chat/conversations` | 列出会话（可选 `?characterId=...`） |
| `GET` | `/stories/:storyId/character-chat/conversations/:conversationId` | 获取一个会话 |
| `POST` | `/stories/:storyId/character-chat/conversations` | 创建会话 |
| `DELETE` | `/stories/:storyId/character-chat/conversations/:conversationId` | 删除会话 |
| `POST` | `/stories/:storyId/character-chat/conversations/:conversationId/chat` | 流式返回角色响应 |

### 创建会话请求体

```json
{
  "characterId": "ch-ab12",
  "persona": { "type": "stranger" },
  "storyPointFragmentId": "pr-xy12",
  "title": "Interrogation in the courtyard"
}
```

### 聊天请求体

```json
{
  "messages": [
    { "role": "user", "content": "What happened in the archive fire?" }
  ]
}
```

### 流式格式（NDJSON）

`/chat` 流的事件示例：

```json
{"type":"text","text":"I remember smoke before I saw flames..."}
{"type":"tool-call","id":"...","toolName":"getFragment","args":{"id":"pr-ab12"}}
{"type":"tool-result","id":"...","toolName":"getFragment","result":{"ok":true}}
{"type":"finish","finishReason":"stop","stepCount":2}
```

## Provider/Model 选择

角色聊天在 `src/server/llm/client.ts` 中以角色 `character-chat.chat` 解析模型，使用共享的回退链：

1. `story.settings.modelOverrides['character-chat.chat']`
2. `story.settings.modelOverrides['character-chat']`
3. `story.settings.modelOverrides['generation']`
4. 旧版 `characterChatProviderId` / `characterChatModelId` 字段，然后是旧版 generation 字段
5. 全局默认 provider

Temperature 使用相同的回退链，因此角色聊天可以独立于 prose 生成继承或覆盖 provider/model temperature。

## 前端集成

- 主 UI：`src/components/character-chat/CharacterChatView.tsx`
- 配置栏：`src/components/character-chat/ChatConfig.tsx`
- 会话浏览器：`src/components/character-chat/ConversationList.tsx`
- 共享消息渲染：`src/components/chat/ChatMessageParts.tsx`
- 客户端 API 封装：`src/lib/api/character-chat.ts`
- 故事路由开关：`src/routes/story.$storyId.tsx`

Character Chat 视图由故事路由挂载。输入框会自动调整高度，可从列表继续会话；当角色 fragment 引用图片或图标 fragment 时，会显示角色头像。

## 上下文组装

角色聊天使用 **agent 块系统**组装上下文。角色聊天 agent 不再使用硬编码系统提示词和手动拼接上下文字符串，而是在 `src/server/character-chat/blocks.ts` 中注册块定义。运行时，`compileAgentContext()` 从这些块组装 system 和 user 消息，并应用每个故事的 agent 块配置覆盖。

Agent 通过共享的 `createToolAgent()` 包装器创建，响应流由 `createEventStream()` 构建，两者均来自 `src/server/agents/`。

当角色 fragment 的 `refs` 数组包含图片引用时，聊天 UI 会显示角色头像。

## 相关文件

- `src/server/character-chat/chat.ts`
- `src/server/character-chat/blocks.ts`——agent 块定义（系统提示词、上下文布局）
- `src/server/character-chat/storage.ts`
- `src/server/character-chat/agents.ts`
- `src/server/agents/create-agent.ts`——共享 `createToolAgent` 包装器
- `src/server/agents/create-event-stream.ts`——共享 NDJSON 流构建器
- `src/server/agents/compile-agent-context.ts`——基于块的上下文编译器
- `tests/character-chat/chat.test.ts`
- `tests/character-chat/storage.test.ts`
