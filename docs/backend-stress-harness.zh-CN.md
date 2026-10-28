# 后端压力测试工具

该工具会构建合成的长篇小说测试数据，并对摘要/上下文路径进行基准测试，用于后端可扩展性工作。

命令：

```bash
bun run stress:backend
```

可选参数：

- `--prose=<n>`：prose fragment 数量（默认 `2000`）
- `--nonProse=<n>`：character/guideline/knowledge fragment 数量（默认 `500`）
- `--reanalysisRatio=<0..1>`：接受第二次分析的 prose fragment 比例（默认 `0.1`）
- `--chapterEvery=<n>`：章节标记间隔（默认 `50`）
- `--runs=<n>`：每项指标的基准测试迭代次数（默认 `20`）
- `--warmups=<n>`：每项指标的预热迭代次数（默认 `3`）
- `--compactType=proseLimit|maxTokens|maxCharacters`：上下文压缩模式（默认 `proseLimit`）
- `--compactValue=<n>`：所选模式的压缩值（默认 `10`）
- `--targetOffset=<n>`：重新生成目标距离 Prose Chain 末尾的位置（默认 `5`）

快速运行示例：

```bash
bun run stress:backend --prose=300 --nonProse=120 --runs=8 --warmups=1
```

测量内容：

- `summaryBefore (legacy scan)`：通过扫描全部分析并去重来重建摘要
- `summaryBefore (index)`：通过 `librarian/index.json` 查询来重建摘要
- `buildContextState (normal)`：标准上下文组装
- `buildContextState (regenerate path)`：使用 `summaryBeforeFragmentId` + `proseBeforeFragmentId` 的重新生成路径

输出包括：

- 每项指标的 p50/p95/mean/min/max
- 摘要一致性检查（`legacy` 与 `index` 的输出必须一致）
- 索引加速比（legacy 平均值 / index 平均值）
- 用于自动解析的 JSON 报告块（`JSON_REPORT_START ... JSON_REPORT_END`）

说明：

- 该工具使用临时数据目录，并在完成后将其删除。
- 数据为合成数据，不会调用外部 LLM provider。
- 它用于验证分析数量很大时，摘要/索引路径的性能和正确性。
