# 当前架构决策

历史决策保留于 Git 历史；本页只列当前有效约定。

| 决策 | 约定 |
|---|---|
| 单一长期主线 | main 同时维护代码与项目记忆；具体问题使用独立 codex/ 分支和 PR。 |
| 原生 AI | 复用 DSH 会话、模型、输入框和权限；插件不复制聊天日志或凭据。 |
| 内容权威 | Host/worker 持有工程、revision、写入排序、冲突和持久化；UI 不建立第二份工程真相。 |
| 共享事务 | AI 与手动剪辑复用同一业务入口和撤销/重做历史。 |
| 独立引擎 | 视频工作在独立 Node worker 执行；[ADR-0001](adr/0001-independent-video-worker.md)。 |
| Host 边界 | 路径、工程/Session 归属与资源限制由可信 Host 校验；[ADR-0002](adr/0002-host-bridge-runtime-and-boundaries.md)。 |
| 预览 | 固定 revision 快照；失败保留上一有效画面，迟到结果不覆盖新版本。 |
| 数据稳定 | 用户工程保存在稳定数据根；更新替换插件，不覆盖作品。 |
| 音频入口 | AI 生成后直接上轨；用户上传进素材；音乐模型、API Key 与追加系统提示词只在插件设置页配置（Host 内部持久化，非文件配置入口），Tool 不得接触凭据。 |
| 配乐模型协议 | 六种协议：qianwen-sync/qianwen-async、stepfun、suno-inspiration、suno-custom、minimax，仅公网 HTTPS，选择协议自动带出官方 Base URL 与远端模型 ID。计费任务标识（task ID／Suno 受理号或 song_ids）先持久化再轮询，重启只恢复查询，绝不重复计费提交；Suno 用受理回执模式加 Idempotency-Key，其它提交超时不自动重试。 |
| 选区配乐 | 时间线框选精确范围注册为原生 `@` range 引用；选区条内写剧情描述后「发送到聊天」走 Host 公开受理通道（UI-only `session.send` → `sessionController.prompt`，mode:queue，requestId 去重，失败只报状态未知不静默重发），DSH 无公开 Composer 草稿写入 API，绝不 DOM/内部事件写入输入框；上轨严格匹配选区（裁到 targetFrames、不循环、不 ripple、不覆盖、不延长影片），短素材保留素材库不上轨。 |
| 安装与发布 | GitHub 源码、npm 和 Release 包均使用完整引擎及依赖；安装时不运行插件构建脚本。公开发布状态读 STATUS。 |

协作与权限只维护在 [DEVELOPMENT](DEVELOPMENT.md)。
