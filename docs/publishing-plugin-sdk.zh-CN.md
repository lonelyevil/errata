# 发布 `@tealios/errata-plugin-sdk`

本项目在 `packages/errata-plugin-sdk` 中包含一个本地 SDK 包。

## 手动发布（npm）

在 SDK 包目录中运行发布命令，不要在仓库根目录运行：

```bash
cd packages/errata-plugin-sdk
NODE_AUTH_TOKEN="<your-npm-token>" npm publish
```

说明：

- 包已配置 `publishConfig.access = public`。
- 发布目标为 npm registry（`https://registry.npmjs.org`）。

## CI 发布（GitHub Actions）

工作流文件：

- `.github/workflows/publish-plugin-sdk.yml`

触发方式：

- 手动触发（`workflow_dispatch`）
- 推送匹配 `sdk-v*` 的 tag（例如 `sdk-v0.1.1`）

行为：

- 校验 tag 版本是否与 `packages/errata-plugin-sdk/package.json` 中的版本一致。
- 从 `packages/errata-plugin-sdk` 发布。

所需的 GitHub secret：

- `NPM_TOKEN`

## 常见错误与修复

### `E403 ... Two-factor authentication ... bypass 2fa enabled is required`

原因：

- token 不满足组织/npm 的 2FA 发布策略；
- 或 token 已过期/被撤销。

修复：

- 创建一个新的 npm automation/granular token，确保它有权发布 `@tealios/errata-plugin-sdk`；
- 确保该 token 符合组织的 2FA 策略；
- 更新 GitHub 中的 `NPM_TOKEN` 后重试发布。

### `Cannot read properties of null (reading 'prerelease')`

原因：

- 通常是因为在错误目录（仓库根目录）运行了 `npm publish`，而不是在 SDK 包目录中运行。

修复：

- 在 `packages/errata-plugin-sdk` 中运行发布命令。

### `gitignore-fallback No .npmignore file found`

原因：

- 缺少 `.npmignore` 时，npm 会使用 `.gitignore`。

修复：

- 可选；如果需要明确控制发布文件，请在 `packages/errata-plugin-sdk` 内添加 `.npmignore`。

## 版本发布流程

1. 更新 `packages/errata-plugin-sdk/package.json` 中的版本号。
2. 手动发布，或推送匹配的发布 tag：

```bash
git tag sdk-v0.1.1
git push origin sdk-v0.1.1
```

## 安全提醒

- 永远不要提交 npm token。
- 如果 token 曾出现在日志或聊天中，请立即轮换/撤销它。
