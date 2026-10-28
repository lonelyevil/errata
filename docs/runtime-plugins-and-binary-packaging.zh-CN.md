# 运行时插件 + Bun 二进制打包

本文说明将 Errata 打包为 Bun 独立可执行文件时的插件加载机制，以及如何安全使用运行时（外部）插件。

## 目标

- 将内置插件打包进应用/二进制文件。
- 允许在运行时从磁盘加载额外插件（服务器端）。
- 确保插件在开发模式和编译模式下行为可预测。

## 当前插件加载模型

Errata 支持两种插件来源：

1. **静态内置插件**（始终可用）
   - 通过 `import.meta.glob('../../plugins/*/entry.server.ts', { eager: true })` 加载。
   - 编译进应用及独立二进制文件。

2. **外部运行时插件**（可选）
   - 设置 `PLUGIN_DIR` 后，在启动时从磁盘加载。
   - 服务器功能在运行时加载。
   - 可选 UI 可通过 `plugin.json` + iframe 面板由 Errata 提供。

代码参考：

- `src/server/init.ts`
- `src/server/plugins/loader.ts`

## 运行时插件目录

将 `PLUGIN_DIR` 设置为每个插件各占一个文件夹的目录。

每个插件文件夹可提供以下服务器入口文件之一（使用第一个匹配项）：

1. `entry.server.ts`
2. `entry.server.js`
3. `plugin.ts`
4. `plugin.js`

模块必须以 `default`（或 `plugin`）导出有效的 `WritingPlugin`。

目录示例：

```text
external-plugins/
  my-plugin/
    entry.server.ts
    plugin.json
    ui/
      index.html
      panel.css
      panel.js
  dice-tools/
    plugin.js
```

## 通过 plugin.json 提供运行时 UI 面板（Iframe）

外部插件无需进入前端构建即可定义面板 UI。

在插件根目录创建 `plugin.json`：

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

- 如果提供 `name`，必须与 `entry.server.*` 中的 `manifest.name` 一致。
- `panel.title` 覆盖侧边栏面板标题。
- `panel.entry` 指向相对于插件根目录的 HTML 入口文件。
- `panel.icon` 可设置侧边栏图标：
  - lucide：`{ "type": "lucide", "name": "Keyboard" }`
  - svg：`{ "type": "svg", "src": "/api/plugins/my-plugin/ui/icon.svg" }`

Errata 通过以下地址提供面板资源：

- `GET /api/plugins/:pluginName/ui/`（入口 HTML）
- `GET /api/plugins/:pluginName/ui/*`（相对资源）

应用会为已启用的插件在 iframe 中渲染这些面板。

代码参考：

- `src/server/plugins/loader.ts`
- `src/server/plugins/runtime-ui.ts`
- `src/server/api.ts`
- `src/components/sidebar/DetailPanel.tsx`

## 插件重名与覆盖行为

插件通过 `plugin.manifest.name` 保证名称唯一。

- 默认情况下，如果外部插件与内置插件重名，会跳过外部插件。
- 要允许外部插件替换，请设置：

```text
PLUGIN_EXTERNAL_OVERRIDE=1
```

启用后，重名的外部插件会注销当前插件并取而代之。

## 日志行为

启动日志包含插件加载结果：

- 外部目录加载成功/失败
- 从外部来源加载/跳过的数量
- 最终已注册插件名称列表

这有助于验证生产环境中实际挂载了哪些插件。

## UI 模式与限制

外部运行时插件 UI 当前通过 `plugin.json` 支持 **iframe 模式**。

- 适用于：运行时加载的独立 HTML/CSS/JS 插件 UI。
- 不支持（针对外部插件）：在运行时将 React 组件挂载到宿主 bundle。

内置插件可使用 `entry.client.ts` 提供 React 面板和构建时发现的客户端钩子。

### 客户端面板钩子

所有插件都会收到面板打开/关闭事件：

- **内置插件**：通过 `entry.client.ts` 中的 `onPanelOpen` / `onPanelClose` 导出。
- **外部插件**：通过 iframe window 上的 `postMessage`（`errata:panel-open`、`errata:panel-close`、`errata:data-changed`）。

可用钩子：

- `activate` / `deactivate`——为故事启用/禁用插件时调用（仅限内置插件）。
- `onPanelOpen` / `onPanelClose`——任意 UI 面板打开/关闭时调用（fragment 编辑器、debug、providers、export、wizard）。

`PanelEvent` 接口和 postMessage 协议参见 `docs/third-party-plugins.md`。

## 独立二进制工作流

内置插件位于二进制文件内。外部插件在运行时从 `PLUGIN_DIR` 指向的磁盘目录加载。

Windows 运行示例：

```bat
set PLUGIN_DIR=C:\errata\plugins
set PLUGIN_EXTERNAL_OVERRIDE=1
errata.exe
```

Linux/macOS 运行示例：

```bash
PLUGIN_DIR=/opt/errata/plugins PLUGIN_EXTERNAL_OVERRIDE=1 ./errata
```

启用后的插件面板 URL：`http://localhost:7739/api/plugins/my-plugin/ui/`

## 构建与打包命令

使用项目脚本，不要直接调用 `bun build --compile`：

```bash
bun run build:binary     # vite build + bun build --compile → dist/errata(.exe) + dist/public/
bun run package:binary   # 将二进制 + public/ 压缩为 zip → dist/errata-bundle.zip
bun run release:binary   # 执行上述两个步骤
```

二进制包装器（`scripts/binary-entry.mjs`）会重映射 Bun 虚拟路径，使运行时资源读取解析到 `dist/public/`。

## CI：自动发布构建

`.github/workflows/release-binary.yml` 会在每次发布 release 时自动构建二进制文件。

它在三个平台并行构建：

| Runner | 产物 |
|--------|----------|
| `windows-latest` | `errata-windows-x64.zip` |
| `ubuntu-latest` | `errata-linux-x64.zip` |
| `macos-latest` | `errata-macos-arm64.zip` |

每个 zip 包含编译后的二进制文件和 `public/` 静态资源。压缩包会作为附件上传到 GitHub release。

触发方式：在 GitHub 上创建 release（或运行 `gh release create v1.x.x`）。

## 打包说明

- API key 和其他 secret 应保存在环境变量中，或通过 UI 配置。
- 通过 `DATA_DIR` 将故事数据放在外部目录。
- 仅使用可信来源的外部插件（存在运行时代码执行风险）。
- 外部 iframe 面板运行在沙箱中（`allow-scripts allow-same-origin allow-forms`）。

## 启动时初始化目录

Errata 启动时会自动创建缺失的基础目录：

- `DATA_DIR`
- `DATA_DIR/stories`
- `PLUGIN_DIR`（如果已设置）

全新安装时无需预先创建空目录。

## 安全注意事项

外部插件是在运行时加载的任意代码。

建议：

- 使用具有受限写权限的专用插件目录。
- 部署前审查插件代码。
- 使用最小权限的 OS/服务凭据运行 Errata。
- 将 `PLUGIN_EXTERNAL_OVERRIDE=1` 视为受控部署设置。
