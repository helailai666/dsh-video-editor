# 独立视频引擎 worker v1

P1-002 受控 fixture 的独立 Node/ESM 进程。HyperFrames SDK / CLI 固定 0.8.167；不依赖 DSH 根插件，不提供 UI、HTTP 或任意代码执行服务。父进程通过 stdio JSON Lines 调用。

## 启动与复现

从仓库根运行；Node >=22、现有 FFmpeg/ffprobe 和 Chrome/Chromium，当前仅验证 macOS arm64 / POSIX。

```sh
npm ci --prefix packages/video-engine-worker --ignore-scripts --no-audit --no-fund --cache "$PWD/packages/video-engine-worker/.cache/npm"
npm run prepare-fixture --prefix packages/video-engine-worker
node packages/video-engine-worker/src/worker.mjs --registry packages/video-engine-worker/artifacts/registry.json
```

prepare-fixture 会重置本包 artifacts/projects/demo，复制本地 GSAP、MotionPathPlugin 和系统字体。字体默认 `/System/Library/Fonts/STHeiti Medium.ttc`，可用 `VIDEO_FONT_PATH` 指定；启动配置 `browserPath` 可指定 Chrome，prepare-fixture 可读取 `VIDEO_BROWSER_PATH`。默认浏览器路径仅用于当前 macOS 实测，其他机器由父进程明确配置；Node 使用父进程选定的 executable，子进程沿用 `process.execPath`，没有把系统 Node 路径写死为分发契约。

registry 是可信父进程的启动配置，非协议请求：

```json
{"root":"/absolute/controlled/projects","projects":{"demo":"/absolute/controlled/projects/demo"},"outputRoot":"/absolute/worker-output","browserPath":"/absolute/chrome"}
```

仅把本仓库自有 fixture 放入 registry；不注册不可信用户 HTML/JS。project.json：

```json
{"entry":"index.html","assets":["assets/gsap.min.js","assets/MotionPathPlugin.min.js","assets/Heiti.ttc"]}
```

v1 固定 index.html、30fps、H.264；frame 精确时间 PNG。项目根、入口、manifest 和资产使用 realpath 检查，禁止符号链接逃逸、绝对/URL/上级路径；项目内指向内部文件的链接允许。快照只复制入口与声明资产的字节，不复制历史、缓存、node_modules 或原工程产物。SDK 字体不入 Git。

## 协议

每行一个 UTF-8 JSON 对象，行长/响应均 <=65536 bytes（不含换行）；顶层及 params 拒绝额外字段。id 为非空字符串 <=128 字符，整个 worker 生命周期不得重复。坏 JSON/超长行的响应 id=null；超长行丢弃到换行后继续。错误统一 `{code,message,stage}`，不回传磁盘路径、源码或原始引擎日志。

```json
{"v":1,"id":"a1","method":"doctor","params":{}}
{"v":1,"id":"a1","ok":true,"result":{"node":"v24.14.0","hyperframes":"0.8.167"}}
{"v":1,"id":"a2","method":"open","params":{"projectId":"demo"}}
{"v":1,"id":"a2","ok":true,"result":{"projectId":"demo","revision":"<64 lowercase hex>","elements":[]}}
{"v":1,"id":"a3","method":"edit","params":{"projectId":"demo","expectedRevision":"<revision>","operationId":"edit-title-1","ops":[{"type":"text","target":"hf-title","text":"每一帧，都可编辑"},{"type":"timing","target":"hf-title","start":1,"duration":3}]}}
{"v":1,"id":"a4","method":"render","params":{"projectId":"demo","revision":"<saved revision>","timeoutMs":120000}}
{"v":1,"id":"a5","method":"status","params":{"jobId":"<returned jobId>"}}
{"v":1,"id":"a6","method":"cancel","params":{"jobId":"<returned jobId>"}}
{"v":1,"id":"a7","method":"shutdown","params":{}}
```

以上响应是字段节选，尖括号需替换成实际值。`protocol.schema.json` 是 v1 请求/响应契约（draft 2020-12，`$id` 稳定）：每个方法的 params 与 result 结构都列入 `$defs`，顶层 `x-methods` 方法表把方法名映射到 request/result 定义（响应 envelope 本身不带 method，无法单独定位）。未来 Host 父进程需持续读 stdout、独立生成 request id、按 id 对应响应，不假定响应顺序。

| 方法 | params | result |
|---|---|---|
| `doctor` | {} | 启动时实际 Node/SDK/CLI/GSAP、Chrome、FFmpeg/ffprobe 版本；缺工具显示 unavailable |
| `open` | projectId | 已注册工程的 inspect；未知映射拒绝，无 path/URL 参数 |
| `inspect` | projectId | revision、尺寸、时长、stableId、文本、原生 timing、规范化 layout/style、capabilities、路径/字节/hash 清单 |
| `edit` | projectId, expectedRevision, operationId, ops | 保存/读回成功后的 revision；ops 支持 text/timing/layout/style，最多32项（P3-006-B） |
| `project.compose` | projectId, expectedRevision, operationId, html | 校验并原子发布整份 HTML 合成（创建与后续每次修改同一路径）；返回 publishedRevision、尺寸/时长、文件清单与 snapshot 证明，见下文 P3-012 |
| `project.source` | projectId | 读取当前 `index.html` 全文、revision 与声明资产；入口 >48 KiB 或 JSON 转义后 >60 KiB 返回 `E_LIMIT`，见下文 P3-012 |
| `frame` | projectId, revision, time, timeoutMs? | 立即返回异步 PNG job；time 位于 [0,duration−1/30] |
| `render` | projectId, revision, timeoutMs? | 立即返回异步 MP4 job，queued；不等待渲染完成 |
| `status` | jobId | 当前状态、阶段、进度、projectId/revision/jobId、工具版本；成功时 artifact |
| `cancel` | jobId | 非终态立即 ack cancelling；终态幂等返回；清理完成才 cancelled |
| `close` | projectId | 同步关闭该工程的准入门，再取消/排空旧生命周期任务和编辑，最后释放 handle 与私有预览快照；并发重复 close 共同等待同一排空 |
| `shutdown` | {} | 取消/排空全部任务、写队列，清理私有预览快照，响应后退出 |
| `preview.snapshot` | projectId, revision, ttlMs? | 为已 open 工程的当前 revision 建立只读私有快照，见下文 P3-004 |
| `preview.release` | snapshotId | 删除指定私有快照，见下文 P3-004 |

