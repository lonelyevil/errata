# 第三方插件开发

本指南介绍如何构建可放入 `PLUGIN_DIR`（或克隆到 `plugins/`）并由 Errata 加载的插件。

相关文档：

- `docs/runtime-plugins-and-binary-packaging.md`
- `plugins/templates/README.md`

## 目标

- 将插件仓库克隆到插件目录。
- 重启 Errata。
- 自动加载插件服务器功能。
- 可选插件 UI 通过 iframe 显示在侧边栏。

## 目录结构

每个插件位于独立文件夹中。

```text
my-plugin/
  entry.server.ts
  plugin.json
  ui/
    index.html
    panel.css
    panel.js
  README.md
```

## 必需的服务器入口

`entry.server.ts`（或 `.js`）必须导出有效的 `WritingPlugin`。

在插件项目中安装 SDK：

```bash
bun add @tealios/errata-plugin-sdk
```

```ts
import { definePlugin, type WritingPlugin } from '@tealios/errata-plugin-sdk'

const plugin: WritingPlugin = definePlugin({
  manifest: {
    name: 'my-plugin',
    version: '0.1.0',
    description: 'Example external plugin',
    panel: {
      title: 'My Plugin',
      icon: { type: 'lucide', name: 'Sparkles' },
    },
  },
  // Optional server capabilities:
  // fragmentTypes, tools, routes, hooks
})

export default plugin
```

### SDK 层（`@tealios/errata-plugin-sdk`）

SDK 为插件作者提供稳定契约：

- 插件类型（`WritingPlugin`、`PluginManifest`、`Fragment`、`ContextBuildState` 等）
- 辅助 API（`definePlugin` / `createPlugin`）

这样可避免使用 `../../src/server/...` 这类脆弱的内部导入来获取类型定义，并为独立插件仓库提供更好的 IDE 支持。

支持的服务器入口文件名（使用第一个匹配项）：

1. `entry.server.ts`
2. `entry.server.js`
3. `plugin.ts`
4. `plugin.js`

## 通过 plugin.json 提供可选 UI

如果希望无需重新构建前端 bundle 即可获得侧边栏面板，请添加 `plugin.json`：

```json
{
  "name": "my-plugin",
  "panel": {
    "title": "My Plugin",
    "entry": "ui/index.html",
    "icon": { "type": "lucide", "name": "Sparkles" }
  }
}
```

规则：

- 如果提供 `name`，必须与 `manifest.name` 一致。
- `panel.entry` 相对于插件根目录。
- `panel.icon` 可选，支持：
  - `{ "type": "lucide", "name": "Sparkles" }`
  - `{ "type": "svg", "src": "/api/plugins/my-plugin/ui/icon.svg" }`
- 入口文件应为 HTML，可引用本地 CSS/JS 文件。

### 插件图标

可在 `manifest.panel.icon` 或 `plugin.json.panel.icon` 中定义插件图标。

- `lucide` 图标使用图标名称。
- `svg` 图标使用图标来源 URL。

侧边栏当前内置支持的 lucide 名称：

- `Sparkles`
- `Keyboard`
- `Wrench`
- `Book`
- `Hash`

未知或缺失的图标回退为 `Sparkles`。

Errata 通过以下地址提供插件 UI：

- `GET /api/plugins/:pluginName/ui/`（入口 HTML）
- `GET /api/plugins/:pluginName/ui/*`（相对于入口目录的资源）

应用在 iframe 中渲染此面板。

## 最小 UI 示例

`ui/index.html`

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>My Plugin</title>
    <link rel="stylesheet" href="./panel.css" />
  </head>
  <body>
    <h1 id="title">My Plugin Panel</h1>
    <script src="./panel.js"></script>
  </body>
</html>
```

`ui/panel.css`

```css
body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 12px; }
```

`ui/panel.js`

```js
const params = new URLSearchParams(location.search)
const storyId = params.get('storyId')
document.getElementById('title').textContent = storyId
  ? `My Plugin Panel (${storyId})`
  : 'My Plugin Panel'
