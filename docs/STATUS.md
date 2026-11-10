# 当前状态

更新：2026-11-10。

## 分支中：设置页音乐模型、追加提示词与选区配乐

`codex/music-model-range-score`（基于 main b901caf）实现并分层验证：

- Host：`host/plugin-settings.js` 页面唯一设置存储（白名单、损坏保留、原子 0600、同步快照）；`audio.js` 动态模型 CRUD/密钥隔离（secrets models 段）、qianwen-sync/qianwen-async 协议、task ID 先持久化后轮询、重启只恢复查询、公网 HTTPS+DNS/重定向/下载围栏；Bridge 新增 `audio.model.*`、`prompt.*`、`audio.check{modelId}`、`audio.generate{modelId,durationFrames}`，全部 UI-only 防护到位。
- 提示词：固定规则移除旧云禁令，追加 `User additional instructions` 块（≤2000 字符），总预算 8000（timeline 固定段实测约 5.4k，原计划 6000 会挤掉选区必需的 facts，已放宽并注释）。
- Client：设置页（音乐模型/系统提示词两页签、不回显 Key）、时间线框选配乐模式、当前选区注册原生 `@`「当前时间范围」+ 复制引用备用；worker 合法空白 range 返回 resolved。
- 本机（Windows）已验证：audio provider 合约（含自定义协议/恢复/SSRF 全绿）、plugin-settings 合约、model-contract 15 项、reference-client 30 项、worker timeline 18 项、smoke-client 86 项、check.mjs 54 通过/4 既有失败（与 main 基线一致）。
- 本机无法验证（引擎 worker 明确拒绝 win32，为既有平台边界）：test-v1-audio-host、timeline-workspace 框选 E2E、audio-creation 严格选区端到端、conversation-chain——需在 macOS/Linux 环境运行后随 PR 评审补证。真实供应商（自定义同步/异步服务）与真实 DSH 端到端配乐上轨未验证，不做已验收声明。

## 1.0.0

功能开发已完成，最后功能通过 PR #33 合入 main（56841bb）。本机仍是此前已验收的 `dsh-video` 1.0.0 / engine 0.9.0 固定 link 包；本轮不替换用户安装或重启 DSH。

已完成：AI 对话生成/续改、自动预览、稳定工程存储、素材导入、多轨剪辑、撤销重做、真实波形、连续缩略图、分离音频、轨道画面/声音控制、带声音 MP4 导出、插件更新入口。

## 仓库与发行整理

- 公开包名调整为 `dsh-video-editor`，避免与他人已占用的 `dsh-video` 混淆。稳定用户数据、UI key 和 API 路由保持不变。
- GitHub/npm 安装带 JS 与引擎源码、固定根依赖；安装无需插件构建脚本。修正引擎对嵌套 node_modules 布局的假设。
- 中英文 README 已精简为产品与使用入口，封面统一为荧光黄/电光蓝撞色风格；另交付知乎与 X 各四张宣传图。安全指南、发布步骤与依赖锁文件保留。
- 历史实验、第三方开发包副本、任务/评审流水与原始证据从当前树移除；整理前固定提交仍保留全部 Git 历史，本机另外保存完整归档。当前 docs 仅保留有效入口与规范。
- Gitleaks 在发布前扫描305个历史提交、当前受控树与最终60文件发行包，均未发现密钥。

## 验证与发行边界

源码门禁58/86/71通过；安装/更新相关15项测试通过；版本门禁10项通过。临时 DSH_HOME 的0.9.9→1.0.0安装、工程revision保留和真实抽帧通过。此为隔离安装/引擎证据，不冒充用户 Desktop 新包验收。

PR #34 已合入 main（3217bff）。GitHub 直接输入仓库首页 URL 安装、创建工程和真实抽帧通过。

npm **dsh-video-editor@1.0.0** 已于2026-10-25公开发布：[npm 包](https://www.npmjs.com/package/dsh-video-editor)。公网 latest 为1.0.0，SHA512完整性与已验证包一致。发布后使用独立缓存，不带版本的 `dsh-video-editor` 包名安装、工程创建和真实抽帧全部通过；初次发布的占位版本不是正式发行内容。GitHub Release 尚未发布。操作见[发行指南](releases/UPDATE-CHANNEL.md)。

## 当前边界

实测平台为 macOS Apple Silicon；Node22+、FFmpeg/ffprobe、Chrome 由系统提供。Windows/Linux/Intel、扬声器听感及真实模型复杂多轮效果未在本轮复验。画布对象直接编辑延期。

开发规则见 [DEVELOPMENT](DEVELOPMENT.md)，交接见 [handoffs](handoffs/README.md)。历史证据见[整理前固定版本](https://github.com/heswy/dsh-video-editor/tree/56841bb60b989aa55aa0ef4897f107a8a66823d1)。
