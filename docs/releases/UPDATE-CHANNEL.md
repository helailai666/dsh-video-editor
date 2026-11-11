# 安装、发布与更新

## DSH 支持四类来源

| 输入 | DSH 的处理方式 | 本项目 |
|---|---|---|
| `https://github.com/helailai666/dsh-video-editor` | 获取 Git 源码并安装依赖 | 直接提供 JS 与引擎源码，无 prepare/postinstall。稳定版建议固定提交。 |
| `dsh-video-editor` 或 `dsh-video-editor@1.0.0` | 从所选 npm registry 下载已发布包 | npm 仍停在已发布的 1.0.0；1.0.1/1.0.2/1.0.3 目前只经 GitHub 源码安装提供，npm 通道发布后再更新本表。镜像可能延迟同步。 |
| HTTPS `.tgz` URL / 本地 `.tgz` 绝对路径 | 安装压缩包及声明依赖 | 常规 npm 包需联网获取依赖；离线平台包另含依赖。 |
| 本地源码目录绝对路径 | link 开发安装 | 先在源码目录装好依赖；不自动替换为公网版本。 |

Release 页面 URL 不是安装包地址。GitHub 仓库 URL 也不会自动下载最新 Release，而是安装仓库源码。

上述契约核对自本机 DSH Plugin Manager 与[官方打包文档](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)。不要在用户真实 profile 中手写配置或运行包管理器。

## 包名与身份

公开包名为 **dsh-video-editor**；`dsh-video` 已由其他作者占用，不属于本仓库。Loader 行与客户端模块 id 使用新包名；UI panel key、API 路由和用户数据保持原值。

旧本机 `dsh-video` link 安装不受此次仓库修改影响。迁移到正式包时通过官方管理器停用/移除旧包再安装新包，不同时启用两者；保留旧固定包和 `~/Movies/DSH Video`，不要删除用户工程。

## 首次 npm 发布

1. 先将已评审 PR 合入 main，从干净提交制作发行包。根依赖与 worker 的固定版本必须一致。
2. 检查 npm 登录账号和包名权限；`npm whoami --registry=https://registry.npmjs.org`。使用交互登录或可信发布，不把 token 放进源码、文档、构建包或终端记录。
3. 完成验证：

   ```sh
   npm ci --ignore-scripts
   npm run check
   node --test tests/*.test.mjs
   npm pack --ignore-scripts --pack-destination /absolute/release-output
   node scripts/test-release-install.mjs /absolute/release-output/dsh-video-editor-1.0.0.tgz
   npm publish --dry-run --ignore-scripts --access public --registry=https://registry.npmjs.org /absolute/release-output/dsh-video-editor-1.0.0.tgz
   ```

   发布前使用 Gitleaks 扫描当前受控文件与全部 Git 历史；核对包内不含 key、个人路径、用户工程和历史证据。`npm pack` 只收录 package.json 的 files 清单。
4. 获得当次正式发布授权后，发布**同一个已验证 tarball**：

   ```sh
   npm publish --ignore-scripts --access public --registry=https://registry.npmjs.org /absolute/release-output/dsh-video-editor-1.0.0.tgz
   ```

   npm 发布要求账号启用2FA，并可能要求网页/通行密钥确认；用户自行完成，不索取验证码或令牌。登录成功或命令返回成功均不能代替公网验证。首次发布的占位版本/旧缓存不可当作正式1.0.0；核对 registry 的 latest、版本和包摘要。
5. 发布后确认 npm 元数据、下载包摘要，再用临时 DSH_HOME 执行包名安装、创建工程及真实抽帧；GitHub 则固定合入提交验证（`node scripts/test-source-install.mjs <git-or-npm-spec>`）。然后移除 README 的“待发布/待合入”提示。版本不可覆盖，后续修复使用1.0.1。

## GitHub Release 与离线包

npm 包与 GitHub 源码安装相同的 JS/引擎源码；正常安装仍需 registry 获取依赖。macOS arm64 离线包可以通过现有固定 staging 构建：

```sh
node scripts/pack-release.mjs /absolute/immutable-stage /absolute/new-output
```

输出 `dsh-video-<version>-darwin-arm64.tgz` 与 SHA256SUMS。离线包包含引擎与 JavaScript 依赖，不包含 Node/FFmpeg/Chrome；只发布已验证设备平台。`RELEASE.json` 记录固定源码提交和平台。

获授权后在对应 main 提交创建 `v<version>` Release，上传已验证包、摘要和版本说明；不覆盖同版资产。`release-workflow.yml.example` 是待启用模板，尚未在云端验证；启用需要 GitHub workflow 权限。不要把“模板存在”当成“发布完成”。

## 后续更新

npm 安装在支持版本 API 的 DSH 上使用官方 listVersions/updateBundle。GitHub 安装检查本仓库非草稿、非预发布的最新 Release，并严格匹配平台资产；Release 尚未发布时明确提示。GitHub 源码安装不会自动轮询 main 提交。

后台只检查；安装由用户主动点击。旧 DSH 不支持 npm 更新 API 时，可通过管理器重新安装新版本。本地 link 仅显示开发安装，不联网替换。更新时保留工程数据，导出期间拒绝安装，失败尝试恢复旧来源，不自动重启。
