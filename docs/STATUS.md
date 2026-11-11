# 当前状态

更新：2026-11-11。

## 分支中：选区配乐两阶段流程（云模型强制 + 逐秒分析 + 确认门控）

基于 main 238b3f0 建 `codex/range-score-cloud-model`（PR #7，追加提交中）：

- 背景：用户实机发送选区后，AI 被"先本地免费合成、仅明确要求才调云模型"的旧措辞带偏，用 procedural 合成了配乐，未调用设置页配置的云音乐模型。
- `sessions.js`：Audio requests 行补注"选区条发送即显式云请求"；Range scoring 行重写为**两阶段**——阶段一不计费：`timeline.resolve` + 新 `timeline.audioProfile` 逐秒响度曲线 + 一次 frame 抽帧（≤4 帧）+ 一次 read_image，融合片段摘要、对话剧本、视频语言与设置页音乐提示词，输出固定列的精确时间轴表（时间段（秒）/情绪状态/强度(1-10)/配器与音色/动态与音量/卡点·转场）与 ≤2000 字符浓缩器乐提示，展示并**结束回合等待用户确认**；阶段二仅在确认后 `audio.generate kind music WITHOUT provider or score` 走页面配置模型，禁止 procedural 替代（未配置模型或云失败才回落且须如实说明）。为守住 8000 上下文预算，压缩了 Audio requests 行措辞（实测 contextChars 6075、含自定义块 7940）。
- Host 新 Tool 面 `timeline.audioProfile(projectId,fromFrame,toFrame)`（`host/bridge.js`+`host/tool.js`）：只读复用既有 UI-only visuals 波形队列做门面——inspect 找选区内未静音可听片段（≤16 窗，单窗 20s/整体 60s 截止），把每窗 256 个波形峰值折叠为逐秒最大峰值曲线（>600s 自动并桶），返回 curve/sampledClips/note；`timeline.visuals.*` 对 Tool 仍封闭。
- `client.js`：发送到聊天自动附加固定请求句（新 locale key `rangeRequest`，zh/en），`rangeSent` 状态文案同步说明将调用配置的音乐模型。
- 配套 skill `skills/music-scoring-library/SKILL.md`（配乐库）：八类短剧题材（复仇霸总/甜宠/悬疑权谋古风/仙侠玄幻/虐恋/喜剧萌宝/都市职场/历史穿越）的核心情绪、乐器音色、BPM 与设计要点表，指导逐秒表各列取值、响度曲线→强度锚定、卡点对齐片段边界、浓缩云提示词的写法与中→英乐器翻译对照；`audio.guide` 现拼接返回 audio-creation+配乐库两份 skill（audio-creation 的选区小节同步改为两阶段+确认门控）；package.json files 与 stage-dev 清单已收录。
- 本机（Windows）验证：model-contract 扩至 40 项断言（两阶段措辞、audioProfile 参数白名单/校验/行为桩测试：静音轨与无声片段跳过、曲线折叠 [0.2,0.2,0.9,0.9]）、audio provider 合约、plugin-settings、smoke-client 86 项、check.mjs 58/0 全绿；真实对话端到端（逐秒表→确认→云生成）待用户实机复测。

## 分支中：DNS 围栏放行代理 fake-IP + 选区配乐携带片段摘要

基于 main 450803d 建 `codex/audio-fence-proxy-ip`（待 PR）：

- 围栏修复：用户本机代理拦截 DNS，把四家厂商域名都解析到保留测试段的 fake-IP（`198.18.0.x`/`2001:2::xx`），而 `assertPublicHttps` 对解析结果"任一私网即拒"，测试连接误报"服务地址指向不允许的网络范围"。新增 `isProxyFakeIp`/`isBlockedResolvedIp`：仅对**解析结果**放行 198.18.0.0/15、2001:0002::/48 与 RFC 2917 的 2001:0200::/48；字面量 IP、回环、RFC1918、CGNAT、链路本地、ULA、组播与逐级重定向复验全部保持不变。
- 选区配乐上下文：发送到聊天时在消息尾部附带 `Range content:` 范围内片段摘要（轨道类型、片段名、相对选区起点秒数，上限 14 条）；`sessions.js` 的 Range scoring 固定指令改为要求 AI 撰写器乐提示词时融合该摘要（含画面/旁白语言）、对话中的剧本与语气、设置页音乐提示词配置块（本就追加进上下文），仍使用页面配置的默认音乐模型。
- 本机（Windows）验证：audio provider 合约（新增 fake-IP 解析通过、ULA 仍拦、字面量 198.18 仍拒等断言）、plugin-settings 合约、model-contract 27 项、smoke-client 86 项、check.mjs **58/0** 全绿；audio-host 与 timeline-workspace 框选 E2E 仍受 win32 引擎 worker 边界限制，需 POSIX 补证。

## 1.0.2：厂商音乐模型、暗色回显与选区发送到聊天

`codex/vendor-music-models` 已通过 PR #3 合入 main（eecea43），版本 bump 至 **1.0.2**：