frame/render 后台通过同一工程队列取得快照。若源已变化，作业 failed + E_REVISION_CONFLICT，不能取最新文件冒充旧 revision。状态 queued→running→succeeded/failed/timed_out，或 queued/running→cancelling→cancelled。frame 超过实际场景末尾在快照阶段 failed + E_PARAMS；请求本身的负数、类型等立即返回错误。所有长作业有 100–120000ms deadline（默认120000）；范围检查、快照复制和文件哈希由受控大小限制，CLI deadline 从启动上游 CLI 开始。

close 进入 worker 后、第一次等待排空前，立即把 projectId 标为 closing。这个状态拒绝新的 open、inspect、edit、frame 和 render，返回 E_PROJECT_CLOSING；status/cancel 仍可读取和管理旧 job。已经获准的编辑按工程队列完成，已经获准的 frame/render 由 close 取消并清理。重复 close 共同等待该次排空，close 成功后 projectId 变为 closed，新的 open 才能建立下一生命周期。这样 close 成功时旧生命周期没有活动作业或私有目录，也不会在关闭后发布产物。

stdout 仅协议，CLI stdout/stderr 通过管道捕获，不转发。捕获尾部最多64KiB；worker stderr 总量最多16KiB，仅固定阶段说明，既不写源码也不写凭据或路径。每进程最多10000个请求id、2048个成功 operationId、256个作业（最多4个活动），达到上限拒绝；父进程负责持续消费 stdout。

## 内容与修订

revision = SHA-256(JSON.stringify({entry,files}))；files 按声明相对路径排序，每项 `{path,bytes,sha256}`，sha256 对原始文件字节计算。manifest 的 entry 和声明资产集合影响 revision；manifest 排版、资产声明次序、未声明文件、.hf-versions/.hyperframes/产物均不进入清单。动态依赖发现不在 v1 范围，受控 fixture 必须声明所有本地依赖。

inspect 读取真实 data-duration，缺省才用 SDK 快照 duration（可能 null），不伪造0。capabilities 是当前实际可编辑范围：叶级 HTML 文本，已有显式 timing 的非 composition 元素。编辑单写者队列串行；两个不同 operationId 竞争相同 expectedRevision，只能一个保存。完整 batch 按顺序累计校验 timing，防止组合后越过场景末尾。SDK fs adapter 执行 batch、persist:error 监听、flush、磁盘 readback 全部成功后才发布 revision。

operationId 以 projectId 为作用域：同一规范化请求（JSON 对象键顺序无关，ops 数组顺序保留）返回首次成功结果而不再次写盘；不同内容拒绝 E_OPERATION_REUSED；失败操作不缓存。重试返回的是原结果，不代表当前工程仍处于该 revision。幂等表仅本进程内存，重启后由 expectedRevision 拦截过期修改；跨进程持久 operation journal 留给 Host 集成。

外部文件变化在编辑前重读两次与 revision 比较；私有快照保存已计算清单的字节，再核对源 revision，后续编辑/资产变化不影响已取得的快照。worker 内只有一条写队列；不声称能对不配合的外部写者提供跨文件原子 CAS，正式 Host 必须拥有唯一写入入口，外部编辑通过版本冲突/重新 open 协调。SDK adapter 如果写入后版本历史失败，不能把该错误视作成功；本轮验证真实目录无写权限失败且入口保持原样，其他存储故障恢复待扩展。

## 作业与清理

每次 CLI 只访问自己的私有快照与 tmp；使用固定参数数组，无 shell 命令拼接。进程跟踪沿用 P1 经验，覆盖 detached Chromium/helper，发信号前核对 PID、启动时间、命令，仅清理拥有的进程；TERM 宽限1.4秒后 KILL，确认清零后删除私有目录。不使用全局 kill-all。取消/超时不会发布半成品，成功产物使用独立 jobId 文件名，不覆盖已有成功文件。MP4 必须经 ffprobe -count_frames 核验 H.264、尺寸、30fps、帧数和时长（<=1帧容差），PNG 验证签名与尺寸，之后才发布 metadata/hash。

stdin EOF、shutdown、SIGINT/SIGTERM、未捕获异常路径均尝试排空并清理。EOF 和信号是真实行为测试；无法在 SIGKILL 或机器断电后执行用户态清理，P2 需父进程监督与重启恢复策略。采样式进程跟踪、路径 confinement 和独立进程均不是安全沙箱，不允许扩大到任意 Agent 生成代码。

错误码：E_JSON/E_LINE_LIMIT/E_OUTPUT_LIMIT/E_VERSION/E_DUPLICATE_ID/E_METHOD/E_PARAMS/E_LIMIT/E_OVERRIDE_CONFLICT、E_PROJECT_NOT_FOUND/E_PROJECT_NOT_OPEN/E_PROJECT_CLOSING/E_PROJECT/E_PATH/E_ASSET_MISSING、E_REVISION_CONFLICT/E_OPERATION_REUSED/E_UNSUPPORTED_EDIT/E_PERSIST/E_COMPOSE_INVALID、E_JOB_NOT_FOUND/E_SHUTDOWN/E_SNAPSHOT/E_SNAPSHOT_NOT_FOUND/E_RENDER/E_METADATA/E_CLEANUP/E_INTERNAL。状态 failed 的 error 有 stage；cancelled/timed_out 为明确终态。

