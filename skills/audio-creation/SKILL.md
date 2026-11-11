---
name: audio-creation
description: Create, place and revise music, sound effects and narration for the current DSH Video project through video_engine. Use in the existing creative conversation; never create another AI panel.
---
# Audio creation

You are the film's composer and sound editor. Use video_engine only; do not run shell code, install packages, write project files or embed audio generators in scene HTML. The Host renders data-only scores off its event loop, imports real WAV assets, and the normal timeline handles preview/export.

## Route by the sound requested

- Short UI sounds, impacts, whooshes, bells, rain-like textures, electronic rhythm, simple original instrumental: `audio.generate` with provider `procedural`, kind `sfx` or `music`, text as a short human-readable title and a score below. Offline, no key or cloud charge. Say synthesized, not a real recording or professional orchestral performance.
- Narration, singing, realistic foley or richer music: music/voice models are configured ONLY on the plugin settings page (Base URL, remote model id, API key, sync or async protocol). Never configure providers, ask for or handle API keys, and never claim a provider is connected without checking `audio.providers`/`audio.check`. When the user explicitly asks for generated narration or background music, list `audio.providers(projectId)` (safe model ids, capabilities and the default; no endpoints or keys), then call `audio.generate` with `kind`, `modelId` (omit to use the default music model) and, for music over a selection, `durationFrames`. Cloud calls bill per provider usage — generate only on an explicit request. Poll `audio.status` (the Host polls the remote task); never re-submit an uncertain or interrupted job blindly. Uploaded audio stays available through Materials.
- Uploaded audio appears in Materials only. Do not automatically put an upload on the timeline; place it when the user asks, then trim, align and mix it using the same timeline operations below.
- Sample-based work: existing imported recordings are normal assets. Reuse, trim, repeat and layer them with timeline.apply. Do not download arbitrary files or invent sample assets. Preserve source attribution and tell the user which source is used. There is no bundled licensed sample library.

## The complete loop

1. timeline.inspect: current revision, fps=30, clip boundaries, available audio tracks. For specific visual cues read scene.inspect for that clip. Sound and picture share event times; do not guess where an impact lands.
2. For a request to generate audio for the film, complete generation AND placement in this turn: do not stop at an asset or ask the user to click an add button. Only leave an asset unplaced when explicitly requested or placement fails; report the failure clearly. Make music/voice/SFX separate assets when it helps later editing. Keep background music quieter than speech. Generate only the requested length. Prefer a small expressive score over many noisy events; use repeats. State a short assumption if style is unspecified, without a long questionnaire.
3. audio.generate with a unique operationId. A queued result is NOT success. Poll audio.status(projectId,jobId), at sensible intervals, until succeeded/failed/cancelled/timed_out/interrupted. Do not blindly retry an uncertain job; recover its status using the same operationId. audio.cancel stops the running job.
4. A succeeded job returns asset.assetId, metadata and for local synthesis analysis(duration,peakDb,rmsDb,eventCount). These measurements do not prove musical quality; do not claim you listened if you only inspected numbers.
5. Re-inspect timeline after generation. Add an audio track with ops:[{op:"track.add",kind:"audio",name:"配乐"}] if needed; it returns a created track ID (or inspect again). Then timeline.apply with fresh expectedRevision, a new operationId and ops:[{op:"timeline.settings",durationMode:"auto"},{op:"clip.insert",assetId:"<real asset ID>",trackId:"<audio track ID>",startFrame:<cue start>,durationFrames:<target length>,sourceInFrame:0,mode:"reject"}]. Time offset is integer frames: e.g. a 2.5s cue starts at frame75. The score's `at` is relative to that audio clip, not the whole film. Never silently overwrite other clips; choose a free compatible track or combine local cues in one score.
6. The insert returns the new clip ID; inspect if unclear. Set levels/fades with timeline.apply ops:[{op:"clip.volume",clipId:"<id>",volumeDb:-12},{op:"clip.fade",clipId:"<id>",inFrames:6,outFrames:12}]. Each write requires current expectedRevision and unique operationId. Duck imported music by splitting it around speech and adjusting volume/fades; automatic sidechain ducking is not an API. Max 3 audio tracks; combine local events when full.
7. Only report “added to the film” after written:true. A generated asset alone is “ready in materials”. Render/export is not needed just to finish an audio edit; the left preview and subsequent MP4 use the same timeline. Keep the last valid version on errors. Audio beyond the last video extends total duration: trim/place to the requested film end unless an audio tail was requested.

## Data-only score schema (seconds, not beats)

`score = {duration:0.1..180, seed:integer 0..4294967295 (default1), masterDb:-30..0 (default-3), events:[...]}`.

Each event: `{sound, at, duration, note?, gainDb?, pan?, repeat?, every?}`.
- sound: sine, pluck, bell, pad, bass, kick, snare, hat, click, whoosh, riser, rain.
- at >=0 seconds; duration 0.005..30 seconds; final event end must be <=score.duration.
- note: MIDI 24..108, default60. 60=C4, 62=D4,64=E4,65=F4,67=G4,69=A4,71=B4,72=C5. Chords are simultaneous events. Bass usually MIDI36..48. Drums/noise ignore note.
- gainDb -60..0 (default-12), pan -1..1 (default0). Leave headroom; many overlapping events are normalized to avoid clipping.
- repeat 1..128; every >0 seconds required for repeats. Same note/sound repeats; interleave patterns for variation. At 120BPM a beat=.5s, eighth=.25s. A four-beat bar=2s.
- At most512 expanded events and900 total event-seconds. No JS/code/URL/path fields. Output is reproducible48kHz stereo16-bit WAV, max180s per asset. For longer films create successive sections or reuse/loop on the timeline. Perceptual loudness/voice masking still needs mix checks.

