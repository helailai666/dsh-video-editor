<div align="center">

![dsh-video-editor — IDEA IN. VIDEO OUT.](docs/assets/hero.svg)

# dsh-video-editor

**用对话构思，用时间线打磨，让想法成为影片。**

DeepSeek Harness 内的 AI 视频创作与剪辑工作台。<br>
右侧对话生成与续改，左侧即时预览，多轨剪辑与 MP4 导出一站完成。

[![npm](https://img.shields.io/npm/v/dsh-video-editor?color=2048ff&style=flat-square)](https://www.npmjs.com/package/dsh-video-editor) [![DSH](https://img.shields.io/badge/DeepSeek_Harness-%E2%89%A50.2.1--rc.2-111111?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness) [![Node](https://img.shields.io/badge/Node.js-22%2B-111111?style=flat-square)](https://nodejs.org/) [![MIT](https://img.shields.io/badge/license-MIT-2048ff?style=flat-square)](LICENSE)

**简体中文** · [English](README.en.md)

[功能](#从一句想法到一条影片) · [安装](#安装) · [开始创作](#开始创作) · [开发](#开发) · [文档](docs/README.md)

</div>

![dsh-video-editor workspace](docs/assets/workspace.png)

## 从一句想法，到一条影片

| 创作环节 | 你可以做什么 |
|---|---|
| **对话创作** | 描述想要的影片，复用 DSH 的模型和原生对话，持续修改同一作品。 |
| **即时预览** | 自动更新画面，播放、暂停、跳转，边看边调整。 |
| **多轨剪辑** | 导入图片、视频与音频；移动、裁剪、拆分、复制、排序和吸附。 |
| **看见声音** | 真实音频波形、连续视频缩略图，视频原声一键分离为独立音轨。 |
| **放心修改** | AI 与手动操作共享撤销/重做；工程自动保存，重开继续创作。 |
| **选区配乐** | 时间线框选一段时间，加入对话并描述剧情节奏；AI 撰写器乐提示词，调用你配置的模型生成配乐并精确覆盖选区。 |
| **交付成片** | 导出带声音的 H264/AAC MP4，查看进度或取消任务。 |

## 安装

需要 **DeepSeek Harness ≥ 0.2.1-rc.2、Node.js ≥ 22、FFmpeg/ffprobe 和 Google Chrome**。

打开 DSH **插件 → 添加插件**，使用下列任一来源，安装后启用：

### GitHub 仓库

```text
https://github.com/helailai666/dsh-video-editor
```

### npm 包名

```text
dsh-video-editor
```

npm 安装推荐选择官方源。

更多安装与更新方式见[安装指南](docs/releases/UPDATE-CHANNEL.md)。

## 开始创作

1. 从 DSH 左侧进入 **dsh-video-editor**，创建或打开作品。
2. 在右侧描述影片；生成后左侧自动更新预览。
3. 继续对话，或在时间线上调整片段。自己的图片、视频和音频从 **素材** 导入。
4. 点击 **导出 MP4**，等待完成并保存成片。

可以从这样的想法开始：

> 做一段 15 秒的产品介绍，深色背景，分三段展示标题、亮点和结束语，转场简洁。

工程自动保存到 `~/Movies/DSH Video`，模型沿用 DSH 中的配置。

## 配乐设置（全部在页面完成）

- 打开对话侧顶栏的 **设置**：在 **音乐模型** 页签添加、编辑、删除、测试连接并选择默认模型。协议内置 **千问（同步返回 / 异步任务）**、**阶跃星辰 StepFun**、**Suno 灵感模式**、**Suno 专业模式**、**MiniMax Music**，选择协议后自动带出官方 Base URL 与远端模型 ID，通常只需粘贴 API Key（自建网关可覆盖 Base URL）。密钥只保存在本机，页面不回显；无需编辑任何配置文件。
- StepFun、Suno、MiniMax 的成片时长由模型决定，无法按帧精确指定；插件按选区严格裁剪，绝不循环或补长。
- 在 **系统提示词** 页签追加你的补充指令（如配乐偏好），随时保存或恢复默认；固定安全规则不被覆盖。
- 时间线点 **框选配乐** 后拖动选择时间范围（也可用秒输入精确到帧），在选区条写一句剧情节奏，点 **发送到聊天**：这条消息带着精确选区引用、你的描述、自动附加的配乐请求句与范围内片段摘要（名称、类型、相对时间）进入右侧对话，AI 结合对话中的剧本、视频语言与设置页的音乐提示词撰写器乐提示，调用你配置的音乐模型（而非本地合成）生成配乐并严格覆盖选区上轨。例如：

> 这段剧情是对立、对抗节奏，请为选中的时间范围生成并添加背景音乐。

想自己组织语言时，点 **复制引用** 或在对话里输入 `@` 选「当前时间范围」，同样可以把引用带进聊天。

生成成功后配乐严格覆盖选区上轨；素材短于选区时保留在素材库并如实说明，不会循环或挤动其它片段。

## 更新、停用与回滚

点击顶栏 **插件更新** 检查并安装新版本。

在 DSH 插件页可以停用；需要回滚时，重新安装上一版本即可，工程数据独立保存。

## 开发

```sh
git clone https://github.com/helailai666/dsh-video-editor.git
cd dsh-video-editor
npm ci --ignore-scripts
npm run check
node --test tests/*.test.mjs
```

运行时为直接加载的 JavaScript。`host/` 负责工程、会话与资源边界，`client.js` 提供原生工作区，`packages/` 保存独立视频引擎。开发规则见 [DEVELOPMENT](docs/DEVELOPMENT.md)，发布流程见[发行指南](docs/releases/UPDATE-CHANNEL.md)。

发现问题请提交 [Issue](https://github.com/helailai666/dsh-video-editor/issues)，附 DSH/插件版本、设备及复现步骤。安全问题见 [SECURITY](SECURITY.md)。

## 致谢与许可

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，视频引擎使用 [HyperFrames](https://github.com/heygen-com/hyperframes)。感谢开源社区。

[MIT](LICENSE) © dsh-video-editor contributors