## 测试与证据

```sh
npm test --prefix packages/video-engine-worker
npm run test:real --prefix packages/video-engine-worker
```

测试父进程实际启动 worker，非内存 SDK/CLI mock。覆盖协议纯净、坏JSON/重复id/行和响应大小、参数边界、竞争编辑、跨 handle 重开、资产/外部入口变化、重复 operationId、真实 SDK 保存失败、符号链接越界、合并 timing 越界；真实抽帧、H.264导出、渲染期间改源仍保持旧快照、取消/超时/EOF/shutdown/SIGTERM 清理且无关 sentinel 存活。真实产物 artifacts/worker.mp4 与 worker.png，元数据 artifacts/evidence/；可提交摘要在 evidence/，不提交字体、媒体、node_modules 或缓存。研究报告见 ../../docs/research/P1-002-engine-worker.md。

## P3-003：多 Scene 工程、修订合并与历史（0.2.0）

v1 模板 `product-launch-v1` 生成单 `index.html` 权威工程：`#main[data-composition-id]` 下每个 Scene 一个 `<section data-scene-id data-scene-order data-start data-duration>`，元素 `data-hf-id="<sceneId>-<elementId>"`，master GSAP timeline 按全局时间控制可见性与入场动画；Scene 局部时间在生成时换算为全局 `data-start`。模板约束 1–12 个 Scene、单 Scene 0.5–60s、总时长 ≤3600s；生成后由 SDK 重开校验，写入使用临时文件 + rename，失败不发布。

worker 新配置模式（管理工程，Host 不直接改这些文件）：

```json
{
  "projectsRoot": "/absolute/managed/projects",
  "registryPath": "/absolute/managed/registry.json",
  "outputRoot": "/absolute/worker-output",
  "assetInboxRoot": "/absolute/read-only/images"
}
```

`registry.json` 由 worker 原子维护（`{"projects":{"<projectId>":"<absolute dir>"}}`，启动时 reload；路径必须 realpath 在 `projectsRoot` 内）。旧的 `{root,projects,outputRoot}` 静态模式继续支持 P2 行为。

新增方法（JSONL v1，参数与错误见 `src/worker.mjs`/`src/projects.mjs`）：

| 方法 | 说明 |
|---|---|
| `project.create` | `{templateId,title?,width?,height?,fps?,assets?:[{inboxName,name?,mediaType?}]}`；worker 生成 projectId、复制模板与素材、原子更新 registry，返回 revision/scenes；`title` 同时作为 `project.json` 的可选显示标题 |
| `project.rename` | `{projectId,title}`；P3-016 UI-only 显示标题更新（trim 后 1..120 字符），原子写 `project.json` 并保留 entry/assets；不改 composition/revision/历史 |
| `asset.import` | `{projectId,expectedRevision,operationId,sourceName,name?,mediaType?}`；只读 inbox 导入 PNG/JPEG，校验路径/签名/限额后原子复制并更新 manifest |
| `scene.create` / `scene.update` / `scene.remove` / `scene.reorder` | 以 expectedRevision + operationId 做单写者、幂等操作；Scene 模型 → 重新生成整份 HTML + timeline → SDK 校验 → 原子写 → revision 重算；校验失败不发布 |
| `project.revise` | `{projectId,baseRevision,expectedRevision,operationId,sceneId,template}`；base 无人工改动时直接写入；否则从历史快照取 base 做 stableId 三方合并，冲突返回 `{written:false, conflicts:[{sceneId,stableId,reason,human,ai}]}` 且不写盘 |
| `history` / `undo` / `redo` | `.dsh-video/history/` 保存 entries/ops/snapshots/state；单调 historyCursor，revision 仍是内容哈希；重启后可继续 undo/redo |

`inspect` / `open` 只新增字段：`scenes:[{sceneId,order,start,duration,elements:[{stableId,sceneId,text,timing,capabilities}]}]`，原有字段不变；P3-016 起再新增可空 `title`（`project.json` 显示标题，旧工程为 `null`）。

素材限额：仅 PNG/JPEG，单文件 ≤8 MiB，每工程 ≤16 张图片资产、声明资产总量 ≤64 MiB。历史保留最近 64 条/快照 ≤8 MiB。v1 仍只支持受控模板生成，不接受任意 Agent HTML/JS。

## P3-004：协议 schema 补齐与预览快照（0.2.1）

本版两包升 **0.2.1**：新增编辑器画布所需的只读预览快照，并把 `protocol.schema.json` 从 P2 方法集补齐为全部 v1 方法（严格 keys/类型/范围，与 worker 校验一致）。除下文列出的三处参数校验收紧外，0.2.0 已实现方法的成功结果与编辑/历史语义保持不变。

### 协议 schema（R1）

