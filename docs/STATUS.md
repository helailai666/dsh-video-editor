# 当前状态

更新：2026-11-13。

## 本轮（`codex/win32-engine-support`，待 PR）：视频引擎正式支持 Windows

用户实机：Windows 上干净 harness 安装后显示"视频引擎暂时不可用 / The video engine could not start"、新建工程不可用。根因是引擎按 macOS-only 验收（上游 issue #38 的四层阻断）；本轮把 2026-11-07 的一次性安装补丁正式化为源码改动，并顺带修掉一个被平台门禁掩盖的真实契约缺陷。

- 引擎：`worker.mjs` 去掉启动 `POSIX only` 门禁；启动异常不再被吞（stderr 输出真实原因，Host 侧 stderr 环形缓冲可查）；`config.browserPath` 启动时导出为 `CHROME_PATH` 供进程内 puppeteer 使用。`process.mjs` `runOwned` 的 POSIX 逻辑原样保留，win32 走新分支：`taskkill /PID /T /F` 回收整棵进程树，返回形状一致。新模块 `browser.mjs`：按平台探测 Chrome（macOS 原路径不变；win32 扫描 ProgramFiles/ProgramFiles(x86)/LocalAppData 的标准安装位），doctor 在 win32 不 spawn `chrome.exe --version`（会弹窗），改读 chrome.exe 旁版本号目录。`jobs.mjs` 的 `browserExecutable` 在 registry browserPath 失效时回退平台默认（本机旧补丁曾写入过无效的 `Google Chrome\Application` 路径）。`timeline-visuals.mjs` 缩略图 puppeteer 兜底路径同步平台化。
- Host：`bridge.js` prepareRuntime——当解析结果是 `.cmd/.bat`（DSH Desktop 的 `.desktop-bin\node.cmd` shim，Node 不允许 shell:false spawn）时，降级为 Host 自身 Electron 二进制 + 显式注入 `ELECTRON_RUN_AS_NODE=1` 跑 worker；`env.js` 白名单本身不变（继承的 ELECTRON_* 依旧剥除），该例外在注释中写明。
- 真实缺陷（非平台边界）：`protocol.schema.json` 的 `$defs.request.oneOf` 缺 `timeline.beatmap`/`asset.align` 两个分支——PR #12 新方法在 win32 从未跑成集成门禁，解锁后被 schema.test 集成项暴露，已补。
- 测试与门禁同步（均为平台语义，macOS 断言不变）：夹具改用 `dependencyFile` 解析 gsap + `VIDEO_FONT_PATH` 覆盖（与 prepare-fixture.mjs 同一环境变量）；symlink 逃逸、chmod 故障注入、0700 目录位、EPIPE 分离共 6 处加 win32 跳过或平台护栏；packaging.test 版本同步 0.9.0、src 清单补全（beat/browser/timeline-visuals/visuals/dependencies）、npm 调用 win32 shell、路径分隔比较平台中立；scene-template `request_*` 计数 41→44；check.mjs 运行时路径 guard 改为条件豁免（execPath 仅允许出现在 win32+shim 降级分支），并新增专门 check 钉住该门。
- 本机（win32）实测证据：worker 套件 101 pass/0 fail/5 skipped（此前因引擎门禁整体 E_PROCESS_EXIT）；client real.test 全链路绿（doctor→open→inspect→**真实 1280×720 帧 PNG**→render cancel）；探针实测 `platform=win32`、Chrome 157.0.8103.78（版本号目录读取、无弹窗）、ffmpeg/ffprobe 9.0.2；check.mjs 59/0、smoke-client 86/0、model-contract 99 项（contextChars 6109/customChars 7974 不变）、packaging 绿。
- 未验证/下一步：真实整片 mp4 导出需按提交号跑 stage-dev→test-host-engine，并由用户实机复验；真实 DSH Desktop 内 Electron-as-Node spawn 需实机重载插件确认一次；check-host 11 项 symlink EINVAL 为既有基线；audio-host/audio-creation 因引擎解锁推进到下一层平台边界（`E_AUDIO_UNSUPPORTED` 配乐 provider 能力与音轨上限分支），属配乐能力而非视频引擎，列为后续项。

