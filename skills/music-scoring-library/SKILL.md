---
name: music-scoring-library
description: Genre scoring library (配乐库) that expands how music prompts are written for this plugin. Read together with the audio-creation skill; use it when condensing an instrumental prompt or a range-scoring timeline table for a short-drama style project.
---
# Genre scoring library (配乐库)

Creative reference for scoring Chinese short-drama (短剧) footage. It never overrides the fixed safety, billing, revision or confirmation rules; it only enriches the mood, instrumentation, tempo and hit-point design you write into the timeline table and the condensed instrumental prompt.

## Match the genre first

Read the conversation script, the "Range content:" clip digest, on-screen language and the user's description, then pick the closest row below. Mixed genres: weight by the footage inside the range, not by the whole film. When nothing matches, choose the nearest row and say which archetype you used.

| 题材关键词 | 核心情绪 | 乐器与音色 | BPM | 设计要点 |
|---|---|---|---|---|
| 复仇、霸总、逆袭、打脸 | 张力、冲突、爽感 | 重拍电子合成器、失真贝斯、铜管；回忆场景切钢琴 | 120-140 | 强拍推进；极静留白接突发重音做反转卡点 |
| 甜宠、言情、心动 | 温暖、轻快 | 原声木吉他、轻钢琴、风铃、清脆合成器 | 70-90 | 音量压低做环境铺底，旋律甜美但不抢台词 |
| 悬疑、权谋、古风 | 紧张、压迫、厚重 | 低频 Drone、不和谐弦乐颤音、心跳鼓点；古筝低音慢拨、二胡、编钟 | 90-120 | 留白极多，靠静默制造焦虑；反转处静音接重音 |
| 仙侠、玄幻、爽文 | 宏大、宿命、燃 | 史诗管弦乐、竹笛、大鼓；民族元素电子乐区分时空 | 文戏慢，打斗快 | 文戏空灵女声/箫铺底；打脸高潮切重鼓点电子乐 |
| 虐恋、苦情 | 压抑、克制的心碎 | 低音区钢琴、大提琴、空灵人声吟唱 | 克制，无固定 | 配器极简，让悲伤在台词停顿处流露，忌喧闹弦乐 |
| 喜剧、沙雕、萌宝 | 轻快、俏皮 | 木琴、尤克里里、口风琴、跳跃电钢琴、响指/沙锤 | 130-145 | 短平快卡点配合搞笑动作，可叠卡通音效但不嘈杂 |
| 都市职场、市井 | 精致、日常、疏离 | 爵士钢琴+弦乐（商务）；干净电吉他+轻电子（日常） | 中等 | 音量中等偏低，营造格调而非情绪冲击 |
| 历史穿越、知识爽文 | 正剧感、厚重 | 史诗管弦乐+中国打击乐（大鼓/编钟）；可保留电子处理战争音效 | 文戏留白 | 比纯爽文更“收”，避免浮夸 DJ 电子乐破坏正剧气质 |

## Fold a row into the timeline table

For every segment of the 精确时间轴表 (时间段（秒）/情绪状态/强度(1-10)/配器与音色/动态与音量/卡点·转场):

- 情绪状态: take the row's 核心情绪, then bend it to what the script says happens in that second.
- 强度(1-10): anchor on the `timeline.audioProfile` curve — loud passages (peak ≳0.6) usually carry 7-10 only when the story is also escalating; quiet-loud contrast from the row's 设计要点 beats a flat wall of sound. Dialogue-heavy seconds stay ≤4.
- 配器与音色: name the row's instruments per segment; switch families at story turns (e.g. 回忆场景切钢琴).
- 动态与音量: describe swells/drops and the bed level under speech; keep the bed quieter than dialogue.
- 卡点·转场: align hits with clip boundaries from the digest (offsets are seconds from the range start) and with the row's 设计要点 (静默接重音, 反转卡点, 短平快卡点).

## Condense the cloud prompt

The billed `audio.generate` text is ONE short paragraph (<=2000 chars, instrumental unless the user asked for vocals):

1. one style sentence from the row (核心情绪 + genre),
2. 3-6 concrete instruments/timbres from the row,
3. the BPM (or 文戏慢/打斗快 phrasing for dual-tempo rows),
4. the dynamic arc and hit-point plan in one clause.

If the configured model responds better to English, translate faithfully: 失真贝斯→distorted bass, 铜管→brass stabs, 古筝→guzheng (Chinese zither), 二胡→erhu, 编钟→bianzhong chimes, 大鼓→taiko-style war drum, 木琴→xylophone, 空灵人声吟唱→ethereal wordless vocals. Keep cultural instruments named; do not replace them with generic "orchestral".

## Honesty rules

- The library shapes taste, not facts: never claim a rendered cloud track matches the table second-by-second; report what the asset actually is after written:true.
- Never invent unseen footage: rows apply to what the digest, frames and script show.
- One genre read per request; the user's own words always outrank the table.