- 覆盖 `doctor/open/inspect/edit/frame/render/status/cancel/close/shutdown` 与 `project.create/asset.import/scene.*/project.revise/history/undo/redo/preview.*` 共 22 个方法。
- 请求 params 使用 `additionalProperties:false` + `required`，范围与 `src/worker.mjs`/`src/projects.mjs` 校验一致（例如 `width`/`height` 为整数、`order` 唯一、`ttlMs` 为 100–1800000 的整数）。
- 顺带消除三处 schema 与校验的隐藏漂移：`project.create.templateId` 现在必填且只接受受控模板（未知值 `E_TEMPLATE`）；`width`/`height` 必须为整数；`scene.update`/`project.revise` 的嵌套 template 不允许再携带 `sceneId`（此前会被静默忽略，现在返回 `E_PARAMS`；`scene.create` 仍可指定）。
- 响应 envelope 保持严格；`x-methods` 把每个方法映射到对应 request/result 定义，测试据此校验真实响应（响应帧不带 method）。
- schema 负责参数的**结构/keys/类型/范围与路径、名称形态**（revision/snapshotId pattern、相对路径、inbox 文件名、图片资产名）；依赖磁盘或引用文件状态的检查（inbox 是否存在、图片签名、资产重复、内容大小、revision 是否当前）仍由 worker 语义校验，schema-valid 请求仍可能得到 `E_ASSET_MISSING`/`E_PARAMS`/`E_REVISION_CONFLICT`/`E_LIMIT`。
- `test/schema.test.mjs` 强制 schema 方法集 == worker switch 方法集、schema 引用的每个 `$ref` 可解析、README 方法表与 schema 同步；并对每个方法做“缺失必填字段/多传字段”双向探针，同时校验真实调用结果。

### preview.snapshot / preview.release

```json
{"v":1,"id":"p1","method":"preview.snapshot","params":{"projectId":"proj-...","revision":"<64 hex>","ttlMs":60000}}
{"v":1,"id":"p1","ok":true,"result":{"snapshotId":"<32 hex>","projectId":"proj-...","revision":"<64 hex>","entry":"index.html","files":[{"path":"index.html","bytes":1785,"sha256":"<64 hex>"}],"expiresAt":"2026-10-17T15:48:25.635Z","maxBytes":134217728}}
{"v":1,"id":"p2","method":"preview.release","params":{"snapshotId":"<32 hex>"}}
{"v":1,"id":"p2","ok":true,"result":{"snapshotId":"<32 hex>","projectId":"proj-...","revision":"<64 hex>","released":true}}
```

- **只对已 open 工程**；`revision` 必须等于当前 revision，过期/竞争返回 `E_REVISION_CONFLICT`（worker 不猜最新）。请求期间工程再次变化也会拒绝并删除半成品。
- worker 只把 `project.json` 声明的 entry + 资产复制到 **`outputRoot/previews/<snapshotId>/`**；`snapshotId` 为 32 位小写 hex（128-bit 随机），不可预测。复制后逐文件重读磁盘，核对字节数/`sha256`/原始字节与 `read()` 清单，全部一致才发布快照。
- 返回**仅相对路径**（`files[].path`），不含绝对路径或 URL；Host 只按 snapshotId + 相对路径读取，不向预览面传任意 path/URL。
- 限额：文件数沿用 manifest 上限（entry + ≤64 资产），快照总字节 ≤128 MiB；超限 `E_LIMIT`。快照只读，不进入 revision/历史，不能用于 edit/revise。
- TTL：默认 10 分钟，上限 30 分钟，最小 100 ms（测试/短会话）；`ttlMs` 必须是整数。到期后由 worker 清理，`preview.release` 对未知或过期 snapshotId 返回 `E_SNAPSHOT_NOT_FOUND`（重复 release 不会重复删除，返回同一错误码）。
- 生命周期：`close` 清理该工程全部快照；`shutdown`/stdin EOF/SIGINT/SIGTERM/未捕获异常路径清理全部快照；worker 启动时丢弃上一进程遗留的整个 `previews/` 私有目录。清理失败不发布半成品、只记固定阶段诊断（stderr 不写路径或内容）。
- 未来 Host 是唯一读取者；本 worker 没有预览内容读取或执行新方法，快照也不是安全沙箱。

## P3-006-B：布局/样式持久化（0.3.1）

两包升 **0.3.1**（P3-006-B 交付 0.3.0，BUG-001 渲染黑带修复升至 0.3.1）；JSONL 协议仍为 v1，原有方法/结果与 P2/P3-003/P3-004 语义保持。统一 `edit.ops` 新增两类受控操作，无需新方法：

```json
{"type":"layout","target":"scene-1-title","unit":"composition-px","box":{"left":120,"top":240}}
{"type":"layout","target":"scene-1-shot","unit":"composition-px","box":{"width":600,"height":320}}
{"type":"style","target":"scene-1-title","styles":{"color":"#ff0000","fontSize":48,"fontWeight":600,"textAlign":"center"}}
```

### 取值与能力

- `layout.box` 是非空 patch，仅 `left/top/width/height`，有限数字；单位固定 `composition-px`。以 Scene 静态布局基座（全幅 composition CSS px）为准，**不是**动画帧 `getBoundingClientRect`，不写 `transform`。数字按 1/1000 px 规范化；`left/top ≥ 0`，`width/height ≥ 1px` 且不超过画布；已知宽高时校验 `left+width`/`top+height` 不越界（auto 尺寸不伪造）。
- `style.styles` 是非空受控 patch：`color`（#RRGGBB，存小写）、`fontSize`（8–256，px）、`fontWeight`（100–900 的 100 整数倍）、`textAlign`（left/center/right）。拒绝未知键、任意 CSS 字符串、url/expression/脚本、transform/animation/zIndex；字体族/旋转/多选/层级暂不支持。
- 能力按受控模板叶子判定：`sceneId-title/subtitle/badge/rule/logo/shot` 且 tag 匹配、父节点必须是该 Scene section。`layout` 覆盖文字/图片/线；`style` 仅文字类（title/subtitle/badge）。root/section/未知/嵌套元素返回 `E_UNSUPPORTED_EDIT`；旧 P2 fixture 无 layout/style 能力，旧 text/timing 路径不变。
- `inspect` 的元素额外返回 `layout` 与 `style`（不支持为 `null`；auto 尺寸/未设置属性为 `null`，不伪装计算矩形），`capabilities` 追加 `layout`/`style`；`scenes[].elements` 同步。client 保持通透，无新方法。
- layout/style 与 text/timing 可同一原子批次；整批先校验后一次写入，任一非法不写盘。operationId 幂等、expectedRevision 冲突、单写者队列不变。