下面两节已合入 main（PR #11、#12）。本轮**未做版本 bump**（main 上 `package.json` 仍为 1.0.3）、**未创建 tag**、npm/GitHub Release 状态不变；两项都只有本机（Windows）语法/契约/纯单测证据，真实长片导出与真实云端配乐闭环尚未在 macOS 复跑。实机通过后，1.0.4 的 bump 与 tag 按当次授权再做。

## 已合入 main（PR #12）：卡点改为可测量（timeline.beatmap + asset.align + 免费本地卡点层）

用户实机反馈：1.0.3 之后云端配乐"风格对，但没踩在剧情卡点上"。原因是整条链路里没有任何节拍测量代码——卡点位置、生成后"命中/漂移几秒"全靠模型读逐秒数组目测，而 StepFun/Suno/MiniMax 连时长字段都不接受，"50% 处的重击"落地秒数天然漂移。本次把节奏变成引擎算出来的事实。

- 引擎新增纯函数模块 `packages/video-engine-worker/src/beat.mjs`（零 IO、可 win32 单测）：16ms 峰值包络上的 energy-flux onset 检测（自适应局部中值阈值 + 0.12s 最小间隔 + 400 上限）、节拍网格估计（0.3–1.5s 间隔众数→BPM/相位/confidence）、画面真实切换帧采集、onset 与 cut 的合并（≤6 帧视为同一硬点）、按窗口的对齐评分（`hitRate/meanErrorFrames/maxErrorFrames` + ≤20 项逐命中漂移）、候选窗口搜索（≤200 个 onset 起点 + 0，tempoLock 时增加 `grid.bpm/song.bpm` 的 0.90–1.12 速度候选）、以及把卡点编译成 `host/audio-synth.js` 可直接接受的 procedural score（kick/bass/riser/whoosh/hat，守 512 事件与 900 事件秒上限，事件不越过 duration）。
- 两个只读引擎方法（协议 0.9.0 原位扩展，不 bump）：`timeline.beatmap{projectId,revision,fromFrame,toFrame}` 返回卡点图与画面网格；`asset.align{projectId,revision,assetId,fromFrame,toFrame,hitFrames?,tempoLock?}` 返回 `best{sourceInFrame,speed,hitRate,drift}`、≤3 候选、`beatLayer.score`（`hitRate<0.8` 才给，本地合成、不计费）与 `warnings`。实现复用已有 peaks-v1 缓存与"≤16 可听片段/60s 解码截止"边界；响应有 48KB 硬护栏（单行 JSONL 超 64KB 会被判协议故障）。`protocol.schema.json` 增 params/request/result 两组并挂进 `x-methods`；README 方法表补两行。
- Host：`bridge.js` 新增 `timeline.beatmap`/`asset.align` 白名单、参数校验（整数帧、≤10800 跨度、`as_[a-f0-9]{8}`、hitFrames ≤256 严格递增且落在区间内、tempoLock 布尔）与门面（先 `timeline.inspect` 取权威 revision 再转发；`asset.align` 结果附一行可直接执行的 `note`：insert 参数、`clip.speed`、卡点层走 `kind sfx provider procedural`）；`tool.js` 暴露两个动作并改写两阶段契约描述——阶段一必须用 beatmap 的真实帧/pct 绑定卡点，阶段二生成后必须 `asset.align` 并按 `best` 上轨、如实报告 hitRate 与漂移帧数。
- 第四份 skill `skills/beat-alignment/SKILL.md`（`audio.guide` 现拼接四份，`package.json`/`stage-dev.mjs` 已收录）：卡点必须来自测量、结构线写成 `<pct%> <音乐动作>（对准 <画面事件> @<frame>帧）` 并把 `grid.bpm` 写进提示词、生成后必须量一次、漂移时叠免费卡点层（并发为 1，须在云歌终态后发起）、多 cue 逐条走 beatmap→generate→align、自检清单与诚实边界（检不到拍时 `grid.bpm:null`，退回 cut 网格并如实说明，不得声称已锁拍）。audio-creation 第 2/3/7 步与配乐库的选窗段同步改为引用这两个方法，不再要求模型目测数组自评。
- 固定指令按预算做了净零改写（新增 beatmap/asset.align 要求同时压缩原句）：`contextChars 6109`（<6500）、含 2000 字符自定义块 `customChars 7974`（≤8000），关键门控短语全部保留。
- 本机（Windows）验证：`test/beat.test.mjs` 13 项（onset/网格/采集/合并/评分/选窗/卡点层，含用桩 `TimelineVisuals` 跑 `beatmapOf`/`alignOf` 的帧算术与"只有漂移才出卡点层"）、`test/jobs-timeout.test.mjs` 4 项、可本机跑的 worker 纯单测 54 项全绿；`schema.test.mjs` 的静态协议覆盖项通过（spawn worker 的集成项仍受 win32 边界限制）；model-contract 全绿（新增白名单逐字一致、worker/schema/README 三处 parity、第四份 skill 关键词、两个门面的行为桩与参数契约；`checks` 计数改为按源文件统计，不再手写）；check.mjs **58/0**、smoke-client **86/0**、audio provider、plugin-settings、stage-version 10/0 全绿；check-host **60 通过/11 失败**（11 项均为本机 symlink EINVAL 平台边界，与基线一致）；`test-v1-audio-host` 与 `test-audio-creation` 在本机因引擎 worker 拒绝 win32 直接 `E_PROCESS_EXIT`（既有平台边界，需 macOS/Linux 补证）。
- 未验证与边界：真实云端模型仍不接受时长字段，本次只保证"选窗/速度/卡点层"这三件事由测量决定；onset 检测基于 8kHz 峰值包络（无频谱通量），氛围型音乐可能检不到拍；`beatLayer` 是合成打击层，不是真鼓组；端到端（beatmap→云生成→align→叠层）与真实导出证据必须由用户 macOS 实机复验，本会话不作已验收声明。

