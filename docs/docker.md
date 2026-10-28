# Docker 镜像、GHCR 发布与部署

本文记录本次 Docker 化的实现，并提供本地构建和 GHCR 部署教程。镜像支持 `linux/amd64` 与 `linux/arm64`。

## 本次变更

- `.dockerignore`：排除源码数据、依赖目录、凭据和构建产物。
- `Dockerfile`：多阶段、跨架构构建；最终镜像使用非 root 用户运行。
- `compose.yaml`：本地构建与启动，使用命名卷保存数据。
- `.github/workflows/docker.yml`：测试、双架构镜像冒烟检查，以及 GHCR 发布。
- `.github/workflows/upstream-docker.yml`：检查上游最新稳定 tag，并为 GHCR 中缺失的版本构建 `<版本号>` 与 `latest` 镜像。
- `package.json`：将直接依赖的 TanStack 包固定到仓库原声明版本（Router/Start `1.132.0`、SSR Query `1.131.7`），避免新版 Start 与 Vite 7 的 peer 版本不兼容。
- `vite.config.ts`：按 TanStack Start 与 Nitro 的集成顺序排列插件。
- `src/routeTree.gen.ts`：由固定版本的路由生成器重新生成类型声明。
- `docs/docker.md`：本文；`README.md` 与 `docs/README.md` 增加入口。

## 镜像设计

构建阶段使用固定版本 `oven/bun:1.4.4`，调用现有 `scripts/build-binary.mjs`。该脚本完成 Vite/Nitro 构建、复制静态资源并编译 Bun 单文件，不在 Docker 中维护另一套应用构建流程。

通过 `BUILDPLATFORM` 在原生构建机上执行 Vite，再按目标架构编译：

| Docker 平台 | Bun 编译目标 |
| --- | --- |
| `linux/amd64` | `bun-linux-x64` |
| `linux/arm64` | `bun-linux-arm64` |

最终镜像基于 `debian:bookworm-slim`，只包含运行所需文件：

```text
/app/errata
/app/public/
/data/
/plugins/
```

`public/` 必须位于可执行文件旁边；`scripts/binary-entry.mjs` 会按相对位置读取静态资源。最终镜像不包含源码、Bun 工具链或 `node_modules`。

运行约定：

| 项目 | 值 |
| --- | --- |
| 用户 | UID/GID `10001:10001` |
| `DATA_DIR` | `/data`，必须持久化 |
| `PLUGIN_DIR` | `/plugins`，可选外部插件目录 |
| 监听地址 | `HOST=0.0.0.0`、`NITRO_HOST=0.0.0.0` |
| 应用端口 | `PORT=7739`、`NITRO_PORT=7739` |
| 健康检查 | `GET /api/health` |
| OpenRouter OAuth 回调 | 容器端口 `3000`，按需发布 |

> 当前 `bun.lock` 被 `.gitignore` 排除，干净构建仍会重新解析未固定的依赖。此次已将直接依赖的 TanStack 包固定到兼容 Vite 7 的版本，避免 Start 新版要求 Vite 8 导致虚拟入口构建失败。若需要整个依赖树严格可复现，建议后续单独决定是否提交锁文件。

## 简单部署：从 GHCR 运行

以下示例使用当前仓库对应的镜像名 `ghcr.io/lonelyevil/errata`。其他 fork 应替换为自己的 GitHub owner/repository。

### 1. 拉取镜像

```bash
docker pull ghcr.io/lonelyevil/errata:latest
```

生产环境建议使用正式版本标签，例如 `1.12.0`，或使用 Release 工作流输出的 `@sha256:...` digest，而不是自动跟随 `latest`。

### 2. 创建数据卷并启动

```bash
docker volume create errata-data

docker run -d \
  --name errata \
  --restart unless-stopped \
  --init \
  --publish 127.0.0.1:7739:7739 \
  --volume errata-data:/data \
  ghcr.io/lonelyevil/errata:latest
```

打开 `http://localhost:7739`，在 onboarding 或 **Settings → Providers** 中配置模型服务。API Key 保存在数据卷中，不需要写入镜像或启动命令。