### 单一权威与重生成

- **工程 HTML 的 inline style 是唯一真相**：不引入第二份覆盖数据库或隐藏元数据；revision 覆盖 HTML 字节，history 快照、preview snapshot、frame/render 均直接反映写入结果。
- 显式覆盖用受控属性 **`data-dv-managed="left top color ..."`** 记录“由 edit op 显式设置的受管属性”：即使值恰好等于当前模板默认，也仍视为人工选择，后续 Scene 级默认值变化（如 accent 改变）不会静默改写或删除；重生成时该标记随元素迁移。该属性是单 HTML 内的受控表示，不是协议字段，也不是用户 API。
- **标记与差量取并集**：无 marker 的文件（外部手改/旧数据）按“与当前模板默认值的差异”识别；一旦某元素因首次 typed edit 获得 marker，其它已有可表达差量仍同时按差异识别，不会因为新增 marker 而丢失（R2）。因此“无 marker 布局 → typed style → 重生成”和反向“无 marker 样式 → typed layout → 重生成”都保留旧差量。
- **旧 base 三方合并保护显式声明**：字段的显式覆盖“是否存在/何时新增”参与合并与删除保护。base 之后新增的显式覆盖即使值等于模板默认也是人工意图：AI 仅改 Scene 默认值时保留人工字段、其它默认照常更新；AI 删除该对象返回 `AI_DELETE_HUMAN_MODIFY`；同字段双改仍 `BOTH_MODIFIED`（R1）。无变化 AI 候选不会误冲突。
- `scene.create/update/reorder/remove` 与 `project.revise` 重生成文档时，会把当前文档中相对模板默认值的**人工 layout/style 差量**移植到保留 stableId 上（不丢人工位置/字号）；重排保持覆盖归属 stableId。
- `scene.update` 若模板删除了带人工 layout/style 的对象 → `E_OVERRIDE_CONFLICT`（不静默恢复模板默认）；`scene.remove` 是显式整 Scene 删除，允许执行并在 `changeSummary.droppedOverrides` 报告影响。
- `project.revise` 三方合并按 **text / timing.start / timing.duration / attributes / class / layout.* / style.* / 其余 inline style** 逐字段比较：人工改位置/样式而 AI 只改文案时可合并、两者都保留；相同字段两边改不同 → `written:false + conflicts[{field,human,ai,humanValue,aiValue}]`；AI 候选删除人工改过或 base 已有人工覆盖的对象 → `AI_DELETE_HUMAN_MODIFY`。其它 Scene 保持逐字节不变。
- layout/style 不修改 GSAP timeline：inline left/top/宽高是静态基座，动画 `y/scaleX/opacity` 继续相对运行；场景时序重生成仍按原规则改 timeline。不支持清除覆盖（无 null 语义）、删除单个元素、字体族/旋转/层级；`scene.*` 重生成仍会重置元素级 timing（沿用既有行为，本轮不扩展）。

## BUG-001：导出底部黑带修复（0.3.1）

- 现象：受控模板 1280×720 MP4 底部 86 行（y=634–719）为黑，worker 同 revision/时刻抽帧完整。
- 根因（上游 HyperFrames 0.8.167，不改 node_modules）：render 的 static-frame dedup 会创建第二个验证页；该页关闭后主捕获页静默丢失 `page.setViewport(1280,720)` 的 device-metrics override，`window.innerHeight` 降为 633（真实 headless 窗口内容高度），而 `captureBeyondViewport` 已被“内容适配”降为 false，CDP 只绘制视口内 633 行，底部 87 行留黑。
- 本项目可控适配：worker 对 render job 设置 `HF_STATIC_DEDUP=false`（仅渲染；frame/snapshot 路径不变），避免第二验证页，保持同一 revision/HTML、完整 720p 构图，不裁切/不拉伸/不补色。代价是长静帧渲染失去该去重优化（实测 5s 单场景 render 约 +1–2s；11s 工程仍在 120s 默认超时内）。上游修复后可移除。
- 回归：`test/render-band.integration.mjs` 覆盖 baseline、人工布局（底部 logo 证明 y>560 内容存在）与 960×720 4:3 静态工程，各两个时刻解码 MP4 帧与同 revision worker frame 对照，并断言底部无黑带、场景背景到底、整帧差异在编码容差内。

## P3-009：完整 Scene 读取契约 scene.template（0.3.2）

两包升 **0.3.2**；JSONL v1、22 个方法、旧字段与写入/重生成/合并/黑带语义均不变。所有 **Scene summary**（`inspect`/`open`、`project.create`、`scene.create/update/remove/reorder`、`project.revise` 成功结果）新增只读字段 **`template`**：

```json
{
  "sceneId": "scene-1",
  "order": 0,
  "start": 0,
  "duration": 5,
  "title": "完整字段场景",
  "template": {
    "title": "完整字段场景",
    "duration": 5,
    "subtitle": "副标题",
    "badge": "BADGE",
    "color": "#123456",
    "accent": "#abcdef",
    "logo": "assets/logo.png",
    "shot": "assets/shot.png"
  }
}
```