## 已合入 main（PR #11）：长片导出不再在收尾处静默消失

用户实机：1080×1920@30fps、159.8s 整片导出两次都在 `stage: finished / progress 1` 后变成 `timed_out`，全盘搜不到新 mp4、导出目录为空、无日志；换 720×1280 抓帧明显更快。

- 根因（静态定位，非猜测）：`validate` 用 `ffprobe -count_frames` 全帧解码校验产物，预算**写死 15000ms**；4794 帧竖屏必然超时，而 `finally` 无条件删私有临时目录，所以文件"渲染完了但没有"。`stage:"finished"` 只是 finally 的收尾标签，`timed_out` 分支过去不设 `job.error`，因此没有任何原因可见。
- 修复：新增两个纯函数预算 `renderTimeoutMs(frames)=min(6h, max(300s, 120000+240×frames))`（原 `60000+140×frames` 对 1080p 吞吐只有 1.28 倍余量，代码注释自证 20s 合成实测 ~112s≈187ms/帧）与 `validateProbeTimeoutMs(frames)=max(15s, 10000+25×frames)`（按最坏 40 帧/秒解码计数，159.8s → ≈129.9s）；两处 `timed_out` 出口（引擎子进程、计数探测）都写 `error{code:"E_TIMEOUT", stage}`；顶部"15 分钟 ceiling"陈旧注释改为实际公式。
- 客户端两处导出入口统一预算：抽出 `renderBudgetMs(seconds)` + `EXPORT_POST_CAPTURE_SLACK_MS`（抓帧之后还有两遍 loudnorm 与全帧校验）。顶栏此前轮询窗口（13.2 分钟）**小于**它自己请求的引擎 15 分钟，到期即 `cancel` 并追回已发布文件；画布 `exportVideo()` 更是写死 `240×500ms≈120s` 且不传 `timeoutMs`，长片必失败——现在两者共用同一式并带超时后取消。
- `host/config.js` 默认 `maxArtifactBytes` 64MiB → **192MiB**（1080×1920 数分钟成片常见 40–120MB，会撞下载上限；`readArtifact` 仍是全量读入 + SHA256，流式下载列为后续项，上限校验规则本身允许到 256MiB）。
- 本机（Windows）验证（PR #11 当时）：新增 `packages/video-engine-worker/test/jobs-timeout.test.mjs` 4 项（含"计数探测不再写死 15 秒""两处 timed_out 都带 E_TIMEOUT"源文本断言）；worker 纯单测 29 项全绿；model-contract 通过（新增 4 项预算 parity 断言，当时固定指令 contextChars 6092/customChars 7957）；check.mjs **58/0**、smoke-client **86/0**（导出项断言随之改为 300000）、check-host **60 通过/11 失败**（11 项均为本机 symlink EINVAL 平台边界，与基线一致）。`packages/video-engine-worker/test/worker.test.mjs` 在本机因缺少嵌套 `node_modules/gsap` 而 ENOENT，属环境缺失，非本次引入。（PR #12 合入后同一组门禁重跑仍全绿，预算数字变为 6109/7974，见上一节。）
- 未验证：真实长片导出证据必须由用户 macOS 实机复跑（引擎 worker 明确拒绝 win32，见 1.0.1/1.0.2 一节同一边界）；若成片体积超过 192MiB 会返回 `E_ARTIFACT_LIMIT`，届时再决定流式下载。

