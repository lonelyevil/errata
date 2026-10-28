# 前端组件 ID 约定

本项目使用 `data-component-id` 作为稳定的 DOM 钩子，用于可扩展性、插件集成和自动化。

## 为什么需要它

- 插件需要可预测的锚点，以便安全地扩展 UI。
- E2E 和集成测试需要在样式/布局变化后仍保持稳定的选择器。
- 避免重复 UI（列表、行、嵌套面板）中的全局 `id` 冲突。

## 基本规则

- 组件钩子使用 `data-component-id`。
- HTML `id` 仅在原生语义明确需要时使用（label、锚点等）。

## 命名约定

使用小写 kebab-case 标识符。

- 静态节点：`section-element`
  - 示例：`character-sidebar-list`
- 动态实体：`<entity-prefix>-<entity-id>-<element>`
  - 示例：`ch-abc123-list-item`
  - 示例：`ch-abc123-pin-toggle`
- 插件边界：
  - `plugin-panel-host`
  - `plugin-<pluginName>-panel-root`

## 辅助工具

使用 `src/lib/dom-ids.ts` 中的辅助函数：

- `componentId(...parts)`
  - 清理各部分并连接为 kebab-case。
- `fragmentComponentId(fragment, suffix)`
  - 使用 fragment 类型/前缀和 fragment ID 生成稳定的 fragment ID。

## 当前主要锚点

### 侧边栏和详情面板

- `story-sidebar`
- `sidebar-section-story-info`
- `sidebar-section-characters`
- `sidebar-section-guidelines`
- `sidebar-section-knowledge`
- `sidebar-section-media`
- `sidebar-section-agent-activity`
- `sidebar-section-settings`
- `detail-panel-root`
- `detail-panel-content`
- `detail-panel-section-<section>`

### Fragment 列表

- `character-sidebar-list`
- `guideline-sidebar-list`
- `knowledge-sidebar-list`
- `media-sidebar-list`
- 动态行和操作：
  - `ch-<id>-list-item`
  - `ch-<id>-select`
  - `ch-<id>-pin-toggle`
  - `ch-<id>-drag-handle`

> 同样的模式也适用于其他前缀（`gl`、`kn`、`pr`、`im`、`ic`）。

### Prose 和生成

- `prose-chain-root`
- `prose-chain-scroll`
- `prose-<fragmentId>-block`
- `prose-<fragmentId>-regenerate`
- `prose-<fragmentId>-refine`
- `inline-generation-root`
- `inline-generation-input`
- `inline-generation-submit`
- `debug-panel-root`
- `debug-log-<logId>-item`

### 路由级外层结构

- `stories-page`
- `story-list`
- `story-<storyId>-card`
- `story-editor-root`
- `main-prose-pane`
- `overlay-story-wizard`
- `overlay-debug-panel`
- `overlay-provider-panel`
- `overlay-fragment-editor-<mode>`

## 添加新 ID

添加或修改 UI 时：

1. 在扩展边界和重复项行上添加 `data-component-id`。
2. 优先使用 `componentId`/`fragmentComponentId`，不要硬编码字符串拼接。
3. 名称应表达功能和角色，而不是样式或视觉位置。
4. 除非有迁移原因，否则保留现有 ID。

## 插件作者指南

- 通过 `data-component-id` 读取宿主应用中的锚点。
- 适用时，将插件 UI 挂载到 `plugin-<pluginName>-panel-root` 内。
- 集成时不要依赖 Tailwind 类名。

## 测试指南

- 优先使用 `[data-component-id="character-sidebar-list"]` 这样的选择器。
- 对于动态行，使用已知实体 ID 构建选择器。
- 存在稳定钩子时，避免使用与文本内容或视觉类名绑定的选择器。