- `template` 从当前权威 HTML 的受控解析模型生成，形状冻结为 `{title,duration,subtitle?,badge?,color?,accent?,logo?,shot?}`，**可直接作为 `scene.update.template`（及 `project.revise.template`）输入**；不再包含 `sceneId/order/start/elements`、目录或绝对路径。
- 颜色/资产路径取当前工程真实值；文本包含人工 text 修改；只改色/换素材时，前端复制当次 `inspect` 的 `template` 再修改目标字段即可保留 subtitle/badge/accent/logo/shot 等其它字段，不需要解析 HTML 或维护第二份真相。
- 可选字段只在当前文档确实存在时出现（subtitle/logo/shot 等不虚构；受控模板的空 badge 元素返回 `badge:""`）。`scene.update` 仍是完整替换语义，**未改成 partial patch**；未设置/清空字段的既有规则不变。无变化提交仍按既有 `E_INTERNAL` 守卫拒绝。
- 为保证投影始终可往返，Scene 文本字段上限与既有 text edit 边界对齐：title/subtitle/badge 的模板输入/投影上限为 **2048** 字符（原有更短值请求不受影响）；title 是必填模板字段，空/纯空白 title 的 `edit {type:'text'}` 返回 `E_PARAMS`，避免产生无法回写的工程状态。其它元素的 text/timing 行为不变。
- 旧 P2 legacy 单 composition 仍返回 `scenes: []`；schema 的 `sceneSummary`/`inspectScene` 均要求 `template`，方法集与 v1 协议不变。

## P3-012：完整合成发布与读取 project.compose / project.source（0.4.0）

两包升 **0.4.0**；JSONL v1 与既有 22 个方法语义不变，新增 2 个方法（共 24 个）。这是“对话生成/续改 + 左侧自动预览”路径的唯一写入入口：Agent 先读当前完整 HTML（`project.source`），生成新的完整文档后一次提交（`project.compose`），worker 校验通过才原子替换 `index.html`。

```json
{"v":1,"id":"c1","method":"project.source","params":{"projectId":"proj-..."}}
{"v":1,"id":"c1","ok":true,"result":{"projectId":"proj-...","revision":"<64 hex>","entry":"index.html","bytes":653,"assets":["assets/gsap.min.js"],"html":"<!doctype html>..."}}
{"v":1,"id":"c2","method":"project.compose","params":{"projectId":"proj-...","expectedRevision":"<64 hex>","operationId":"compose-1","html":"<!doctype html>..."}}
```

`project.compose` 结果（`scenes: []` 是拒绝隐式的合成模式标记；字段固定，供 Host prompt facts 使用）：

```json
{
  "projectId": "proj-...",
  "revision": "<new 64 hex>",
  "publishedRevision": "<same new 64 hex>",
  "written": true,
  "unchanged": false,
  "scenes": [],
  "entry": "index.html",
  "width": 1280,
  "height": 720,
  "duration": 5,
  "bytes": 653,
  "assets": ["assets/gsap.min.js"],
  "elements": [{"stableId": "hf-abcd", "capabilities": ["text"]}],
  "files": [{"path": "assets/gsap.min.js", "bytes": 72927, "sha256": "<64 hex>"}, {"path": "index.html", "bytes": 653, "sha256": "<64 hex>"}],
  "preview": {"mode": "snapshot", "status": "ready", "checked": "composition+snapshot", "revision": "<new 64 hex>"},
  "history": {"status": "recorded", "historyCursor": 2}
}
```

`history` 发布结算字段（见下文“发布结算”）：
- `{"status":"recorded","historyCursor":<int>}`：历史条目已写入；
- `{"status":"degraded","code":"E_HISTORY"}`：作品已权威提交（入口字节 + 回读 + 快照证明），但历史阶段失败，结果仍为成功并带真实 `publishedRevision`；失败细节只进受限 diagnostic；
- `{"status":"unchanged"}`：与当前入口字节相同，未发生历史写入。

### 合成契约（发布前校验，任一不满足返回 E_COMPOSE_INVALID 且不写盘）

1. UTF-8 1..49152 字节（48 KiB），不含 NUL；`MAX_COMPOSITION_BYTES = 48 * 1024`。同时 `JSON.stringify(html)` 的 UTF-8 转义字节数必须 ≤ **61440（60 KiB，`MAX_COMPOSITION_ESCAPED_BYTES`）**：文档在 JSONL 里是一个 JSON 字符串，引号/反斜杠/控制字符会成倍增加行长度，超限返回 `E_COMPOSE_INVALID`（消息含原始字节、转义字节与上限），避免一行超过 64 KiB 而丢失请求/响应。
2. 完整文档：可选 BOM/空白后以 `<!doctype html`（大小写不敏感）或 `<html` 开始，且包含 `</html>`。
3. 恰好一个 `id="main"` 元素，带非空 `data-composition-id` 与数值 `data-width`（320..3840）、`data-height`（180..2160）、`data-duration`（0.1..3600）。
4. 必须由**内联 `<script>` 体**里的赋值暴露预览 timeline：`window.__timelines = { main: <gsap timeline> }`（也接受 `window["__timelines"]`）；带 `src=` 的 script、HTML 注释、属性文本里的同名字符串都不算；`main: null`/`main: undefined` 这类明显占位映射被拒绝，缺失/占位时给出可操作错误。**该静态检查是必要条件而非充分条件**：是否真的能播放由固定预览运行时证明，脚本从不赋真实 timeline 会在预览侧表现为可恢复错误，而不是 compose 失败。
5. 拒绝 `<iframe>/<object>/<embed>/<base>/<link>/<video>/<audio>/<source>/<track>`，以及 `src=`/`href=`/CSS `url(...)` 中的 `http:`/`https:`/`//`/`file:`/`blob:`/`javascript:`。`xmlns="http://www.w3.org/2000/svg"` 是命名空间不是 fetch，允许；`url(#fragment)` 同文档引用也允许。
6. `src=`/`href=`/`url(...)` 的本地引用（去掉前导 `./`）必须是 `project.json` 已声明资产（通常 `assets/gsap.min.js`）；引用 `index.html`、未声明文件、绝对路径或 `..` 被拒绝，错误信息列出当前声明资产。
7. SDK 校验与 inspect 一致：`openComposition(html)` 可打开，`buildDocument(comp.serialize())` 的 width/height/duration 有限且在范围内；始终 `comp.dispose()`。
8. 与当前入口字节完全相同时不写盘，返回 `unchanged: true` 且 revision 不变（仍做一次 snapshot 证明，绝不写盘）。

