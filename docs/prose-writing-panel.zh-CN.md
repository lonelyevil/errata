# Prose Writing Panel

Prose Writing Panel 是面向 prose fragment 的专注长文编辑器，与支持内联生成、变体、librarian 操作和时间线分叉的 Prose Chain 视图配套使用。

## 概述

- 从 `ProseChainView` 中 prose 块的操作（Edit）打开。
- 使用 Tiptap（`@tiptap/react` + `@tiptap/starter-kit`）提供富文本编辑体验，但保存的是纯 prose 文本。
- 支持通过侧边栏快速切换段落，并显示章节标记以提供上下文。
- 关闭、按 Escape 或切换到其他段落时自动保存。
- 外层 Prose Chain 视图针对长篇小说进行了虚拟化，并按故事保存滚动位置。

## 键盘快捷键

- `Ctrl+S` / `Cmd+S`——保存当前 prose fragment
- `Esc`——关闭面板（有未保存修改时自动保存）
- `Alt+Up` / `Alt+Down`——切换到上一段/下一段

## 选区转换

选中文本后，会出现包含内置转换操作的浮动工具栏：

- `Rewrite`
- `Expand`
- `Compress`

也可通过 `useWritingTransforms()`（`src/lib/theme.tsx`）添加自定义转换，它们会显示为额外按钮。

转换请求以流式方式返回文本和可选 reasoning；选中的范围会被原地替换。

## API 端点

选区转换由以下端点提供：

`POST /stories/:storyId/librarian/prose-transform`

请求体结构（`src/server/api.ts`）：

```json
{
  "fragmentId": "pr-ab12",
  "selectedText": "She entered the room.",
  "operation": "rewrite",
  "instruction": "optional for custom mode",
  "sourceContent": "optional full prose",
  "contextBefore": "optional local context",
  "contextAfter": "optional local context"
}
```

响应为 NDJSON（`application/x-ndjson`），事件类型包括：

- `text`
- `reasoning`
- `tool-call`
- `tool-result`
- `finish`

## 上下文条

编辑器在编辑区域上方和下方显示上下文条：

- **上一段上下文条**——显示 Prose Chain 中前一段的截断预览，在写作时提供连续性上下文。
- **下一段上下文条**——显示后一段的截断预览。

仅在存在相邻段落时显示上下文条。作者无需滚动完整 Prose Chain，即可保持行文连贯。

## Prose 侧边栏

可折叠侧边栏列出所有 prose 段落和章节标记，并提供：

- **搜索**——按内容筛选段落
- **章节标记**——显示为带书签图标的分节标题
- **保存状态指示**——绿色对勾（已保存）、黄色圆点（未保存）
- **快速导航**——点击任意段落切换过去（有未保存修改时先自动保存当前段落）

侧边栏可折叠，以最大化编辑空间。使用标题栏中的面板图标切换。

## 编辑器统计

状态栏显示当前段落的实时统计：

- 单词数
- 字符数
- 估算 token 数
- 段落数
- 估算阅读时间

## 对话格式

Prose 块会自动将引号中的对话显示为斜体，以便区分。该功能使用 `src/lib/character-mentions.ts` 中的 `formatDialogue`，并通过 `composeTextTransforms` 与提及高亮组合。格式化只影响显示，不会修改底层 fragment 内容。

## 中止生成

生成可在流式输出过程中中止。`InlineGenerationInput` 组件在生成期间提供暂停按钮。中止信号通过 `AbortController` 从客户端传递到服务器流。中止前已生成的文本会保存为部分 prose fragment。

## 引导模式

内联生成输入支持三种模式：

- **Freeform**——标准文本输入，用于自定义作者指令。
- **Guided**——显示 librarian 最近一次分析生成的方向建议卡片。点击卡片会将其指令填入生成输入框。刷新按钮可按需请求新建议。
- **Compose**——绕过生成，直接在 chain 中编写新的 prose 分节。

Guided 模式还提供以下快捷操作：

- **Continue**——自然推进情节
- **Scene-setting**——侧重氛围和角色时刻

模式偏好保存在 `localStorage` 中。

## 内联 Prose 操作

Chain 视图中的每个 prose 块都提供围绕写作面板的操作菜单：

- **Edit**——打开完整 Prose Writing Panel
- **Redo**——根据原始 prompt/description 重新生成
- **Ask / Refine**——打开 librarian 并预填该 fragment
- **Analyze**——手动触发该 prose fragment 的 librarian 分析
- **Read aloud / Stop**——通过配置的朗读引擎播放段落（如果选区位于段落内，则只播放选中文本）；如果正在播放，则停止当前段落
- **Split from here**——从该分节创建新的时间线分叉
- **Variation switching**——在同一分节的备选版本之间切换

如果 prose fragment 已有 librarian 分析，块右上角会显示一个绿色小圆点。

## 朗读

启用 **Settings > Read aloud** 后，每个 prose 块都会显示 **Read aloud** 操作。音频按句合成，并由底部播放栏控制。点击朗读前如果选中了段落内文本，则只朗读选区（播放器标题增加 `· selection` 后缀）；没有选区时朗读整段。

播放栏显示当前段落标题、分块进度、引擎标签、暂停/继续、静音、播放设置和停止控件。播放设置包括语速、音调和音量。浏览器语音可立即开始；Supertonic 在模型下载并缓存后，完全在浏览器本地运行。

## 封面图片横幅

故事设置封面图片后，`ProseChainView` 会在滚动区域顶部、Prose Chain 上方渲染横幅。横幅显示封面图片，并带有渐隐到背景色的渐变遮罩。封面图片由故事路由通过 `coverImage` prop 传给组件。

## 大纲与重排

Prose 大纲面板与当前 chain 保持一致，并可进入重排模式。重排会更新 Prose Chain 本身，因此后续阅读、生成上下文和时间线分叉都会使用新的分节顺序。

## 数据流

1. 用户打开某个 prose fragment 的写作面板。
2. 编辑器从 fragment 初始化内容，并跟踪未保存状态。
3. 保存通过 `api.fragments.update(...)` 写回。
4. 选区转换调用 `api.librarian.transformProseSelection(...)`。
5. 返回的文本替换编辑器中的选区；用户可以继续编辑并保存。
6. 通过侧边栏或 `Alt+Up/Down` 切换段落时，如有未保存修改，会在加载新段落前自动保存。

## 组件/路由对照

- `src/components/prose/ProseWritingPanel.tsx`
- `src/components/prose/InlineGenerationInput.tsx`
- `src/components/tiptap/FloatingElement.tsx`
- `src/components/prose/ProseBlock.tsx`（入口操作）
- `src/components/prose/ProseChainView.tsx`（面板交接）
- `src/components/prose/ProseOutlinePanel.tsx`
- `src/routes/story.$storyId.tsx`（overlay 挂载）
- `src/lib/api/librarian.ts`（客户端 API）
- `src/server/librarian/prose-transform.ts`（agent 实现）

## 测试

- `tests/api/prose-edit-reanalysis.test.ts`
- `tests/librarian/refine.test.ts`
