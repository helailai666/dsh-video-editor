---
name: beat-alignment
description: 节奏对齐手册（卡点必须来自测量）。与 audio-creation、配乐库、情绪突变设计器一起阅读；用于选区配乐时把画面切换/反转变成可计算的卡点，并在云端歌曲生成后用引擎测量决定插入窗口、可选速度与本地卡点层。
---
# 节奏对齐（Beat alignment）

这份手册只解决一件事：**音乐到底有没有踩在画面上**。它不改变任何安全、计费、确认或 revision 规则；它把"卡点"从形容词变成引擎测出来的帧。

引擎提供两个只读方法：

- `timeline.beatmap(projectId,fromFrame,toFrame)` — 返回这段区间的**画面卡点图**：`hits[{frame, seconds, pct, source:'cut'|'onset', strength, aligned?}]` 与 `grid{bpm, intervalSeconds, phaseSeconds, confidence}`。`source:'cut'` 是未静音视觉轨的真实切换帧（编辑器已经决定的点，优先级最高）；`source:'onset'` 是从 8kHz 峰值包络（16ms 桶）测出的音频突变（台词重音、音效冲击、动作起手）；`aligned:true` 表示实测音频事件正好落在这个切换上。`pct` 是该帧占区间长度的百分比。
- `asset.align(projectId,assetId,fromFrame,toFrame,hitFrames?,tempoLock?)` — 把**云端歌曲的实测 onset** 与上面的卡点比对，返回 `song{bpm,intervalSeconds,confidence,onsetCount}`、`candidates[≤3]`、`best{sourceInFrame, seconds, speed, hitRate, meanErrorFrames, maxErrorFrames, toleranceFrames, drift[≤20]}`，以及 `beatLayer`（`{score}` 或 `null`）与 `beatLayerReason`。`sourceInFrame` 是**素材帧**单位的插入起点；`drift` 只列没踩上的命中及偏差帧数。

## 1. 卡点必须来自测量，不来自想象

阶段一（不计费）在 `timeline.resolve` + `timeline.audioProfile` 之后**必须**调用 `timeline.beatmap`：

- 确认表的"卡点·转场"每一行都要绑定返回的 `frame` 与 `pct`（例：`75帧 / 6.2% 她抽回手`）。
- 禁止无帧泛词：`中段`、`缓慢推进`、`紧张渐起`、`高潮渐强` 这类没有帧号的描述不算卡点。
- 计费提示词里的百分比位置**只能取 `pct` 四舍五入到 5%**（模型遵循相对位置，忽略绝对秒数）。
- `grid.bpm` 与 `confidence` 就是这段画面的实际节奏；把它写进提示词的 BPM 字段。若 `grid.bpm` 为 `null`（区间内卡点太少或间隔超出 0.3–1.5 秒），改用相邻 `cut` 帧间隔手算并写明依据。

## 2. 结构线可执行化

沿用配乐库的五段式，但第 4 条（卡点结构线）按下面的可执行形状写：

`<pct%> <音乐动作>（对准 <画面事件> @<frame>帧）`

- 音乐动作选模型跟得住的结构词：`downbeat hit`、`half-beat rest then drop`、`break before the reversal`、`sudden silence to slam`、`final hit to cut`；强度只用两态（`pp` 铺底 / `fff` 爆发），禁止 4–7 的中间态平铺。
- 每个 `aligned:true` 的卡点是硬点（画面切换与音频突变同时发生），必须给重音；`source:'onset'` 是软点，可给推进或余音。
- 收尾方式要与下一段的转场一致（硬切下一段 → `骤停归零`；接长镜 → `衰减`）。
- 画面空隙（beatmap 里两个相邻 `cut` 之间的大间隔、或对白静默段）要求音乐留**同比例休止**，不要用它填满。

## 3. 生成后必须量一次

阶段二云端任务 `audio.status` 为 `succeeded` 之后、插入之前，**必须**调用 `asset.align(projectId,assetId,fromFrame,toFrame)`（`hitFrames` 省略，由引擎自己按 beatmap 测）：