### 原子性、幂等与 preview 证明

- `expectedRevision` 不是当前 revision → `E_REVISION_CONFLICT`（stage `compose`），不写。参数结构/类型错误 → `E_PARAMS`；契约校验失败 → `E_COMPOSE_INVALID`（stage `compose`）。三者都在写盘前发生。
- operationId 与 `edit` 相同的单写者队列 + 内存幂等：同 projectId 下同一规范化请求返回首次成功结果，不重复写盘；相同 operationId 不同内容 → `E_OPERATION_REUSED`；失败不缓存。
- 写入路径：`atomicWrite(index.html)` → `read()` 逐字节读回核对；不一致或读取失败则用 `atomicWrite` 恢复旧字节并返回 `E_PERSIST`（stage `persist`）；恢复也失败时错误带 `uncertain: true`。
- 发布后立即通过既有 `Previews.create` 建立新 revision 的私有快照（TTL 单独用 60s），确认入口文件在快照清单内后 `discard`；失败则恢复旧字节并返回 `E_PERSIST`。`preview.status: "ready"` 只表示“契约校验通过 + 该 revision 可通过既有快照路由服务”，不声称浏览器已播放。

### 发布结算（权威 commit 点与历史降级）

- **权威 commit 点 = 入口 `atomicWrite` + 逐字节 `read()` 回读 + 新 revision 的 preview snapshot 证明。** 这三步之后作品已确认发布；历史写入是辅助审计，不允许把已发布的新 revision 作为普通失败返回。
- 历史写入（`recordWrite`：快照/entries/ops/state）抽成实例方法 `recordComposeHistory`，包裹结算：成功 → `history:{status:"recorded",historyCursor}`；任意历史阶段失败 → **成功结果** `history:{status:"degraded",code:"E_HISTORY"}`，`revision`/`publishedRevision`/`preview` 与真实发布一致，不恢复作品、不泄漏路径或原始错误消息（失败只用于受限 diagnostic）。相同 operationId 重试返回缓存的同一结算结果，不重复写盘；不同内容仍 `E_OPERATION_REUSED`。
- `unchanged` 路径不写历史，返回 `history:{status:"unchanged"}`。
- 历史阶段失败后可能留下部分历史状态（例如已写快照但未写 entries/state）；下一次成功 compose 的 `recordWrite` 会裁剪/覆盖未完成条目并继续工作，测试覆盖 entries 为目录（读失败）、snapshots 只读、history 目录只读（entries 写失败）、ops.jsonl 只读（append 失败）四种注入及恢复后的记录。
- commit 点之前的失败语义不变：入口写/回读/preview 证明失败会恢复旧字节并返回 `E_PERSIST`；无法恢复时带 `uncertain: true`（明确失败保留旧状态 / 明确提交返回真实新 revision / 未知显式 uncertain）。
- `project.source` 只读：返回当前 revision 的完整 HTML 与声明资产；入口 > 48 KiB 或 `JSON.stringify(html)` 转义后 > 60 KiB 返回 `E_LIMIT`（浏览器预览仍可读，Agent 编辑路径拒绝；后者保证 source 结果不会超过 64 KiB Tool 预算）。`source` 不写事实、不产生历史。

### 测试

- `test/schema.test.mjs`：schema 方法集 == worker switch 方法集（25）、新方法 params/result 双向校验。
- `test/compose.integration.mjs`（真实 worker 进程）：创建工程 → `project.source` 读回 → `project.compose` 发布（新 revision/`history.status="recorded"`/close 重开/重启持久化）→ 相同内容 `unchanged` + `history.status="unchanged"` → 幂等与 `E_OPERATION_REUSED` → `E_REVISION_CONFLICT` 不改文件 → 各契约失败场景均为 `E_COMPOSE_INVALID` 且 revision/内容不变（含引号密集文档的 JSON 转义上限、HTML 注释里的 `__timelines`、`main: null`）→ 参数错误 `E_PARAMS` → 工程目录只读注入恢复旧内容（`uncertain: true`）→ 预览快照目录只读注入恢复旧版本 → 直接植入引号密集入口后 `project.source` 的转义上限 `E_LIMIT` → 历史读/snapshots/entries/ops 四种故障下发布返回成功且 `history.status="degraded"`，source/inspect/后续 compose 一致，恢复后下一次 compose 记录历史，同 operationId 重试返回缓存结果。
- `test/compose-settlement.test.mjs`（直接 `Projects` 单元测试）：覆写 `recordComposeHistory` 抛错 → 降级成功结果；覆写 `previews.create` 抛错 + `restoreEntry` 返回 false → `E_PERSIST` stage `persist` 且 `uncertain:true`。
- 运行：`node --test --test-concurrency=1 test/*.test.mjs`（既有 44 项 + 新结算单元测试）与 `node --test --test-concurrency=1 test/compose.integration.mjs`。

## P3-016：工程显示标题与 UI-only 重命名（0.4.0 方法集）

JSONL v1 方法集新增 1 个 UI-only 方法（共 25 个）；既有方法的结果语义不变。

