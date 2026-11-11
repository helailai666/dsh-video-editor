# 开发与协作规则

## 事实来源与分工

- main 是唯一长期主分支，同时维护代码与最新项目记忆。开工先 `git fetch origin`，再依次读取 origin/main 的 STATUS、DEVELOPMENT 与 handoffs/README；不得为读文档随意 merge/rebase。离线说明缓存提交。
- 主会话负责产品、架构、任务、规范、协调、评审与验收；用户指定开发会话负责实现、验证、修复和 PR。仅在用户明确指派时直接实现，不自动派发或联系其他会话。当前用户要求优先于历史授权。
- 通用规则只维护于本页；任务文档仅补充特定范围与验收。状态读 STATUS，产品读 PRODUCT，设计读 FRONTEND-DESIGN，决策读 DECISIONS。

## Git 与工作区

- 功能或问题修复从最新 origin/main 建立 `codex/<问题名>` 分支，PR 回 main；不在 main 直接开发。同一工作区只有一个写入会话。
- 仓库根是标准入口；隔离工作区放在同级 `dsh-video-editor-worktrees/`，固定包和证据放该目录的 `artifacts/`。用户工程独立于源码。
- 保留用户修改、已安装包和回滚锚点；不 reset/clean/强推。清理前备份有用资料，不覆盖不可变 staging。推送/PR 不等于验收或发布。
- 合并、安装、重启与公开发布按当次授权。没有覆盖这些操作的授权时，先完成可评审的修改、固定包和验证，再请求最终授权；已经明确授权的操作不重复确认。

## 产品与运行边界

- 原生 Slot、主题和资源清理遵守当前 DSH 契约。不修改 DSH 源码、app.asar、宿主根 DOM、会话协议或用户凭据。
- 复用宿主原生模型、会话、输入框和权限。UI 与 AI 共用 Host 业务入口；工程、revision、写入排序、冲突和持久化由 Host/worker 负责。
- 预览绑定固定 revision；失败保留上一画面，迟到结果不覆盖新作品。生成代码不在 Host 主进程执行；iframe/CSP 不等于系统级沙箱。
- 工程内容仅由受控 worker 写入，Session/工程归属、路径与资源上限在 Host 校验。
- npm 包名、Loader 行与客户端模块 id 为 `dsh-video-editor`；稳定 UI key、API 路由和用户数据目录保留 `dsh-video`，避免破坏旧工程。旧本机 link 包在正式迁移前保留，不同时启用旧包与新包。
- 音乐模型与追加系统提示词的唯一用户入口是插件设置页；`<dataRoot>/plugin-settings.json` 与 `<dataRoot>/audio/audio-secrets.json`（含 models 段）只是页面保存后的 Host 内部持久化，不是配置方式。Key/Base URL/提示词不经聊天 Tool 读写；六种协议（qianwen-sync/qianwen-async、stepfun、suno-inspiration、suno-custom、minimax）仅公网 HTTPS，每次请求前校验 URL 与 DNS，下载不带凭据；损坏的设置文件保留并报错，不静默重置。
- 计费安全：StepFun task_id、Suno 受理号（`req:` 前缀）或 song_ids 一律先持久化再轮询，重启只恢复查询；Suno 提交使用 `accept_mode=async` 加 `Idempotency-Key`（复用 operationId），其它协议提交失败/超时不自动重试。设置页「测试连接」对无模型列表接口的厂商使用不计费 probe（假任务号/受理号查询/空体请求，400 与 404 视为可达）。StepFun 与 MiniMax 的内联音频响应上限 96 MiB，解码后素材仍限 64 MiB。

## 打包与验证

- 使用锁文件，安装依赖加 `--ignore-scripts`；不运行未知构建脚本或进行无关依赖升级。根运行依赖与 worker 依赖版本保持一致。
- 源码直接提供 JavaScript 和引擎源码；npm/Git 安装通过 Node 解析运行依赖，不依赖相邻工作树或写死的 node_modules 布局。离线发行包可包含完整依赖闭包。
- 固定包记录源码提交、版本和摘要，从干净提交构建；不热改已验收候选，不把新包套用旧包验收结果。
- 分层报告语法/契约、组件、真实 Host/浏览器、真实 DSH、真实模型和真实导出证据。按修改风险验证，不用测试数量代替用户闭环。
- DSH 安装统一使用官方 Plugin Manager 或 CLI；不手改真实 profile，不在其目录运行包管理器。安装测试使用临时 DSH_HOME 和临时工程。
- 运行时更新仅由认证 UI 的用户动作触发；后台只检查，不向 AI 暴露安装 URL 或更新方法。不在插件启动/HMR事务中嵌套卸载安装。

## 用户数据与安全

- 不修改/重置用户作品，不用用户工程跑自动化 fixture。迁移只复制、可重试、保留旧数据。
- 不提交密钥、令牌、个人配置、原始聊天、用户工程或未脱敏截图。发布前扫描当前文件与全部 Git 历史；真实泄漏先撤销凭据，历史重写另行协调。
- 用户同时使用电脑时，不使用全局坐标/键盘/剪贴板或强切前台；仅用绑定目标的 DOM/AX 通道。没有可用通道时提供最少人工步骤。
- 安装后核对实际 Client/worker 来源；Host 新而 Client 旧时需按授权重启，不靠修改冻结文件强刷。真实模型、系统设置及安装/重启按当次授权。