```

## 本地开发流程

### 模板目录

完整模板位于 `plugins/templates/README.md`。

示例包括：

- `my-first-plugin`
- `recipe-fragment-type-plugin`
- `recipe-llm-tool-plugin`
- `recipe-story-fragments-plugin`
- `recipe-hooks-plugin`
- `recipe-iframe-ui-plugin`

从模板创建插件脚手架：

```bash
bun run new:plugin my-plugin
```

使用指定的完整配方模板：

```bash
bun scripts/new-plugin.mjs my-plugin --template recipe-llm-tool-plugin
```

也可以指定自定义插件根目录：

```bash
bun scripts/new-plugin.mjs my-plugin /opt/errata/plugins
```

然后在运行 Errata 时将 `PLUGIN_DIR` 指向该根目录。

1. 将插件文件夹放入运行时插件目录。
2. 使用环境变量启动 Errata：

Windows：

```bat
set PLUGIN_DIR=C:\path\to\plugins
bun run dev
```

macOS/Linux：

```bash
PLUGIN_DIR=/path/to/plugins bun run dev
```

3. 在故事设置中启用插件（`enabledPlugins`）。
4. 在侧边栏打开插件面板。

### 在开发环境中验证外部插件

本地开发时，可采用与生产环境运行时插件完全相同的方式测试：

```bash
PLUGIN_DIR=/path/to/plugins bun run dev
```

然后验证：

- `GET /api/plugins` 包含你的插件 manifest
- 插件已在故事设置中启用
- 如果存在 `plugin.json.panel.entry`，可通过 iframe 使用面板

Windows 示例：

```bat
set PLUGIN_DIR=C:\path\to\plugins
bun run dev
```

### IDE 导入指南

- 插件契约使用 SDK 导入（`@tealios/errata-plugin-sdk`）。
- 仅在可选高级配方中导入 Errata 内部模块（`../../src/server/...`）。
- 如果需要这些内部导入在 IDE 中完整解析，请在 monorepo 内开发插件（或在迭代时将其 symlink 到 monorepo）。

## 客户端面板钩子

Errata 会向所有插件广播面板打开/关闭事件。内置和外部插件均可响应这些事件。

### 内置插件（`entry.client.ts`）

内置插件直接导出生命周期和面板钩子：

```ts
// entry.client.ts
import type { PanelEvent, PluginRuntimeContext } from '@/lib/plugin-panels'

export const pluginName = 'my-plugin'
export const activate = (ctx: PluginRuntimeContext) => { /* plugin enabled */ }
export const deactivate = (ctx: PluginRuntimeContext) => { /* plugin disabled */ }

export const onPanelOpen = (event: PanelEvent, ctx: PluginRuntimeContext) => {
  if (event.panel === 'fragment-editor') {
    console.log('Fragment opened:', event.fragment?.id, 'mode:', event.mode)
  }
}

export const onPanelClose = (event: PanelEvent, ctx: PluginRuntimeContext) => {
  if (event.panel === 'fragment-editor') {
    console.log('Fragment editor closed')
  }
}
```

为侧边栏面板导出 `panel` React 组件：

```ts
import type { PluginPanelProps } from '@/lib/plugin-panels'

export const panel = ({ storyId }: PluginPanelProps) => <div>...</div>
```

### 外部插件（iframe `postMessage`）

外部插件通过 iframe window 上的 `postMessage` 接收相同事件：

```js
// ui/panel.js
window.addEventListener('message', (e) => {
  if (e.data.type === 'errata:panel-open') {
    const { event, context } = e.data
    // event.panel, event.fragment, event.mode
    // context.storyId
  }

  if (e.data.type === 'errata:panel-close') {
    const { event, context } = e.data
  }

  if (e.data.type === 'errata:data-changed') {
    // Another plugin modified data — re-fetch if needed
    // e.data.queryKeys contains the affected query key arrays
  }
})
```

### PanelEvent 结构

`PanelEvent.panel` 的值包括：`'fragment-editor'`、`'debug'`、`'providers'`、`'export'`、`'wizard'`。

对于 `'fragment-editor'`，事件还包含：

- `fragment?: Fragment`——正在编辑的 fragment（创建模式下不存在）
- `mode: 'edit' | 'create'`——编辑器模式

### 查询缓存失效

插件运行时（原生 JS，无 React 上下文）可通过派发 window 事件，使宿主应用的 TanStack Query 缓存失效：

```ts
window.dispatchEvent(new CustomEvent('errata:plugin:invalidate', {
  detail: {
    queryKeys: [
      ['tags', storyId, fragmentId],
      ['fragment', storyId, fragmentId],
    ],
  },
}))
```

故事路由会监听该事件并使每个 query key 失效，同时向所有插件 iframe 广播 `errata:data-changed` 消息，让它们重新获取各自的数据。

## 名称冲突

插件以 `manifest.name` 为 key。

- 默认：跳过重名的外部插件。
- 允许外部覆盖：

```text
PLUGIN_EXTERNAL_OVERRIDE=1
```

## 安全说明

- 外部插件可执行任意服务器代码。
- 只加载可信插件。
- 限制插件目录的写权限。
- Iframe UI 运行在沙箱中，但仍应将插件 UI 视为不可信代码。

## 克隆并运行示例

```bash
git clone https://github.com/your-org/errata-plugin-foo /opt/errata/plugins/foo
PLUGIN_DIR=/opt/errata/plugins ./errata
```