- 配色：设置浮层与框选条原先引用浅色主题 token（`--dsw-bg-container,#fff` 等），在暗色宿主下输入框与下拉弹出成白底。现全部改用面板自身变量 `--dv-panel-line`/`--dv-panel-ink` 的 color-mix 与 `--dsw-alias-bg-base,#1a1a1c` 兜底，`select option` 单独着色，危险按钮改暗色红 `#e57373`。
- 协议：`host/plugin-settings.js` 扩为六种（qianwen-sync/qianwen-async/stepfun/suno-inspiration/suno-custom/minimax），厂商协议带文档默认远端模型（`stepaudio-3-music-preview`/`suno-v6`/`music-3.0`），留空自动回填；设置页下拉切换协议时自动带出官方 Base URL 与模型 ID，并显示该厂商的时长/计费提示（zh/en 各 3 个新 key）。
- 供应商实现（`host/audio.js` CustomMusicProvider）：StepFun 提交+5s 轮询、成功返回 base64 内联音频、`error.stage=censor` 映射内容审核；Suno 灵感/专业分别走 `/api/music/create` 与 `/create/custom`（style_tags 按 1000 UTF-16 单元在分隔符处裁剪），统一使用 `accept_mode=async` 受理回执 + `Idempotency-Key`（复用 operationId），受理号以 `req:` 前缀先持久化，取得真实 song_id 后改写为 `s1,s2` 联合串，完成后下载 `audio_url`（不带 Key）；MiniMax 同步 `/v1/music_generation`，hex 内联解码、`base_resp.status_code` 非 0 视为业务失败。`mapAudioError` 去掉千问专属措辞并补 402/451。
- 计费与围栏：内联音频响应上限 96 MiB、解码后素材 64 MiB；按协议设置轮询下限（StepFun 5s、Suno 2s）与请求超时（厂商 600s、MiniMax 420s）；「测试连接」对无模型列表接口厂商使用不计费 probe（假任务号/受理号 GET/空体 POST，400/404 视为可达，401/403 拒绝）。
- 选区「添加到聊天」原本只复制引用并让用户去输入 `@`，用户实机反馈"点了没用"。查证宿主后确认 **DSH 没有公开的 Composer 草稿写入 API**（插件可见面只有 `inputTriggers.registerSource/sessionOf`，真正插入走内部 `slash/input-insert-*` 事件，属禁止触碰的宿主会话协议/DOM）。按用户选择改为：选区条内新增剧情描述输入 + **发送到聊天**，走 Host 新增的 UI-only `session.send` → 公开 `sessionController.prompt`（mode:queue），消息=精确选区引用 token + 描述，真实进入本作品绑定的会话；`(projectId,requestId)` 去重让丢失的确认可安全重放、不重复插入，失败如实报"状态未知"；空描述禁用按钮；`复制引用` 与 `@` 候选保留为手动路径。Tool 侧仍无任何 `session.*`。
- 本机（Windows）验证：audio provider 合约（含四协议 StepFun/Suno 灵感/Suno 专业/Suno 恢复/MiniMax/probe/围栏）、plugin-settings 合约、model-contract 27 项（含 session.send 受理/去重/映射权威）、reference-client 30 项、worker timeline 18 项、smoke-client 86 项、check.mjs **58/0**（上一节记录的 54/4 是本机文件被转成 CRLF 导致 check.mjs 的 CSS 模板字面量与多行断言失配，行尾恢复 LF 后与 main 基线一致，非代码缺陷）；check-host 11 项失败均为本机 Windows symlink/权限与 realpath 语义所致（与本次改动无关，需 POSIX 补证）。
- 未验证与限制：四家真实供应商端到端未跑（无真实 Key/额度）；StepFun/Suno/MiniMax 均不能按帧精确指定时长，依赖既有严格选区裁剪；MiniMax 文档明示自 2026-08-20 起付费音乐接口不再向新账户开放（已在设置页提示）。
- 发布：`v1.0.2` tag 在本 bump 合入 main 后创建；GitHub 源码安装与"插件更新"检查以该 tag 为准。npm 通道仍停在 1.0.0（1.0.1/1.0.2 未发布，需 npm 登录与 POSIX 安装验证门禁）；GitHub Release 页面仍未确认创建，未创建时应用内"检查更新"读不到资产。

## 1.0.1：GitHub 源码安装通道

设置页音乐模型、追加系统提示词与选区配乐已通过 PR #1 合入 main（c7e8a80）。版本 bump 至 **1.0.1**，安装源统一为 `https://github.com/helailai666/dsh-video-editor`（README、发行指南、插件更新检测 `host/updates.js` 与相关测试同步）。DSH 插件页填该仓库 URL 即可安装/更新；`v1.0.1` tag 在 bump 合入 main 后创建。npm 仍为 1.0.0，1.0.1 的 npm 发布未执行（需 npm 登录与 POSIX 安装验证门禁）。

## 分支中：设置页音乐模型、追加提示词与选区配乐（已合入）

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

开发规则见 [DEVELOPMENT](DEVELOPMENT.md)，交接见 [handoffs](handoffs/README.md)。历史证据见[整理前固定版本](https://github.com/helailai666/dsh-video-editor/tree/56841bb60b989aa55aa0ef4897f107a8a66823d1)。