- 用 `best.sourceInFrame` 插入：`clip.insert(assetId, trackId, startFrame:fromFrame, durationFrames:toFrame-fromFrame, sourceInFrame:best.sourceInFrame, mode:"reject")`。
- `best.speed !== 1` 时随后一条 `clip.speed(clipId, speed:best.speed)`（引擎会走 atempo，不改变音高；只在 0.90–1.12 内给出）。
- 报告必须带 `hitRate`、`meanErrorFrames`、`maxErrorFrames`，以及 `drift` 里最差的几个命中"差几帧/差几秒"。不要再用眼睛读包络数组自评。
- 只有 `written:true` 之后才说"已上轨"。

## 4. 漂移兜底：本地卡点强化层（免费、不计费）

`beatLayer` 非空即表示最佳窗口仍有卡点落在容差之外（`hitRate < 0.8`）。这时不要再烧一次云调用，先补一层帧精确的本地打击：

1. `track.add kind audio` 新建第二条音轨（若三条音轨已满，如实停下说明，不要覆盖别人的片段）。
2. `audio.generate(projectId, operationId, kind:"sfx", provider:"procedural", text:"卡点强化层 · <题材>", score:<beatLayer.score 原样透传>)` —— **这是本地合成，不计费、不受每日 20 次云护栏限制**。音频服务并发为 1：必须在云歌任务终态后再发起；返回 `E_AUDIO_BUSY` 就等待后重试，绝不并行。
3. 轮询 `audio.status` 到 `succeeded`，再 `clip.insert(startFrame:fromFrame, sourceInFrame:0, durationFrames:toFrame-fromFrame, mode:"reject")` 插到新音轨。
4. `clip.volume` 把这一层压到云乐之下（相对 -4dB 起步），需要时 `clip.fade` 收边。
5. 报告要写清楚："叠了本地免费卡点层，因为最佳窗口仍有 N 帧漂移"，并给出这一层的 clipId。

score 的 `at` 是相对该片段起点的秒数（引擎已按 30fps 换算），不要手改数字去"试试看"。

## 5. 多 cue（衔接情绪突变设计器）

`drama-beat-shifts` 要求每个稳态/爆发段独立成 cue：每条 cue 都各自走 `timeline.beatmap`（用该 cue 的 from/to）→ 计费生成 → `asset.align`。cue 之间表达"全体休止"的空隙由该 cue 的卡点层补 hit，空隙本身不铺音乐。N 段仍是 N 次计费，必须在阶段一确认表里写清"共几条 cue、各多长、总计费几次"。

## 6. 自检清单（交付前逐条回答）

- 确认表的卡点行数 = `beatmap` 返回的 hits 数（或说明为何只取其中若干）？
- 提示词里的每个百分比都来自 `pct`？
- 有没有调用 `asset.align`？`hitRate` 是否 ≥0.8？
- `maxErrorFrames` 与最差漂移命中是否已如实报告？
- 需要时是否叠了 `beatLayer`，且音量已压低、说明不计费？
- 所有 ID/位置是否只在 `written:true` 之后报告？

## 7. 诚实边界

- onset 检测建立在 8kHz 峰值包络上，没有频谱通量：氛围铺底、慢板、低频为主的段落可能检不到拍（`onsetCount` 很小、`grid.bpm` 为 `null`）。这时如实说明"未检出可信节拍"，退回按画面 `cut` 网格选窗，**不得声称已锁拍**。
- `hitRate` 只证明"测出来的 onset 与测出来的卡点对上了"，不证明听感好坏，也不代表你听过这段音乐。
- 卡点层是合成打击乐，不是真鼓组录音；说"合成"，不说"实拍/专业演奏"。
- 引擎的响应有硬上限（最多 120 个卡点、3 个候选窗口、20 项漂移）；`truncated` 或 `warnings` 出现时要说明分析被截断，不要把截断结果当全覆盖。