- `project.json` 新增**可选** `title`：trim 后 1..120 字符，仅作显示标题。revision 仍是 entry + 声明资产的内容哈希，标题不进 revision/history；rename 只原子重写 `project.json`（保留 entry/assets 与顺序），不触碰 `index.html`、快照或历史。
- `project.rename`：`{projectId,"title":"..."}`，仅对已 open 的工程可用（未 open → `E_PROJECT_NOT_OPEN`，closing → `E_PROJECT_CLOSING`）；参数非法 → `E_PARAMS`；标题相同返回 `changed:false` 且不写盘。结果为 `{projectId,revision,title,changed}`，revision 与重命名前相同。它和 `inspect`/`edit` 共用单工程写队列，不会与 manifest 重写交错。
- `inspect` / `open` 新增可空 `title`；`project.create.title`（若提供）同时作为初始显示标题写入 manifest。`asset.import` 重写 manifest 时保留已有 `title`。
- Host 侧：`project.rename` 是 UI-only 方法（Tool source 返回 `E_METHOD`）；Host `project.list` 每项新增可空 `title` 供选择器显示。
- `test/project-rename.test.mjs`（真实 worker 进程）：创建 → inspect title → rename（trim/原子写/保留 entry+assets/无 revision 变化）→ 重开与重启后标题持久 → 相同标题幂等 → 非法标题/未 open 的错误码 → Tool/Host 契约见 Host `scripts/check-host.mjs`。

## V1 M2 工程媒体库

| 方法 | 参数与行为 |
|---|---|
| `asset.importMedia` | `{projectId,sourceName,operationId?,name?,limits?}`；从受控 inbox 流式 hash/探测并导入 media，按完整 sha256 去重；短 ID 碰撞拒绝，不覆盖已有文件 |
| `asset.list` | `{projectId,kind?,query?,cursor?,limit?}`；最多 50 项，不返回磁盘路径；含独立 indexRevision |
| `asset.derive` | `{projectId,assetId,kind:"thumb"或"waveform"或"proxy"}`；独立异步请求，缩略图/波形 30 秒、兼容代理 110 秒超时，可重试；工程私有缓存可重建 |
| `asset.envelope` | `{projectId,assetId}`；返回整条素材的逐秒级响度包络（约 1 秒桶的 peaks/rms + materialPeak），复用 timeline-visuals 的 peaks-v1 缓存，供选区配乐在上轨前挑选插入窗口；只读，无音频素材拒绝 |
| `asset.align` | `{projectId,revision,assetId,fromFrame,toFrame,hitFrames?,tempoLock?}`；在 peaks-v1 最细一层（16ms）测出歌曲 onset 与节拍网格，与画面卡点（hitFrames 缺省时由 `timeline.beatmap` 自测）比对，返回最佳插入窗口 `best.sourceInFrame`（素材帧）、可选 `best.speed`（0.90–1.12，用 `clip.speed` 落地）、逐命中漂移与 `hitRate`；`hitRate<0.8` 时附免费本地卡点层 `beatLayer.score`。只读，最多 3 个候选、20 项漂移，60 秒解码截止 |
| `asset.remove` | `{projectId,assetId,operationId?}`；检查 timeline/project/composition 引用；先暂存媒体，再原子提交索引，失败恢复媒体 |

媒体索引与派生缓存独立于 composition revision。所有媒体操作复用工程写入队列，关闭/退出排空；单文件 2 GiB、工程 8 GiB。损坏索引保留 `.corrupt-*` 后重建，缺失索引从 media 重建。M2 不把素材自动放入作品，时间线由 M3 接入。

### M3 timeline methods

| `timeline.visuals.request` | UI background derivation: projectId, expectedRevision, clipId, bounded visible frame window, count 1–4; returns taskId |
| `timeline.visuals.status` | Project-scoped task status and bounded image/peak data; no disk paths |
| `timeline.visuals.cancel` | Cancel this view request without editing content |
| `timeline.beatmap` | `{projectId,revision,fromFrame,toFrame}`；把未静音视觉轨的真实切换帧与 peaks-v1（16ms）测得的音频 onset 合成确定性卡点图，返回 `hits[{frame,seconds,pct,source,strength,aligned?}]`、画面 `grid{bpm,intervalSeconds,phaseSeconds,confidence}` 与采样计数；只读，最多 16 个可听片段/120 个卡点，60 秒解码截止 |
| `timeline.inspect` | Timeline truth, integer frames, expectedRevision for writes |
| `timeline.apply` | Timeline truth, integer frames, expectedRevision for writes |
| `timeline.references` | Current project clip/scene/asset/range tokens; query, offset/limit |
| `timeline.resolve` | Timeline truth, integer frames, expectedRevision for writes |
| `timeline.undo` | Timeline truth, integer frames, expectedRevision for writes |
| `timeline.redo` | Timeline truth, integer frames, expectedRevision for writes |
| `scene.compose` | Timeline truth, integer frames, expectedRevision for writes |
| `scene.inspect` | Timeline truth, integer frames, expectedRevision for writes |

`preview.files` paginates the private snapshot manifest in 100-file pages; Host assembles it before registering exact routes.

M5 reference tokens are `dshvideo:v1/PROJECT/KIND/ID/REVISION`. Resolve tokens with `refs:[{kind:"token",token:"..."}]` before applying edits. Range tokens expire when revision changes. Clip/scene/asset IDs survive moves; missing and foreign references never match a substitute. Ordinals are per track; multiple tracks matching the ordinal return ambiguous. `timeline.inspect` includes the durable `lastChange` and `historyCursor`; targeted undo/redo accepts `expectedHistoryCursor` and `expectedOperationId`. `timeline.apply(dryRun:true)` returns a summary without writing or consuming the operation ID.

Timeline 0.9.0 adds `clip.detachAudio` to the existing atomic apply transaction. The detached audio references the same immutable video asset with `audioOnly:true`, preserving source timing and original track gain as `sourceGainDb`. The original clip is muted. The UI right-click flow is the release acceptance scope; AI calls are allowed through the same operation without an AI quality guarantee.