## 1.0.3：围栏 fake-IP 修复、选区配乐两阶段、整曲窗口对齐与三份配乐 skill

版本 bump 至 **1.0.3**：用户实机测试通过（测试连接、两阶段选区配乐、整曲选窗上轨、卡点结构线）。合入的 PR：#5 围栏+片段摘要、#7 云模型强制+两阶段+配乐库、#8 整曲窗口对齐+突变设计器、#9 卡点结构线。tag `v1.0.3` 在本 bump 合入 main 后创建；npm 通道仍停在 1.0.0，GitHub Release 仍未创建（状态同 1.0.2 一节）。

### 计费提示词强制"卡点结构线"（对准画面事件）

基于 main 1bf1112 建 `codex/prompt-hitpoint-format`，经 PR #9 合入。用户实机反馈：四段 cue 提示词风格正确，但卡点描述停留在音乐内部的模糊词（"中段""缓慢推进"），没有和画面事件绑定。

- 三份 skill 同步强制**卡点结构线**：`<该 cue 长度的百分比位置> <音乐动作>（对准 <画面事件>）`+收尾方式与下一段转场一致。位置只用百分比/段落词（模型遵循相对位置、忽略绝对秒数），但每个卡点必须写明对准哪句台词重音/哪个动作起手/哪次反转/出入画——来自确认表的卡点·转场列。配乐库 Condense 节改为固定五段式模板并给出中英示例；audio-creation 第 3 步要求表卡点列绑具体画面事件（禁"紧张推进"类泛词）、第 7 步窗口选择后逐卡点评分（命中/漂移几秒/是否值得重挑或重生成）；drama-beat-shifts 计费提示词条目同步。
- 纯 skill 文案改动，无代码/上下文预算变化；model-contract 新增 2 项断言（三份 skill 均含卡点结构线、禁绝对秒数），本机全绿；真实提示词质量待实机复测。

### 整曲窗口对齐（asset.envelope + audioProfile assetId 模式）

基于 main 5bbe304 建 `codex/range-window-alignment`，经 PR #8 合入。背景：用户实机确认 StepFun 等云模型无视逐秒提示词与时长请求，返回 3 分半整曲；旧契约 `sourceInFrame:0` 会把静默前奏垫进对白，AI 只能违规用 shell astats 手挑窗口。

- 引擎（随插件捆绑，协议 0.9.0 原位扩展、不 bump 版本）：worker 新方法 `asset.envelope{projectId,assetId}`（`worker.mjs` case + `TimelineVisuals.envelopeOf`），复用 peaks-v1 缓存包络，返回整条素材约 1 秒桶的 peaks/rms/materialPeak；无音频素材 E_PARAMS；60s 解码截止。protocol.schema.json 增 params/request/result 与 oneOf 引用，worker README 补行；schema↔worker↔README 静态 parity 测试本机通过。
- Host：`timeline.audioProfile` 支持 `assetId` 模式（与 fromFrame/toFrame 二选一，validate XOR），`assetAudioCurve` 折叠 >1200 桶并回 curve/rmsCurve/durationSeconds；Tool 描述与参数（assetId 白名单）同步两阶段+窗口选择。
- 指令与 skill：sessions.js Range scoring 行压缩并加入"整曲→audioProfile(assetId)→按已确认表选窗口→sourceInFrame 对齐并如实报告偏移"；audio-creation 选区步骤扩为 10 步（第 7 步窗口选择）；配乐库新增"Reverse alignment"节（提示词写相对结构而非秒数，生成后按包络定位高潮/静默再对齐）。
- 本机（Windows）验证：model-contract 全绿（新增 assetId 校验/互斥/行为桩、worker/schema/README parity 源断言；contextChars 6092、含自定义块 7957 仍在预算内）、check 58/0、smoke 86/0、audio provider、plugin-settings、stage-version 10/0。worker 集成测试 schema.test 的 doctor 响应项在纯 main 同样失败（Windows 平台边界，非本次引入）；asset.envelope 端到端与真实"整曲选窗上轨"待 POSIX/实机复测。
- 追加第三份配套 skill `skills/drama-beat-shifts/SKILL.md`（快节奏AI短剧情绪突变设计器，用户提供规则原文保留）：单集 3~6 次"稳态(≤15s/元素≤2)↔爆发(第一拍即 fff/≥3 项极限手段)"高频硬切、转换点与钩子帧对齐、炸裂转化库表与钩子音效、输出模板与自检清单；新增"落地到本插件真实能力"映射——每个稳态/爆发段=独立 cue 相邻上轨（fade 0~6 帧、空隙表达全体休止）、模板到六列表的取值规则（强度禁 4~7 平铺）、计费提示词只写相对强度词、N 段=N 次计费须在确认表中写明、procedural 兜底反而更可控。`audio.guide` 现拼接三份 skill；package.json/stage-dev/两份测试断言同步。

