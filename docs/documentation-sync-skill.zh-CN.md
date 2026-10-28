# 文档同步 Skill

该 skill 用于让项目文档与 git commit 保持同步。

## 功能

1. 从最新到最旧扫描 Markdown 历史，直到至少 50% 的受跟踪文档发生过变更，据此确定基线 commit。
2. 将该基线作为增量同步的起点。
3. 读取从上一个已处理 commit 到 `HEAD` 的 commit。
4. 生成 `docs/commit-doc-sync.md`，内容包括：
   - 基线详情；
   - commit 列表；
   - 代码已变更但文档未更新时，建议复查的文档。
5. 将状态保存到 `.agent/docs-sync-state.json`。
6. 用户可见功能发生变化时，更新应用内帮助组件（`src/components/help/help-content.tsx`）。

## 运行

```bash
bun run docs:sync
```

## 受跟踪的文档

- **Markdown 文档**——`docs/` 中的文件和根目录下的 `.md` 文件。
- **帮助组件**——`src/components/help/help-content.tsx` 包含应用内帮助面板的内容。新增或修改功能时，应同步更新对应的帮助章节/小节。帮助内容采用 `HELP_SECTIONS` 结构，即由 `HelpSection` 对象组成的数组，每个对象都包含带有 JSX 内容的 `subsections`。

## 基线行为

- 首次运行：根据文档历史计算基线。
- 后续运行：基线固定保存在 `.agent/docs-sync-state.json` 中，从上一个已处理的 commit 开始增量同步。

## 重置基线

删除 `.agent/docs-sync-state.json`，然后重新运行。
