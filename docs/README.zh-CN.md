# 文档索引

- `docs/fragments-and-prose-chain.md`
  - Fragment 系统与 Prose Chain：完整 schema 参考、fragment 类型、ID 约定、Prose Chain 结构、文件系统存储布局、完整 API 参考、导入/导出格式、SillyTavern 角色卡导入（PNG + JSON，支持 lorebook/world book）以及移植指南。
- `docs/context-blocks.md`
  - Context Block 系统：结构化 LLM 提示词块、`beforeBlocks` 插件钩子、Block Editor UI、自定义块（简单块 + 脚本块）以及块配置 API。
- `docs/summarization-and-memory.md`
  - 滚动故事记忆技术参考：延迟摘要应用、用于安全重新分析的 latest-analysis 去重、结构化摘要信号、压缩阈值、设置/API 接入以及测试覆盖。
- `docs/character-chat.md`
  - Character Chat 架构与 API：会话存储模型、NDJSON 流式聊天端点、persona 模式、模型/provider 解析以及前端集成点。
- `docs/prose-writing-panel.md`
  - Prose Writing Panel 流程：基于 Tiptap 的编辑器行为、自动保存规则、选区转换操作（`rewrite`/`expand`/`compress`/custom）以及 `librarian/prose-transform` API。
- `docs/backend-stress-harness.md`
  - 如何运行合成后端压力测试工具，用于摘要/索引可扩展性验证和上下文构建延迟基准测试。
- `docs/third-party-plugins.md`
  - 如何构建外部插件、使用运行时 iframe UI、从模板创建脚手架、客户端面板钩子（内置插件使用 `onPanelOpen`/`onPanelClose`，iframe 使用 `postMessage`）、查询缓存失效以及开发环境验证。
- `docs/runtime-plugins-and-binary-packaging.md`
  - 运行时插件加载、二进制构建/打包工作流、CI 发布自动化以及部署说明。
- `docs/docker.md`
  - Docker 镜像设计、linux/amd64 + linux/arm64 构建、Compose、GHCR Actions 发布以及部署指南。
- `docs/component-ids.md`
  - 用于可扩展性和自动化的前端 `data-component-id` 约定。
- `docs/publishing-plugin-sdk.md`
  - 如何手动及通过 GitHub Actions 发布 `@tealios/errata-plugin-sdk`。
- `docs/instruction-registry.md`
  - Instruction Registry：集中式提示词管理、模型专用指令覆盖、InstructionSet schema 和已注册的 key。
- `docs/generation-pipeline.md`
  - 生成管线：standard 与 prewriter 模式、上下文组装、流式事件、生成日志以及各模式的行为。
- `docs/adding-agents.md`
  - 添加新 agent 的贡献者指南：文件结构、系统提示词、块构建器、运行时逻辑、注册、模型解析、UI 集成和测试清单。
- `docs/commit-doc-sync.md`
  - 自动生成的 commit 驱动文档同步报告，包含基线检测和后续建议。
- `docs/documentation-sync-skill.md`
  - commit 驱动文档同步 skill 的实现说明和用法。

相关内容：

- `plugins/templates/README.md`
  - 插件配方模板目录。
- `packages/errata-plugin-sdk/package.json`
  - 本地 SDK 包：`@tealios/errata-plugin-sdk`。
- `PLAN.md`
  - 完整架构参考：schema、项目结构、API 路由、数据模型和生成管线。
- `CLAUDE.md`
  - Claude Code 开发指南：命令、约定和效率提示。

自动化：

- `bun run docs:sync`
  - 根据 git 历史重新生成 `docs/commit-doc-sync.md`，并将状态保存到 `.agent/docs-sync-state.json`。
