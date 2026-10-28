# Errata

Errata 是一款围绕 fragment 系统构建的 LLM 辅助写作应用。Prose、角色、准则和知识都是可组合的 fragment，可组装为结构化的 LLM 上下文，用于生成故事。

加入 Discord 社区：https://discord.gg/ywVFKvdH49

![主编辑器视图](docs/imgs/initial-view.png)

## 功能

- **Fragment 系统**——所有内容都是 fragment，支持标签、引用、sticky/system 放置和版本历史
- **Prose Chain + 写作面板**——可分支的 prose，支持重新生成/优化/切换/删除、选区转换（rewrite/expand/compress），以及专用长文编辑视图
- **两阶段 Prewriter**——可选规划 agent 在 writer 生成前，将完整上下文提炼为聚焦的写作 brief，在减少 token 浪费的同时让输出以故事内容为依据
- **按角色选择模型**——为 generation、librarian、角色聊天、directions 和各个 agent 分配不同的 provider 和模型，包括原生 Google Gemini，并支持自动回退链
- **故事方向建议**——AI 生成“接下来发生什么？”的选项，支持自定义提示词模板和引导式方向模式
- **Character Chat 模式**——故事范围内的聊天，支持流式响应、provider/model 选择和角色头像
- **块化上下文**——可视化编辑器用于重排、覆盖和扩展 LLM 提示词结构，包括带实时预览的 JavaScript 脚本块
- **Agent 上下文面板**——按 agent 编辑块，可自定义任意 agent 的提示词、禁用工具并设置模型覆盖
- **Librarian 记忆工具**——滚动连续性、分层摘要、矛盾跟踪和摘要压缩控制
- **通用导入/导出**——拖放 JSON、bundle ZIP 和 SillyTavern/Tavern 卡片（PNG/JSON，支持 lorebook）
- **故事封面图片**——故事列表以画廊网格布局显示封面
- **插件系统**——内置插件 + 外部运行时插件，支持 iframe UI 面板
- **Onboarding 向导 + 应用内帮助**——首次运行设置流程和上下文帮助文章
- **自定义 CSS**——用户自定义界面主题样式
- **无数据库**——使用文件系统存储，可编译为单个二进制文件

### Story Wizard

你可以与 Errata 讨论任何创作起点，无论是粗略 premise、角色、场景还是氛围。实时检查清单会跟踪有用的信息缺口，同时在对话中创建和修改可编辑的 guideline、character、knowledge 和开场 prose。准备好后随时打开故事，无需单独的创建步骤。

### 角色与 Fragment

在侧边栏中浏览和编辑 fragment。Character、guideline 和 knowledge 的使用方式一致。

![角色面板](docs/imgs/character-panel.png)

### Debug 面板

检查任意生成过程的完整 LLM 提示词、工具调用和 token 用量。

![Debug 面板](docs/imgs/debug-window.png)

### Character Chat

从 prose 视图切换到 Character Chat，使用已配置的 provider 进行故事世界内的对话，并保存聊天历史。

## 快速开始

```bash
git clone https://github.com/tealios/errata.git
cd errata
bun install
bun run dev
```

打开 `http://localhost:7739`。在 onboarding 向导或 Settings > Providers 中配置 LLM provider。

## 开发

Windows 一键设置——按需安装 Git 和 Bun、克隆/拉取仓库、安装依赖并启动开发服务器：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

也可以不先克隆仓库，直接通过 Web 运行：

```powershell
irm https://raw.githubusercontent.com/tealios/errata/master/scripts/setup.ps1 | iex
```

## 下载

[Releases](https://github.com/tealios/errata/releases) 页面提供 Windows、Linux 和 macOS 的预构建二进制文件。解压 zip 后即可运行，无需额外运行时依赖。

```bash
# Windows
errata.exe

# Linux
chmod +x errata
./errata

# macOS — 先移除隔离属性
xattr -cr errata
chmod +x errata
./errata
```

设置 `DATA_DIR` 可控制故事数据的存储位置（默认 `./data`）。

容器化部署请参阅 [Docker 和 GHCR 指南](docs/docker.md)。镜像支持 `linux/amd64` 和 `linux/arm64`。

## 环境变量

| 变量 | 默认值 | 说明 |
|----------|---------|-------------|
| `DATA_DIR` | `./data` | 故事数据目录 |
| `PORT` | `7739` | 服务器端口 |
| `PLUGIN_DIR` | — | 外部插件目录 |

也可以在 UI 的 Settings > Providers 中配置 LLM provider。

## 脚本

```bash
bun run dev              # 开发服务器
bun run build            # 生产构建
bun run test             # 运行测试
bun run new:plugin       # 从模板创建插件脚手架
bun run build:binary     # 编译为独立二进制文件
bun run release:binary   # 构建并打包 zip 包
```

## 项目结构

```
src/                    应用代码（路由、服务器、组件、lib）
  server/               Elysia API、fragment、块、LLM、agent、librarian
  components/           React UI（prose、fragment、块、生成、侧边栏）
  lib/api/              带类型的前端 API 客户端
plugins/                内置插件（diceroll、keybinds、names）+ 模板
packages/               插件 SDK（@tealios/errata-plugin-sdk）
tests/                  Vitest 测试套件
docs/                   文档
```

## 技术栈

Bun、TanStack Start + React 19、Elysia、Zod v4、Vercel AI SDK v6、Tailwind v4 + shadcn/ui、Vitest。

## 插件

插件可以注册 fragment 类型、LLM 工具、API 路由和管线钩子。外部插件在运行时从 `PLUGIN_DIR` 加载，并使用基于 iframe 的 UI 面板。

- [插件开发指南](docs/third-party-plugins.md)
- [运行时插件 + 二进制打包](docs/runtime-plugins-and-binary-packaging.md)
- [插件模板](plugins/templates/README.md)
- SDK：`@tealios/errata-plugin-sdk`

## 文档

- [架构与数据模型](PLAN.md)
- [生成管线](docs/generation-pipeline.md)
- [Context Block 系统](docs/context-blocks.md)
- [Instruction Registry](docs/instruction-registry.md)
- [Character Chat](docs/character-chat.md)
- [Prose Writing Panel](docs/prose-writing-panel.md)
- [组件 ID 约定](docs/component-ids.md)
- [发布插件 SDK](docs/publishing-plugin-sdk.md)
- [完整文档索引](docs/README.md)

---

由 [nokusukun](https://github.com/nokusukun) 构建
