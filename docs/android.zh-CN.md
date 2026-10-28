# Android

Errata 在 Android 上完全离线运行。APK 携带与桌面版和二进制构建相同的 Nitro 服务器包，在设备上的嵌入式 Node.js 运行时中执行，应用的 WebView 通过回环地址与其通信。无需 PC、远程服务器或账号。

## 整体结构

```
android/                        Capacitor 项目（纳入版本控制；像普通 Android 应用一样编辑）
capacitor.config.ts             appId、webDir、插件配置
mobile/
  shell/index.html              WebView 启动时显示的加载页
  node/main.cjs                 嵌入式 Node 运行时执行的入口
  node/boot.cjs                 polyfill、环境变量、健康检查轮询（有单元测试）
  www/                          生成目录：加载页 + nodejs/ 项目（被 git 忽略）
scripts/build-android.mjs       vite build -> 组装 mobile/www -> cap sync
```

启动顺序：

1. Capacitor 显示 `mobile/www/index.html`（羊皮纸风格的“Opening the library…”）。
2. Node.js 插件（`@capawesome/capacitor-nodejs`，Node 18.20.4）从同一 Web 目录启动 `nodejs/main.cjs`。
3. `main.cjs` 将 `DATA_DIR` 设置为应用私有文件目录，安装 Node 18 缺少的 polyfill，导入 `server/index.mjs`，并轮询 `/api/health`。
4. 健康检查通过后，通过插件桥发送 `errata:status { status: 'ready', url }`，加载页随后执行 `location.replace('http://127.0.0.1:7739/')`。

此后，WebView 就只是指向本地 Errata 的浏览器。Web 应用的功能（生成、librarian、通过 WASM 实现的 TTS、插件）均与桌面端一致。

## 前置条件

Node 运行时由编译后的 C++（libnode）和小型 JNI 桥组成，因此除常规 Android 组件外，构建还需要原生工具链。

- Android Studio（Ladybug 2024.2.1 或更新版本）及 SDK Platform 36
- JDK 21（可使用 Android Studio 自带的 JBR；从 shell 构建时请设置 `JAVA_HOME`）
- NDK 和 CMake 3.22+（SDK Manager > SDK Tools）
- Bun，与仓库其他部分相同

首次 Gradle 构建会将 Node.js for Mobile Apps 二进制文件（约 100 MB）下载到 Gradle 缓存。每个运行时版本只需下载一次。

## 构建

```bash
bun run android:assemble        # vite build、组装 mobile/www、cap sync android
bun run android:open            # 同上，然后在 Android Studio 中打开 android/
bun run android:apk             # 同上，然后执行 gradle assembleDebug
```

底层脚本支持的参数：

```bash
bun scripts/build-android.mjs --skip-build   # 复用此前构建的 .output
bun scripts/build-android.mjs --no-sync      # 仅组装，不执行 cap sync
```

Debug APK 输出到 `android/app/build/outputs/apk/debug/app-debug.apk`。连接设备后，可使用 `adb install -r <apk>` 安装，或从 Android Studio 运行。

Release 构建使用标准 Android 流程：在 `android/app/build.gradle` 中创建签名配置（或使用 Android Studio > Build > Generate Signed Bundle），然后执行 `gradlew assembleRelease`；发布 Play Store 时使用 `bundleRelease`。

## 数据位置

数据位于插件桥提供的 `app.datadir()`，即应用私有文件目录（`/data/user/0/com.tealios.errata/files`）：

| 路径 | 内容 |
| --- | --- |
| `files/data/` | `config.json`、`stories/<id>/`、日志。布局与桌面端 `DATA_DIR` 相同。 |
| `files/plugins/` | 外部插件（`PLUGIN_DIR`）。将插件文件夹放入此处即可加载。 |

卸载应用会删除这两处数据。请使用 Android 应用备份，或在 Errata 内导出故事进行备份。

## 限制

- **Node 18 运行时。**服务器包面向较新的 Node；`boot.cjs` 为 `Promise.withResolvers` 和全局 `crypto` 提供 polyfill。如果依赖开始需要 Node 20+ 的其他能力，请在那里补充。`tests/android/boot.test.ts` 覆盖这些 polyfill；如果服务器代码引入 Bun 专用 API，`tests/server-portability.test.ts` 会失败。
- **不能创建子进程。**Node.js for Mobile Apps 无法 spawn。Cloudflare 隧道分享（会启动 `cloudflared`）不可用；通过设备 Wi-Fi 地址进行 LAN 分享则可用。
- **每次启动只有一个运行时。**Node 引擎不能重启。如果服务器启动失败，加载页会显示错误，并要求用户强制关闭应用后重新启动。
- **体积。**libnode 每个 ABI 约 30 MB。APK 包含 armeabi-v7a、arm64-v8a 和 x86_64；发布 Play Store 时请使用 App Bundle，让设备只下载所需版本。
- **运行时没有 ICU。**Node.js for Mobile Apps 不带 Intl，正则表达式也不支持 Unicode property escape。`boot.cjs` 包装了 `RegExp`，使通过 `\p{...}` 构建的模式（OpenAPI 插件会在导入时这样做）退化为“任意非 ASCII 字符”，而不是崩溃。`Intl` 为 undefined；服务器代码不能依赖它。
- **打过补丁的插件。**`patches/@capawesome%2Fcapacitor-nodejs@0.1.1.patch` 将插件的 started/ready 标志改为静态。没有该补丁时，Android 重建 activity（在根页面按返回键，然后重新启动）会在同一进程中第二次启动 libnode，导致应用崩溃。Bun 安装依赖时会应用补丁；在上游修复前请保留它。
- **后台运行。**应用进入后台时，Android 可能暂停运行时。入口会立即释放 pause lock；进行中的生成会随应用恢复。

## 故障排查

- **显示“Ready.”后白屏。**WebView 拒绝跳转到明文 HTTP 地址 `http://127.0.0.1`。检查 manifest 是否引用了 `android/app/src/main/res/xml/network_security_config.xml`，以及该配置是否允许 `127.0.0.1` 使用明文流量。
- **“Errata could not start”并伴随模块错误。**通常是 Node 18 缺少某项能力。可在桌面端使用真实 Node 18 复现：编写一个 preload，加载 `mobile/node/boot.cjs`，调用 `installPolyfills()`，并将 `buildServerEnv(tmpDir)` 应用到 `process.env`，然后运行 `npx -p node@18.20.4 node -r ./preload.cjs .output/server/index.mjs`。针对失败项扩展 `installPolyfills`。
- **Gradle 报 `LIBNODE_DIR must be defined` 或缺少 CMake。**通过 SDK Manager 安装 NDK + CMake，然后重新同步。
- **重新构建后仍是旧资源。**`scripts/build-android.mjs` 每次都会清理 `mobile/www`，但 Android Studio 可能存在缓存；请使用 Build > Clean Project。
