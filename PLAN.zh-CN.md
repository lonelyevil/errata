# Errata——可扩展写作应用

## 目录

- [概述](#概述)
- [架构](#架构)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [数据模型](#数据模型)
- [Fragment 系统](#fragment-系统)
- [Context Block 系统](#context-block-系统)
- [LLM 集成](#llm-集成)
- [Agent 框架](#agent-框架)
- [后台 Librarian](#后台-librarian)
- [插件系统](#插件系统)
- [前端](#前端)
- [API 路由](#api-路由)
- [二进制分发](#二进制分发)
- [开发工作流](#开发工作流)
- [环境变量](#环境变量)

---

## 概述

Errata 是一款围绕 **fragment 系统**构建的模型辅助写作应用——所有内容（prose、角色、准则、知识）都是 fragment。Fragment 通过**块系统**组合为结构化的 LLM 上下文，根据作者指令生成故事后续内容。应用支持多个 LLM provider、插件架构，以及用于连续性管理的后台 librarian agent。

---

## 架构

Elysia 在 TanStack Start 的 catch-all 服务器路由（`src/routes/api.$.ts`）中运行。应用使用单一部署产物，可编译为独立的 Bun 二进制文件进行分发。

```
Browser <--HTTP--> TanStack Start (Vite/Nitro)
                         |
                    /api/* routes --> Elysia (embedded)
                         |
                    Filesystem Storage (data/)
```

---

## 技术栈

| 层级 | 技术 | 版本 |
|---------------|-------------------------------|--------------------|
| 运行时 | Bun | 1.x |
| 前端 | TanStack Start (React) | 1.132.x |
| 路由 | TanStack Router | 1.132.x |
| 服务器状态 | TanStack Query (React Query) | 5.x |
| 后端 | Elysia | 1.4.x |
| 验证 | Zod | 4.x（`zod/v4`） |
| LLM SDK | Vercel AI SDK（`ai`） | 6.x |
| LLM Provider | `@ai-sdk/deepseek`、`@ai-sdk/openai-compatible` | latest |
| 样式 | Tailwind CSS 4.x + shadcn/ui | latest |
| 构建 | Vite 7.x + Nitro | latest |
| 测试 | Vitest + React Testing Lib | 3.x / latest |
| 压缩 | fflate | 0.8.x |

---

## 项目结构

```
errata/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── PLAN.md
├── CLAUDE.md
│
├── src/
│   ├── routes/
│   │   ├── __root.tsx                # 根布局
│   │   ├── index.tsx                 # 故事列表/首页
│   │   ├── story.$storyId.tsx        # 主编辑器视图
│   │   └── api.$.ts                  # Elysia catch-all API 路由
│   │
│   ├── server/
│   │   ├── api.ts                    # Elysia 应用 + 全部路由定义
│   │   ├── init.ts                   # 启动初始化
│   │   ├── treaty.ts                 # Eden Treaty 同构客户端
│   │   ├── story-archive.ts          # 故事归档/导出逻辑
│   │   │
│   │   ├── fragments/
│   │   │   ├── schema.ts             # Zod schema（Fragment、StoryMeta、ProseChain）
│   │   │   ├── storage.ts            # 文件系统 CRUD + 版本化更新
│   │   │   ├── registry.ts           # Fragment 类型 registry
│   │   │   └── prose-chain.ts        # 带变体的 Prose Chain 排序
│   │   │
│   │   ├── blocks/
│   │   │   ├── schema.ts             # 块配置 Zod schema
│   │   │   ├── storage.ts            # 块配置持久化
│   │   │   └── apply.ts              # 将块配置应用到默认块
│   │   │
│   │   ├── config/
│   │   │   ├── schema.ts             # Provider 配置 schema + 预设
│   │   │   └── storage.ts            # 全局配置持久化
│   │   │
│   │   ├── llm/
│   │   │   ├── client.ts             # 多 provider 模型解析
│   │   │   ├── context-builder.ts    # 基于块的上下文组装
│   │   │   ├── tools.ts              # 动态 LLM 工具生成
│   │   │   ├── writer-agent.ts       # Writer agent 包装器
│   │   │   └── generation-logs.ts    # 生成日志存储
│   │   │
│   │   ├── agents/
│   │   │   ├── types.ts              # AgentDefinition、AgentInvocationContext
│   │   │   ├── registry.ts           # 全局 agent registry
│   │   │   ├── runner.ts             # 带深度/超时限制的 agent 调用
│   │   │   ├── traces.ts             # Agent trace 日志
│   │   │   ├── register-core.ts      # 核心 agent 注册
│   │   │   └── index.ts              # 重新导出
│   │   │
│   │   ├── librarian/
│   │   │   ├── agent.ts              # 主要 librarian 分析逻辑
│   │   │   ├── agents.ts             # Librarian agent 定义
│   │   │   ├── llm-agents.ts         # 基于 LLM 的 agent 定义
│   │   │   ├── chat.ts               # 与 librarian 聊天
│   │   │   ├── refine.ts             # 通过 agent 优化 fragment
│   │   │   ├── suggestions.ts        # 知识建议逻辑
│   │   │   ├── storage.ts            # Librarian 状态 + analysis 持久化
│   │   │   └── scheduler.ts          # 防抖触发器
│   │   │
│   │   ├── plugins/
│   │   │   ├── loader.ts             # 插件发现（内置 + 外部）
│   │   │   ├── types.ts              # WritingPlugin 接口
│   │   │   ├── hooks.ts              # 管线钩子系统
│   │   │   └── tools.ts              # 插件工具注册
│   │   │
│   │   └── logging/
│   │       ├── types.ts
│   │       ├── storage.ts
│   │       ├── logger.ts
│   │       └── index.ts
│   │
│   ├── components/
│   │   ├── prose/
│   │   │   ├── ProseChainView.tsx     # 可滚动 Prose Chain
│   │   │   ├── ProseBlock.tsx         # 单个 prose 块
│   │   │   ├── ProseOutlinePanel.tsx  # Prose 大纲/导航
│   │   │   ├── InlineGenerationInput.tsx # 作者输入
│   │   │   └── ChevronRail.tsx        # 导航栏
│   │   ├── fragments/
│   │   │   ├── FragmentList.tsx       # 带搜索/排序的侧边栏列表
│   │   │   ├── FragmentEditor.tsx     # 完整编辑器（标签、引用、sticky、placement）
│   │   │   ├── FragmentExportPanel.tsx
│   │   │   ├── FragmentImportDialog.tsx
│   │   │   └── ContextOrderPanel.tsx  # 块内 fragment 排序
│   │   ├── blocks/
│   │   │   ├── BlockEditorPanel.tsx   # 可视化块编辑器
│   │   │   ├── BlockCreateDialog.tsx  # 自定义块创建
│   │   │   ├── BlockPreviewDialog.tsx # 上下文预览
│   │   │   └── BlockContentView.tsx   # 块内容显示
│   │   ├── generation/
│   │   │   ├── GenerationPanel.tsx    # 流式生成 UI
│   │   │   └── DebugPanel.tsx         # 生成日志检查器
│   │   ├── sidebar/
│   │   │   ├── StorySidebar.tsx       # 分节导航
│   │   │   ├── DetailPanel.tsx        # 按分节渲染详情
│   │   │   ├── StoryInfoPanel.tsx
│   │   │   ├── SettingsPanel.tsx      # 故事 + LLM 设置
│   │   │   ├── LibrarianPanel.tsx     # Librarian 活动/聊天
│   │   │   └── ArchivePanel.tsx       # 故事归档
│   │   ├── wizard/
│   │   │   └── StoryWizard.tsx        # 对话式故事设置
│   │   ├── settings/
│   │   │   └── ProviderManager.tsx    # LLM provider CRUD
│   │   ├── onboarding/
│   │   │   └── OnboardingWizard.tsx   # 首次运行 onboarding
│   │   ├── help/
│   │   │   ├── HelpPanel.tsx
│   │   │   └── help-content.tsx
│   │   └── ui/                        # shadcn/ui 组件
│   │
│   ├── lib/
│   │   ├── api/                       # 模块化 API 客户端
│   │   │   ├── client.ts             # 带类型的 fetch 包装器
│   │   │   ├── index.ts              # 重新导出
│   │   │   ├── types.ts              # 集中式 API 类型
│   │   │   ├── fragments.ts
│   │   │   ├── stories.ts
│   │   │   ├── generation.ts
│   │   │   ├── blocks.ts
│   │   │   ├── librarian.ts
│   │   │   ├── config.ts
│   │   │   ├── settings.ts
│   │   │   ├── prose-chain.ts
│   │   │   └── plugins.ts
│   │   ├── fragment-ids.ts           # 可发音 ID 生成
│   │   ├── fragment-visuals.ts       # Fragment 类型视觉形状/颜色
│   │   ├── fragment-clipboard.ts     # 复制/粘贴 fragment
│   │   ├── dom-ids.ts               # data-component-id 辅助函数
│   │   ├── plugin-panels.ts         # 客户端插件 registry、PanelEvent、通知函数
│   │   ├── plugin-panel-init.ts     # 自动发现内置 entry.client.ts 文件
│   │   ├── theme.tsx                # 主题 provider（字体、暗色模式）
│   │   └── utils.ts
│   │
│   └── styles.css                    # Tailwind + 自定义样式
│
├── tests/
│   ├── setup.ts                      # 临时目录辅助函数、全局设置
│   ├── fragments/                    # Schema、存储、ID 测试
│   ├── llm/                          # 上下文构建器、工具、生成测试
│   ├── librarian/                    # Agent、聊天、优化、调度测试
│   ├── agents/                       # Agent runner 测试
│   ├── blocks/                       # 块存储和应用测试
│   ├── api/                          # 路由集成测试
│   ├── plugins/                      # 插件加载和钩子测试
│   └── fixtures/
│
├── plugins/                          # 内置插件
│   ├── color-picker/                # Fragment 颜色标记（使用面板钩子）
│   ├── diceroll/
│   ├── keybinds/
│   ├── names/
│   └── templates/                    # 插件配方模板
│
├── packages/
│   └── errata-plugin-sdk/            # 发布为 @tealios/errata-plugin-sdk
│
├── scripts/
│   ├── build-binary.mjs              # 编译为 Bun 独立二进制文件
│   ├── package-binary.mjs            # 压缩二进制 + public 资源
│   ├── new-plugin.mjs                # 插件脚手架
│   ├── binary-entry.mjs              # 二进制运行时入口
│   └── proxy-with-qr.mjs            # 带 QR 码的开发分享
│
├── .github/workflows/
│   ├── release-binary.yml            # Release 时构建并上传二进制文件
│   └── publish-plugin-sdk.yml        # 按 tag 将 SDK 发布到 npm
│
└── data/                             # 文件系统存储根目录（被 git 忽略）
    ├── config.json                   # 全局 provider 配置
    └── stories/
        └── <storyId>/
            ├── meta.json
            ├── prose-chain.json       # 带变体的有序 prose
            ├── fragments/             # 独立 fragment JSON 文件
            ├── associations.json
            ├── block-config.json      # 块编辑器配置
            ├── generation-logs/
            └── librarian/
                ├── state.json
                ├── chat-history.json
                └── analyses/
```

---

## 数据模型

### Fragment Schema

```typescript
import { z } from 'zod/v4'

export const FragmentIdSchema = z.string().regex(/^[a-z]{2,4}-[a-z0-9]{4,12}$/)

export const FragmentSchema = z.object({
  id: FragmentIdSchema,
  type: z.string().min(1),               // 'prose', 'character', 'guideline', 'knowledge', 'image', 'icon', or plugin types
  name: z.string().max(100),
  description: z.string().max(250),
  content: z.string(),
  tags: z.array(z.string()).default([]),
  refs: z.array(FragmentIdSchema).default([]),
  sticky: z.boolean().default(false),     // Always in LLM context
  placement: z.enum(['system', 'user']).default('user'), // Which LLM message role
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  order: z.int().default(0),
  meta: z.record(z.string(), z.unknown()).default({}),
  archived: z.boolean().default(false),
  version: z.int().min(1).default(1),
  versions: z.array(z.object({           // Version history
    version: z.int().min(1),
    name: z.string().max(100),
    description: z.string().max(250),
    content: z.string(),
    createdAt: z.iso.datetime(),
    reason: z.string().optional(),
  })).default([]),
})
```

### Story Schema

```typescript
export const StoryMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  summary: z.string().default(''),            // Maintained by librarian
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  settings: z.object({
    outputFormat: z.enum(['plaintext', 'markdown']).default('markdown'),
    enabledPlugins: z.array(z.string()).default([]),
    summarizationThreshold: z.int().min(0).default(4),
    maxSteps: z.int().min(1).max(50).default(10),
    providerId: z.string().nullable().default(null),
    modelId: z.string().nullable().default(null),
    librarianProviderId: z.string().nullable().default(null),
    librarianModelId: z.string().nullable().default(null),
    autoApplyLibrarianSuggestions: z.boolean().default(false),
    contextOrderMode: z.enum(['simple', 'advanced']).default('simple'),
    fragmentOrder: z.array(z.string()).default([]),
    contextCompact: z.object({
      type: z.enum(['proseLimit', 'maxTokens', 'maxCharacters']),
      value: z.number().int().min(1),
    }).default({ type: 'proseLimit', value: 10 }),
  }),
})
```

### Prose Chain

Prose 通过支持变体的 chain 排序：

```typescript
export const ProseChainSchema = z.object({
  entries: z.array(z.object({
    proseFragments: z.array(FragmentIdSchema),  // All variations
    active: FragmentIdSchema,                    // Currently selected variation
  })),
})
```

### Provider 配置

```typescript
export const ProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  preset: z.string().default('custom'),     // 'deepseek', 'openai', 'anthropic', 'openrouter', 'custom'
  baseURL: z.string().url(),
  apiKey: z.string().min(1),
  defaultModel: z.string().min(1),
  enabled: z.boolean().default(true),
  customHeaders: z.record(z.string(), z.string()).optional().default({}),
  createdAt: z.iso.datetime(),
})

export const GlobalConfigSchema = z.object({
  providers: z.array(ProviderConfigSchema).default([]),
  defaultProviderId: z.string().nullable().default(null),
})
```

### Fragment ID 前缀

| 类型 | 前缀 |
|------------|--------|
| prose | `pr` |
| character | `ch` |
| guideline | `gl` |
| knowledge | `kn` |
| image | `im` |
| icon | `ic` |

ID 可发音（例如 `ch-bokura`、`pr-katemi`）。插件可注册自己的前缀。

---

## Fragment 系统

### 存储

所有数据位于文件系统的 `data/stories/<storyId>/` 下，使用 Node.js `fs/promises`。

Fragment 支持版本化更新——`updateFragmentVersioned()` 在应用变更前，会先将先前状态快照到 `versions[]`。

### 类型 Registry

Registry（`src/server/fragments/registry.ts`）保存全部 fragment 类型定义。每种类型指定：

- `type`、`prefix`、`stickyByDefault`
- `contextRenderer`——如何将 fragment 渲染到 LLM 上下文
- `llmTools`——是否生成该类型专用的 LLM 工具（默认：true）

内置类型（prose、character、guideline、knowledge、image、icon）设置为 `llmTools: false`，因为其内容已直接进入上下文。

### 上下文行为

| Fragment 类型 | 是否进入上下文？ | 候选列表？ |
|---------------|---------------------------|-----------------------------------|
| Prose | 最近 N 条（可配置） | 完整列表（id、type、description） |
| Character | Sticky 项（完整内容） | 完整列表（id、name、description） |
| Guideline | Sticky 项（完整内容） | 完整列表（id、name、description） |
| Knowledge | Sticky 项（完整内容） | 完整列表（id、name、description） |

---

## Context Block 系统

上下文构建器生成离散的**块**，这些块在编译为 LLM 消息前可以操作。完整文档参见 `docs/context-blocks.md`。

```
buildContextState() → beforeContext hooks → createDefaultBlocks() → applyBlockConfig() → beforeBlocks hooks → compileBlocks() → beforeGeneration hooks → streamText()
```

### 默认块

| 块 ID | 角色 | 顺序 | 内容 |
|---|---|---|---|
| `instructions` | system | 100 | 写作助手指令 |
| `tools` | system | 200 | 可用工具列表 |
| `system-fragments` | system | 300 | 放在 system 位置的 sticky fragment |
| `story-info` | user | 100 | 故事名称 + 描述 |
| `summary` | user | 200 | 滚动故事摘要 |
| `user-fragments` | user | 300 | 放在 user 位置的 sticky fragment |
| `shortlist-guidelines` | user | 400 | 非 sticky guideline 候选列表 |
| `shortlist-knowledge` | user | 410 | 非 sticky knowledge 候选列表 |
| `shortlist-characters` | user | 420 | 非 sticky character 候选列表 |
| `prose` | user | 500 | 近期 Prose Chain |
| `author-input` | user | 600 | 作者指令 |

用户可通过 Block Editor 自定义块（需要在 Settings 中启用 Advanced prompt control 模式）。自定义块可以是静态文本，也可以访问完整故事上下文的 JavaScript 脚本。

---

## LLM 集成

### 多 Provider 支持

模型解析链：故事设置 → 全局默认值 → 未配置时抛出错误。

Provider 预设：DeepSeek、OpenAI、Anthropic、Google Gemini、Kimi、OpenRouter、Z.AI 和 Custom。Gemini 使用原生 `@ai-sdk/google` provider；其他预设和自定义端点使用 `@ai-sdk/openai-compatible`。故事可以为 generation 和 librarian 分别配置 provider。

### LLM 工具

根据已注册的 fragment 类型动态生成工具。`llmTools: false` 的类型（所有内置类型）会跳过，因为其内容已在上下文中。

**始终可用（通用）：**
- `getFragment(id)`——按 ID 获取任意 fragment
- `listFragments(type?)`——列出 fragment，可按类型过滤
- `searchFragments(query, type?)`——跨 fragment 全文搜索
- `listFragmentTypes()`——列出已注册类型

**写入工具（非 readOnly 时）：**
- `createFragment(type, name, description, content)`
- `updateFragment(fragmentId, newContent, newDescription)`
- `editFragment(fragmentId, oldText, newText)`
- `deleteFragment(fragmentId)`
- `editProse(oldText, newText)`——在当前活跃 Prose Chain 中查找替换
- `getStorySummary()` / `updateStorySummary(summary)`

**按类型生成的工具（用于 `llmTools: true` 的插件类型）：**
- `get{Type}(id)`、`list{Types}()`

### 生成管线

```
作者输入
    |
buildContextState()                -- 将 fragment 加载为带类型状态
    |
beforeContext hooks                -- 插件修改状态
    |
createDefaultBlocks()              -- 将状态转换为 ContextBlock[]
    |
applyBlockConfig()                 -- 用户的块自定义配置
    |
beforeBlocks hooks                 -- 插件操作块
    |
compileBlocks()                    -- 块 → ContextMessage[]
    |
beforeGeneration hooks             -- 插件修改最终消息
    |
streamText() with tools            -- Vercel AI SDK v6
    |
流式传输到客户端（SSE）
    |
afterGeneration hooks
    |
保存 prose fragment（版本化）
    |
afterSave hooks
    |
触发 librarian（异步）
```

---

## Agent 框架

结构化 agent 调用系统（`src/server/agents/`）。

```typescript
interface AgentDefinition<TInput, TOutput> {
  name: string
  description: string
  inputSchema: ZodSchema
  outputSchema?: ZodSchema
  allowedCalls?: string[]
  run: (ctx: AgentInvocationContext, input: TInput) => Promise<TOutput>
}
```

Runner 强制执行深度限制、调用次数限制和超时。Agent 可通过 `ctx.invokeAgent()` 调用其他 agent。每次运行都会记录 trace。

核心 agent：`librarian.analyze`、`librarian.refine`、`librarian.chat`。

---

## 后台 Librarian

在保存 prose 后触发，执行连续性管理：

1. 更新滚动故事摘要
2. 检测角色提及
3. 标记矛盾
4. 建议知识 fragment
5. 跟踪时间线事件

近期行为更新：

- 可安全重新分析的摘要应用：同一 prose fragment 存在多条 analysis 时，摘要重建/应用解析到最新 analysis（先比较 `createdAt`，再以 `id` 打破平局）。
- `updateSummary` 接受结构化信号（`events`、`stateChanges`、`openThreads`），自由形式摘要文本为空时可推导规范的 `summaryUpdate` 文本。
- 结构化摘要请求体会持久化到每条 librarian analysis，并显示在侧边栏 Librarian 面板中。

还支持交互式聊天（询问故事相关问题）和 fragment 优化（通过 agent 改进 fragment）。

存储于 `data/stories/<storyId>/librarian/`，包括状态、analysis 和聊天历史。

---

## 插件系统

插件实现 `WritingPlugin`，可提供：

- 自定义 fragment 类型
- LLM 工具
- `/api/plugins/<name>/` 下的 API 路由
- 服务器管线钩子（`beforeContext`、`beforeBlocks`、`beforeGeneration`、`afterGeneration`、`afterSave`）
- 客户端面板钩子（`onPanelOpen`、`onPanelClose`）——响应 UI 面板打开/关闭事件
- 侧边栏 UI 面板（外部插件使用 iframe）

两种插件来源：

1. **内置**——从 `plugins/*/` 编译进应用
2. **外部**——运行时从 `PLUGIN_DIR` 加载

内置插件：`diceroll`、`keybinds`、`names`、`color-picker`。

### 客户端插件钩子

面板打开/关闭事件会发送给所有插件：

- **内置插件**：通过 `entry.client.ts` 中的 `onPanelOpen`/`onPanelClose` 导出
- **外部插件**：通过 iframe window 上的 `postMessage`（`errata:panel-open`、`errata:panel-close`）

内置 `entry.client.ts` 导出：

```typescript
export const pluginName = 'my-plugin'
export const panel = MyPanelComponent                    // React component
export const activate = (ctx: PluginRuntimeContext) => {} // Plugin enabled
export const deactivate = (ctx: PluginRuntimeContext) => {} // Plugin disabled
export const onPanelOpen = (event: PanelEvent, ctx: PluginRuntimeContext) => {}
export const onPanelClose = (event: PanelEvent, ctx: PluginRuntimeContext) => {}
```

外部 iframe 插件通过 `postMessage` 监听：

```js
window.addEventListener('message', (e) => {
  if (e.data.type === 'errata:panel-open')  { /* e.data.event, e.data.context */ }
  if (e.data.type === 'errata:panel-close') { /* e.data.event, e.data.context */ }
  if (e.data.type === 'errata:data-changed') { /* e.data.queryKeys */ }
})
```

`PanelEvent` 根据 `panel` 字段区分：

| `event.panel` | 额外字段 | 触发时机 |
|---|---|---|
| `'fragment-editor'` | `fragment?: Fragment`、`mode: 'edit' \| 'create'` | Fragment 编辑器打开/关闭 |
| `'debug'` | — | Debug 面板打开/关闭 |
| `'providers'` | — | Provider 管理器打开/关闭 |
| `'export'` | — | Export 面板打开/关闭 |
| `'wizard'` | — | Story wizard 打开/关闭 |

### 查询缓存失效

插件运行时（原生 JS，无 React 上下文）可通过派发 window 事件使 TanStack Query 缓存失效：

```typescript
window.dispatchEvent(new CustomEvent('errata:plugin:invalidate', {
  detail: { queryKeys: [['tags', storyId, fragmentId], ['fragment', storyId, fragmentId]] },
}))
```

故事路由使每个 key 失效，并向所有插件 iframe 广播 `errata:data-changed`。

插件 SDK 发布为 `@tealios/errata-plugin-sdk`。开发指南参见 `docs/third-party-plugins.md`。

---

## 前端

### 路由

| 路由 | 组件 | 说明 |
|--------------------|------------------------|--------------------------------|
| `/` | `index.tsx` | 故事列表、创建/导入 |
| `/story/:storyId` | `story.$storyId.tsx` | 带侧边栏的主编辑器视图 |

故事设置（`StoryWizard.tsx`）是故事路由内的 overlay，而不是独立路由。它运行开放式模型对话，并提供实时规划检查清单。模型在整个对话中创建和版本更新真实的故事 fragment；打开故事时只是关闭设置 overlay。

### 关键模式

- 使用 **React Query** 管理服务器状态并自动刷新
- **模块化 API 客户端**（`src/lib/api/`）——带类型的 fetch 包装器，客户端不使用 Eden Treaty
- 通过 Vercel AI SDK 使用 **SSE 流式生成**
- **主题系统**支持配置 prose 字体
- **响应式布局**支持移动端

---

## API 路由

所有路由通过 Elysia 挂载在 `/api/*` 下。

### Stories 与 Fragments

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| GET | `/api/stories` | 列出故事 |
| POST | `/api/stories` | 创建故事 |
| GET | `/api/stories/:id` | 获取故事 |
| PUT | `/api/stories/:id` | 更新故事 |
| DELETE | `/api/stories/:id` | 删除故事 |
| GET | `/api/stories/:id/fragments` | 列出 fragment（`?type=`） |
| GET | `/api/stories/:id/fragments/:fid` | 获取 fragment |
| POST | `/api/stories/:id/fragments` | 创建 fragment |
| PUT | `/api/stories/:id/fragments/:fid` | 更新 fragment |
| DELETE | `/api/stories/:id/fragments/:fid` | 删除 fragment |
| GET | `/api/stories/:id/prose-chain` | 获取 Prose Chain |
| PUT | `/api/stories/:id/prose-chain` | 更新 Prose Chain |

### 生成

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| POST | `/api/stories/:id/generate` | 生成 prose（流式 SSE） |
| POST | `/api/stories/:id/setup/chat` | 继续对话式故事设置（流式 NDJSON） |
| POST | `/api/stories/:id/setup/complete` | 供设置 API 客户端使用的旧式显式完成操作 |
| GET | `/api/stories/:id/generation-logs` | 列出生成日志 |
| GET | `/api/stories/:id/generation-logs/:logId` | 获取完整日志 |

### 块

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| GET | `/api/stories/:id/blocks` | 获取块配置 + 内置元数据 |
| GET | `/api/stories/:id/blocks/preview` | 预览编译后的上下文 |
| POST | `/api/stories/:id/blocks/custom` | 创建自定义块 |
| PUT | `/api/stories/:id/blocks/custom/:blockId` | 更新自定义块 |
| DELETE | `/api/stories/:id/blocks/custom/:blockId` | 删除自定义块 |
| PATCH | `/api/stories/:id/blocks/config` | 更新覆盖/排序 |

### Librarian

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| GET | `/api/stories/:id/librarian/status` | Librarian 状态 |
| GET | `/api/stories/:id/librarian/analyses` | 列出 analysis |
| GET | `/api/stories/:id/librarian/analyses/:aid` | 获取 analysis |
| POST | `/api/stories/:id/librarian/chat` | 与 librarian 聊天 |
| POST | `/api/stories/:id/librarian/refine` | 优化 fragment |

### 配置

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| GET | `/api/config` | 获取全局配置 |
| POST | `/api/config/providers` | 添加 provider |
| PUT | `/api/config/providers/:id` | 更新 provider |
| DELETE | `/api/config/providers/:id` | 删除 provider |

### 插件

插件挂载在 `/api/plugins/<name>/*` 下。插件 UI 从 `/api/plugins/<name>/ui/*` 提供。

---

## 二进制分发

编译为带静态资源的独立 Bun 可执行文件。

```bash
bun run build:binary     # 构建二进制（vite build + bun build --compile）
bun run package:binary   # 压缩二进制 + public/ 资源
bun run release:binary   # 执行上述两个步骤
```

GitHub Actions（`.github/workflows/release-binary.yml`）在每个 release tag 上构建 Windows x64、Linux x64 和 macOS ARM64 版本。

---

## 开发工作流

测试优先，使用 Conventional Commits。

```bash
bun install              # 安装依赖
bun run dev              # 在端口 7739 启动开发服务器
bun run test             # 运行全部测试（vitest）
bun run test:watch       # Watch 模式
```

### 测试策略

| 层级 | 方法 |
|-------|----------|
| Schema | 验证正确/错误输入 |
| 存储 | 在临时目录中使用真实文件系统 |
| API 路由 | 通过 `app.fetch(new Request(...))` 调用 Elysia |
| 上下文构建器 | 固定 fragment fixture，断言消息组装 |
| LLM/生成 | Mock AI SDK（`streamText`、`generateText`） |
| Agent | Mock agent runner，验证调用和 trace |
| 块 | 测试配置应用和块操作 |
| 插件 | 测试插件 fixture，验证注册和钩子 |
| Librarian | 使用 prose fixture、mock LLM，验证分析更新 |

---

## 环境变量

| 变量 | 默认值 | 说明 |
|----------|---------|-------------|
| `DATA_DIR` | `./data` | 文件系统存储根目录 |
| `PORT` | `7739` | 服务器端口 |
| `PLUGIN_DIR` | — | 外部插件目录 |
| `PLUGIN_EXTERNAL_OVERRIDE` | — | 允许外部插件替换内置插件 |