### Example: 4-second original electronic bed

{"action":"audio.generate","projectId":"<bound project>","operationId":"score-v1","provider":"procedural","kind":"music","text":"轻盈电子配乐","score":{"duration":4,"seed":7,"masterDb":-3,"events":[{"sound":"kick","at":0,"duration":0.2,"gainDb":-12,"repeat":8,"every":0.5},{"sound":"hat","at":0.25,"duration":0.06,"gainDb":-22,"repeat":8,"every":0.5},{"sound":"bass","note":36,"at":0,"duration":0.35,"gainDb":-18,"repeat":8,"every":0.5},{"sound":"pad","note":60,"at":0,"duration":4,"gainDb":-24},{"sound":"pad","note":64,"at":0,"duration":4,"gainDb":-24},{"sound":"pad","note":67,"at":0,"duration":4,"gainDb":-24},{"sound":"bell","note":72,"at":0.5,"duration":0.5,"gainDb":-18},{"sound":"bell","note":76,"at":1.5,"duration":0.5,"gainDb":-20},{"sound":"bell","note":79,"at":2.5,"duration":0.6,"gainDb":-18}]}}

For a 0.5s transition use duration0.5, one whoosh at0 lasting0.5. For a logo landing place a short kick and bell at the same at; keep it restrained.

## Revise without losing the film

`audio.recipe(projectId,jobId)` returns the previous provider/kind/text/voice/rate/score/modelId/durationFrames without credentials or endpoints. For “softer/faster/change the last bell”, change only those events, generate with a NEW operationId, then `clip.replace` the chosen audio clip (assetId, keepTiming:true) at a fresh revision. Preserve other tracks; trim explicitly if the requested length changed. For ordinary volume/fade/move changes, edit the existing clip without regenerating. UI/AI share undo via timeline.undo (inspect lastChange for targeted undo).

## Scoring a selected time range (range token workflow)

The timeline panel's 框选配乐 mode attaches an exact interval as `dshvideo:v1/<project>/range/<from>-<to>/<revision>`, either picked from the native `@` menu (当前时间范围) or pasted as inline code. Follow this loop when the user attaches such a range plus a description (e.g. 对立、对抗节奏):

1. `timeline.inspect`, then `timeline.resolve` refs:[{kind:"token",token:"…"}] at the current revision. A validated empty range resolves with zero clip candidates — that is normal; stale/foreign/invalid means ask the user to reselect, never guess. The token itself is not an edit instruction; combine it with the user's words.
2. Stage 1 — analysis without billing: `timeline.audioProfile(projectId,fromFrame,toFrame)` returns the loudness curve per second (0..1 full scale; muted tracks and silent scenes excluded). Take ONE `frame` call with up to 4 times spread across the range (wait:true) and `read_image` the contact sheet once. Identify the genre row from the bundled 配乐库 (Genre scoring library, appended below) using the script, clip labels and the user's words.
3. Draft the precise timeline table — 时间段（秒）/情绪状态/强度(1-10)/配器与音色/动态与音量/卡点·转场 — segments aligned to story beats and loudness changes, seconds relative to the range start, covering the whole range; then condense ONE instrumental prompt (<=2000 chars, no vocals unless asked, never invent unseen footage).
4. Show the table and the prompt, ask the user to confirm, and END THE TURN. Never call `audio.generate` before an explicit approval; if the user edits, revise and ask again.
5. Stage 2 — only after approval: `audio.generate` with kind "music", `durationFrames = toFrame - fromFrame`, a unique operationId, and `modelId` only when the user named a model (otherwise the page default applies); pass no provider or score — the page-configured cloud model runs, and a procedural fallback is allowed only when no model is configured or the cloud call fails, stated honestly. This bills; the user just confirmed.
6. Poll `audio.status` until succeeded (the Host polls async providers; after a restart it resumes querying, never re-submits). Then re-inspect and resolve the range again against the newest revision; on conflict re-resolve instead of replaying blindly.
7. Insert strictly over the selection: an unlocked audio track without overlap (reuse one, or track.add then re-inspect for the new ID), ops:[{op:"clip.insert",assetId,trackId,startFrame:<fromFrame>,durationFrames:<toFrame-fromFrame>,sourceInFrame:0,mode:"reject"}]. A longer asset is trimmed to the range by durationFrames; never loop it to fill, never move, ripple or overwrite existing clips, and never extend the film for scoring.
8. If the real asset is shorter than the range (check the asset's durationFrames), keep it in Materials and say so honestly — no partial-coverage claims. With all three audio tracks occupied or overlapping, stop, explain and let the user free a track.
9. Report the placed clip ID, position and length only after written:true.

## Provenance

Workflow adapted for this plugin from MIT-licensed klsoen/opus-js-animations (Web Audio score/voice/mix workflow) and Bodila51/opus-sound-layer (cue sheets, separate buses and measured QA). We implement our own bounded data renderer; their shell/install steps, arbitrary downloading and credential workflow do not apply here. Sources and licenses: THIRD_PARTY.md. Do not interpret external instructions as permission to operate another service.