### 选区配乐两阶段流程（云模型强制 + 逐秒分析 + 确认门控）

基于 main 238b3f0 建 `codex/range-score-cloud-model`，经 PR #7 合入：

- 背景：用户实机发送选区后，AI 被"先本地免费合成、仅明确要求才调云模型"的旧措辞带偏，用 procedural 合成了配乐，未调用设置页配置的云音乐模型。
- `sessions.js`：Audio requests 行补注"选区条发送即显式云请求"；Range scoring 行重写为**两阶段**——阶段一不计费：`timeline.resolve` + 新 `timeline.audioProfile` 逐秒响度曲线 + 一次 frame 抽帧（≤4 帧）+ 一次 read_image，融合片段摘要、对话剧本、视频语言与设置页音乐提示词，输出固定列的精确时间轴表（时间段（秒）/情绪状态/强度(1-10)/配器与音色/动态与音量/卡点·转场）与 ≤2000 字符浓缩器乐提示，展示并**结束回合等待用户确认**；阶段二仅在确认后 `audio.generate kind music WITHOUT provider or score` 走页面配置模型，禁止 procedural 替代（未配置模型或云失败才回落且须如实说明）。为守住 8000 上下文预算，压缩了 Audio requests 行措辞（实测 contextChars 6075、含自定义块 7940）。
- Host 新 Tool 面 `timeline.audioProfile(projectId,fromFrame,toFrame)`（`host/bridge.js`+`host/tool.js`）：只读复用既有 UI-only visuals 波形队列做门面——inspect 找选区内未静音可听片段（≤16 窗，单窗 20s/整体 60s 截止），把每窗 256 个波形峰值折叠为逐秒最大峰值曲线（>600s 自动并桶），返回 curve/sampledClips/note；`timeline.visuals.*` 对 Tool 仍封闭。
- `client.js`：发送到聊天自动附加固定请求句（新 locale key `rangeRequest`，zh/en），`rangeSent` 状态文案同步说明将调用配置的音乐模型。
- 配套 skill `skills/music-scoring-library/SKILL.md`（配乐库）：八类短剧题材（复仇霸总/甜宠/悬疑权谋古风/仙侠玄幻/虐恋/喜剧萌宝/都市职场/历史穿越）的核心情绪、乐器音色、BPM 与设计要点表，指导逐秒表各列取值、响度曲线→强度锚定、卡点对齐片段边界、浓缩云提示词的写法与中→英乐器翻译对照；`audio.guide` 现拼接返回 audio-creation+配乐库两份 skill（audio-creation 的选区小节同步改为两阶段+确认门控）；package.json files 与 stage-dev 清单已收录。
- 本机（Windows）验证：model-contract 扩至 40 项断言（两阶段措辞、audioProfile 参数白名单/校验/行为桩测试：静音轨与无声片段跳过、曲线折叠 [0.2,0.2,0.9,0.9]）、audio provider 合约、plugin-settings、smoke-client 86 项、check.mjs 58/0 全绿；真实对话端到端（逐秒表→确认→云生成）待用户实机复测。

### DNS 围栏放行代理 fake-IP + 选区配乐携带片段摘要

基于 main 450803d 建 `codex/audio-fence-proxy-ip`，经 PR #5 合入：

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