检查健康状态：

```bash
curl --fail http://127.0.0.1:7739/api/health
```

默认只绑定宿主机回环地址。远程部署时建议通过 SSH 隧道或反向代理访问，不要在没有访问控制的情况下直接将写作数据暴露到公网。

### 3. 可选：外部插件

挂载只包含可信插件的目录，然后重启容器：

```text
--volume /absolute/path/to/plugins:/plugins
```

外部插件是在启动时加载的任意代码。插件目录的读写权限应根据插件实际需要设置。

### 4. 可选：本地 OpenRouter OAuth

OpenRouter 回调固定使用 `localhost:3000`。在本机 Docker 上使用该登录方式时，为容器增加：

```text
--publish 127.0.0.1:3000:3000
```

宿主机端口 `3000` 必须空闲。远程服务器上的 `localhost` 指向用户自己的计算机，不能直接当作服务器地址；此时可使用 API Key，或自行建立到容器回调端口的 SSH 转发。

### 5. 升级与备份

- 升级前备份 `errata-data` 数据卷。
- 使用同一数据卷重新创建或更新容器，故事与配置即可保留。
- 若部署用的 Compose 文件直接引用 GHCR 镜像，可执行 `docker compose pull` 后 `docker compose up -d`；不要给 `down` 添加 `-v`/`--volumes`，以免删除数据卷。
- 回滚时选择先前的精确版本标签或 digest，并先确认该版本兼容现有数据格式。

## 本地构建与 Compose

在仓库根目录构建并启动：

```bash
docker compose up -d --build
```

访问 `http://127.0.0.1:7739`。Compose 使用 `errata:local` 镜像和 `errata-data` 命名卷，并开启 `init` 与 `unless-stopped` 重启策略。

仅校验 Compose 配置：

```bash
docker compose config --quiet
```

`compose.yaml` 中保留了被注释的 OpenRouter `3000` 端口映射和外部插件挂载示例，按需取消注释。普通 `docker compose down` 不会删除命名卷；不要添加 `-v` 或 `--volumes`。

也可以直接使用 Buildx 构建单一架构：

```bash
docker buildx build --platform linux/amd64 --load --tag errata:local .
```

构建双架构 manifest 并推送需要 Buildx 和 registry；本地 Docker image store 不应被用来加载多架构 manifest。

## GitHub Actions 与 GHCR

工作流：`.github/workflows/docker.yml` 与 `.github/workflows/upstream-docker.yml`。

### 触发与发布规则

| 触发 | 验证 | 推送 GHCR |
| --- | --- | --- |
| PR 指向 `main`/`master` | Vitest、双架构构建和容器冒烟检查 | 否 |
| push/merge 到 `main`/`master` | 同上 | `edge`、`sha-<short>` |
| 发布 GitHub Release | 同上，另校验 Release tag 与 `package.json` | semver、`latest`、`sha-<short>` |
| 手动 `workflow_dispatch` | 同上 | 默认否；显式设置 `push=true` 时推送 SHA 标签 |

正式 Release `v1.12.0` 会生成 `1.12.0`、`1.12`、`1`、`latest` 和 SHA 标签。预发布不更新 `latest`。

### 上游稳定版本补建

`.github/workflows/upstream-docker.yml` 每天 02:23 UTC 以及每次 push/merge 到 `main`/`master` 时运行，也可手动触发。它通过 `git ls-remote` 获取 `tealios/errata` 的最新稳定 `vX.Y.Z` tag，并检查当前 GHCR 是否已有对应的 `X.Y.Z` 镜像：

- 已存在：跳过构建。
- 不存在：先构建并冒烟检查 `linux/amd64` 与 `linux/arm64`，通过后发布 `X.Y.Z` 和 `latest`。
- 手动触发默认只验证；显式设置 `push=true` 才发布。

