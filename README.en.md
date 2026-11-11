<div align="center">

![dsh-video-editor — IDEA IN. VIDEO OUT.](docs/assets/hero.svg)

# dsh-video-editor

**Start with a conversation. Refine on a timeline. Make it move.**

An AI video workspace inside DeepSeek Harness.<br>
Create and refine in chat, preview alongside it, edit across tracks, and export to MP4.

[![npm](https://img.shields.io/npm/v/dsh-video-editor?color=2048ff&style=flat-square)](https://www.npmjs.com/package/dsh-video-editor) [![DSH](https://img.shields.io/badge/DeepSeek_Harness-%E2%89%A50.2.1--rc.2-111111?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness) [![Node](https://img.shields.io/badge/Node.js-22%2B-111111?style=flat-square)](https://nodejs.org/) [![MIT](https://img.shields.io/badge/license-MIT-2048ff?style=flat-square)](LICENSE)

[简体中文](README.md) · **English**

[Features](#from-an-idea-to-a-video) · [Installation](#installation) · [Quick start](#quick-start) · [Development](#development) · [Docs](docs/README.md)

</div>

![dsh-video-editor workspace](docs/assets/workspace.png)

## From an idea to a video

| Step | What you can do |
|---|---|
| **Create in chat** | Describe a video using DSH's native conversation and models. Keep refining the same project. |
| **Preview as you go** | Automatically refresh the preview, play, pause, and seek. |
| **Edit across tracks** | Import images, video, and audio; move, trim, split, duplicate, reorder, and snap clips. |
| **See your sound** | Inspect real waveforms and continuous thumbnails. Detach video audio into its own track. |
| **Keep your progress** | Share undo/redo between AI and manual edits. Projects persist across restarts. |
| **Score a selection** | Drag a time range on the timeline, attach it to the chat, and describe the scene; the AI writes an instrumental prompt, calls your configured model, and places the score exactly over the range. |
| **Export a finished video** | Render H264/AAC MP4 with progress and cancellation. |

## Installation

Requires **DeepSeek Harness ≥ 0.2.1-rc.2, Node.js ≥ 22, FFmpeg/ffprobe, and Google Chrome**.

Open DSH **Plugins → Add plugin**, enter one of the following sources, install, and enable:

### GitHub repository

```text
https://github.com/helailai666/dsh-video-editor
```

### npm package

```text
dsh-video-editor
```

Use the official npm registry for installation.

See the [installation guide](docs/releases/UPDATE-CHANNEL.md) for more options.

## Quick start

1. Open **dsh-video-editor** in the DSH sidebar. Create or open a project.
2. Describe the video in the right-hand conversation; the preview updates on the left.
3. Continue in chat or edit clips on the timeline. Import your own media through **素材 / Assets**.
4. Choose **Export MP4**, wait for rendering, and save your video.

Try an idea like this:

> Make a 15-second product introduction with a dark background. Use three sections for the title, key features, and closing line. Keep transitions simple.

Projects save automatically to `~/Movies/DSH Video` and use your DSH model configuration.

## Music settings (all in the page, no config files)

- Open **Settings** in the chat header. Under **Music models** add, edit, remove, test, and pick the default model. Built-in protocols cover **Qianwen (sync / async task)**, **StepFun**, **Suno inspiration mode**, **Suno custom mode** and **MiniMax Music**; selecting one fills in the official Base URL and remote model ID, so usually you only paste an API key (override the Base URL for your own gateway). Keys stay local, are never re-displayed, and no configuration file editing is ever required.
- StepFun, Suno and MiniMax decide the rendered length themselves; the plugin trims the result exactly to your selection and never loops or pads it.
- Under **System prompt** append your extra instructions (for example scoring preferences); save or restore the default at any time. The fixed safety rules are never overridden.
- Click **Range scoring** on the timeline, drag to select a range (or type exact seconds), write one line about this beat in the range bar and press **Send to chat**: the message carries the precise range reference plus a digest of the clips inside the selection (label, track kind, relative time) into the conversation on the right; the AI blends your note, the script and the language of the footage with the music prompt from the settings page, calls the model you configured and scores exactly the selection. For example:

> This beat is confrontational and driving — generate and add background music for the selected range.

To phrase it yourself, press **Copy reference** or type `@` in the conversation and pick 当前时间范围.

A successful score is trimmed exactly to the selection; a shorter asset stays in Materials with an honest note — never looped, never moving or overwriting other clips.

## Updates, disabling, and rollback

Use **Plugin updates** in the editor toolbar to check and install new versions.

Disable the plugin from DSH's plugin page. To roll back, reinstall the previous version. Project data is saved independently.

## Development

```sh
git clone https://github.com/helailai666/dsh-video-editor.git
cd dsh-video-editor
npm ci --ignore-scripts
npm run check
node --test tests/*.test.mjs
```

The runtime loads JavaScript directly. `host/` owns project, session, and resource boundaries; `client.js` provides the native workspace; `packages/` contains the independent engine. Read [development rules](docs/DEVELOPMENT.md) and the [publishing guide](docs/releases/UPDATE-CHANNEL.md).

Report problems through [Issues](https://github.com/helailai666/dsh-video-editor/issues) with your DSH/plugin version, device, and reproduction steps. See [SECURITY](SECURITY.md) for vulnerability reports.

## Acknowledgements and license

Built for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with a video engine powered by [HyperFrames](https://github.com/heygen-com/hyperframes). Thanks to the open-source community.

[MIT](LICENSE) © dsh-video-editor contributors