构建上下文来自上游 tag 的实际源码，不把当前分支代码冒充上游版本。为保证容器打包可重复，工作流会从当前仓库覆盖 `Dockerfile`、`.dockerignore`、`package.json` 和 `vite.config.ts`，同步 `patches/`（上游没有该目录时先创建空目录），随后把 `package.json` 的 `version` 写回上游 tag 版本。若未来上游依赖或构建方式变化导致这些兼容文件不再适用，工作流会失败，需要同步更新打包配置，而不是静默发布错误镜像。

发布 job 使用最小权限：

```yaml
permissions:
  contents: read
  packages: write
```

通过 `GITHUB_TOKEN` 登录 `ghcr.io`，不需要长期 PAT。构建使用 GitHub Actions Buildx 缓存，并在正式推送时生成 SBOM 与 `mode=max` provenance。

### 双架构验证

PR 和发布前验证分别构建 `linux/amd64`、`linux/arm64` 单架构镜像，并检查：

- `/api/health` 与首页可访问；
- 实际镜像架构正确；
- 容器用户为 `10001:10001`；
- `/data` 可写，重启后测试数据仍存在。

ARM64 冒烟运行使用 QEMU；发布阶段也为目标架构的运行镜像准备 QEMU。最终发布将两个架构组合为同一个多架构 manifest。

### 首次发布后的 GHCR 设置

GitHub 文档说明首次发布的 package 默认为 private。首次工作流成功后：

1. 打开仓库关联的 `errata` Package。
2. 确认 Package 已关联当前仓库，并允许该仓库的 Actions 写入。
3. 若希望匿名 `docker pull`，在 Package Settings 中改为 public；否则拉取方需要使用具有 `read:packages` 权限的凭据登录 GHCR。

镜像还包含 source、description、license 等 OCI metadata。

## 故障排查

### 容器启动但宿主机无法访问

查看日志和健康接口：

```bash
docker logs errata
curl --fail http://127.0.0.1:7739/api/health
```

确认端口映射存在，且镜像中的 `HOST`/`NITRO_HOST` 没有被覆盖为 `127.0.0.1`。

### `/data` 写入失败

命名卷通常继承镜像中目录的 `10001:10001` 所有权。使用宿主机 bind mount 时，需要自行确保该 UID 对目录有写权限。

### GHCR 推送返回 403

检查 publish job 的 `packages: write`、Package 的 Actions access，以及现有 Package 是否已关联当前仓库。 fork 的 PR 不应推送镜像。

### OpenRouter 回调失败

确认本机映射了 `127.0.0.1:3000:3000`，宿主机没有另一个进程占用 `3000`，并注意远程部署时 `localhost` 的含义。

### 检查镜像支持的架构

```bash
docker buildx imagetools inspect ghcr.io/lonelyevil/errata:latest
```

输出应包含 `linux/amd64` 和 `linux/arm64`。

## 本次验证记录

- `bun run build`：通过。
- `bun run test`：92 个测试文件、920 个测试全部通过。
- `docker compose config --quiet` 与 workflow YAML 静态解析：通过。
- ARM64 镜像构建及健康、架构、非 root 用户和持久化检查：通过。
- AMD64 镜像构建：完成；受本地环境限制，容器运行检查未完成，不计为通过项。
- 上游补建 workflow：YAML、job 依赖与嵌入 shell 静态检查通过；实际上游检测和构建由 GitHub Actions 执行。
- GHCR 实际推送与多架构 manifest：未在本地执行，由首次 GitHub Actions 发布验证。

## 官方资料

- [GitHub：使用 Actions 发布 Package](https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions)
- [GitHub：使用 Container registry（GHCR）](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Docker Docs：多阶段构建](https://docs.docker.com/build/building/multi-stage/)
- [Docker Docs：GitHub Actions 多平台构建](https://docs.docker.com/build/ci/github-actions/multi-platform/)
- [Docker Docs：推送前测试镜像](https://docs.docker.com/build/ci/github-actions/test-before-push/)
- [Docker Docs：GitHub Actions 缓存](https://docs.docker.com/build/cache/backends/gha/)
- [Docker Docs：SBOM 与 provenance](https://docs.docker.com/build/ci/github-actions/attestations/)
- [Bun：Docker 镜像与 glibc 要求](https://bun.sh/docs/installation)
