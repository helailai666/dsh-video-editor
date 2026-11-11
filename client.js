/**
 * dsh-video-editor — Client half (stable workspace key: dsh-video).
 *
 * Hand-written DSH client bundle (no bundler, no JSX, no npm dependencies).
 * It contributes exactly two things:
 *
 *   1. one native sidebar navigation entry ("dsh-video-editor") in the host's
 *      `sidebar.panellist` list, immediately after the shipped panel rows and
 *      before the Workspace/Session browsing region;
 *   2. one global main panel under the `dsh-video` key, registered in the host
 *      `main` keyed slot and selected only through `ctx.layout.selectPanel`.
 *
 * Boundaries (P0-005):
 *   - the selected state is read by the host from its own layout store; the
 *     plugin keeps no second mode boolean and never registers a second nav row;
 *   - no overlay, no host-header replacement, no DOM geometry reads, no sidebar
 *     replacement, no Remote, no session events, no local project content store;
 *     project/revision/job authority stays in the Host worker, while this Client
 *     keeps only bounded view memory across a panel switch;
 *   - the main panel and the sidebar entry are one atomic pair: the panel is
 *     registered first, the entry only after it; any failure, conflict or loss
 *     releases both, and a later declaration retries. The panel can never stay
 *     registered without a reachable navigation entry;
 *   - every registration is owned by the caller fiber through `ctx.slots.inject`
 *     / `ctx.effect`, so disabling the plugin removes it and the host's
 *     `retainMainPanels` mechanism can return the UI to the conversation.
 *
 * Browser persistence is limited to the resizable AI-pane width preference,
 * versioned and corruption-safe. Project content is not stored here.
 */
window.__ModuleLoader__.load({
  id: 'dsh-video-editor',
  factory(require) {
    'use strict';

    //#region constants
    const React = require('react');
    const h = React.createElement;

    /** Main-panel key, sidebar list id, Loader row id and Client module id. */
    const PANEL_ID = 'dsh-video';
    /** Locale namespace registered for this plugin's UI text. */
    const NS = 'dshVideo';
    /** Versioned browser preference key for the resizable right pane (P3-016). */
    const LAYOUT_PREFS_KEY = 'dsh-video.layout.v1';
    const LAYOUT_PREFS_VERSION = 1;
    /**
     * Sidebar row position. The shipped panel rows use orders 0 (plugins),
     * 10 (schedules) and 20 (context). The workspace/session region is a
     * different sidebar slot rendered after the whole panel list, so any order
     * greater than 20 lands after the last shipped row and before the Workspace
     * group. 30 leaves room for future shipped rows without reordering them.
     */
    const SIDEBAR_ORDER = 30;
    //#endregion

    //#region layout splitter helpers
    /**
     * P3-016: the right AI pane is a resizable split view. The ratio is the AI
     * pane's share of the workspace width; CSS clamps it to a readable minimum,
     * a 720px maximum and a protected left stage. These helpers are pure so the
     * smoke test can execute the shipped bytes (same pattern as the canvas
     * helpers): persistence/corruption handling never depends on the DOM.
     */
    const AI_PANE_DEFAULT_RATIO = 0.42;
    const AI_PANE_RATIO_MIN = 0.2;
    const AI_PANE_RATIO_MAX = 0.7;
    const AI_PANE_KEYBOARD_STEP = 0.02;
    const AI_PANE_MIN_WIDTH = 320;
    const AI_PANE_MAX_WIDTH = 720;
    const LEFT_PANE_MIN_WIDTH = 360;

    function clampNumber(value, min, max) {
      if (value < min) return min;
      if (value > max) return max;
      return value;
    }

    /** Finite ratio clamped to the resize bounds and rounded to 0.01%. */
    function normalizeAiPaneRatio(value) {
      const number = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(number) === false) return AI_PANE_DEFAULT_RATIO;
      return Math.round(clampNumber(number, AI_PANE_RATIO_MIN, AI_PANE_RATIO_MAX) * 10000) / 10000;
    }

    /**
     * CSS width for `.dv-ai`: ratio-driven, but never below the readable AI
     * minimum, above 720px, or wider than the container minus the left minimum.
     * The narrow (stacked) container query overrides the width back to auto.
     */
    function aiPaneWidthCss(ratio) {
      const percent = String(Math.round(normalizeAiPaneRatio(ratio) * 10000) / 100);
      return (
        'clamp(' + AI_PANE_MIN_WIDTH + 'px, ' + percent + '%, min(' + AI_PANE_MAX_WIDTH +
        'px, calc(100% - ' + LEFT_PANE_MIN_WIDTH + 'px)))'
      );
    }

    /** Keyboard stepping: positive moves the divider left (wider AI pane). */
    function stepAiPaneRatio(ratio, delta) {
      return normalizeAiPaneRatio(normalizeAiPaneRatio(ratio) + Number(delta));
    }

    /** Pixel width from one drag position, clamped for the measured container. */
    function clampAiPaneWidth(width, containerWidth) {
      const container = Number(containerWidth);
      const upper = Number.isFinite(container) && container > 0
        ? Math.min(AI_PANE_MAX_WIDTH, container - LEFT_PANE_MIN_WIDTH)
        : AI_PANE_MAX_WIDTH;
      const lower = Math.min(AI_PANE_MIN_WIDTH, upper);
      const candidate = Number(width);
      if (Number.isFinite(candidate) === false) return lower;
      return clampNumber(candidate, lower, upper);
    }
    //#endregion

    //#region locale dictionaries
    const ZH = {
      'video.reference.refresh': '刷新引用',
      'video.change.uncertain': '结果未确认，重试原请求以确认状态。',
      'video.change.retry': '重试原请求',
      'video.change.conflict': '作品已更新。请查看当前内容，再预演此修改。',
      'video.change.dismiss': '放弃修改',
      'video.change.apply': '确认应用',
      'video.change.preview': '预演此修改',
      'video.change.undo': '撤销这次修改',
      'video.reference.previous': '上一页',
      'video.reference.to': '区间终点（秒）',
      'video.reference.from': '区间起点（秒）',
      'video.reference.range': '区间',
      'video.reference.asset': '素材',
      'video.reference.scene': '场景',
      'video.reference.clip': '片段',
      'video.reference.empty': '没有匹配的引用',
      'video.reference.rangeInvalid': '请输入作品时长内的有效区间',
      'video.reference.failed': '引用不可用，请重新选择',
      'video.reference.search': '搜索片段或素材',
      'video.reference.help': '选择对象，复制引用到对话；也可直接输入 @。',
      'video.reference.customRange': '自定义时间区间',
      'video.reference.title': '引用',

      'video.timeline.detachAudio': "分离音频",
      'video.timeline.noAudio': "此视频无音频",
      'video.timeline.alreadyDetached': "此片段原声已分离",
      'video.timeline.detachAudioHelp': "将视频原声放入独立音频轨",
      'video.timeline.doubleAudio': "原声已分离，重新开启会与独立音频叠加播放",
      'video.update.title': "插件更新",
      'video.update.close': "关闭更新面板",
      'video.update.busy': "请等待当前操作或导出结束",
      'video.update.version': "当前版本",
      'video.update.idle': "检查是否有新版本。",
      'video.update.checking': "正在检查更新…",
      'video.update.available': "有新版本可用。安装由 DSH 管理，作品保留在原处。期间编辑器可能重新加载，可从侧栏重新打开。",
      'video.update.availableButton': "有新版本",
      'video.update.current': "已是最新正式版。",
      'video.update.local': "当前是本地开发安装，由开发者更新；不会自动替换。",
      'video.update.unsupported': "此安装来源或 DSH 版本暂不支持在线更新。请在 DSH 插件页管理。",
      'video.update.unpublished': "尚未发布正式版本。",
      'video.update.release-unavailable': "新版本尚未提供适用于这台设备的安装包，请稍后再试。",
      'video.update.check-failed': "暂时无法检查更新，请稍后重试。",
      'video.update.installing': "正在通过 DSH 安装更新，请稍候…",
      'video.update.restart-required': "更新已安装，重启 DSH 后生效。",
      'video.update.installed': "更新已应用。重新打开编辑器可确认版本。",
      'video.update.failed': "更新未完成。请重试或在 DSH 插件页检查安装状态。",
      'video.update.notes': "查看更新说明",
      'video.update.install': "安装更新",
      'video.update.check': "检查更新",
      'video.timeline.enableOriginal': "开启视频原声",
      'video.timeline.rangeScore': "框选配乐",
      'video.timeline.rangeTitle': "配乐选区",
      'video.timeline.rangeLabel': "时间范围 {from}–{to}",
      'video.timeline.rangeDescription': "引用这个时间范围生成配乐",
      'video.timeline.rangeReady': "选区已就绪：在下方描述这段剧情的节奏，然后点「发送到聊天」。",
      'video.timeline.rangeFrom': "选区起点（秒）",
      'video.timeline.rangeTo': "选区终点（秒）",
      'video.timeline.rangeCopy': "复制引用",
      'video.timeline.rangeCopied': "已复制选区引用，可直接粘贴到对话。",
      'video.timeline.rangeNote': "剧情节奏描述",
      'video.timeline.rangeSend': "发送到聊天",
      'video.timeline.rangeSending': "发送中…",
      'video.timeline.rangeSent': "已发送到对话：AI 会撰写器乐提示词，并按选区生成和添加配乐。",
      'video.timeline.rangeSendFailed': "发送失败或状态未知：请先在对话中确认，再重试（同一请求不会重复插入）。",
      'video.timeline.rangeNoteRequired': "请先描述这段剧情的节奏与情绪。",
      'video.timeline.rangeClear': "清除选区",
      'video.timeline.rangeInvalid': "请输入作品时长内的有效范围",
      'video.timeline.rangeCopyFailed': "复制失败，请手动选择引用文本",
      'video.settings.title': "设置",
      'video.settings.tabModels': "音乐模型",
      'video.settings.tabPrompt': "系统提示词",
      'video.settings.modelsHelp': "在此添加、编辑、删除和测试音乐模型；密钥只保存在本机 Host，不会回显，也无需编辑任何配置文件。",
      'video.settings.default': "默认",
      'video.settings.builtIn': "内置",
      'video.settings.hasKey': "已配置密钥",
      'video.settings.noKey': "未配置密钥",
      'video.settings.setDefault': "设为默认",
      'video.settings.test': "测试连接",
      'video.settings.testOk': "连接成功",
      'video.settings.edit': "编辑",
      'video.settings.remove': "删除",
      'video.settings.confirmRemove': "确认删除",
      'video.settings.add': "添加音乐模型",
      'video.settings.name': "名称",
      'video.settings.protocol': "协议",
      'video.settings.protocolSync': "同步返回",
      'video.settings.protocolAsync': "异步任务",
      'video.settings.protocolStepfun': "阶跃星辰 StepFun",
      'video.settings.protocolSunoInspiration': "Suno 灵感模式",
      'video.settings.protocolSunoCustom': "Suno 专业模式（风格标签）",
      'video.settings.protocolMinimax': "MiniMax Music",
      'video.settings.hintStepfun': "阶跃星辰：纯器乐，成片时长由模型决定（通常 1–3 分钟），无法精确指定；插件会按选区自动裁剪。",
      'video.settings.hintSuno': "Suno：按次计费，每次通常返回 2 首，导入第一首完成的音频；提交后请勿连续重试。",
      'video.settings.hintMinimax': "MiniMax：同步返回，单次可能等待数分钟；2026-08-20 起付费音乐接口不再向新账户开放。",
      'video.settings.remoteModel': "远端模型 ID",
      'video.settings.apiKey': "API Key",
      'video.settings.apiKeyKeep': "留空保留现有密钥",
      'video.settings.builtInKeyHelp': "内置千问云密钥",
      'video.settings.save': "保存",
      'video.settings.cancel': "取消",
      'video.settings.saved': "设置已保存",
      'video.settings.removed': "模型已删除",
      'video.settings.defaultSet': "已设为默认配乐模型",
      'video.settings.promptHelp': "追加而非替换：你的补充指令会附加在固定规则之后，不能覆盖安全、凭据、revision 与 Tool 契约规则。",
      'video.settings.promptFixed': "固定规则由 Host 维护：工程写入边界、revision 与 operationId、凭据安全、成功判定等始终生效。",
      'video.settings.promptPlaceholder': "例如：配乐默认保持器乐、突出对抗节奏……",
      'video.settings.promptReset': "已恢复默认提示词",
      'video.timeline.disableOriginal': "关闭视频原声",
      'video.timeline.enableClipSound': "开启片段声音",
      'video.timeline.disableClipSound': "关闭片段声音",
      'video.audio.volume': "音量",
      'video.audio.fadeIn': "淡入",
      'video.audio.fadeOut': "淡出",
      'video.audio.gain': "轨道增益",
      'video.audio.mute': "静音轨道",
      'video.audio.unmute': '取消静音',
      'video.timeline.videoTrack': '视频轨道',
      'video.timeline.audioTrack': '音频轨道',
      'video.timeline.soundOnly': '仅控制声音，不隐藏画面',
      'video.audio.addTrack': "添加音轨",
      'video.audio.more': "更多编辑",
      'video.timeline.title': "时间线",
'video.timeline.loading': "正在读取时间线…",
'video.timeline.updated': "修改已保存",
'video.timeline.saved': "已保存",
'video.timeline.needTrack': "请先添加视频轨",
'video.timeline.cutHint': "将播放头移到选中片段内再切分",
'video.timeline.split': "切分",
'video.timeline.delete': "删除",
'video.timeline.duplicate': "复制片段",
'video.timeline.hideTrack':'关闭画面',
'video.timeline.showTrack':'开启画面',
'video.timeline.removeTrack':'删除轨道',
'video.timeline.removeTrackHelp':'此轨道内的片段也会删除。素材仍保留，可通过撤销恢复。',
'video.timeline.cancelDelete':'取消',
'video.timeline.confirmDelete':'确认删除轨道',
'video.timeline.swapPrevious': '与前一片段交换',
'video.timeline.swapNext': '与后一片段交换',
'video.timeline.addTrack': "添加视频轨",
'video.timeline.snap': "吸附",
      'video.timeline.playhead': '播放头',
      'video.timeline.snapOn': '吸附已开启',
      'video.timeline.snapOff': '吸附已关闭',
'video.timeline.zoom': "缩放时间线",
'video.timeline.compact': "紧凑轨道",
'video.timeline.trimIn': "调节入点",
'video.timeline.trimOut': "调节出点",
'video.timeline.track': "轨道",
'video.timeline.speed': "速度",
'video.timeline.saving': "正在保存…",
'video.timeline.hint': "选择片段 · S 切分 · 拖边精调 · Delete 删除",
'video.timeline.add': "加入时间线",

      'nav.label': 'dsh-video-editor',
      'video.back': '返回对话',
      'video.empty': '尚无工程',
      'video.open': '打开示例',
      'video.opening': '正在打开…',
      'video.title': '标题',
      'video.timing': '时间',
      'video.timing.range': '开始时间与时长超出工程时长（最长 {duration} 秒）。',
      'video.start': '开始（秒）',
      'video.duration': '时长（秒）',
      'video.update': '更新画面',
      'video.updating': '正在生成画面…',
      'video.save': '保存修改',
      'video.saving': '正在保存…',
      'video.export': '导出 MP4',
      'video.exporting': '正在导出…',
      'video.export.stage.queued': '等待引擎',
      'video.export.stage.snapshot': '准备快照',
      'video.export.stage.engine': '渲染中',
      'video.export.stage.capture': '捕获帧',
      'video.export.stage.validate': '校验中',
      'video.export.stage.finished': '收尾中',
      'video.export.elapsed': '已用 {seconds}s',
      'video.export.cancelled': '导出已取消。',
      'video.cancel': '取消',
      'video.cancelling': '正在取消…',
      'video.download': '下载 MP4',
      'video.refresh': '重新读取',
      'video.refreshing': '正在读取…',
      'video.frame.empty': '画面尚未生成',
      'video.frame.failed': '画面加载失败，请重新更新。',
      'video.frameTime': '画面时间（秒）',
      'video.frameTime.invalid': '画面时间需在工程时长范围内。',
      'video.noText': '此工程没有可编辑元素。',
      'video.details': '属性',
      'video.target': '目标',
      'video.capabilities': '能力',
      'video.edit.empty': '没有需要保存的修改。',
      'video.edit.invalidTiming': '请输入有效的开始时间和时长。',
      'video.error.frameFailed': '画面生成失败，请重试。',
      'video.error.renderFailed': '导出失败，请重试。',
      'video.error.timedOut': '操作超时，请重试。',
      'video.error.back': '返回对话失败，请重试。',
      'video.error.configuration': '视频服务尚未配置，请检查 Host 配置。',
      'video.error.network': '无法连接到视频服务。',
      'video.error.worker': '视频引擎暂时不可用。',
      'video.error.conflict': '工程已更新，请重新读取后再修改。',
      'video.error.generic': '操作失败。',
      'video.state.queued': '等待中',
      'video.state.running': '处理中',
      'video.state.cancelling': '正在取消',
      'video.state.succeeded': '已完成',
      'video.state.failed': '失败',
      'video.state.cancelled': '已取消',
      'video.state.timed_out': '超时',
      'video.ai.title': 'AI 创作',
      'video.ai.empty': '还没有创作会话',
      'video.ai.create': '开始创作',
      'video.ai.creating': '正在创建…',
      'video.ai.new': '新会话',
      'video.ai.history': '创作历史',
      'video.ai.loading': '正在打开创作会话…',
      'video.ai.unavailable': '宿主未提供原生会话入口。',
      'video.ai.disabled': '创作会话未配置（Host 缺少 sessionStatePath/sessionCwd）；画面与导出仍可用。',
      'video.ai.error': '创作会话打开失败。',
      'video.ai.retry': '重试',
      'video.ai.hostOpen': '该会话已在宿主对话中打开，请先在宿主中关闭它。',
      'video.ai.archived': '已归档',
      'video.ai.missing': '不可用',
      'video.ai.listEmpty': '当前工程还没有创作会话。',
      'video.project.label': '工程',
      'video.project.new': '新建工程',
      'video.project.untitled': '未命名作品',
      'video.project.open': '打开工程',
      'video.project.rename': '重命名工程',
      'video.project.renameHint': '点击重命名（回车保存，Esc 取消）',
      'video.project.renameEmpty': '工程名称不能为空。',
      'video.project.renameFailed': '重命名失败，请重试。',
      'video.project.reveal': '在 Finder 中显示',
      'video.project.revealGeneric': '在文件管理器中显示',
      'video.project.copyPath': '复制路径',
      'video.project.copyPathDone': '路径已复制',
      'video.project.copyPathFailed': '复制路径失败，请手动复制：',
      'video.project.revealFailed': '无法打开工程文件夹，请重试。',
      'video.save.saving': '保存中…',
      'video.save.saved': '已保存',
      'video.save.failed': '保存失败 · 重试',
      'video.save.retryHint': '面板状态保存失败，点击重试',
      'video.layout.resize': '调整面板宽度',
      'video.canvas.play': '播放',
      'video.canvas.pause': '暂停',
      'video.canvas.timeline': '时间轴',
      'video.canvas.undo': '撤销',
      'video.canvas.redo': '重做',
      'video.timeline.dropInvalid': '不能放到这里',
      'video.timeline.move.outside': '拖到轨道内放置',
      'video.timeline.move.missing': '片段已变化，请重试',
      'video.timeline.move.locked': '轨道已锁定',
      'video.timeline.move.kind': '请选择同类型轨道',
      'video.timeline.move.overlap': '目标位置已有片段',
      'video.timeline.move.extend': '工程延长至',

      'video.timeline.properties': '片段设置',
      'video.timeline.fit': '适应时间线',
      'video.timeline.history': '最近修改',
      'video.canvas.resources': '工程资源',
      'video.canvas.materials': '素材',
      'video.media.compatibility': '生成兼容预览',
      'video.media.import': '导入素材 · 或拖入文件',
      'video.media.search': '搜索素材',
      'video.media.filter': '素材类型',
      'video.media.all': '全部',
      'video.media.video': '视频',
      'video.media.image': '图片',
      'video.media.audio': '音频',
      'video.media.cancel': '取消',
      'video.media.processing': '处理中…',
      'video.media.failed': '导入失败，请重试',
      'video.media.cancelled': '已取消导入',
      'video.media.retry': '重试',
      'video.media.loading': '正在读取素材…',
      'video.media.empty': '拖入视频、图片或音频',
      'video.media.more': '加载更多',
      'video.media.waveform': '波形',
      'video.media.thumbnail': '缩略图',
      'video.media.rebuild': '重新生成预览图',
      'video.media.reference': '引用标记（选择复制）',
      'video.media.remove': '删除素材',
      'video.media.confirmRemove': '确认删除素材',
      'video.canvas.addScene': '添加场景',
      'video.canvas.export': '导出 MP4',
      'video.canvas.exporting': '正在导出…',
      'video.canvas.download': '下载 MP4',
      'video.canvas.loading': '正在准备预览',
      'video.canvas.retry': '重试',
      'video.canvas.updatingPreview': '正在更新预览',
      'video.canvas.loadTimeout': '预览准备超时，请重试。',
      'video.canvas.frameTitle': '视频预览',
      'video.canvas.runtimeError': '画布运行时错误。',
      'video.canvas.invalidStyle': '请输入有效样式。',
      'video.canvas.uploadFailed': '上传失败。',
      'video.canvas.exportFailed': '导出失败。',
      'video.canvas.sceneColor': '场景底色',
      'video.canvas.textStyle': '文字样式',
      'video.canvas.apply': '应用',
      'video.canvas.hint': '点击画布选择对象；双击文字原位修改。',
      'video.canvas.busy': '处理中…',
      'video.canvas.close': '关闭',
      'video.canvas.upload': '上传 PNG/JPEG',
      'video.canvas.uploading': '正在上传…',
      'video.canvas.noAssets': '还没有图片素材。',
      'video.canvas.useAsset': '用作画面',
      'video.canvas.newSceneTitle': '新场景',
      'video.canvas.templateUnavailable': '当前场景缺少完整的可写数据，已取消本次写入以免丢失其它内容。',
      'video.canvas.invalidColor': '场景底色无效。',
      'video.canvas.invalidAsset': '图片素材地址无效。',
      'video.canvas.layoutRefused': '该对象缺少可用的静态位置，已取消本次写入。',
      'video.canvas.layoutScaleUnknown': '无法确定该对象当前的缩放比例，已取消本次写入。',
      'video.canvas.persistFailed': '保存失败，请重试。',
      'video.canvas.retryText': '重试保存',
      'video.canvas.revisionRefreshed': '工程已更新，请再次提交保存。',
      'video.preview.booting': '正在准备工程…',
      'video.preview.empty': '描述你的想法，画面将在这里出现。',
      'video.preview.retry': '重试',
      'video.error.session': '创作会话暂不可用。',
      'video.error.sessionConfig': '创作会话尚未配置。',
      'video.error.sessionState': '创作会话记录无法读取，请检查 Host 存储。',
      'video.preview.title': '文件预览',
      'video.preview.loading': '正在打开预览…',
      'video.preview.close': '关闭预览',
      'video.preview.unsupported': '此文件类型暂不支持内嵌预览。',
      'video.preview.tooLarge': '文件过大，无法内嵌预览。',
      'video.preview.denied': '无法预览该文件：不在本会话允许的范围内。',
      'video.preview.notFound': '文件不存在或已被移动。',
      'video.preview.failed': '预览失败，请重试。',
    };

    const EN = {
      'video.reference.refresh': 'Refresh references',
      'video.change.uncertain': 'The result is unconfirmed. Retry the original request to confirm it.',
      'video.change.retry': 'Retry original request',
      'video.change.conflict': 'The project changed. Review the current content, then preview this edit.',
      'video.change.dismiss': 'Discard edit',
      'video.change.apply': 'Apply edit',
      'video.change.preview': 'Preview this edit',
      'video.change.undo': 'Undo this change',
      'video.reference.previous': 'Previous',
      'video.reference.to': 'Range end (seconds)',
      'video.reference.from': 'Range start (seconds)',
      'video.reference.range': 'Range',
      'video.reference.asset': 'Asset',
      'video.reference.scene': 'Scene',
      'video.reference.clip': 'Clip',
      'video.reference.empty': 'No matching references',
      'video.reference.rangeInvalid': 'Enter a valid range within the project.',
      'video.reference.failed': 'Reference unavailable. Please reselect.',
      'video.reference.search': 'Search clips or assets',
      'video.reference.help': 'Select an item and copy its reference into chat, or type @.',
      'video.reference.customRange': 'Custom time range',
      'video.reference.title': 'References',

      'video.timeline.detachAudio': "Detach audio",
      'video.timeline.noAudio': "This video has no audio",
      'video.timeline.alreadyDetached': "Original audio is already detached",
      'video.timeline.detachAudioHelp': "Put original audio on an independent audio track",
      'video.timeline.doubleAudio': "Audio is detached; enabling original audio will play both",
      'video.update.title': "Plugin updates",
      'video.update.close': "Close updates",
      'video.update.busy': "Wait for the current operation or export to finish",
      'video.update.version': "Current version",
      'video.update.idle': "Check for a newer release.",
      'video.update.checking': "Checking for updates…",
      'video.update.available': "A new release is available. DSH installs it; your projects stay in place. The editor may reload; reopen it from the sidebar.",
      'video.update.availableButton': "Update available",
      'video.update.current': "You have the latest stable release.",
      'video.update.local': "Local development installation. Updated by the developer, never replaced automatically.",
      'video.update.unsupported': "This source or DSH version does not support online updates. Manage it in DSH Plugins.",
      'video.update.unpublished': "No stable release has been published yet.",
      'video.update.release-unavailable': "The new release has no package for this device yet. Please try again later.",
      'video.update.check-failed': "Cannot check right now. Please try again later.",
      'video.update.installing': "DSH is installing the update. Please wait…",
      'video.update.restart-required': "Update installed. Restart DSH to use it.",
      'video.update.installed': "Update applied. Reopen the editor to confirm its version.",
      'video.update.failed': "Update did not complete. Retry or check installation status in DSH Plugins.",
      'video.update.notes': "Release notes",
      'video.update.install': "Install update",
      'video.update.check': "Check for updates",
      'video.timeline.enableOriginal': "Enable original audio",
      'video.timeline.rangeScore': "Range scoring",
      'video.timeline.rangeTitle': "Scoring range",
      'video.timeline.rangeLabel': "Range {from}–{to}",
      'video.timeline.rangeDescription': "Use this range for background scoring",
      'video.timeline.rangeReady': "Range ready: describe this beat below, then press Send to chat.",
      'video.timeline.rangeFrom': "Range start (seconds)",
      'video.timeline.rangeTo': "Range end (seconds)",
      'video.timeline.rangeCopy': "Copy reference",
      'video.timeline.rangeCopied': "Range reference copied; paste it into the conversation.",
      'video.timeline.rangeNote': "Scene rhythm note",
      'video.timeline.rangeSend': "Send to chat",
      'video.timeline.rangeSending': "Sending…",
      'video.timeline.rangeSent': "Sent to the conversation: the AI writes the instrumental prompt and scores the selection.",
      'video.timeline.rangeSendFailed': "Send failed or unconfirmed: check the conversation first, then retry (the same request is never inserted twice).",
      'video.timeline.rangeNoteRequired': "Describe the rhythm and mood of this beat first.",
      'video.timeline.rangeClear': "Clear range",
      'video.timeline.rangeInvalid': "Enter a valid range inside the project duration",
      'video.timeline.rangeCopyFailed': "Copy failed; select the reference text manually",
      'video.settings.title': "Settings",
      'video.settings.tabModels': "Music models",
      'video.settings.tabPrompt': "System prompt",
      'video.settings.modelsHelp': "Add, edit, remove and test music models here. Keys stay in the local Host, are never re-displayed, and no config file editing is required.",
      'video.settings.default': "Default",
      'video.settings.builtIn': "Built-in",
      'video.settings.hasKey': "Key configured",
      'video.settings.noKey': "No key yet",
      'video.settings.setDefault': "Set default",
      'video.settings.test': "Test connection",
      'video.settings.testOk': "Connected",
      'video.settings.edit': "Edit",
      'video.settings.remove': "Remove",
      'video.settings.confirmRemove': "Confirm remove",
      'video.settings.add': "Add music model",
      'video.settings.name': "Name",
      'video.settings.protocol': "Protocol",
      'video.settings.protocolSync': "Sync response",
      'video.settings.protocolAsync': "Async task",
      'video.settings.protocolStepfun': "StepFun Step Audio",
      'video.settings.protocolSunoInspiration': "Suno inspiration mode",
      'video.settings.protocolSunoCustom': "Suno custom mode (style tags)",
      'video.settings.protocolMinimax': "MiniMax Music",
      'video.settings.hintStepfun': "StepFun: instrumental output whose length is decided by the model (typically 1-3 minutes); the plugin trims it to your selection.",
      'video.settings.hintSuno': "Suno: billed per submit and usually returns 2 songs; the first finished one is imported. Never retry a submit blindly.",
      'video.settings.hintMinimax': "MiniMax: synchronous response that can take minutes; since 2026-08-20 the paid music API is closed to new accounts.",
      'video.settings.remoteModel': "Remote model ID",
      'video.settings.apiKey': "API Key",
      'video.settings.apiKeyKeep': "Leave blank to keep the current key",
      'video.settings.builtInKeyHelp': "Built-in Qianwen key",
      'video.settings.save': "Save",
      'video.settings.cancel': "Cancel",
      'video.settings.saved': "Settings saved",
      'video.settings.removed': "Model removed",
      'video.settings.defaultSet': "Default music model updated",
      'video.settings.promptHelp': "Append-only: your extra instructions follow the fixed rules and can never override safety, credentials, revision or Tool contracts.",
      'video.settings.promptFixed': "Fixed rules are Host-owned: project-write boundaries, revision/operationId contracts and credential safety always apply.",
      'video.settings.promptPlaceholder': "e.g. Background scores should stay instrumental with a driving rhythm…",
      'video.settings.promptReset': "Prompt restored to default",
      'video.timeline.disableOriginal': "Disable original audio",
      'video.timeline.enableClipSound': "Enable clip audio",
      'video.timeline.disableClipSound': "Disable clip audio",
      'video.audio.volume': "Volume",
      'video.audio.fadeIn': "Fade in",
      'video.audio.fadeOut': "Fade out",
      'video.audio.gain': "Track gain",
      'video.audio.mute': "Mute track",
      'video.audio.unmute': 'Unmute track',
      'video.timeline.videoTrack': 'Video track',
      'video.timeline.audioTrack': 'Audio track',
      'video.timeline.soundOnly': 'Controls sound only; video stays visible',
      'video.audio.addTrack': "Add audio track",
      'video.audio.more': "More edits",
      'video.timeline.title': "Timeline",
'video.timeline.loading': "Loading timeline…",
'video.timeline.updated': "Changes saved",
'video.timeline.saved': "Saved",
'video.timeline.needTrack': "Add a video track first",
'video.timeline.cutHint': "Move the playhead inside the selected clip",
'video.timeline.split': "Split",
'video.timeline.delete': "Delete",
'video.timeline.duplicate': "Duplicate clip",
'video.timeline.hideTrack':'Disable picture',
'video.timeline.showTrack':'Enable picture',
'video.timeline.removeTrack':'Delete track',
'video.timeline.removeTrackHelp':'Clips on this track will also be removed. Materials remain available. Undo restores the track.',
'video.timeline.cancelDelete':'Cancel',
'video.timeline.confirmDelete':'Confirm track deletion',
'video.timeline.swapPrevious': 'Swap with previous clip',
'video.timeline.swapNext': 'Swap with next clip',
'video.timeline.addTrack': "Add video track",
'video.timeline.snap': "Snap",
      'video.timeline.playhead': 'Playhead',
      'video.timeline.snapOn': 'Snapping on',
      'video.timeline.snapOff': 'Snapping off',
'video.timeline.zoom': "Timeline zoom",
'video.timeline.compact': "Compact",
'video.timeline.trimIn': "Trim in",
'video.timeline.trimOut': "Trim out",
'video.timeline.track': "Track",
'video.timeline.speed': "Speed",
'video.timeline.saving': "Saving…",
'video.timeline.hint': "Select a clip · S to split · drag edges to trim · Delete",
'video.timeline.add': "Add to timeline",

      'nav.label': 'dsh-video-editor',
      'video.back': 'Back to conversation',
      'video.empty': 'No project yet',
      'video.open': 'Open example',
      'video.opening': 'Opening…',
      'video.title': 'Title',
      'video.timing': 'Timing',
      'video.timing.range': 'Start time plus duration exceeds the project length (maximum {duration}s).',
      'video.start': 'Start (s)',
      'video.duration': 'Duration (s)',
      'video.update': 'Update frame',
      'video.updating': 'Rendering frame…',
      'video.save': 'Save changes',
      'video.saving': 'Saving…',
      'video.export': 'Export MP4',
      'video.exporting': 'Exporting…',
      'video.export.stage.queued': 'Waiting for the engine',
      'video.export.stage.snapshot': 'Preparing snapshot',
      'video.export.stage.engine': 'Rendering',
      'video.export.stage.capture': 'Capturing frames',
      'video.export.stage.validate': 'Validating',
      'video.export.stage.finished': 'Finishing',
      'video.export.elapsed': '{seconds}s elapsed',
      'video.export.cancelled': 'The export was cancelled.',
      'video.cancel': 'Cancel',
      'video.cancelling': 'Cancelling…',
      'video.download': 'Download MP4',
      'video.refresh': 'Reload project',
      'video.refreshing': 'Reloading…',
      'video.frame.empty': 'No frame yet',
      'video.frame.failed': 'The frame could not be loaded. Update it again.',
      'video.frameTime': 'Frame time (s)',
      'video.frameTime.invalid': 'Frame time must be within the project duration.',
      'video.noText': 'This project has no editable elements.',
      'video.details': 'Properties',
      'video.target': 'Target',
      'video.capabilities': 'Capabilities',
      'video.edit.empty': 'There is nothing to save.',
      'video.edit.invalidTiming': 'Enter a valid start time and duration.',
      'video.error.frameFailed': 'The frame could not be generated. Try again.',
      'video.error.renderFailed': 'The export failed. Try again.',
      'video.error.timedOut': 'The operation timed out. Try again.',
      'video.error.back': 'Could not return to the conversation. Try again.',
      'video.error.configuration': 'The video service is not configured. Check the Host configuration.',
      'video.error.network': 'Could not reach the video service.',
      'video.error.worker': 'The video engine is temporarily unavailable.',
      'video.error.conflict': 'The project changed. Reload it before editing again.',
      'video.error.generic': 'The operation failed.',
      'video.state.queued': 'Queued',
      'video.state.running': 'Running',
      'video.state.cancelling': 'Cancelling',
      'video.state.succeeded': 'Done',
      'video.state.failed': 'Failed',
      'video.state.cancelled': 'Cancelled',
      'video.state.timed_out': 'Timed out',
      'video.ai.title': 'AI creation',
      'video.ai.empty': 'No creation conversation yet',
      'video.ai.create': 'Start creating',
      'video.ai.creating': 'Starting…',
      'video.ai.new': 'New conversation',
      'video.ai.history': 'Conversation history',
      'video.ai.loading': 'Opening the creation conversation…',
      'video.ai.unavailable': 'This host does not expose the native conversation entry.',
      'video.ai.disabled': 'Creation conversations are not configured (the Host has no sessionStatePath/sessionCwd). Preview and export still work.',
      'video.ai.error': 'The creation conversation could not be opened.',
      'video.ai.retry': 'Retry',
      'video.ai.hostOpen': 'This Session is open in the host conversation. Close it there first.',
      'video.ai.archived': 'Archived',
      'video.ai.missing': 'Unavailable',
      'video.ai.listEmpty': 'This project has no creation conversation yet.',
      'video.project.label': 'Project',
      'video.project.new': 'New project',
      'video.project.untitled': 'Untitled film',
      'video.project.open': 'Open project',
      'video.project.rename': 'Rename project',
      'video.project.renameHint': 'Click to rename (Enter saves, Esc cancels)',
      'video.project.renameEmpty': 'A project name is required.',
      'video.project.renameFailed': 'Could not rename the project; try again.',
      'video.project.reveal': 'Show in Finder',
      'video.project.revealGeneric': 'Show in file manager',
      'video.project.copyPath': 'Copy path',
      'video.project.copyPathDone': 'Path copied',
      'video.project.copyPathFailed': 'Could not copy the path; copy it manually:',
      'video.project.revealFailed': 'Could not open the project folder; try again.',
      'video.save.saving': 'Saving…',
      'video.save.saved': 'Saved',
      'video.save.failed': 'Save failed · Retry',
      'video.save.retryHint': 'Panel state could not be saved; click to retry',
      'video.layout.resize': 'Resize panels',
      'video.canvas.play': 'Play',
      'video.canvas.pause': 'Pause',
      'video.canvas.timeline': 'Timeline',
      'video.canvas.undo': 'Undo',
      'video.canvas.redo': 'Redo',
      'video.timeline.dropInvalid': 'Cannot place here',
      'video.timeline.move.outside': 'Drop inside a track',
      'video.timeline.move.missing': 'Clip changed; try again',
      'video.timeline.move.locked': 'Track is locked',
      'video.timeline.move.kind': 'Choose a compatible track',
      'video.timeline.move.overlap': 'Clips overlap at this position',
      'video.timeline.move.extend': 'Film extends to',

      'video.timeline.properties': 'Clip settings',
      'video.timeline.fit': 'Fit timeline',
      'video.timeline.history': 'Recent change',
      'video.canvas.resources': 'Project resources',
      'video.canvas.materials': 'Assets',
      'video.media.compatibility': 'Build compatible preview',
      'video.media.import': 'Import media · or drop files',
      'video.media.search': 'Search media',
      'video.media.filter': 'Media type',
      'video.media.all': 'All',
      'video.media.video': 'Video',
      'video.media.image': 'Images',
      'video.media.audio': 'Audio',
      'video.media.cancel': 'Cancel',
      'video.media.processing': 'Processing…',
      'video.media.failed': 'Import failed. Try again.',
      'video.media.cancelled': 'Import cancelled',
      'video.media.retry': 'Retry',
      'video.media.loading': 'Loading media…',
      'video.media.empty': 'Drop video, images or audio',
      'video.media.more': 'Load more',
      'video.media.waveform': 'Waveform',
      'video.media.thumbnail': 'Thumbnail',
      'video.media.rebuild': 'Rebuild preview image',
      'video.media.reference': 'Reference (select to copy)',
      'video.media.remove': 'Delete media',
      'video.media.confirmRemove': 'Confirm deletion',
      'video.canvas.addScene': 'Add scene',
      'video.canvas.export': 'Export MP4',
      'video.canvas.exporting': 'Exporting…',
      'video.canvas.download': 'Download MP4',
      'video.canvas.loading': 'Preparing preview',
      'video.canvas.retry': 'Retry',
      'video.canvas.updatingPreview': 'Updating preview',
      'video.canvas.loadTimeout': 'Preview took too long. Please retry.',
      'video.canvas.frameTitle': 'Video preview',
      'video.canvas.runtimeError': 'The canvas runtime reported an error.',
      'video.canvas.invalidStyle': 'Enter a valid style.',
      'video.canvas.uploadFailed': 'The upload failed.',
      'video.canvas.exportFailed': 'The export failed.',
      'video.canvas.sceneColor': 'Scene background',
      'video.canvas.textStyle': 'Text style',
      'video.canvas.apply': 'Apply',
      'video.canvas.hint': 'Click the canvas to select an object; double-click text to edit it in place.',
      'video.canvas.busy': 'Working…',
      'video.canvas.close': 'Close',
      'video.canvas.upload': 'Upload PNG/JPEG',
      'video.canvas.uploading': 'Uploading…',
      'video.canvas.noAssets': 'No image assets yet.',
      'video.canvas.useAsset': 'Use as picture',
      'video.canvas.newSceneTitle': 'New scene',
      'video.canvas.templateUnavailable': 'This Scene does not expose complete writable data, so the write was cancelled to avoid dropping other content.',
      'video.canvas.invalidColor': 'The Scene background color is invalid.',
      'video.canvas.invalidAsset': 'The picture asset address is invalid.',
      'video.canvas.layoutRefused': 'This object has no usable static position, so the write was cancelled.',
      'video.canvas.layoutScaleUnknown': 'The current scale of this object is unknown, so the write was cancelled.',
      'video.canvas.persistFailed': 'The save failed. Try again.',
      'video.canvas.retryText': 'Retry save',
      'video.canvas.revisionRefreshed': 'The project was updated; submit the save again.',
      'video.preview.booting': 'Preparing the project…',
      'video.preview.empty': 'Describe your idea. Your film will appear here.',
      'video.preview.retry': 'Retry',
      'video.error.session': 'Creation conversations are temporarily unavailable.',
      'video.error.sessionConfig': 'Creation conversations are not configured.',
      'video.error.sessionState': 'The creation conversation record could not be read. Check the Host storage.',
      'video.preview.title': 'File preview',
      'video.preview.loading': 'Opening preview…',
      'video.preview.close': 'Close preview',
      'video.preview.unsupported': 'Inline preview does not support this file type yet.',
      'video.preview.tooLarge': 'This file is too large for an inline preview.',
      'video.preview.denied': 'This file cannot be previewed: it is outside the allowed Session scope.',
      'video.preview.notFound': 'The file no longer exists or has moved.',
      'video.preview.failed': 'The preview failed. Try again.',
    };
    //#endregion

    //#region styles
    // Only inspected theme tokens (--dsw-alias-*) are used for colors; the
    // host-published --dsh-content-font-size and --dsh-frame-top-clearance
    // variables keep typography and the macOS window-chrome clearance native.
    // The empty workspace is deliberately plain: one quiet sentence, no cards,
    // badges, stage framing, decorative motion or future-capability copy.
    const CSS = `
.dv-timeline{flex-shrink:0;border-top:1px solid var(--dsw-alias-border-l1,#ffffff12);min-height:148px;max-height:310px;background:var(--dsw-alias-bg-base,#191a1d);color:var(--dsw-alias-label-secondary,#aaaeb6);font-size:11px;position:relative}
.dv-timeline-toolbar{height:38px;display:flex;align-items:center;gap:3px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#ffffff0b)}
.dv-timeline-heading{font-size:11px;font-weight:500;letter-spacing:.04em;margin-right:12px;color:var(--dsw-alias-label-tertiary,#92959e)}
.dv-timeline-tool,.dv-timeline-more summary{border:0;background:transparent;color:inherit;display:grid;place-items:center;width:28px;height:28px;padding:0;border-radius:5px;cursor:pointer;list-style:none;font-size:18px}
.dv-timeline-tool:hover,.dv-timeline-more summary:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff0c);color:var(--dsw-alias-label-primary,#eee)}
.dv-timeline-tool:disabled{opacity:.28;cursor:default}.dv-timeline-tool:focus-visible,.dv-track-mute:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#8facbc);outline-offset:1px}
.dv-tool-divider{width:1px;height:14px;background:var(--dsw-alias-border-l1,#ffffff14);margin:0 5px}.dv-timeline-spacer{flex:1}
.dv-timeline-more{position:relative}.dv-timeline-more summary::-webkit-details-marker{display:none}.dv-timeline-menu{position:absolute;bottom:calc(100% + 6px);left:0;min-width:184px;padding:6px;background:var(--dsw-alias-bg-layer-1,#25262a);border:1px solid var(--dsw-alias-border-l1,#ffffff16);border-radius:8px;z-index:10;box-shadow:0 8px 28px #0003}.dv-timeline-menu button{display:block;width:100%;background:none;border:0;color:inherit;font:inherit;text-align:left;padding:8px;border-radius:4px;cursor:pointer}.dv-timeline-menu button:hover{background:#8881}.dv-timeline-menu button:disabled{opacity:.45;cursor:default}.dv-timeline-menu button:nth-child(4){margin-top:5px;border-top:1px solid var(--dsw-alias-border-l1,#8883);border-radius:0;padding-top:12px}.dv-timeline-menu button:last-child{margin-top:5px;border-top:1px solid var(--dsw-alias-border-l1,#8883);border-radius:0;padding-top:12px}
.dv-snap-toggle{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--dsw-alias-label-tertiary,#92959e);margin-right:8px;cursor:pointer}.dv-snap-toggle input{width:11px;height:11px;accent-color:#96afba}.dv-timeline-zoom{width:64px;height:2px;accent-color:#96afba}
.dv-timeline-scroll{overflow:auto;max-height:174px;scrollbar-width:thin;scrollbar-color:#7774 transparent}.dv-timeline-content{position:relative}.dv-timeline-ruler{height:26px;position:relative;cursor:crosshair;background:var(--dsw-alias-bg-base,#191a1d);border-bottom:1px solid var(--dsw-alias-border-l1,#ffffff0b)}.dv-timeline-ruler span{position:absolute;top:7px;border-left:1px solid var(--dsw-alias-border-l1,#ffffff1a);padding-left:5px;color:var(--dsw-alias-label-tertiary,#777d88);font-size:9px;font-variant-numeric:tabular-nums;line-height:13px}
.dv-timeline-track{display:flex;height:46px;border-bottom:1px solid var(--dsw-alias-border-l1,#ffffff0b)}.dv-timeline-track-name{width:156px;flex-shrink:0;display:flex;align-items:center;gap:4px;padding:0 9px;box-sizing:border-box;position:sticky;left:0;z-index:4;background:var(--dsw-alias-bg-base,#191a1d);border-right:1px solid var(--dsw-alias-border-l1,#ffffff0b);white-space:nowrap}.dv-track-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:10px}.dv-track-kind{display:inline-block;font-size:9px;color:var(--dsw-alias-label-tertiary,#707783);margin-right:7px}.dv-track-mute{flex-shrink:0;width:18px;height:20px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#777d88);font:inherit;font-size:9px;cursor:pointer;border-radius:3px}.dv-track-mute[aria-pressed=true]{color:#e8c887;background:#e8c88718}
.dv-timeline-lane{position:relative;background:var(--dsw-alias-bg-layer-1,#ffffff02)}.dv-timeline-clip{position:absolute;top:6px;bottom:6px;box-sizing:border-box;border:1px solid #879cb62b;background:#57729538;border-radius:4px;color:var(--dsw-alias-label-primary,#d5dce6);cursor:grab;overflow:hidden;touch-action:none;display:flex;align-items:center}.dv-timeline-clip.is-audio{background:#568c7b2b;border-color:#7bb59c2b}.dv-timeline-clip.is-selected{outline:1px solid #a9c1d6;outline-offset:-1px;background:#57729565}.dv-timeline-clip.is-audio.is-selected{outline-color:#9dcdb7;background:#568c7b4a}.dv-timeline-clip-label{padding:0 9px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;pointer-events:none;font-size:10px;z-index:1}.dv-clip-waveform{position:absolute;left:0;top:8px;width:100%;height:calc(100% - 8px);opacity:.42;object-fit:fill;pointer-events:none}.is-audio .dv-timeline-clip-label{align-self:flex-start;font-size:9px;line-height:15px;text-shadow:0 1px 4px #171a1b}
.dv-timeline-edge{position:absolute;left:0;top:0;bottom:0;width:6px;cursor:ew-resize;z-index:2;opacity:0;background:#ffffff22}.dv-timeline-clip:hover .dv-timeline-edge,.dv-timeline-clip.is-selected .dv-timeline-edge{opacity:1}.dv-timeline-edge-out{left:auto;right:0}.dv-timeline-playhead{position:absolute;top:0;bottom:0;width:1px;background:#e1ab7e;pointer-events:none;z-index:3}.dv-timeline-playhead:before{content:'';position:absolute;top:0;left:-3px;border:4px solid transparent;border-top-color:#e1ab7e}
.dv-timeline-inspector{display:flex;align-items:center;gap:12px;min-height:34px;padding:4px 12px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l1,#ffffff0b);font-size:10px}.dv-timeline-inspector label{display:flex;gap:5px;align-items:center;white-space:nowrap}.dv-inspector-name{white-space:nowrap;max-width:80px;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary,#777d88)}.dv-timeline-inspector select,.dv-timeline-inspector input{color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l1,#ffffff14);border-radius:4px;font:inherit;height:23px;padding:0 4px;box-sizing:border-box;max-width:85px}.dv-timeline-inspector input{width:43px}.dv-timeline-notice{padding:3px 12px 5px;color:var(--dsw-alias-label-tertiary,#777d88);min-height:12px;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dv-timeline-compact .dv-timeline-track{height:30px}.dv-timeline-compact .dv-timeline-clip{top:3px;bottom:3px}
@media(max-width:480px){.dv-timeline-toolbar{padding:0 7px}.dv-timeline-heading{display:none}.dv-timeline-inspector{gap:8px}.dv-inspector-name{display:none}.dv-timeline-zoom{width:40px}}


.dv-root{
  --dv-dur-fast:120ms;
  --dv-dur-med:160ms;
  --dv-ease:cubic-bezier(.2,.8,.2,1);
  box-sizing:border-box;
  display:flex;
  flex-direction:column;
  width:100%;
  height:100%;
  min-width:0;
  min-height:0;
  overflow:hidden;
  container-type:inline-size;
  container-name:dsh-video;
  background:var(--dsw-alias-bg-base, #1a1a1c);
  color:var(--dsw-alias-label-primary, #f2f2f5);
  font-family:inherit;
  font-size:var(--dsh-content-font-size, 14px);
  line-height:1.5;
  /* P3-028: the host may publish a large --dsh-frame-leading-clearance when the
     macOS sidebar is collapsed (160px) because its own title row shares the
     window-chrome seat. This panel's topbar already sits below that seat via
     --dsh-frame-top-clearance, so re-applying the full leading clearance would
     shift the back button / project name to the right. Darwin therefore clamps
     the topbar leading to its normal padding; other platforms keep the host
     safety clearance. */
  --dv-topbar-leading:max(16px, var(--dsh-frame-leading-clearance, 0px));
  animation:dv-panel-in var(--dv-dur-med) var(--dv-ease) both;
}
[data-platform="darwin"] .dv-root{
  --dv-topbar-leading:16px;
}
.dv-root *,.dv-root *::before,.dv-root *::after{box-sizing:border-box;}
@keyframes dv-panel-in{
  from{opacity:0;transform:translateY(2px);}
  to{opacity:1;transform:none;}
}
.dv-topbar{
  display:flex;
  align-items:center;
  gap:8px;
  flex:none;
  min-height:56px;
  padding:8px 20px 8px var(--dv-topbar-leading);
  border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.28)) 62%, transparent);
}
[data-platform="darwin"] .dv-topbar{
  padding-top:calc(8px + var(--dsh-frame-top-clearance, 0px));
}
.dv-back{
  display:inline-flex;
  align-items:center;
  gap:6px;
  flex:none;
  height:32px;
  padding:0 10px;
  border:0;
  border-radius:8px;
  background:transparent;
  color:var(--dsw-alias-label-secondary, #a4a4ad);
  font:inherit;
  font-size:.86em;
  cursor:pointer;
  -webkit-app-region:no-drag;
  transition:color var(--dv-dur-fast) var(--dv-ease), background var(--dv-dur-fast) var(--dv-ease);
}
.dv-back:hover{
  color:var(--dsw-alias-label-primary, #f2f2f5);
  background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,140,.14));
}
.dv-back:focus-visible{
  outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #5b8cff));
  outline-offset:2px;
}
.dv-back-label{white-space:nowrap;}
.dv-sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0;}
.dv-spacer{flex:1;min-width:0;}
/* P3-017 B3: product export control in the topbar (right side). P3-016 keeps the
   project name/arrow on the left and removed the display-settings menu. */
.dv-export{display:inline-flex;align-items:center;gap:8px;flex:none;min-width:0;}
.dv-export-status{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:220px;color:var(--dsw-alias-label-secondary,#a4a4ad);font-size:.78em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;}
.dv-export-note{color:var(--dsw-alias-label-secondary,#a4a4ad);font-size:.78em;white-space:nowrap;}
.dv-export-error{color:var(--dsw-alias-label-secondary,#a4a4ad);font-size:.78em;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dv-export .dv-button{min-height:30px;padding:0 12px;}
.dv-export .dv-loader{width:12px;height:12px;border-width:1.5px;flex:none;}
.dv-export-spinner{flex:none;}
.dv-export-cancel{min-height:30px;padding:0 8px;}
.dv-export-link{text-decoration:none;}
/* P3-016: draggable divider between the read-only stage and the AI pane. The
   hit area overhangs the 1px rule so it is easy to grab without a visible
   gutter; the pane width itself is driven by the --dv-ai-width variable. */
.dv-splitter{
  position:relative;
  z-index:2;
  flex:none;
  width:9px;
  margin:0 -4px;
  padding:0;
  border:0;
  background:transparent;
  cursor:col-resize;
  touch-action:none;
  -webkit-app-region:no-drag;
}
.dv-splitter::before{
  content:'';
  position:absolute;
  top:0;
  bottom:0;
  left:50%;
  width:1px;
  transform:translateX(-50%);
  background:transparent;
  transition:background var(--dv-dur-fast) var(--dv-ease);
}
.dv-splitter:hover::before,.dv-splitter:focus-visible::before,.dv-splitter[data-dragging="true"]::before{
  background:var(--dsw-alias-border-l1, rgba(127,127,140,.5));
}
.dv-splitter:focus-visible{
  outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #5b8cff));
  outline-offset:-3px;
  border-radius:4px;
}
.dv-main[data-resizing="true"]{user-select:none;}
.dv-icon-button{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  width:32px;
  height:32px;
  padding:0;
  border:0;
  border-radius:8px;
  background:transparent;
  color:var(--dsw-alias-label-secondary, #a4a4ad);
  cursor:pointer;
  -webkit-app-region:no-drag;
  transition:color var(--dv-dur-fast) var(--dv-ease), background var(--dv-dur-fast) var(--dv-ease);
}
.dv-icon-button:hover,.dv-icon-button[aria-expanded="true"]{
  color:var(--dsw-alias-label-primary, #f2f2f5);
  background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,140,.14));
}
.dv-icon-button:focus-visible{
  outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #5b8cff));
  outline-offset:2px;
}
.dv-main{
  display:flex;
  flex:1;
  flex-direction:row;
  min-width:0;
  min-height:0;
  overflow:hidden;
}
.dv-left{
  display:flex;
  flex:1;
  flex-direction:column;
  min-width:0;
  min-height:0;
  overflow:hidden;
}
.dv-ai{
  display:flex;
  flex:none;
  flex-direction:column;
  /* P3-016: --dv-ai-width is set inline from the dragged/persisted ratio; the
     fallback is the same 42% default with a readable minimum, a 720px maximum
     and a protected left stage. The stacked (narrow container) query below
     overrides width back to auto. */
  width:var(--dv-ai-width, clamp(320px, 42%, min(720px, calc(100% - 360px))));
  min-width:0;
  min-height:0;
  border-left:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.28)) 62%, transparent);
  background:var(--dsw-alias-bg-base, #1a1a1c);
  position:relative;
}
.dv-ai-head{
  display:flex;
  flex:none;
  align-items:center;
  justify-content:space-between;
  gap:8px;
  min-height:56px;
  padding:10px 20px;
  border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.28)) 40%, transparent);
}
.dv-ai-heading{
  display:flex;
  align-items:baseline;
  gap:8px;
  min-width:0;
}
.dv-ai-title{
  flex:none;
  color:var(--dsw-alias-label-primary, #f2f2f5);
  font-size:.9em;
  font-weight:600;
}
/* M2 media drawer floats over the preview, preserving the conversation width. */
.dv-drawer.dv-media-library{width:min(360px,calc(100% - 16px));max-height:calc(100% - 56px);overflow:auto;gap:12px;z-index:12;}
.dv-media-search,.dv-media-reference input{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid var(--dsw-alias-border-secondary,#ffffff20);border-radius:8px;background:transparent;color:inherit;font:inherit;}
.dv-media-filters{display:flex;gap:2px;flex-wrap:wrap;}
.dv-media-filters [aria-pressed="true"],.dv-media-tile[aria-pressed="true"]{background:var(--dsw-alias-fill-secondary,#ffffff12);outline:1px solid var(--dsw-alias-label-secondary,#999);}
.dv-media-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}
.dv-media-tile{display:flex;flex-direction:column;gap:5px;min-width:0;padding:7px;text-align:left;background:transparent;color:inherit;border:1px solid var(--dsw-alias-border-secondary,#ffffff14);border-radius:8px;cursor:pointer;}
.dv-media-tile img,.dv-media-placeholder{width:100%;height:76px;object-fit:contain;background:#00000018;border-radius:4px;}
.dv-media-placeholder{display:grid;place-items:center;font-size:28px;}
.dv-media-name{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dv-media-tile small{opacity:.6;font-variant-numeric:tabular-nums;}
.dv-media-detail{display:flex;flex-direction:column;gap:10px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-secondary,#ffffff20);overflow-wrap:anywhere;}
.dv-media-preview{width:100%;max-height:180px;object-fit:contain;}
.dv-media-derived{width:100%;max-height:100px;object-fit:contain;}
.dv-media-progress{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:.85em;}
.dv-media-progress span:first-child{width:100%;overflow-wrap:anywhere;}
.dv-upload:focus-within{outline:2px solid var(--dsw-focus-ring-color,#4578dd);outline-offset:2px;}
.dv-media-reference{font-size:.8em;opacity:.8;}
.dv-ai-session{
  min-width:0;
  overflow:hidden;
  color:var(--dsw-alias-label-tertiary, #7f7f88);
  font-size:.78em;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.dv-ai-actions{display:flex;flex:none;align-items:center;gap:4px;}
.dv-history-toggle,.dv-new-session{width:36px;height:36px;}
.dv-ai-body{
  display:flex;
  flex:1;
  flex-direction:column;
  min-width:0;
  min-height:0;
  overflow:hidden;
}
.dv-ai-body > *{min-width:0;min-height:0;}
/* Own full-height boundary; only stable native region attributes are used.
   Native Composer, approvals, model selection, scroll and editor stay mounted. */
.dv-conversation{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;overflow:hidden;}
.dv-conversation > *{flex:1;min-height:0;}
.dv-conversation [data-conversation-content]{flex:1;min-height:0;height:100%;}
.dv-conversation [data-conversation-scroll]{display:flex;flex:1;flex-direction:column;min-height:0;}
.dv-conversation [data-conversation-scroll] > [data-slot="conversation.session"]{display:flex;flex:1 0 auto;flex-direction:column;min-height:0;}
.dv-conversation [data-conversation-region="composer"]{flex-shrink:0;margin-top:auto;}

.dv-preview{
  position:absolute;
  inset:0;
  z-index:6;
  display:flex;
  flex-direction:column;
  min-width:0;
  min-height:0;
  background:var(--dsw-alias-bg-layer-1, #232327);
}
.dv-preview-head{
  display:flex;
  flex:none;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  padding:10px 12px;
  border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.28)) 62%, transparent);
}
.dv-preview-title{
  min-width:0;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  color:var(--dsw-alias-label-primary, #f2f2f5);
  font-size:.86em;
}
.dv-preview-close{
  flex:none;
  min-height:28px;
  padding:0 9px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.32)) 82%, transparent);
  border-radius:8px;
  background:transparent;
  color:var(--dsw-alias-label-primary, #f2f2f5);
  font:inherit;
  font-size:.8em;
  cursor:pointer;
}
.dv-preview-close:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,140,.14));}
.dv-preview-body{
  display:flex;
  flex:1;
  align-items:center;
  justify-content:center;
  min-width:0;
  min-height:0;
  padding:12px;
  overflow:auto;
}
.dv-preview-image{
  display:block;
  max-width:100%;
  max-height:100%;
  object-fit:contain;
  border-radius:6px;
  background:var(--dsw-alias-bg-base, #1a1a1c);
}
.dv-preview-status{
  margin:0;
  padding:12px;
  color:var(--dsw-alias-label-secondary, #a4a4ad);
  font-size:.84em;
  text-align:center;
}
.dv-preview-status[data-error="true"]{color:var(--dsw-alias-state-error-primary, #e06c75);}
.dv-ai-loading,.dv-ai-hint,.dv-ai-notice{
  margin:0;
  padding:14px;
  color:var(--dsw-alias-label-secondary, #a4a4ad);
  font-size:.84em;
  text-align:left;
}
.dv-ai-error{
  display:flex;
  flex:1;
  flex-direction:column;
  align-items:flex-start;
  gap:10px;
  padding:14px;
}
.dv-ai-error .dv-error{max-width:none;text-align:left;}
.dv-ai-empty{
  display:flex;
  flex:1;
  flex-direction:column;
  align-items:flex-start;
  justify-content:center;
  gap:12px;
  padding:18px;
}
.dv-history-menu{
  position:absolute;
  top:44px;
  right:10px;
  z-index:3;
  display:flex;
  flex-direction:column;
  gap:2px;
  min-width:240px;
  max-width:calc(100% - 20px);
  max-height:320px;
  overflow:auto;
  padding:6px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.28)) 84%, transparent);
  border-radius:10px;
  background:var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #232327));
  box-shadow:0 12px 32px -20px rgba(0,0,0,.5);
}
.dv-history-item{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  width:100%;
  min-height:32px;
  padding:0 9px;
  border:0;
  border-radius:7px;
  background:transparent;
  color:var(--dsw-alias-label-primary, #f2f2f5);
  font:inherit;
  font-size:.82em;
  text-align:left;
  cursor:pointer;
}
.dv-history-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,140,.14));}
.dv-history-item[aria-checked="true"]{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,140,.14));}
.dv-history-item:disabled{opacity:.55;cursor:default;}
.dv-history-item:focus-visible{
  outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #5b8cff));
  outline-offset:-2px;
}
.dv-history-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dv-history-state{flex:none;color:var(--dsw-alias-label-tertiary, #7f7f88);font-size:.92em;}
.dv-emptywrap{
  display:flex;
  flex:1;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  gap:14px;
  min-width:0;
  min-height:0;
  padding:24px;
}
.dv-empty{
  margin:0;
  color:var(--dsw-alias-label-secondary, #a4a4ad);
  font-size:1em;
}
.dv-error{
  margin:0;
  max-width:38em;
  color:var(--dsw-alias-state-error-primary, #e5484d);
  font-size:.86em;
  text-align:center;
}
.dv-editor{
  display:flex;
  flex:1;
  flex-direction:column;
  min-width:0;
  min-height:0;
}
.dv-stage{
  display:flex;
  flex:1;
  flex-direction:column;
  gap:12px;
  min-width:0;
  min-height:0;
  padding:16px;
}
.dv-stagebar{
  display:flex;
  align-items:baseline;
  justify-content:space-between;
  gap:12px;
  min-height:28px;
}
.dv-project-title{
  min-width:0;
  overflow:hidden;
  color:var(--dsw-alias-label-primary, #f2f2f5);
  font-size:1.08em;
  font-weight:600;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.dv-project-meta{
  flex:none;
  color:var(--dsw-alias-label-secondary, #a4a4ad);
  font-size:.8em;
  font-variant-numeric:tabular-nums;
  white-space:nowrap;
}
.dv-canvas{
  position:relative;
  display:flex;
  flex:1;
  align-items:center;
  justify-content:center;
  min-height:200px;
  overflow:hidden;
  border:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.28)) 70%, transparent);
  border-radius:10px;
  background:var(--dsw-alias-bg-layer-1, #232327);
}
.dv-frame{
  display:block;
  max-width:100%;
  max-height:100%;
  object-fit:contain;
}
.dv-canvas-note{
  margin:0;
  max-width:32em;
  padding:16px;
  color:var(--dsw-alias-label-secondary, #a4a4ad);
  font-size:.86em;
  text-align:center;
}
.dv-controls{
  display:flex;
  flex:none;
  flex-wrap:wrap;
  align-items:flex-end;
  gap:12px;
  max-height:44%;
  min-height:0;
  overflow:auto;
  padding:12px 16px 16px;
  border-top:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.28)) 62%, transparent);
}
.dv-controls > .dv-field{min-width:130px;flex:0 1 180px;}
.dv-controls > .dv-field-row{flex:1 1 260px;}
.dv-controls > .dv-field-row .dv-field{min-width:110px;}
.dv-controls > .dv-actions{width:100%;}
.dv-controls > .dv-details{width:100%;}
.dv-controls > .dv-note,.dv-controls > .dv-error{width:100%;}
.dv-controls > .dv-job{width:100%;}
.dv-actions{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
}
.dv-button{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  min-height:32px;
  padding:0 12px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.28)) 86%, transparent);
  border-radius:8px;
  background:transparent;
  color:var(--dsw-alias-label-primary, #f2f2f5);
  font:inherit;
  font-size:.86em;
  cursor:pointer;
  transition:background var(--dv-dur-fast) var(--dv-ease), border-color var(--dv-dur-fast) var(--dv-ease), opacity var(--dv-dur-fast) var(--dv-ease);
}
.dv-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,140,.14));}
.dv-button:focus-visible{
  outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #5b8cff));
  outline-offset:2px;
}
.dv-button:disabled{opacity:.55;cursor:default;}
.dv-button-primary{
  border-color:transparent;
  background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #5b8cff));
  color:var(--dsw-alias-label-primary-foreground, #fff);
}
.dv-button-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #5b8cff));}
.dv-button-primary:disabled{
  opacity:1;
  background:var(--dsw-alias-button-primary-dimmed, var(--dsw-alias-interactive-bg-hover, rgba(127,127,140,.14)));
  color:var(--dsw-alias-label-secondary, #a4a4ad);
}
.dv-button-quiet{color:var(--dsw-alias-label-secondary, #a4a4ad);}
.dv-field{
  display:flex;
  flex-direction:column;
  gap:6px;
}
.dv-field-row{
  display:flex;
  gap:8px;
}
.dv-field-row .dv-field{flex:1;min-width:0;}
.dv-label{
  color:var(--dsw-alias-label-secondary, #a4a4ad);
  font-size:.8em;
}
.dv-input{
  width:100%;
  min-width:0;
  height:32px;
  padding:0 9px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.28)) 86%, transparent);
  border-radius:8px;
  background:var(--dsw-alias-bg-base, #1a1a1c);
  color:var(--dsw-alias-label-primary, #f2f2f5);
  font:inherit;
  font-size:.86em;
}
.dv-input:focus-visible{
  outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #5b8cff));
  outline-offset:1px;
}
.dv-note{
  margin:0;
  color:var(--dsw-alias-label-secondary, #a4a4ad);
  font-size:.8em;
}
.dv-job{
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  gap:8px;
  color:var(--dsw-alias-label-secondary, #a4a4ad);
  font-size:.8em;
}
.dv-job-state{
  color:var(--dsw-alias-label-primary, #f2f2f5);
}
.dv-download{
  color:var(--dsw-alias-brand-primary, #5b8cff);
  font-size:.86em;
  text-decoration:none;
}
.dv-download:hover{text-decoration:underline;}
.dv-download:focus-visible{
  outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #5b8cff));
  outline-offset:2px;
}
.dv-details{
  padding-top:10px;
  border-top:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.28)) 62%, transparent);
  color:var(--dsw-alias-label-secondary, #a4a4ad);
  font-size:.8em;
}
.dv-details summary{cursor:pointer;color:var(--dsw-alias-label-primary, #f2f2f5);}
.dv-meta-list{
  display:flex;
  flex-direction:column;
  gap:6px;
  margin:8px 0 0;
  padding:0;
  list-style:none;
}
.dv-meta-item{
  min-width:0;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.dv-controls .dv-error{
  max-width:none;
  text-align:left;
}

/* P3-016 topbar: back button -> clickable work name -> project menu arrow.
   The name itself is the inline-rename trigger; the arrow only opens the picker
   so a click on the title never silently switches projects. */
.dv-projectbar{position:relative;display:flex;align-items:center;gap:2px;min-width:0;max-width:min(60%, 420px);-webkit-app-region:no-drag;}
.dv-project-name{
  min-width:0;
  max-width:320px;
  height:32px;
  padding:0 8px;
  border:0;
  border-radius:8px;
  background:transparent;
  color:var(--dsw-alias-label-primary,#f2f2f5);
  font:inherit;
  font-size:.94em;
  font-weight:550;
  text-align:left;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
  cursor:text;
  transition:background var(--dv-dur-fast) var(--dv-ease);
}
.dv-project-name:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,140,.12));}
.dv-project-name:focus-visible,.dv-project-name-input:focus-visible{
  outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#5b8cff));
  outline-offset:2px;
}
.dv-project-name:disabled{opacity:.55;cursor:default;}
.dv-project-name-input{
  width:min(260px, 40vw);
  min-width:140px;
  max-width:320px;
  height:32px;
  padding:0 8px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,rgba(127,127,140,.28)) 86%,transparent);
  border-radius:8px;
  background:var(--dsw-alias-bg-base,#1a1a1c);
  color:var(--dsw-alias-label-primary,#f2f2f5);
  font:inherit;
  font-size:.94em;
  font-weight:550;
}
.dv-project-name-input:disabled{opacity:.6;}
.dv-project-toggle{width:28px;height:28px;}
.dv-project-menu{
  position:absolute;
  top:calc(100% + 6px);
  left:0;
  z-index:3;
  display:flex;
  flex-direction:column;
  gap:2px;
  min-width:220px;
  max-width:min(340px, calc(100vw - 48px));
  max-height:320px;
  overflow:auto;
  padding:6px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.28)) 84%, transparent);
  border-radius:10px;
  background:var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1,#232327));
  box-shadow:0 12px 32px -20px rgba(0,0,0,.5);
  -webkit-app-region:no-drag;
}
.dv-project-item{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  width:100%;
  min-height:32px;
  padding:0 9px;
  border:0;
  border-radius:7px;
  background:transparent;
  color:var(--dsw-alias-label-primary,#f2f2f5);
  font:inherit;
  font-size:.84em;
  text-align:left;
  cursor:pointer;
}
.dv-project-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,140,.14));}
.dv-project-item[aria-checked="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,140,.14));}
.dv-project-item:disabled{opacity:.55;cursor:default;}
.dv-project-item:focus-visible{
  outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#5b8cff));
  outline-offset:-2px;
}
.dv-project-item-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dv-project-item-check{flex:none;min-width:1em;color:var(--dsw-alias-label-secondary,#a4a4ad);text-align:center;}
.dv-project-separator{height:1px;margin:4px 6px;background:color-mix(in srgb,var(--dsw-alias-border-l1,rgba(127,127,140,.28)) 62%,transparent);}
.dv-project-folder-notice{margin:0 8px;max-width:min(420px,42vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.78em;color:var(--dsw-alias-label-secondary,#a4a4ad);}
.dv-project-folder-notice[data-kind="error"]{color:var(--dsw-alias-state-error-primary,#e06c75);}
.dv-save-status{flex:none;margin-right:6px;padding:0 8px;height:22px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,rgba(127,127,140,.32)) 82%,transparent);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#a4a4ad);font:inherit;font-size:.72em;line-height:20px;cursor:default;white-space:nowrap;}
.dv-save-status[data-status="failed"]{color:var(--dsw-alias-state-error-primary,#e06c75);cursor:pointer;}
.dv-save-status:disabled{opacity:1;}
.dv-folder-button{flex:none;margin-left:2px;}
@media (max-width: 640px){.dv-folder-button{display:none;}}
.dv-project-rename-error{
  min-width:0;
  margin:0;
  overflow:hidden;
  color:var(--dsw-alias-state-error-primary,#e5484d);
  font-size:.78em;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.dv-canvas-shell{
  display:flex;
  flex:1;
  flex-direction:column;
  min-width:0;
  min-height:0;
  padding:8px 16px 14px;
  gap:8px;
  position:relative;
}
.dv-canvas-bar{
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  gap:6px;
  flex:none;
}
.dv-canvas-bar .dv-button{min-height:28px;padding:0 9px;font-size:.8em;}
.dv-seek{flex:1;min-width:60px;height:20px;margin:0;appearance:none;background:transparent;accent-color:var(--dsw-alias-label-primary,#f2f2f5);cursor:pointer;}
.dv-seek::-webkit-slider-runnable-track{height:3px;border-radius:99px;background:var(--dsw-alias-border-l1,rgba(127,127,140,.28));}
.dv-seek::-webkit-slider-thumb{appearance:none;width:10px;height:10px;margin-top:-3.5px;border:0;border-radius:50%;background:var(--dsw-alias-label-primary,#f2f2f5);transition:box-shadow var(--dv-dur-fast) var(--dv-ease);}
.dv-seek::-moz-range-track{height:3px;border-radius:99px;background:var(--dsw-alias-border-l1,rgba(127,127,140,.28));}
.dv-seek::-moz-range-thumb{width:10px;height:10px;border:0;border-radius:50%;background:var(--dsw-alias-label-primary,#f2f2f5);}
.dv-seek:hover:not(:disabled)::-webkit-slider-thumb{box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-label-primary,#f2f2f5) 8%,transparent);}
.dv-seek:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#5b8cff));outline-offset:4px;border-radius:4px;}
.dv-seek:disabled{opacity:.35;cursor:default;}
.dv-time{color:var(--dsw-alias-label-secondary,#a4a4ad);font-size:.78em;font-variant-numeric:tabular-nums;white-space:nowrap;}
.dv-export-link{text-decoration:none;display:inline-flex;align-items:center;}
.dv-canvas-wrap{
  position:relative;
  display:flex;
  flex:1;
  align-items:center;
  justify-content:center;
  min-width:0;
  min-height:0;
  overflow:hidden;
  border:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.28)) 64%, transparent);
  border-radius:10px;
  background:var(--dsw-alias-bg-base,#1a1a1c);
}
.dv-stage{position:relative;overflow:hidden;background:#000;box-shadow:0 12px 32px -24px rgba(0,0,0,.65);}
.dv-stage.dv-canvas-stage{display:block;flex:none;padding:0;}
.dv-stage-frame{position:absolute;top:0;left:0;border:0;background:#000;}
.dv-stage-frame-candidate{pointer-events:none;}
.dv-canvas-status-overlay{
  position:absolute;
  inset:0;
  display:flex;
  align-items:center;
  justify-content:center;
  margin:0;
  padding:0;
  pointer-events:none;
}
.dv-preview-notice{
  display:flex;
  flex:none;
  flex-wrap:wrap;
  align-items:center;
  gap:8px;
  padding:6px 10px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 45%, transparent);
  border-radius:8px;
  background:var(--dsw-alias-bg-layer-1, #232327);
  color:var(--dsw-alias-state-error-primary, #e5484d);
  font-size:.8em;
}
.dv-preview-notice-text{min-width:0;overflow:hidden;text-overflow:ellipsis;}
.dv-preview-notice-retry{min-height:24px;padding:0 8px;font-size:.92em;}
.dv-overlay{position:absolute;inset:0;cursor:default;touch-action:none;}
.dv-selection{
  position:absolute;
  border:1.5px solid var(--dsw-alias-state-business-primary,#6f8cff);
  background:transparent;
  cursor:move;
  box-shadow:0 0 0 1px rgba(0,0,0,.25);
}
.dv-handle{
  position:absolute;
  width:9px;
  height:9px;
  border-radius:2px;
  border:1px solid var(--dsw-alias-state-business-primary,#6f8cff);
  background:var(--dsw-alias-bg-layer-1,#232327);
}
.dv-handle-nw{left:-5px;top:-5px;cursor:nwse-resize;}
.dv-handle-ne{right:-5px;top:-5px;cursor:nesw-resize;}
.dv-handle-sw{left:-5px;bottom:-5px;cursor:nesw-resize;}
.dv-handle-se{right:-5px;bottom:-5px;cursor:nwse-resize;}
.dv-inline-editor{
  position:absolute;
  z-index:2;
  min-width:80px;
  padding:2px 4px;
  border:1px solid var(--dsw-alias-state-business-primary,#6f8cff);
  border-radius:3px;
  background:var(--dsw-alias-bg-overlay,#232327);
  color:var(--dsw-alias-label-primary,#f2f2f5);
  font:inherit;
  resize:none;
}
.dv-editor-actions{
  position:absolute;
  z-index:3;
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  gap:6px;
  max-width:min(320px, 90%);
  padding:3px 6px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #e06c75) 55%, transparent);
  border-radius:5px;
  background:var(--dsw-alias-bg-overlay,#232327);
  box-shadow:0 8px 20px -14px rgba(0,0,0,.6);
  font-size:.74em;
}
.dv-editor-actions .dv-button{min-height:22px;padding:0 7px;font-size:.92em;}
.dv-editor-actions .dv-editor-retry{flex:none;}
.dv-editor-actions .dv-tool-error{min-width:0;overflow:hidden;text-overflow:ellipsis;}
.dv-canvas-status{
  margin:auto;
  padding:14px;
  color:var(--dsw-alias-label-secondary,#a4a4ad);
  font-size:.84em;
  text-align:center;
}
.dv-canvas-status .dv-button{margin-top:10px;}
.dv-canvas-tools{
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  gap:10px;
  min-height:28px;
  flex:none;
  font-size:.8em;
}
.dv-tool-field{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#a4a4ad);}
.dv-tool-field input[type="color"]{width:28px;height:24px;padding:1px;border:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.32)) 80%, transparent);border-radius:5px;background:transparent;}
.dv-size-input{width:52px;height:24px;border:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.32)) 80%, transparent);border-radius:5px;background:var(--dsw-alias-bg-layer-1,#232327);color:var(--dsw-alias-label-primary,#f2f2f5);font:inherit;font-size:.95em;padding:0 4px;}
.dv-tool-hint{color:var(--dsw-alias-label-tertiary,#7f7f88);}
.dv-tool-error{color:var(--dsw-alias-state-error-primary,#e06c75);}
.dv-drawer{
  position:absolute;
  top:44px;
  left:16px;
  bottom:44px;
  z-index:4;
  display:flex;
  flex-direction:column;
  gap:8px;
  width:min(260px, calc(100% - 32px));
  padding:10px;
  overflow:auto;
  border:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.28)) 82%, transparent);
  border-radius:10px;
  background:var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1,#232327));
  box-shadow:0 12px 32px -20px rgba(0,0,0,.5);
}
.dv-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:.86em;}
.dv-upload{display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:0 8px;border:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.32)) 82%, transparent);border-radius:7px;color:var(--dsw-alias-label-primary,#f2f2f5);cursor:pointer;font-size:.8em;}
.dv-upload input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;}
.dv-asset-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;}
.dv-asset-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;padding:2px 0;}
.dv-asset-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.78em;}
.dv-asset-row .dv-button{min-height:24px;padding:0 7px;font-size:.74em;}
.dv-empty-actions{display:flex;flex-wrap:wrap;gap:8px;}
.dv-managed-stage{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;}
.dv-left{background:color-mix(in srgb,var(--dsw-alias-bg-base,#1a1a1c) 96%,var(--dsw-alias-label-primary,#f2f2f5));}
.dv-canvas-shell[data-preview-only="true"]{padding:24px;gap:16px;}
.dv-canvas-shell[data-preview-only="true"] .dv-canvas-wrap{border:0;border-radius:0;background:transparent;}
.dv-canvas-shell[data-preview-only="true"] .dv-canvas-stage{border-radius:6px;box-shadow:0 12px 36px -20px rgba(0,0,0,.32);}
.dv-canvas-shell[data-preview-only="true"] .dv-canvas-stage[data-ready="false"]{background:transparent;box-shadow:none;}
.dv-canvas-shell[data-preview-only="true"] .dv-canvas-bar{
  align-self:center;
  flex-wrap:nowrap;
  gap:14px;
  width:min(100%, 560px);
  min-height:52px;
  padding:6px 16px 6px 8px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,rgba(127,127,140,.28)) 55%,transparent);
  border-radius:16px;
  background:var(--dsw-alias-bg-base,#1a1a1c);
  box-shadow:0 4px 16px -10px rgba(0,0,0,.16);
}
.dv-canvas-bar .dv-play{flex:none;width:36px;min-height:36px;padding:0;border:0;border-radius:50%;color:var(--dsw-alias-label-primary,#f2f2f5);}
.dv-canvas-status{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;line-height:1.6;}
.dv-canvas-status-overlay{padding:20px;background:transparent;}
.dv-loader{display:block;width:22px;height:22px;border:1.5px solid color-mix(in srgb,var(--dsw-alias-label-secondary,#a4a4ad) 20%,transparent);border-top-color:var(--dsw-alias-label-secondary,#a4a4ad);border-radius:50%;animation:dv-loading 1s linear infinite;}
@keyframes dv-loading{to{transform:rotate(360deg);}}
.dv-preview-progress{position:absolute;top:36px;right:36px;z-index:1;display:flex;align-items:center;gap:7px;padding:6px 10px;border-radius:99px;background:var(--dsw-alias-bg-base,#1a1a1c);color:var(--dsw-alias-label-secondary,#a4a4ad);font-size:.78em;box-shadow:0 2px 8px -4px rgba(0,0,0,.2);}
.dv-status-dot{width:5px;height:5px;border-radius:50%;background:currentColor;}
@supports (backdrop-filter: blur(16px)){
  .dv-canvas-shell[data-preview-only="true"] .dv-canvas-bar{background:color-mix(in srgb,var(--dsw-alias-bg-base,#1a1a1c) 80%,transparent);backdrop-filter:blur(16px);}
}
@media (prefers-reduced-transparency: reduce){
  .dv-root .dv-canvas-shell[data-preview-only="true"] .dv-canvas-bar{background:var(--dsw-alias-bg-base,#1a1a1c);backdrop-filter:none;}
}
@media (prefers-reduced-motion: reduce){
  .dv-root,.dv-loader{animation:none;}
}
@container dsh-video (max-width: 900px){
  .dv-canvas-shell[data-preview-only="true"]{padding:16px;gap:12px;}
  .dv-stage{padding:12px;}
  .dv-controls{padding:10px 12px 12px;}
}
@container dsh-video (max-width: 700px){
  .dv-main{flex-direction:column;}
  .dv-splitter{display:none;}
  .dv-left{flex:1 1 48%;min-height:180px;}
  .dv-ai{
    width:auto;
    flex:1 1 52%;
    min-height:220px;
    max-height:none;
    border-left:0;
    border-top:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(127,127,140,.28)) 62%, transparent);
  }
  .dv-stage{padding-bottom:8px;}
}
@container dsh-video (max-width: 520px){
  .dv-topbar{padding-left:max(12px, var(--dv-topbar-leading));padding-right:12px;}
  .dv-projectbar{max-width:calc(100% - 90px);}
  .dv-canvas-shell[data-preview-only="true"]{padding:12px;gap:8px;}
  .dv-ai-head{min-height:48px;padding:6px 12px;}
  .dv-back{padding:0 8px;}
  .dv-stage{padding:10px;}
  .dv-controls{padding:8px 10px 10px;}
}

.dv-reference-toggle{align-self:flex-start;margin:0 12px 4px}.dv-reference-panel{display:flex;flex-direction:column;gap:4px;margin:0 12px 8px;padding:10px;border:1px solid var(--dsw-alias-border-l1, rgba(127,127,140,.28));border-radius:8px;min-height:0;overflow:auto;max-height:42vh;font-size:12px}.dv-reference-head,.dv-reference-range,.dv-reference-pages{display:flex;align-items:center;gap:6px}.dv-reference-head{justify-content:space-between}.dv-reference-panel>*{flex-shrink:0}.dv-reference-panel input{font:inherit;color:inherit;background:var(--dsw-alias-bg-base, #1c1c20);border:1px solid var(--dsw-alias-border-l1, rgba(127,127,140,.28));border-radius:4px;padding:5px;min-width:0;max-width:100%}.dv-reference-panel input[type=search]{width:100%}.dv-reference-help{opacity:.7;margin:6px 0}.dv-reference-items{display:grid;gap:2px;max-height:180px;overflow:auto;flex:1 1 auto;min-height:48px}.dv-reference-item{border:0;border-radius:4px;background:transparent;color:inherit;text-align:left;padding:6px;cursor:pointer;min-width:0}.dv-reference-item:hover,.dv-reference-item[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,140,.14))}.dv-reference-item span,.dv-reference-item small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dv-reference-item small{opacity:.6}.dv-reference-range{margin-top:6px}.dv-reference-range input{width:62px}.dv-reference-token{display:block;margin-top:8px}.dv-reference-token input{display:block;width:100%;font-family:monospace}.dv-change-receipt{display:flex;align-items:center;gap:8px;font-size:11px;padding:4px 8px;min-width:0}.dv-change-receipt span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.dv-change-recovery{padding:6px 8px;font-size:12px}.dv-change-recovery button{margin:3px}.dv-clip-reference{width:100px;min-width:50px!important;font-size:10px!important}

/* Lifted clips follow the pointer; lane footprints preview the committed, snapped position. */
.dv-root .dv-timeline-clip.is-dragging{z-index:20;cursor:grabbing;opacity:.92;pointer-events:auto;box-shadow:0 10px 24px #0005,0 2px 6px #0003;outline:1.5px solid var(--dsw-alias-brand-primary,#82c8cf);transform-origin:center;will-change:transform}
.dv-root .dv-timeline-clip.is-dragging.is-invalid{cursor:not-allowed;outline-color:var(--dsw-alias-state-error-primary,#dd777d)}
.dv-root .dv-timeline-lane.is-drop-target{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#82c8cf) 9%,transparent);box-shadow:inset 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,#82c8cf) 35%,transparent),inset 0 -1px color-mix(in srgb,var(--dsw-alias-brand-primary,#82c8cf) 35%,transparent)}
.dv-root .dv-timeline-lane.is-drop-invalid{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dd777d) 7%,transparent)}
.dv-drop-guide{position:absolute;top:0;bottom:0;border-left:1px dashed var(--dsw-alias-brand-primary,#82c8cf);z-index:5;pointer-events:none}
.dv-drag-origin,.dv-drop-preview{position:absolute;top:7px;bottom:7px;box-sizing:border-box;border-radius:5px;pointer-events:none}
.dv-drag-origin{border:1px dashed var(--dsw-alias-border-l1,#ffffff26);background:var(--dsw-alias-interactive-bg-hover,#ffffff06)}
.dv-drop-preview{z-index:1;border:1px dashed var(--dsw-alias-brand-primary,#82c8cf);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#82c8cf) 12%,transparent);color:var(--dsw-alias-label-primary,#eee)}
.dv-drop-preview.is-invalid{border-color:var(--dsw-alias-state-error-primary,#dd777d);color:var(--dsw-alias-state-error-primary,#dd777d)}
.dv-drop-preview span{position:absolute;bottom:calc(100% + 5px);left:0;padding:3px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-1,#25262a);box-shadow:0 2px 8px #0002;font-size:10px;white-space:nowrap}
.dv-timeline-compact .dv-drag-origin,.dv-timeline-compact .dv-drop-preview{top:4px;bottom:4px}

.dv-root .dv-timeline-track[data-kind=video]{height:88px}.dv-root .dv-timeline-track[data-kind=audio]{height:64px}
.dv-root .dv-timeline-clip{display:block;background:#315e8038;border-color:#668eaa66}.dv-root .dv-timeline-clip.is-audio{background:#175f4e;border-color:#4b998766}
.dv-root .dv-timeline-clip-label,.dv-root .is-audio .dv-timeline-clip-label{position:absolute;left:0;right:0;top:0;height:18px;line-height:18px;padding:0 7px;font-size:10px;background:#315e8055;text-shadow:none;z-index:2}
.dv-root .is-audio .dv-timeline-clip-label{background:#124a3ee0;color:#e0f4ec}
.dv-clip-visuals{position:absolute;inset:18px 0 0;pointer-events:none;overflow:hidden;background:#18354812}.dv-filmstrip{position:absolute;top:0;bottom:0;display:flex;overflow:hidden}.dv-filmstrip img{min-width:0;flex:1;width:0;height:100%;object-fit:cover;pointer-events:none}.has-original-audio:not(.is-audio-visual) .dv-filmstrip{bottom:17px}.dv-clip-envelope{position:absolute;bottom:0;height:16px;background:#164c42d9;pointer-events:none}.is-audio-visual .dv-clip-envelope{height:32px;background:transparent}.is-muted .dv-clip-envelope{opacity:.3}.dv-timeline-track:has(.dv-track-visibility[aria-pressed=false]) .dv-filmstrip{opacity:.25}
.dv-root .dv-timeline-compact .dv-timeline-track[data-kind=video]{height:52px}.dv-root .dv-timeline-compact .dv-timeline-track[data-kind=audio]{height:42px}.dv-timeline-compact .dv-clip-visuals{top:14px}.dv-root .dv-timeline-compact .dv-timeline-clip-label{height:14px;line-height:14px;font-size:9px}.dv-timeline-compact .has-original-audio:not(.is-audio-visual) .dv-filmstrip{bottom:10px}.dv-timeline-compact .dv-clip-envelope{height:10px}.dv-timeline-compact .is-audio-visual .dv-clip-envelope{height:20px}
/* Resource shelf, transport, and editing tools have separate visual roles. */

.dv-root .dv-canvas-shell[data-preview-only="true"]{padding:0;gap:0;overflow:hidden;container-type:inline-size;container-name:video-canvas}
.dv-update-control{position:relative;flex-shrink:0}.dv-update-control>button{font-size:11px;color:var(--dsw-alias-label-secondary,#858992)}.dv-update-panel{position:absolute;right:0;top:calc(100% + 12px);z-index:60;box-sizing:border-box;width:min(300px,calc(100vw - 24px));padding:18px;border:1px solid var(--dsw-alias-border-l1,#8883);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#25262a);color:var(--dsw-alias-label-primary,#eee);box-shadow:0 12px 40px #0003;font-size:12px}.dv-update-panel header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.dv-update-panel p{line-height:1.7;margin:12px 0}.dv-update-panel small{color:var(--dsw-alias-label-secondary,#858992)}.dv-update-panel a{display:block;margin-top:8px;color:inherit}.dv-update-panel footer{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.dv-resource-bar{display:flex;align-items:center;gap:4px;min-height:44px;padding:0 16px;flex-shrink:0;border-bottom:1px solid var(--dsw-alias-border-l1,#ffffff10)}
.dv-resource-tab{display:flex;align-items:center;gap:7px;padding:7px 10px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#aaaeb6);font:inherit;font-size:12px;cursor:pointer}
.dv-resource-tab:hover,.dv-resource-tab[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,#ffffff0c);color:var(--dsw-alias-label-primary,#eee)}
.dv-resource-tab:focus-visible,.dv-clip-settings summary:focus-visible,.dv-timeline-history summary:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#8facbc);outline-offset:1px}
.dv-root .dv-canvas-shell[data-preview-only="true"] .dv-canvas-wrap{margin:20px 24px 8px;min-height:60px}
.dv-root .dv-canvas-shell[data-preview-only="true"] .dv-canvas-bar{align-self:stretch;width:auto;min-height:40px;padding:4px 18px;gap:12px;border:0;border-radius:0;background:transparent;box-shadow:none;backdrop-filter:none;flex-shrink:0}
.dv-root .dv-canvas-shell[data-preview-only="true"] .dv-play{width:28px;min-height:28px;border-radius:4px}
.dv-root .dv-canvas-shell[data-preview-only="true"] .dv-time{font-size:10px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#aaaeb6)}
.dv-root .dv-timeline{min-height:158px;max-height:300px;background:var(--dsw-alias-bg-base,#191a1d)}
.dv-root .dv-timeline-toolbar{height:40px;gap:3px;padding:0 10px}
.dv-root .dv-timeline-heading{font-size:10px;letter-spacing:0;margin-right:8px}
.dv-root .dv-timeline-scroll{min-height:116px;max-height:208px}
.dv-root .dv-timeline-ruler{height:28px}
.dv-root .dv-timeline-ruler span{top:8px;font-size:9px;border:0;padding:0;line-height:12px}
.dv-root .dv-timeline-track{height:54px;border-bottom-color:var(--dsw-alias-border-l1,#ffffff08)}
.dv-root .dv-timeline-track-name{padding:0 10px;gap:6px;background:var(--dsw-alias-bg-base,#191a1d);border-right-color:var(--dsw-alias-border-l1,#ffffff08)}
.dv-root .dv-track-kind{margin-right:5px;font-variant-numeric:tabular-nums}
.dv-root .dv-track-mute{font-size:9px;opacity:.55}
.dv-root .dv-timeline-track:hover .dv-track-mute,.dv-root .dv-track-mute:focus-visible,.dv-root .dv-track-mute[aria-pressed=true]{opacity:1}
.dv-root .dv-timeline-lane{background:var(--dsw-alias-bg-layer-1,#ffffff02)}
.dv-root .dv-timeline-clip{top:7px;bottom:7px;background:color-mix(in srgb,#7199ba 25%,var(--dsw-alias-bg-base,#191a1d));border-color:#8caec333;border-radius:5px;box-shadow:inset 0 1px #ffffff08}
.dv-root .dv-timeline-clip.is-audio{background:color-mix(in srgb,#6a9c87 24%,var(--dsw-alias-bg-base,#191a1d));border-color:#8abc9b33}
.dv-root .dv-timeline-clip.is-selected{outline:1.5px solid #9ac6db;outline-offset:-1.5px;background:color-mix(in srgb,#7199ba 38%,var(--dsw-alias-bg-base,#191a1d))}
.dv-root .dv-timeline-clip.is-audio.is-selected{outline-color:#9acbb8;background:color-mix(in srgb,#6a9c87 38%,var(--dsw-alias-bg-base,#191a1d))}
.dv-root .dv-timeline-clip-label{font-size:11px;padding:0 10px}
.dv-root .dv-timeline-playhead{background:var(--dsw-alias-label-primary,#eee)}
.dv-root .dv-timeline-playhead:before{border-top-color:var(--dsw-alias-label-primary,#eee)}
.dv-root .dv-snap-toggle{margin:0 5px;position:relative;color:var(--dsw-alias-label-secondary,#aaaeb6)}
.dv-root .dv-snap-toggle input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.dv-root .dv-snap-toggle:has(input:checked){color:var(--dsw-alias-brand-primary,#82c8cf)}
.dv-root .dv-snap-toggle:has(input:focus-visible){outline:2px solid var(--dsw-focus-ring-color,#8facbc);outline-offset:4px}
.dv-clip-settings,.dv-timeline-history{position:static;flex-shrink:0}
.dv-clip-settings summary,.dv-timeline-history summary{display:flex;align-items:center;justify-content:center;gap:5px;min-height:28px;padding:0 6px;font-size:10px;border-radius:4px;list-style:none;cursor:pointer}
.dv-clip-settings summary::-webkit-details-marker,.dv-timeline-history summary::-webkit-details-marker{display:none}
.dv-clip-settings[open] summary,.dv-timeline-history[open] summary,.dv-clip-settings summary:hover,.dv-timeline-history summary:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff0c)}
.dv-root .dv-timeline-inspector{position:absolute;right:10px;bottom:calc(100% - 2px);width:260px;max-width:calc(100cqw - 24px);z-index:15;box-sizing:border-box;display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:14px;border:1px solid var(--dsw-alias-border-l1,#ffffff18);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#25262a);box-shadow:0 8px 30px #0003;font-size:11px}
.dv-root .dv-timeline-inspector label{justify-content:space-between;gap:5px;min-width:0}
.dv-root .dv-timeline-inspector .dv-clip-reference{grid-column:1/-1;width:100%;max-width:none;padding:5px 6px;height:28px}
.dv-root .dv-timeline-inspector .dv-inspector-name{display:block;max-width:160px;font-size:11px;color:var(--dsw-alias-label-primary,#eee)}
.dv-root .dv-timeline-history .dv-change-receipt{position:absolute;left:10px;bottom:calc(100% - 2px);z-index:15;width:250px;max-width:calc(100cqw - 24px);padding:10px 12px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,#ffffff18);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#25262a);box-shadow:0 8px 30px #0003}
.dv-root .dv-timeline-history .dv-change-receipt span{white-space:normal}
.dv-root .dv-timeline-notice{padding:5px 12px;font-size:10px}
.dv-root .dv-timeline-compact .dv-timeline-track{height:34px}
.dv-root .dv-timeline-compact .dv-timeline-clip{top:4px;bottom:4px}
.dv-root .dv-drawer.dv-media-library{top:48px;left:10px;max-height:calc(100% - 60px);width:min(336px,calc(100% - 20px));padding:16px;gap:12px;border-radius:8px;box-shadow:0 12px 40px #0003}
.dv-root .dv-media-filters .dv-button{min-height:26px;font-size:11px;padding:0 9px;border:0}
.dv-root .dv-media-tile{padding:5px;border-color:transparent;border-radius:6px;gap:6px}
.dv-root .dv-media-tile:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff0c)}
.dv-root .dv-media-name{font-size:11px}
.dv-root .dv-media-tile small{font-size:10px}

/* Compact studio popovers: solid surface, readable hierarchy, bounded content. */
.dv-root .dv-reference-panel,.dv-root .dv-drawer.dv-media-library{
 --dv-panel-ink:var(--dsw-alias-label-primary,#f2f2f5);
 --dv-panel-line:color-mix(in srgb,var(--dv-panel-ink) 15%,transparent);
 box-sizing:border-box;position:absolute;bottom:auto;z-index:30;margin:0;padding:16px;
 color:var(--dv-panel-ink);background:var(--dsw-alias-bg-base,#1a1a1c);
 border:1px solid var(--dv-panel-line);border-radius:12px;
 box-shadow:0 18px 48px -12px #0004,0 3px 10px #00000012;
 gap:12px;overflow:auto;font-size:12px;line-height:1.5;
}
.dv-root .dv-reference-panel{top:64px;right:12px;left:auto;width:calc(100% - 24px);max-width:400px;max-height:calc(100% - 80px)}
.dv-root .dv-settings-panel{max-width:460px}
.dv-root .dv-settings-tabs{display:flex;gap:6px;flex-shrink:0}
.dv-root .dv-settings-tabs button{flex:1;padding:6px 8px;border-radius:8px;border:1px solid var(--dv-panel-line);background:transparent;color:inherit;font-size:12px;cursor:pointer}
.dv-root .dv-settings-tabs button.is-active{border-color:var(--dsw-alias-brand-primary,#82c8cf);font-weight:600;background:color-mix(in srgb,var(--dv-panel-ink) 6%,transparent)}
.dv-root .dv-settings-body{display:flex;flex-direction:column;gap:8px;min-height:0}
.dv-root .dv-settings-help,.dv-root .dv-settings-fixed{margin:0;font-size:11.5px;opacity:.8;line-height:1.5}
.dv-root .dv-settings-fixed{padding:6px 8px;border-radius:8px;background:color-mix(in srgb,var(--dv-panel-ink) 6%,transparent)}
.dv-root .dv-settings-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0}
.dv-root .dv-settings-list li{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--dv-panel-line);border-radius:9px;background:color-mix(in srgb,var(--dv-panel-ink) 4%,transparent)}
.dv-root .dv-settings-list li[data-default="true"]{border-color:var(--dsw-alias-brand-primary,#82c8cf)}
.dv-root .dv-settings-item-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.dv-root .dv-settings-item-main strong{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dv-root .dv-settings-item-main small{font-size:11px;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dv-root .dv-settings-item-main .dv-settings-url{font-family:ui-monospace,Consolas,monospace}
.dv-root .dv-settings-badge{font-style:normal;font-size:10px;padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--dv-panel-ink) 12%,transparent);color:inherit;width:max-content}
.dv-root .dv-settings-item-actions{display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}
.dv-root .dv-settings-item-actions .dv-button{font-size:11px;padding:3px 7px}
.dv-root .dv-settings-form{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--dv-panel-line);border-radius:10px;flex-shrink:0;background:color-mix(in srgb,var(--dv-panel-ink) 4%,transparent)}
.dv-root .dv-settings-form label{display:flex;align-items:center;gap:6px;font-size:11.5px}
.dv-root .dv-settings-form input,.dv-root .dv-settings-form select{box-sizing:border-box;flex:1;min-width:0;font-size:12px;padding:4px 7px;border-radius:7px;border:1px solid var(--dv-panel-line);background:color-mix(in srgb,var(--dv-panel-ink) 3%,var(--dsw-alias-bg-base,#1a1a1c));color:inherit}
.dv-root .dv-settings-form select option{background:var(--dsw-alias-bg-base,#1a1a1c);color:inherit}
.dv-root .dv-settings-form-actions{display:flex;align-items:center;gap:6px;justify-content:flex-end}
.dv-root .dv-settings-count{margin-right:auto;font-size:11px;opacity:.7}
.dv-root .dv-settings-prompt{box-sizing:border-box;width:100%;font-size:12px;line-height:1.5;padding:7px 9px;border-radius:9px;border:1px solid var(--dv-panel-line);background:color-mix(in srgb,var(--dv-panel-ink) 3%,var(--dsw-alias-bg-base,#1a1a1c));color:inherit;resize:vertical;font-family:inherit}
.dv-root .dv-settings-add{align-self:flex-start}
.dv-root .dv-settings-notice{margin:0;min-height:16px;font-size:11.5px;color:var(--dsw-alias-brand-primary,#3f9a95)}
.dv-root .dv-range-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--dv-panel-line);font-size:12px;flex-shrink:0}
.dv-root .dv-range-bar strong{font-size:12px}
.dv-root .dv-range-label{opacity:.8;font-size:11.5px}
.dv-root .dv-range-bar input[type="number"]{box-sizing:border-box;width:74px;font-size:12px;padding:3px 6px;border-radius:7px;border:1px solid var(--dv-panel-line);background:color-mix(in srgb,var(--dv-panel-ink) 3%,var(--dsw-alias-bg-base,#1a1a1c));color:inherit}
.dv-root .dv-range-bar .dv-range-note{flex:1 1 160px;min-width:140px;font-size:12px;padding:3px 7px;border-radius:7px;border:1px solid var(--dv-panel-line);background:color-mix(in srgb,var(--dv-panel-ink) 3%,var(--dsw-alias-bg-base,#1a1a1c));color:inherit}
.dv-root .dv-range-bar .dv-range-note::placeholder{color:color-mix(in srgb,var(--dv-panel-ink) 55%,transparent)}
.dv-root .dv-range-bar .dv-button{font-size:11px;padding:3px 8px}
.dv-root .dv-timeline-range{position:absolute;top:26px;bottom:0;z-index:6;pointer-events:none;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#82c8cf) 18%,transparent);border-left:2px solid var(--dsw-alias-brand-primary,#5fb7b0);border-right:2px solid var(--dsw-alias-brand-primary,#5fb7b0)}
.dv-root .dv-timeline-range[data-draft="true"]{opacity:.75}
.dv-root .dv-timeline[data-range-mode="true"] .dv-timeline-ruler{cursor:crosshair}
.dv-root .dv-timeline[data-range-mode="true"] .dv-playhead-handle{pointer-events:none}
.dv-root .dv-settings-toggle svg{opacity:.85}
.dv-root .dv-range-tool[aria-pressed="true"]{color:var(--dsw-alias-brand-primary,#3f9a95);border-color:var(--dsw-alias-brand-primary,#82c8cf)}
.dv-root .dv-button-danger{color:#e57373;border-color:color-mix(in srgb,#e57373 45%,transparent)}
.dv-root .dv-drawer.dv-media-library{top:52px;left:12px;width:min(352px,calc(100% - 24px));max-height:min(580px,calc(100% - 68px))}
.dv-root .dv-reference-toggle{margin:0;align-self:auto;width:auto;display:inline-flex;gap:5px;padding:0 8px;font-size:12px}
.dv-root .dv-reference-head,.dv-root .dv-drawer-head{display:flex;align-items:center;gap:8px;font-size:13px;min-height:28px;flex-shrink:0}
.dv-root .dv-reference-head strong,.dv-root .dv-drawer-head strong{flex:1;font-weight:600}
.dv-panel-actions{display:flex;align-items:center;gap:2px}
.dv-root .dv-reference-panel .dv-icon-button,.dv-root .dv-drawer .dv-icon-button{width:28px;height:28px;min-height:28px;border-radius:6px;font-size:17px}
.dv-root .dv-reference-panel input,.dv-root .dv-media-search{box-sizing:border-box;border:1px solid var(--dv-panel-line);border-radius:7px;background:color-mix(in srgb,var(--dv-panel-ink) 3%,var(--dsw-alias-bg-base,#1a1a1c));padding:8px 10px;font-size:12px;color:inherit}
.dv-root .dv-reference-help{font-size:11px;line-height:1.6;opacity:.62;margin:0}
.dv-root .dv-reference-items{gap:3px;max-height:280px;min-height:48px;flex:1 1 auto}
.dv-root .dv-reference-item{padding:9px 10px;border-radius:7px;min-height:54px}
.dv-root .dv-reference-item span{font-size:12px;font-weight:500}
.dv-root .dv-reference-item small{font-size:10px;margin-top:3px;opacity:.62}
.dv-reference-kind{font-style:normal}
.dv-root .dv-reference-token{margin:0;padding:10px;border-radius:7px;background:color-mix(in srgb,var(--dv-panel-ink) 5%,transparent);font-size:11px}
.dv-root .dv-reference-token input{margin-top:6px;font-size:10px}
.dv-root .dv-reference-range-wrap{border-top:1px solid var(--dv-panel-line);padding-top:10px;font-size:11px}
.dv-reference-range-wrap summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#73767e)}
.dv-root .dv-reference-range{margin-top:10px;gap:6px;flex-wrap:wrap}
.dv-root .dv-reference-range input{width:68px}
.dv-root .dv-reference-panel p[role=status]:empty,.dv-root .dv-reference-pages:empty{display:none}
.dv-root .dv-upload{border:1px dashed var(--dv-panel-line);border-radius:8px;min-height:48px;font-size:12px;background:color-mix(in srgb,var(--dv-panel-ink) 2%,transparent)}
.dv-root .dv-media-filters{padding:3px;border-radius:7px;background:color-mix(in srgb,var(--dv-panel-ink) 5%,transparent);gap:2px}
.dv-root .dv-media-filters .dv-button{flex:1;border-radius:5px;min-height:28px;font-size:11px}
.dv-root .dv-media-filters .dv-button[aria-pressed=true]{background:var(--dsw-alias-bg-base,#1a1a1c);box-shadow:0 1px 3px #0002;outline:0}
.dv-root .dv-media-grid{gap:10px;align-content:start}
.dv-root .dv-media-tile{padding:6px;border:1px solid var(--dv-panel-line);border-radius:8px;gap:5px}
.dv-root .dv-media-tile img,.dv-root .dv-media-placeholder{height:88px;background:color-mix(in srgb,var(--dv-panel-ink) 5%,transparent);border-radius:5px}
.dv-root .dv-media-tile[aria-pressed=true]{outline:2px solid var(--dsw-focus-ring-color,#8facbc);outline-offset:-2px}


.dv-root .dv-track-name-text{font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:none;border:0;color:inherit;font:inherit;text-align:left;padding:0;cursor:pointer}
.dv-root .dv-track-visibility{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:24px;padding:0;border:1px solid transparent;border-radius:5px;background:none;color:inherit;cursor:pointer}
.dv-timeline-track-name[data-selected=true]{box-shadow:inset 2px 0 var(--dsw-focus-ring-color,#8facbc)}.dv-track-visibility svg{width:14px;height:14px}.dv-track-visibility[aria-pressed=false]{color:#7a4b00;background:#ffe0a1;border-color:#d7a44d}
.dv-track-visibility:focus-visible,.dv-track-name-text:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#8facbc)}
.dv-track-menu-title{display:block;padding:8px;font-size:11px;opacity:.6}.dv-timeline-menu .dv-track-remove{color:var(--dsw-alias-status-error,#c45454)}.dv-track-delete-confirm{position:absolute;bottom:100%;left:10px;z-index:20;max-width:300px;padding:16px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#8884);background:var(--dsw-alias-bg-base,#25262a);box-shadow:0 8px 28px #0003;font-size:12px}.dv-track-delete-confirm p{line-height:1.6}.dv-track-delete-confirm button{margin-right:8px}
/* Timeline state and media identity must remain legible in both themes. */
.dv-root .dv-snap-toggle{display:inline-flex;align-items:center;justify-content:center;width:30px;height:28px;box-sizing:border-box;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#eee) 22%,transparent);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#a4a8b2)}
.dv-root .dv-snap-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff0c)}
.dv-root .dv-snap-toggle:has(input:checked){background:#245cba;border-color:#245cba;color:#fff;box-shadow:inset 0 1px #ffffff24}
.dv-root .dv-snap-toggle:has(input:focus-visible){outline-offset:2px}
.dv-snap-state{position:absolute;right:1px;bottom:-1px;font-size:10px;font-weight:700;line-height:12px;pointer-events:none}
.dv-root .dv-timeline-clip.is-audio{background:#227b60;border:1px solid #176047;color:#fff;box-shadow:inset 0 -1px #00000014}
.dv-root .dv-timeline-clip.is-audio:hover{background:#29896b}
.dv-root .dv-timeline-clip.is-audio.is-selected{background:#1a6c52;outline:2px solid #8ce8bd;outline-offset:-2px;box-shadow:inset 0 0 0 3px #14533e}
.dv-root .is-audio .dv-timeline-clip-label{align-self:flex-start;box-sizing:border-box;width:100%;height:15px;line-height:15px;padding:0 8px;font-size:10px;color:#fff;background:#14573f;text-shadow:none}
.dv-root .is-audio .dv-clip-waveform{top:17px;height:calc(100% - 19px);opacity:.75;filter:brightness(0) invert(1)}
.dv-root .dv-timeline-track[data-kind=audio] .dv-track-kind{color:#238266;font-weight:600}
.dv-root .dv-timeline-clip.is-audio.is-muted{filter:saturate(.12);opacity:.58}

.dv-root .dv-timeline-track-name{padding:0 8px;gap:4px}
.dv-root .dv-track-label{display:flex;align-items:center;gap:4px}
.dv-root .dv-track-kind{display:inline-flex;align-items:center;flex:none;margin:0}
.dv-root .dv-track-kind svg{width:13px;height:13px}
.dv-track-name-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dv-root .dv-track-mute{display:inline-flex;align-items:center;justify-content:center;width:22px;height:24px;opacity:.8;border:1px solid transparent;border-radius:5px}
.dv-root .dv-track-mute svg{width:14px;height:14px;pointer-events:none}
.dv-root .dv-track-mute:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff12);opacity:1}
.dv-root .dv-track-mute[aria-pressed=true]{opacity:1;color:#7a4b00;background:#ffe0a1;border-color:#d7a44d}

.dv-root .dv-timeline-ruler,.dv-root .dv-timeline-ruler *, .dv-root .dv-timeline-playhead,.dv-root .dv-timeline[data-scrubbing=true]{user-select:none;-webkit-user-select:none;touch-action:none}
.dv-root .dv-timeline-ruler{cursor:ew-resize}
.dv-root .dv-timeline-playhead{width:1px;background:transparent;pointer-events:auto;cursor:ew-resize;touch-action:none}
.dv-root .dv-timeline-playhead:after{content:'';position:absolute;left:0;top:0;bottom:0;width:1px;background:var(--dsw-alias-label-primary,#eee);pointer-events:none}
.dv-root .dv-timeline-playhead:before{left:-3px;pointer-events:none}
.dv-playhead-handle{position:absolute;left:-6px;top:0;width:13px;height:28px;cursor:ew-resize;touch-action:none}
.dv-root .dv-timeline-playhead:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#8facbc);outline-offset:1px}

@container video-canvas (max-width:480px){.dv-root .dv-timeline-heading{display:none}.dv-root .dv-timeline-zoom{width:40px}.dv-root .dv-clip-settings summary span{display:none}.dv-root .dv-resource-bar{padding:0 8px}.dv-root .dv-canvas-shell[data-preview-only="true"] .dv-canvas-wrap{margin:12px 12px 4px}.dv-root .dv-timeline-toolbar{padding:0 6px;gap:1px}.dv-root .dv-tool-divider{margin:0 3px}}

`;
    //#endregion

    //#region diagnostics
    const reportedCodes = new Set();
    let reportIssue = function noopReport() {};

    /** Build a logger that can never throw into the UI or the slot runtime. */
    function makeReporter(ctx) {
      return function report(code, error) {
        try {
          const message = 'dsh-video: ' + code;
          if (error === undefined) {
            if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(message);
          } else if (ctx.logger && typeof ctx.logger.error === 'function') {
            ctx.logger.error(message, error);
          }
        } catch (_ignored) {
          /* diagnostics must not break activation or interaction */
        }
      };
    }

    function reportOnce(code, error) {
      if (reportedCodes.has(code)) return;
      reportedCodes.add(code);
      reportIssue(code, error);
    }
    //#endregion

    //#region preferences + plugin store
    function safeStorage() {
      try {
        if (typeof localStorage === 'undefined') return null;
        const candidate = localStorage;
        if (
          candidate === null ||
          typeof candidate !== 'object' ||
          typeof candidate.getItem !== 'function' ||
          typeof candidate.setItem !== 'function'
        ) {
          return null;
        }
        return candidate;
      } catch (_error) {
        return null;
      }
    }

    /**
     * Read the versioned layout preference (P3-016 resizable AI pane). Any
     * absence, corrupt JSON, unexpected shape, unknown version, or storage
     * exception falls back to the default ratio; the pure helpers clamp/bound
     * an accepted ratio.
     */
    function readLayoutPrefs() {
      const storage = safeStorage();
      if (storage === null) return { aiPaneRatio: AI_PANE_DEFAULT_RATIO };
      let raw;
      try {
        raw = storage.getItem(LAYOUT_PREFS_KEY);
      } catch (error) {
        reportOnce('prefs-read-failed', error);
        return { aiPaneRatio: AI_PANE_DEFAULT_RATIO };
      }
      if (typeof raw !== 'string' || raw === '') return { aiPaneRatio: AI_PANE_DEFAULT_RATIO };
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { aiPaneRatio: AI_PANE_DEFAULT_RATIO };
        }
        if (parsed.version !== LAYOUT_PREFS_VERSION) return { aiPaneRatio: AI_PANE_DEFAULT_RATIO };
        return { aiPaneRatio: normalizeAiPaneRatio(parsed.aiPaneRatio) };
      } catch (error) {
        reportOnce('prefs-corrupt', error);
        return { aiPaneRatio: AI_PANE_DEFAULT_RATIO };
      }
    }

    /** Default ratio used by a fresh panel; kept as one call for tests/mount. */
    function readAiPaneRatio() {
      return readLayoutPrefs().aiPaneRatio;
    }

    /**
     * Best-effort write of the versioned layout preference. A failed write keeps
     * the in-memory ratio and reports once; it never blocks the UI.
     */
    function writeLayoutPrefs(ratio) {
      const storage = safeStorage();
      if (storage === null) {
        reportOnce('prefs-storage-unavailable');
        return false;
      }
      try {
        storage.setItem(
          LAYOUT_PREFS_KEY,
          JSON.stringify({ version: LAYOUT_PREFS_VERSION, aiPaneRatio: normalizeAiPaneRatio(ratio) })
        );
        return true;
      } catch (error) {
        reportOnce('prefs-write-failed', error);
        return false;
      }
    }

    function createUiStore(initial, report) {
      let state = initial;
      const listeners = new Set();
      return {
        getSnapshot() {
          return state;
        },
        subscribe(listener) {
          listeners.add(listener);
          return function unsubscribe() {
            listeners.delete(listener);
          };
        },
        setPatch(patch) {
          state = Object.assign({}, state, patch);
          const snapshot = Array.from(listeners);
          for (let index = 0; index < snapshot.length; index += 1) {
            try {
              snapshot[index]();
            } catch (error) {
              report('store-listener-failed', error);
            }
          }
        },
      };
    }

    /** Plugin-scope store for panel-level notices (no project/content truth). */
    let uiStore = null;
    /** Bounded panel-scope memory: a mode switch must not rewrite worker state. */
    let editorMemory = null;

    function getStore() {
      if (uiStore === null) {
        uiStore = createUiStore({ navigationError: null }, function noop() {});
      }
      return uiStore;
    }

    function usePluginState() {
      const store = getStore();
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    }

    function setNavigationError(code) {
      const store = getStore();
      const value = typeof code === 'string' ? code : null;
      if (store.getSnapshot().navigationError === value) return;
      store.setPatch({ navigationError: value });
    }
    //#endregion

    //#region host helpers
    /** Feature-detected slot enumeration, used for occupancy diagnostics. */
    function slotEntries(ctx, slotName) {
      try {
        const slots = ctx.slots;
        if (slots === null || typeof slots !== 'object' || typeof slots.entries !== 'function') return null;
        const entries = slots.entries(slotName);
        return Array.isArray(entries) ? entries : null;
      } catch (error) {
        reportOnce('slot-entries-failed', error);
        return null;
      }
    }

    /**
     * Detect whether a slot already has occupants. `field === null` matches any
     * entry (single/list slots); otherwise the entry's options[field] must equal
     * value. Returns null when the runtime cannot answer.
     */
    function findOccupants(ctx, slotName, field, value) {
      const entries = slotEntries(ctx, slotName);
      if (entries === null) return null;
      if (field === null) return entries;
      return entries.filter(function keep(entry) {
        return entry !== null && typeof entry === 'object' && entry.options && entry.options[field] === value;
      });
    }

    /** Whether a slot declaration currently exists; null when it cannot be known. */
    function isSlotDeclared(ctx, slotName) {
      try {
        const slots = ctx.slots;
        if (slots === null || typeof slots !== 'object') return null;
        if (typeof slots.specDynamic === 'function') return slots.specDynamic(slotName) !== undefined;
        if (typeof slots.spec === 'function') return slots.spec(slotName) !== undefined;
      } catch (_error) {
        return null;
      }
      return null;
    }
    //#endregion

    //#region icons
    /**
     * Refined one-pixel video-camera outline for the host sidebar row. The host
     * supplies the square edge (`size`: 16 expanded / 18 collapsed in 0.2.0-rc.2)
     * and the selected state; the glyph follows the row's currentColor only.
     */
    function SidebarVideoIcon(props) {
      let size = props && typeof props.size === 'number' && isFinite(props.size) ? props.size : 16;
      if (size < 12) size = 12;
      if (size > 24) size = 24;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
          stroke: 'currentColor',
          strokeWidth: 1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('rect', { x: 1.25, y: 3.5, width: 8.75, height: 9, rx: 2 }),
        h('path', { d: 'M10 7.15 13.9 5a.55.55 0 0 1 .82.48v5.04a.55.55 0 0 1-.82.48L10 8.85' })
      );
    }

    function FolderIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: '16', height: '16', fill: 'none', stroke: 'currentColor', strokeWidth: '1.4', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M1.8 4.3c0-.7.6-1.3 1.3-1.3h3.1l1.4 1.6h5.3c.7 0 1.3.6 1.3 1.3v6.8c0 .7-.6 1.3-1.3 1.3H3.1c-.7 0-1.3-.6-1.3-1.3V4.3z' })
      );
    }

    function BackIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M9.75 3.5 5.25 8l4.5 4.5' })
      );
    }

    /** P3-016 project-picker arrow; never the rename trigger itself. */
    function ChevronDownIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'm4 6.25 4 4 4-4' })
      );
    }
    function HistoryIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
          stroke: 'currentColor',
          strokeWidth: 1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('circle', { cx: 8, cy: 8, r: 5.75 }),
        h('path', { d: 'M8 4.75v3.5l2.35 1.4' })
      );
    }
    //#endregion

    //#region host bridge helpers
    // The Host-configured controlled fixture id. A request can only reference a
    // project id from the trusted allowlist; this UI never sends a path or URL.
    const DEMO_PROJECT_ID = 'demo';
    // The read-only preview follows the exact revision the Host reports. The
    // poll is the only UI-side trigger for a new preview snapshot: an AI Tool
    // publish (project.compose) bumps the worker revision, this panel observes it
    // through `inspect` and mounts the new snapshot without a user action.
    const REVISION_POLL_MS = 1500;
    // P3-017 B1 preview state machine. A published revision is debounced so a
    // burst of Agent publishes settles on the last one; the snapshot request and
    // the mounted candidate's runtime handshake each get their own independent
    // budget, because a cold worker start and a slow composition load are
    // different failure modes. A failed attempt is retried once with a fresh
    // snapshot before the honest error is shown, and the previously displayed
    // composition stays visible/playable throughout.
    const PREVIEW_DEBOUNCE_MS = 1000;
    const PREVIEW_SNAPSHOT_TIMEOUT_MS = 30000;
    const PREVIEW_READY_TIMEOUT_MS = 30000;
    const PREVIEW_RETRY_LIMIT = 1;
    const PREVIEW_RETRY_DELAY_MS = 400;
    const PREVIEW_DIAGNOSTIC_LIMIT = 6;
    // P3-017 B3 product export. The render deadline is measured by the worker
    // (a real composition needs minutes); the UI poll simply follows the job
    // until it settles. The client deadline is a safety net slightly above the
    // Host maximum, never a substitute for the worker's own timeout.
    const PRODUCT_RENDER_TIMEOUT_MS = 900000;
    const PRODUCT_EXPORT_DEADLINE_MS = 16 * 60 * 1000;
    const PRODUCT_EXPORT_POLL_MS = 500;
    // The plugin-private source key for its owned Session references. It must
    // never reuse "mainView": the host derives its current conversation from
    // that retention key (see P3-005-A investigation).
    const SESSION_SOURCE = 'videoView';
    // A private session-scope child slot is declared only to receive the
    // renderer's SessionProvider/renderSlot kit; the conversation Factory is
    // rendered directly inside the Provider and this slot has no occupant.
    const SESSION_CHILD_SLOT = 'dsh-video.chat';
    const REQUEST_ROUTE = 'api/dsh-video/request';
    const ARTIFACT_ROUTE = 'api/dsh-video/artifact';
    const TERMINAL_JOB_STATES = ['succeeded', 'failed', 'cancelled', 'timed_out'];

    function operationId() {
      try {
        if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      } catch (_error) {
        /* fall through to the bounded local form */
      }
      return 'ui-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    function artifactUrl(jobId) {
      return ARTIFACT_ROUTE + '?jobId=' + encodeURIComponent(String(jobId));
    }

    function capabilityList(element) {
      return element && Array.isArray(element.capabilities) ? element.capabilities : [];
    }

    // The controlled fixture's title contract. Real fixtures may place a
    // text-only eyebrow before the title, so title/timing must never be found by
    // two independent "first capability" scans. A single target is selected and
    // both fields operate on that exact stableId; the target can be switched in
    // the properties panel.
    const FIXTURE_TITLE_ID = 'hf-title';

    function elementsOf(project) {
      return project && Array.isArray(project.elements) ? project.elements : [];
    }

    function hasCapability(element, capability) {
      return capabilityList(element).indexOf(capability) !== -1;
    }

    function editableElements(elements) {
      return elements.filter(function editable(element) {
        return hasCapability(element, 'text') || hasCapability(element, 'timing');
      });
    }

    function targetFor(elements, preferredId) {
      const preferred = typeof preferredId === 'string' && preferredId.length > 0
        ? elements.find(function byId(element) { return element && element.stableId === preferredId; })
        : null;
      if (preferred !== undefined && preferred !== null && (hasCapability(preferred, 'text') || hasCapability(preferred, 'timing'))) return preferred;
      const contractTitle = elements.find(function fixtureTitle(element) {
        return element && element.stableId === FIXTURE_TITLE_ID && hasCapability(element, 'text') && hasCapability(element, 'timing');
      });
      if (contractTitle !== undefined) return contractTitle;
      const combined = elements.find(function both(element) {
        return hasCapability(element, 'text') && hasCapability(element, 'timing');
      });
      if (combined !== undefined) return combined;
      const candidates = editableElements(elements);
      return candidates.length > 0 ? candidates[0] : null;
    }

    /** Small, consistent currentColor controls; hidden names remain real text. */
    function StudioIcon(props) {
      const name = props.name;
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
        name === 'play' ? h('path', { d: 'M9 5.5v13l10-6.5z', fill: 'currentColor', stroke: 'none' }) :
        name === 'pause' ? h('path', { d: 'M9 5.5v13M15 5.5v13', strokeWidth: 2.5 }) :
        name === 'media' ? h('path',{d:'M3 7h7l2 2h9v11H3zM3 7V4h7l2 3M8 13l3 3 3-4 4 5'}) :
        name === 'video-off' ? h('path',{d:'M3 6h12v12H3zM15 10l6-3v10l-6-3M2 2l20 20'}) :
        name === 'video' ? h('path',{d:'M3 6h12v12H3zM15 10l6-3v10l-6-3'}) :
        name === 'speaker' ? h('path',{d:'M4 9h4l5-4v14l-5-4H4zM17 8a6 6 0 0 1 0 8M20 5a10 10 0 0 1 0 14'}) :
        name === 'speaker-off' ? h('path',{d:'M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6'}) :
        name === 'audio' ? h('path',{d:'M9 18V5l11-2v13M9 8l11-2M9 18c0 2-6 3-6 0s6-3 6 0m11-2c0 2-6 3-6 0s6-3 6 0'}) :
        name === 'reference' ? h('path',{d:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2'}) :
        name === 'new' ? h('path', { d: 'M12 5v14M5 12h14' }) :
        h('rect', { x: 4, y: 6, width: 16, height: 12, rx: 3 })
      );
    }

    /**
     * Presentation only: never use UI labels as project identity or write truth.
     * P3-016: the explicit `project.json` title (returned by inspect/rename) wins;
     * legacy projects without one keep the previous content-derived fallback.
     */
    function studioProjectTitle(project, fallback) {
      if (project === null || typeof project !== 'object') return fallback;
      if (typeof project.title === 'string') {
        const stored = project.title.trim();
        if (stored.length > 0) return stored.slice(0, 120);
      }
      const scene = Array.isArray(project.scenes) ? project.scenes[0] : null;
      const textElement = Array.isArray(project.elements) ? project.elements.find(function titleText(element) {
        return element && typeof element.text === 'string' && element.text.trim().length > 0 && element.text.length <= 120 && hasCapability(element, 'text');
      }) : null;
      const title = scene && typeof scene.title === 'string' ? scene.title : textElement !== null && textElement !== undefined ? textElement.text : '';
      const text = title.trim();
      return text.length > 0 ? text.slice(0, 120) : fallback;
    }

    function durationOf(project) {
      const duration = Number(project && project.duration);
      return Number.isFinite(duration) && duration >= 0 ? duration : null;
    }

    function defaultFrameTime(project, rememberedValue) {
      const duration = durationOf(project);
      if (duration === null) return 0;
      const raw = typeof rememberedValue === 'string' ? rememberedValue.trim() : rememberedValue;
      if (raw !== '' && raw !== null && raw !== undefined) {
        const remembered = Number(raw);
        if (Number.isFinite(remembered) && remembered >= 0 && remembered <= duration) return remembered;
      }
      return Math.min(2.5, duration);
    }

    function parseFrameTime(value, project) {
      const duration = durationOf(project);
      if (duration === null) return null;
      if (typeof value === 'string' && value.trim() === '') return null;
      const time = Number(value);
      if (Number.isFinite(time) === false || time < 0 || time > duration) return null;
      return time;
    }

    function formatSeconds(value) {
      return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '';
    }

    function isTerminalJob(job) {
      return job !== null && typeof job === 'object' && TERMINAL_JOB_STATES.indexOf(job.state) !== -1;
    }

    function hostError(error) {
      if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
        return {
          code: error.code,
          message: typeof error.message === 'string' && error.message.length > 0 ? error.message : 'Request failed',
          uncertain: error.uncertain === true,
          jobUnknown: error.jobUnknown === true,
        };
      }
      return { code: 'E_NETWORK', message: 'Request failed', uncertain: false, jobUnknown: false };
    }

    const REFERENCE_TOKEN =
      /^dshvideo:v1\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(clip|scene|asset|range)\/[A-Za-z0-9_.-]{1,128}\/[a-f0-9]{64}$/;
    /** Pure move plan shared by pointer preview, pointer release, drop and track selection. */
    function planTimelineMove(timeline,clipId,trackId,rawFrame,options={}) {
      const tracks=timeline.tracks,source=tracks.find(tr=>tr.clips.some(c=>c.clipId===clipId)),
        clip=source?.clips.find(c=>c.clipId===clipId),target=tracks.find(tr=>tr.trackId===trackId);
      const invalid=reason=>({valid:false,reason,startFrame:Math.max(0,Math.round(rawFrame||0)),snapFrame:null,nextDuration:timeline.settings.durationFrames,ops:[]});
      if(!clip)return invalid('missing');
      if(!target)return invalid('outside');
      if(source.locked||target.locked)return invalid('locked');
      if(source.kind!==target.kind)return invalid('kind');
      const raw=Math.max(0,Math.round(rawFrame)),others=target.clips.filter(c=>c.clipId!==clipId),
        overlaps=start=>others.some(c=>start<c.startFrame+c.durationFrames&&start+clip.durationFrames>c.startFrame),
        points=[0,timeline.settings.durationFrames,options.playheadFrame,...tracks.flatMap(tr=>tr.clips.filter(c=>c.clipId!==clipId).flatMap(c=>[c.startFrame,c.startFrame+c.durationFrames]))].filter(Number.isFinite);
      let startFrame=raw,snapFrame=null;
      if(options.snap){
        const candidates=points.flatMap(point=>[{start:point,point},{start:point-clip.durationFrames,point}])
          .filter(c=>c.start>=0&&Math.abs(c.start-raw)*(options.zoom||36)/30<=6&&!overlaps(c.start))
          .sort((a,b)=>Math.abs(a.start-raw)-Math.abs(b.start-raw));
        if(candidates.length){startFrame=candidates[0].start;snapFrame=candidates[0].point;}
      }
      const end=startFrame+clip.durationFrames,
        nextDuration=Math.max(1,end,...tracks.flatMap(tr=>tr.clips.filter(c=>c.clipId!==clipId).map(c=>c.startFrame+c.durationFrames)));
      if(overlaps(startFrame))return {...invalid('overlap'),startFrame,snapFrame,nextDuration};
      const ops=[];
      if(target.trackId!==source.trackId||startFrame!==clip.startFrame){
        // Product editing follows content bounds; preserve generic Tool fixed-mode support.
        if(timeline.settings.durationMode!=='auto')ops.push({op:'timeline.settings',durationMode:'auto'});
        ops.push({op:'clip.move',clipId,trackId:target.trackId,startFrame,mode:'reject'});
      }
      return {valid:true,reason:null,startFrame,snapFrame,nextDuration,ops};
    }

    function referenceToken(projectId, kind, id, revision) {
      const token =
        'dshvideo:v1/' + projectId + '/' + kind + '/' + id + '/' + revision;
      return REFERENCE_TOKEN.test(token) ? token : null;
    }
    function referenceText(token) {
      return (
        '`' +
        (typeof token === 'string' && REFERENCE_TOKEN.test(token)
          ? token
          : 'dshvideo:invalid') +
        '`'
      );
    }
    /**
     * The timeline panel's current free range selection, page-registered for
     * the native @ menu. Only the user's own selection is offered; worker
     * whole-clip ranges stay filtered out. Cleared on project switch,
     * revision change and unmount so a stale range can never be attached.
     */
    let activeRangeCandidate = null;
    function setActiveRangeCandidate(next) {
      activeRangeCandidate =
        next && REFERENCE_TOKEN.test(next.token) && /^range$/.test(next.kind)
          ? next
          : null;
    }
    function activeRangeItem(query) {
      const item = activeRangeCandidate;
      if (item === null) return null;
      const q = String(query || '').trim().toLowerCase();
      if (q.length > 0 && (item.label + ' ' + item.description).toLowerCase().indexOf(q) < 0)
        return null;
      return {
        name: item.label,
        label: item.label,
        description: item.description,
        icon: 'file',
        section: '当前时间范围',
        value: JSON.stringify({ token: item.token, label: item.label, kind: 'range' }),
      };
    }
    function createReferenceSource(request) {
      return {
        trigger: '@',
        name: 'dsh-video',
        showGroupTitle: false,
        order: 50,
        async candidates(session, req = {}) {
          if (
            req.quoted ||
            req.drilled ||
            req.signal?.aborted ||
            !session?.sessionId
          )
            return [];
          try {
            const result = await request(
              'reference.list',
              {
                sessionId: session.sessionId,
                query: typeof req.query === 'string' ? req.query.slice(0, 120) : '',
                limit: 50,
              },
              req.signal,
            );
            if (req.signal?.aborted) return [];
            // Native @ is a concise object picker. Scene aliases and generated
            // whole-clip ranges repeat the same target; the user's current
            // free range selection is offered first as "当前时间范围".
            // The underlying tokens/resolve contract is unchanged.
            const list = (result.items || [])
              .filter(x => REFERENCE_TOKEN.test(x.token) && ['clip','asset'].includes(x.kind))
              .sort((a,b) => (a.kind === 'asset') - (b.kind === 'asset'))
              .map(x => {
                const clean = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
                const detail = clean(x.detail);
                const boundary = detail.indexOf(' · ');
                const time = boundary >= 0 ? detail.slice(0,boundary) : detail;
                const track = boundary >= 0 ? detail.slice(boundary+3) : '';
                const label = (clean(x.label) + (x.kind === 'clip' && time ? ' · ' + time : '')).slice(0,120);
                return {
                  name: label,
                  label,
                  description: x.kind === 'clip'
                    ? (track ? track + ' · ' : '') + '修改这个片段'
                    : ({image:'图片',video:'视频',audio:'音频'}[detail] || detail || '素材') + ' · 引用源素材',
                  icon: 'file',
                  section: x.kind === 'clip' ? '时间线片段' : '素材库',
                  value: JSON.stringify({token:x.token,label,kind:x.kind}),
                };
              });
            const current = activeRangeItem(req.query);
            const merged = current === null
              ? list
              : [current, ...list.filter(x => x.value !== current.value)];
            return merged.slice(0, 50);
          } catch (_error) {
            return [];
          }
        },
        onPick({ candidate } = {}) {
          try {
            const item = JSON.parse(candidate?.value);
            if (!REFERENCE_TOKEN.test(item.token)) return;
            return {
              insert: {
                source: 'dsh-video',
                ref: item.token,
                label: item.label,
                appearance: item.kind === 'scene' ? 'folder' : 'file',
                clipboardText: referenceText(item.token),
              },
            };
          } catch (_error) {
            return;
          }
        },
        codec: {
          serialize: (token) => Promise.resolve(referenceText(token)),
          clipboardText: referenceText,
        },
      };
    }

    function installReferenceSource(ctx) {
      const register = (scope) => {
        try {
        const service =
          typeof scope.get === 'function' ? scope.get('inputTriggers') : null;
        if (service && typeof service.registerSource === 'function')
          return scope.effect(
            () => service.registerSource(createReferenceSource(hostRequest)),
            'dsh-video: reference source',
          );
        }catch(_error){/* Optional API drift keeps copyable references available. */}
      };
      try {
        if (typeof ctx.inject === 'function')
          return ctx.inject(['inputTriggers'], register);
        return register(ctx);
      } catch (_error) {
        /* Copyable tokens remain available. */
      }
    }
    async function hostRequest(method, params, signal) {
      if (typeof fetch !== 'function') throw { code: 'E_NETWORK', message: 'fetch is unavailable' };
      let response;
      try {
        response = await fetch(REQUEST_ROUTE, {
          signal,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ method: method, params: params || {} }),
        });
      } catch (_error) {
        throw { code: 'E_NETWORK', message: 'Could not reach the video service' };
      }
      let body = null;
      try {
        body = await response.json();
      } catch (_error) {
        body = null;
      }
      if (body === null || typeof body !== 'object') {
        throw { code: 'E_NETWORK', message: 'The video service returned an invalid response' };
      }
      if (body.ok === true) return body.result;
      const error = body.error !== null && typeof body.error === 'object' ? body.error : {};
      throw hostError({
        code: typeof error.code === 'string' ? error.code : 'E_INTERNAL',
        message: typeof error.message === 'string' ? error.message : 'The video service rejected the request',
        uncertain: error.uncertain === true,
        jobUnknown: error.jobUnknown === true,
      });
    }

    function errorText(error, t) {
      const code = error && error.code;
      let friendly = null;
      if (code === 'E_CONFIGURATION') friendly = t('video.error.configuration');
      else if (code === 'E_NETWORK') friendly = t('video.error.network');
      else if (code === 'E_REVISION_CONFLICT' || code === 'E_OPERATION_REUSED' || code === 'E_PROJECT_CLOSING' || code === 'E_PROJECT_NOT_OPEN') friendly = t('video.error.conflict');
      else if (code === 'E_WORKER_START' || code === 'E_WORKER_EXITED' || code === 'E_WORKER_DISPOSED' || code === 'E_TRANSPORT' || code === 'E_STARTUP') friendly = t('video.error.worker');
      else if (code === 'E_ARTIFACT_INTEGRITY' || code === 'E_ARTIFACT_NOT_READY') friendly = t('video.frame.failed');
      else if (code === 'E_PERSIST') friendly = t('video.canvas.persistFailed');
      else if (code === 'E_SESSION_CONFIG') friendly = t('video.error.sessionConfig');
      else if (code === 'E_SESSION_STATE_CORRUPT' || code === 'E_SESSION_STATE_VERSION' || code === 'E_SESSION_STATE_LIMIT' || code === 'E_SESSION_STATE_DISPOSED') friendly = t('video.error.sessionState');
      else if (code === 'E_SESSION_CREATE' || code === 'E_SESSION_RESPONSE' || code === 'E_SESSION_NOT_BOUND' || code === 'E_SESSION_ALREADY_BOUND' || code === 'E_AGENT_REQUIRED' || code === 'E_PROJECT_SCOPE') friendly = t('video.error.session');
      else if (code === 'E_SESSION_OPEN' || code === 'E_SESSION_UNAVAILABLE') friendly = t('video.ai.error');
      const detail = error && typeof error.message === 'string' ? error.message : '';
      if (friendly !== null) {
        return detail.length > 0 ? friendly + ' ' + detail : friendly;
      }
      return detail.length > 0 ? detail : t('video.error.generic');
    }

    function timingRangeMessage(t, duration) {
      if (duration === null) return t('video.edit.invalidTiming');
      return t('video.timing.range').replace('{duration}', formatSeconds(duration));
    }

    function isTimingBeyondComposition(error) {
      return error !== null && typeof error === 'object' && error.code === 'E_PARAMS' && typeof error.message === 'string' && /Timing extends beyond composition/i.test(error.message);
    }

    // A preview click is intercepted only inside this plugin's embedded AI
    // surface. File cards and Markdown file links keep their native content; the
    // local handler routes only path-like targets to the Host-supported preview
    // route, so the global right sidebar never has to be mounted.
    const PREVIEW_PATH_EXTENSION = /\.[A-Za-z0-9]{1,12}(?:$|[?#])/;
    const PREVIEW_EXTERNAL_PREFIX = /^(?:https?:|mailto:|tel:|javascript:|data:|#)/i;
    // P3-022: the host chat renders a ToolRow's collapsed result summary as
    // `<button type="button" class="<css-hash>_fileLink" onClick={openFile}>`
    // (or an `<a class="..._fileLink">`) with NO title/data-* path attribute.
    // The summary text is "<localized tool title> · <file path>" (U+00B7 middle
    // dot separator); the path may be workspace-relative or absolute. A click on
    // the button/child span would otherwise run the host `openFile`, which needs
    // the host's global right-sidebar file opener and throws inside this
    // plugin's embedded conversation (that surface is not mounted under a global
    // main panel). Matching the CSS-module suffix keeps working when the hash
    // changes.
    const PREVIEW_FILE_LINK_SELECTOR = '[class*="fileLink"]';
    const PREVIEW_SUMMARY_SEPARATOR = ' \u00b7 ';

    /** Extract the file path from a ToolRow summary ("<title> · <path>"). */
    function previewSummaryPath(text) {
      if (typeof text !== 'string') return null;
      const trimmed = text.replace(/\s+/g, ' ').trim();
      if (trimmed.length === 0 || trimmed.length > 4096) return null;
      const index = trimmed.lastIndexOf(PREVIEW_SUMMARY_SEPARATOR);
      const candidate = (index >= 0 ? trimmed.slice(index + PREVIEW_SUMMARY_SEPARATOR.length) : trimmed).trim();
      if (candidate.length === 0 || candidate.length > 4096) return null;
      return localPathLike(candidate) ? candidate : null;
    }

    /** Resolve the file path of a host ToolRow file link (button or anchor). */
    function fileLinkPathFromTarget(target) {
      if (target === null || typeof target !== 'object' || typeof target.closest !== 'function') return null;
      try {
        const link = target.closest(PREVIEW_FILE_LINK_SELECTOR);
        if (link === null || link === undefined) return null;
        if (typeof link.getAttribute === 'function') {
          const attributes = [
            link.getAttribute('data-file-path'),
            link.getAttribute('data-path'),
            link.getAttribute('title'),
          ];
          for (const value of attributes) {
            if (localPathLike(value)) return value;
          }
          const href = link.getAttribute('href');
          if (localPathLike(href)) return href;
        }
        const text = typeof link.textContent === 'string' ? link.textContent : '';
        return previewSummaryPath(text);
      } catch (_error) {
        return null;
      }
    }

    function localPathFromTarget(target) {
      if (target === null || typeof target !== 'object' || typeof target.closest !== 'function') return null;
      try {
        const button = target.closest('button[title]');
        if (button !== null && button !== undefined && typeof button.getAttribute === 'function') {
          const title = button.getAttribute('title');
          if (localPathLike(title)) return title;
        }
        const dataNode = target.closest('[data-file-path],[data-path]');
        if (dataNode !== null && dataNode !== undefined && typeof dataNode.getAttribute === 'function') {
          const value = dataNode.getAttribute('data-file-path') || dataNode.getAttribute('data-path');
          if (localPathLike(value)) return value;
        }
        const anchor = target.closest('a[href]');
        if (anchor !== null && anchor !== undefined && typeof anchor.getAttribute === 'function') {
          const href = anchor.getAttribute('href');
          if (localPathLike(href)) return href;
        }
        const fileLink = fileLinkPathFromTarget(target);
        if (fileLink !== null) return fileLink;
      } catch (_error) {
        return null;
      }
      return null;
    }

    function localPathLike(value) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false;
      if (PREVIEW_EXTERNAL_PREFIX.test(value) === true) return false;
      if (value.indexOf('\n') !== -1) return false;
      if (value.startsWith('file://')) return true;
      if (value.startsWith('/') && value.length > 1) return true;
      if (/^[A-Za-z]:[\\/]/.test(value) === true) return true;
      return PREVIEW_PATH_EXTENSION.test(value);
    }

    // P3-017 B2: an image click inside the embedded conversation must never fall
    // back to the Host's global right sidebar (that surface is not mounted inside
    // a global main panel). Browser-owned sources (data:/blob:/remote URLs already
    // loaded by the chat, or a same-origin chat image route) render directly in
    // the plugin overlay; path-like local sources (including the workspace-relative
    // `.dsh-video-frames/latest.png`) go through the existing bounded Host preview
    // route, which resolves Session/project roots server-side.
    const PREVIEW_INLINE_IMAGE = /^(?:data:image\/|blob:)/i;
    const PREVIEW_REMOTE_IMAGE = /^https?:\/\//i;

    function imagePreviewTarget(target) {
      if (target === null || typeof target !== 'object' || typeof target.closest !== 'function') return null;
      try {
        const image = target.closest('img[src]');
        if (image === null || image === undefined || typeof image.getAttribute !== 'function') return null;
        const src = image.getAttribute('src');
        if (typeof src !== 'string' || src.length === 0 || src.length > 8192 || src.indexOf('\n') !== -1) return null;
        if (PREVIEW_INLINE_IMAGE.test(src) === true) return { kind: 'inline', src: src };
        if (localPathLike(src) === true) return { kind: 'host', path: src };
        if (PREVIEW_REMOTE_IMAGE.test(src) === true || src.startsWith('api/') === true || src.startsWith('./') === true) {
          return { kind: 'inline', src: src };
        }
      } catch (_error) {
        return null;
      }
      return null;
    }

    function previewFileName(path) {
      if (typeof path !== 'string') return '';
      const withoutQuery = path.split('?')[0].split('#')[0];
      const parts = withoutQuery.split(/[\\/]/);
      return parts.length === 0 ? '' : parts[parts.length - 1];
    }

    function previewErrorText(error, t) {
      const code = error !== null && typeof error === 'object' ? error.code : null;
      if (code === 'E_PREVIEW_UNSUPPORTED') return t('video.preview.unsupported');
      if (code === 'E_PREVIEW_LIMIT') return t('video.preview.tooLarge');
      if (code === 'E_PREVIEW_DENIED') return t('video.preview.denied');
      if (code === 'E_PREVIEW_NOT_FOUND') return t('video.preview.notFound');
      return t('video.preview.failed');
    }

    function stateText(state, t) {
      return typeof state === 'string' && state.length > 0 ? t('video.state.' + state) : '';
    }

    // ---------------------------------------------------------------------------
    // Pure canvas helpers. Kept at module scope, free of React/DOM/Host state so
    // the Node smoke test can execute this exact source (vm-extracted) and prove
    // the numeric layout patch, the frozen Scene template copy and the reviewed
    // P3-005-B runtime message contract without a browser. CanvasWorkspace is the
    // only caller; keeping them here also keeps the browser harness extraction
    // inside the two reviewed region slices.
    // ---------------------------------------------------------------------------

    const CANVAS_CONTRACT_VERSION = 1;
    const CANVAS_MAX_MESSAGE_BYTES = 16384;
    const CANVAS_INSTANCE_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
    const CANVAS_NONCE = /^[a-f0-9]{32}$/;
    const CANVAS_COMMAND_TYPES = Object.freeze([
      'ping',
      'state',
      'seek',
      'play',
      'enableSound',
      'pause',
      'hitTest',
      'getElements',
      'destroy',
    ]);
    const CANVAS_EVENT_TYPES = Object.freeze([
      'ready',
      'soundEnabled',
      'pong',
      'state',
      'seeked',
      'playing',
      'paused',
      'hit',
      'elements',
      'destroyed',
      'error',
    ]);
    // Direct (unsolicited) events may not carry a replyTo: every one of these is
    // a direct answer to a command, so a floating copy is a protocol violation
    // and would otherwise let a stale snapshot mutate the current UI.
    const CANVAS_CORRELATED_EVENT_TYPES = Object.freeze([
      'pong',
      'seeked',
      'playing',
      'paused',
      'hit',
      'elements',
      'state',
      'destroyed',
    ]);
    const CANVAS_COMMAND_REQUIRED = Object.freeze({
      enableSound: [],
      ping: [],
      state: [],
      seek: ['time'],
      play: [],
      pause: [],
      hitTest: ['x', 'y'],
      getElements: [],
      destroy: [],
    });
    const CANVAS_EVENT_REQUIRED = Object.freeze({
      soundEnabled: [],
      ready: ['runtimeVersion', 'width', 'height', 'duration'],
      pong: [],
      state: ['time', 'duration', 'playing'],
      seeked: ['time'],
      playing: ['time'],
      paused: ['time'],
      hit: ['hit'],
      elements: ['elements'],
      destroyed: [],
      error: ['code', 'message'],
    });
    const CANVAS_COMMAND_KEYS = Object.freeze(['v', 'kind', 'instanceId', 'nonce', 'seq', 'type', 'payload']);
    const CANVAS_EVENT_KEYS = Object.freeze(['v', 'kind', 'instanceId', 'nonce', 'seq', 'type', 'replyTo', 'payload']);
    const CANVAS_SCENE_TEMPLATE_KEYS = Object.freeze(['title', 'duration', 'subtitle', 'badge', 'color', 'accent', 'logo', 'shot']);
    // Frozen engine 0.3.2 sceneTemplate text limits (UTF-16 string length, as
    // enforced by the Host bridge and the worker). Human typed text edits can
    // legally reach these lengths, so the client copy must not reject or
    // truncate them and must use the same length semantics as the Host/engine.
    const CANVAS_SCENE_TEXT_MAX = 2048;
    const CANVAS_SCENE_COLOR = /^#[0-9a-fA-F]{6}$/;
    const CANVAS_SCENE_ASSET = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g)$/i;
    const CANVAS_REVISION = /^[a-f0-9]{64}$/;

    function canvasPlainObject(value) {
      return value !== null && typeof value === 'object' && Array.isArray(value) === false;
    }

    function canvasFiniteNumber(value) {
      return typeof value === 'number' && Number.isFinite(value);
    }

    /**
     * Text length in UTF-16 code units, exactly like the frozen Host bridge and
     * engine (`typeof value === 'string'` + `value.length`).
     */
    function canvasTextLength(value) {
      return typeof value === 'string' ? value.length : -1;
    }

    function canvasExactKeys(value, allowed, required) {
      if (canvasPlainObject(value) === false) return 'not-object';
      for (const key of Object.keys(value)) {
        if (allowed.includes(key) === false) return 'unknown-key:' + key;
      }
      for (const key of required) {
        if (Object.prototype.hasOwnProperty.call(value, key) === false || value[key] === undefined) return 'missing-key:' + key;
      }
      return null;
    }

    function canvasIsOversizedMessage(message) {
      try {
        const encoded = JSON.stringify(message);
        if (typeof TextEncoder === 'function') return new TextEncoder().encode(encoded).length > CANVAS_MAX_MESSAGE_BYTES;
        return encoded.length > CANVAS_MAX_MESSAGE_BYTES;
      } catch (_error) {
        return true;
      }
    }

    function canvasValidateEnvelope(message, kind, types, required, allowedKeys) {
      const keyError = canvasExactKeys(message, allowedKeys, allowedKeys);
      if (keyError !== null) return { ok: false, code: 'E_MALFORMED', detail: keyError };
      if (message.v !== CANVAS_CONTRACT_VERSION) return { ok: false, code: 'E_VERSION', detail: 'unsupported contract version' };
      if (message.kind !== kind) return { ok: false, code: 'E_MALFORMED', detail: 'wrong kind' };
      if (typeof message.instanceId !== 'string' || CANVAS_INSTANCE_ID.test(message.instanceId) === false) {
        return { ok: false, code: 'E_INSTANCE', detail: 'invalid instanceId' };
      }
      if (typeof message.nonce !== 'string' || CANVAS_NONCE.test(message.nonce) === false) {
        return { ok: false, code: 'E_NONCE', detail: 'invalid nonce' };
      }
      if (Number.isInteger(message.seq) === false || message.seq < 1) {
        return { ok: false, code: 'E_SEQ', detail: 'seq must be a positive integer' };
      }
      if (types.includes(message.type) === false) return { ok: false, code: 'E_TYPE', detail: 'unknown message type' };
      if (kind === 'evt' && message.replyTo !== null && Number.isInteger(message.replyTo) === false) {
        return { ok: false, code: 'E_REPLY', detail: 'replyTo must be integer or null' };
      }
      if (canvasPlainObject(message.payload) === false) return { ok: false, code: 'E_PAYLOAD', detail: 'payload must be an object' };
      const payloadKeys = required[message.type];
      const payloadError = canvasExactKeys(message.payload, payloadKeys, payloadKeys);
      if (payloadError !== null) return { ok: false, code: 'E_PAYLOAD', detail: message.type + ':' + payloadError };
      return { ok: true };
    }

    /** Validate a runtime event against the reviewed P3-005-B contract. */
    function canvasValidateEvent(message) {
      const envelope = canvasValidateEnvelope(message, 'evt', CANVAS_EVENT_TYPES, CANVAS_EVENT_REQUIRED, CANVAS_EVENT_KEYS);
      if (envelope.ok === false) return envelope;
      const payload = message.payload;
      if (message.type === 'ready') {
        if (
          typeof payload.runtimeVersion !== 'string' ||
          canvasFiniteNumber(payload.width) === false ||
          canvasFiniteNumber(payload.height) === false ||
          canvasFiniteNumber(payload.duration) === false ||
          payload.width <= 0 ||
          payload.height <= 0 ||
          payload.duration <= 0
        ) {
          return { ok: false, code: 'E_PAYLOAD', detail: 'ready shape' };
        }
      } else if (message.type === 'state') {
        if (canvasFiniteNumber(payload.time) === false || canvasFiniteNumber(payload.duration) === false || typeof payload.playing !== 'boolean') {
          return { ok: false, code: 'E_PAYLOAD', detail: 'state shape' };
        }
      } else if (message.type === 'seeked' || message.type === 'playing' || message.type === 'paused') {
        if (canvasFiniteNumber(payload.time) === false) return { ok: false, code: 'E_PAYLOAD', detail: message.type + '.time' };
      } else if (message.type === 'hit') {
        if (payload.hit !== null && canvasValidateHit(payload.hit) !== null) return { ok: false, code: 'E_PAYLOAD', detail: 'hit shape' };
      } else if (message.type === 'elements') {
        if (Array.isArray(payload.elements) === false || payload.elements.length > 512) {
          return { ok: false, code: 'E_PAYLOAD', detail: 'elements shape' };
        }
      } else if (message.type === 'error') {
        if (
          typeof payload.code !== 'string' ||
          payload.code.length === 0 ||
          payload.code.length > 64 ||
          typeof payload.message !== 'string' ||
          payload.message.length > 512
        ) {
          return { ok: false, code: 'E_PAYLOAD', detail: 'error shape' };
        }
      }
      return { ok: true };
    }

    /** Validate a parent-to-runtime command (the UI only sends known types). */
    function canvasValidateCommand(message) {
      const envelope = canvasValidateEnvelope(message, 'cmd', CANVAS_COMMAND_TYPES, CANVAS_COMMAND_REQUIRED, CANVAS_COMMAND_KEYS);
      if (envelope.ok === false) return envelope;
      const payload = message.payload;
      if (message.type === 'seek') {
        if (canvasFiniteNumber(payload.time) === false) return { ok: false, code: 'E_PAYLOAD', detail: 'seek.time must be finite' };
      } else if (message.type === 'hitTest') {
        if (canvasFiniteNumber(payload.x) === false || canvasFiniteNumber(payload.y) === false) {
          return { ok: false, code: 'E_PAYLOAD', detail: 'hitTest coordinates must be finite' };
        }
      }
      return { ok: true };
    }

    /** Returns null for a valid hit description, else the failing detail. */
    function canvasValidateHit(hit) {
      if (canvasPlainObject(hit) === false) return 'not-object';
      const allowed = ['stableId', 'sceneId', 'tag', 'text', 'rect', 'style', 'stack'];
      for (const key of Object.keys(hit)) {
        if (allowed.includes(key) === false) return 'unknown:' + key;
      }
      if (typeof hit.stableId !== 'string' || hit.stableId.length === 0) return 'stableId';
      if (hit.sceneId !== null && typeof hit.sceneId !== 'string') return 'sceneId';
      if (typeof hit.tag !== 'string' || hit.tag.length > 32) return 'tag';
      if (typeof hit.text !== 'string') return 'text';
      if (canvasPlainObject(hit.rect) === false) return 'rect';
      const rectError = canvasExactKeys(hit.rect, ['x', 'y', 'width', 'height'], ['x', 'y', 'width', 'height']);
      if (rectError !== null) return 'rect:' + rectError;
      for (const value of Object.values(hit.rect)) {
        if (canvasFiniteNumber(value) === false) return 'rect-number';
      }
      if (hit.rect.width < 0 || hit.rect.height < 0) return 'rect-negative';
      if (canvasPlainObject(hit.style) === false) return 'style';
      if (Array.isArray(hit.stack) === false || hit.stack.length > 32) return 'stack';
      for (const id of hit.stack) {
        if (typeof id !== 'string') return 'stack-id';
      }
      return null;
    }

    /**
     * One ledger per preview snapshot instance. Mirrors the reviewed spike
     * contract: commands carry increasing seq numbers, incoming events must pass
     * the strict shape check, belong to this exact instance/nonce, advance the
     * event sequence strictly and either answer a pending command or be an
     * explicit unsolicited event (ready/error). `revoke()` returns the still
     * pending seqs so the caller can settle every promise explicitly.
     */
    function canvasMessageLedger(options) {
      const settings = canvasPlainObject(options) ? options : {};
      const instanceId = settings.instanceId;
      const nonce = settings.nonce;
      const timeoutMs = canvasFiniteNumber(settings.timeoutMs) && settings.timeoutMs > 0 ? settings.timeoutMs : 4000;
      if (typeof instanceId !== 'string' || CANVAS_INSTANCE_ID.test(instanceId) === false) throw new TypeError('invalid canvas instanceId');
      if (typeof nonce !== 'string' || CANVAS_NONCE.test(nonce) === false) throw new TypeError('invalid canvas nonce');
      let nextSeq = 1;
      let lastEventSeq = 0;
      let revoked = false;
      const pending = new Map();
      const now = typeof settings.now === 'function' ? settings.now : Date.now;

      function command(type, payload) {
        const message = {
          v: CANVAS_CONTRACT_VERSION,
          kind: 'cmd',
          instanceId: instanceId,
          nonce: nonce,
          seq: nextSeq,
          type: type,
          payload: payload === undefined ? {} : payload,
        };
        const validation = canvasValidateCommand(message);
        if (validation.ok === false) throw new TypeError('invalid canvas command: ' + validation.detail);
        nextSeq += 1;
        pending.set(message.seq, { type: type, deadline: now() + timeoutMs });
        return message;
      }

      function revoke() {
        revoked = true;
        const seqs = [...pending.keys()];
        pending.clear();
        return seqs;
      }

      function expire(at) {
        const expired = [];
        for (const [seq, entry] of pending) {
          if (entry.deadline <= at) {
            expired.push(seq);
            pending.delete(seq);
          }
        }
        return expired;
      }

      function accept(message, acceptance) {
        const optionsInput = canvasPlainObject(acceptance) ? acceptance : {};
        const at = canvasFiniteNumber(optionsInput.now) ? optionsInput.now : now();
        function drop(code, detail) {
          return { accepted: false, code: code, detail: detail, seq: canvasPlainObject(message) && Number.isInteger(message.seq) ? message.seq : null };
        }
        if (revoked) return drop('E_INSTANCE_REVOKED', 'canvas instance was revoked');
        if (optionsInput.sourceOk !== true) return drop('E_SOURCE_MISMATCH', 'event source is not this iframe');
        if (canvasIsOversizedMessage(message)) return drop('E_OVERSIZED', 'event exceeds the message size limit');
        const validation = canvasValidateEvent(message);
        if (validation.ok === false) return drop(validation.code, validation.detail);
        if (message.instanceId !== instanceId) return drop('E_WRONG_INSTANCE', 'event belongs to another instance');
        if (message.nonce !== nonce) return drop('E_NONCE', 'nonce mismatch');
        if (message.seq <= lastEventSeq) return drop('E_STALE_SEQ', 'event sequence already seen');
        lastEventSeq = message.seq;
        let correlated = null;
        if (message.replyTo !== null) {
          correlated = pending.get(message.replyTo) || null;
          if (correlated === null) return drop('E_LATE_RESPONSE', 'no pending command for seq ' + message.replyTo);
          pending.delete(message.replyTo);
        } else if (CANVAS_CORRELATED_EVENT_TYPES.includes(message.type)) {
          return drop('E_UNCORRELATED', message.type + ' needs replyTo');
        }
        void at;
        return {
          accepted: true,
          seq: message.seq,
          type: message.type,
          payload: message.payload,
          replyTo: message.replyTo,
          commandType: correlated === null ? null : correlated.type,
        };
      }

      function pendingCount() {
        return pending.size;
      }

      function pendingSeqs() {
        return [...pending.keys()];
      }

      return { command: command, accept: accept, revoke: revoke, expire: expire, pendingCount: pendingCount, pendingSeqs: pendingSeqs };
    }

    /** Static layout base (composition px) from the authoritative inspect. */
    function canvasStaticBase(layout) {
      function extent(key, positive) {
        if (canvasPlainObject(layout) === false) return null;
        const value = layout[key];
        if (canvasFiniteNumber(value) === false || value < 0) return null;
        if (positive === true && value <= 0) return null;
        return value;
      }
      return {
        left: extent('left', false),
        top: extent('top', false),
        width: extent('width', true),
        height: extent('height', true),
      };
    }

    function canvasClampNumber(value, minimum, maximum) {
      const ceiling = maximum < minimum ? minimum : maximum;
      return Math.min(Math.max(value, minimum), ceiling);
    }

    function canvasRoundNumber(value) {
      return Math.round(value * 1000) / 1000;
    }

    function canvasValidRect(value) {
      if (canvasPlainObject(value) === false) return null;
      if (canvasFiniteNumber(value.x) === false || canvasFiniteNumber(value.y) === false) return null;
      if (canvasFiniteNumber(value.width) === false || canvasFiniteNumber(value.height) === false) return null;
      if (value.width < 0 || value.height < 0) return null;
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    }

    /**
     * Turn an animated drag preview into the static layout patch to persist.
     *
     * `base` is inspected.elements[].layout (null = unset/auto), `animated` is the
     * runtime hit rect captured at pointer-down and `preview` is the same rect
     * moved by the pointer delta. A move only patches left/top from the static
     * origin plus the animated delta; a resize inverts the current animation
     * scale (sx from width, sy from height, else sy := sx) so neither the
     * transform nor the animated offset is ever baked into the document.
     */
    function canvasLayoutPatch(input) {
      const settings = canvasPlainObject(input) ? input : {};
      const mode = typeof settings.mode === 'string' ? settings.mode : '';
      const base = settings.base;
      const animated = canvasValidRect(settings.animated);
      const preview = canvasValidRect(settings.preview);
      const composition = canvasPlainObject(settings.composition)
        ? canvasValidRect({ x: 0, y: 0, width: settings.composition.width, height: settings.composition.height })
        : null;
      if (canvasPlainObject(base) === false || animated === null || preview === null || composition === null) {
        return { ok: false, code: 'E_LAYOUT_INPUT', detail: 'layout drag input is incomplete' };
      }
      if (composition.width <= 0 || composition.height <= 0) {
        return { ok: false, code: 'E_LAYOUT_INPUT', detail: 'composition size is unknown' };
      }
      const move = mode === 'move';
      const widthSide = mode.includes('e') || mode.includes('w');
      const heightSide = mode.includes('n') || mode.includes('s');
      if (move === false && (mode === '' || /^[ns]?[ew]?$/.test(mode) === false || (widthSide === false && heightSide === false))) {
        return { ok: false, code: 'E_LAYOUT_INPUT', detail: 'unknown drag mode' };
      }
      const dx = preview.x - animated.x;
      const dy = preview.y - animated.y;
      if (move) {
        if (base.left === null || base.top === null) return { ok: false, code: 'E_LAYOUT_BASE', detail: 'static origin is unknown' };
        const widthBasis = base.width !== null ? base.width : animated.width;
        const heightBasis = base.height !== null ? base.height : animated.height;
        return {
          ok: true,
          patch: {
            left: canvasRoundNumber(canvasClampNumber(base.left + dx, 0, composition.width - widthBasis)),
            top: canvasRoundNumber(canvasClampNumber(base.top + dy, 0, composition.height - heightBasis)),
          },
        };
      }
      // sx is only derivable from the static width; an auto width must never be
      // turned into a scale guess. sy falls back to sx, as the reviewed inverse
      // mapping specifies (uniform scale when the static height is auto).
      const sxFromWidth = base.width !== null && animated.width > 0 ? animated.width / base.width : null;
      const syFromHeight = base.height !== null && animated.height > 0 ? animated.height / base.height : null;
      const sxKnown = sxFromWidth !== null && Number.isFinite(sxFromWidth) && sxFromWidth > 0;
      const syKnown = syFromHeight !== null && Number.isFinite(syFromHeight) && syFromHeight > 0;
      const sx = sxKnown ? sxFromWidth : null;
      const sy = syKnown ? syFromHeight : sx;
      if (widthSide && (sx === null || sx <= 0)) return { ok: false, code: 'E_LAYOUT_SCALE', detail: 'current width scale is unknown' };
      if (heightSide && (sy === null || sy <= 0)) return { ok: false, code: 'E_LAYOUT_SCALE', detail: 'current height scale is unknown' };
      const patch = {};
      // East/south edges keep the static left/top, so the composition bound for
      // the new extent is the remaining space after that static origin.
      const widthCeiling = widthSide && mode.includes('w') === false && base.left !== null ? Math.max(1, composition.width - base.left) : composition.width;
      const heightCeiling = heightSide && mode.includes('n') === false && base.top !== null ? Math.max(1, composition.height - base.top) : composition.height;
      if (widthSide) patch.width = canvasRoundNumber(canvasClampNumber(preview.width / sx, 1, widthCeiling));
      if (heightSide) patch.height = canvasRoundNumber(canvasClampNumber(preview.height / sy, 1, heightCeiling));
      if (mode.includes('w')) {
        if (base.left === null) return { ok: false, code: 'E_LAYOUT_BASE', detail: 'static left is unknown' };
        const left = canvasClampNumber(base.left + dx / sx, 0, composition.width - 1);
        patch.left = canvasRoundNumber(left);
        if (widthSide) patch.width = canvasRoundNumber(canvasClampNumber(preview.width / sx, 1, Math.max(1, composition.width - left)));
      }
      if (mode.includes('n')) {
        if (base.top === null) return { ok: false, code: 'E_LAYOUT_BASE', detail: 'static top is unknown' };
        const top = canvasClampNumber(base.top + dy / sy, 0, composition.height - 1);
        patch.top = canvasRoundNumber(top);
        if (heightSide) patch.height = canvasRoundNumber(canvasClampNumber(preview.height / sy, 1, Math.max(1, composition.height - top)));
      }
      return { ok: true, patch: patch };
    }

    /**
     * Validate and copy the frozen P3-009 `scene.template` from one authoritative
     * inspect result. The returned object is exactly the full replacement input
     * for scene.update: every supported field is preserved, sceneId and unknown
     * keys are not copied, and an absent/invalid template is refused instead of
     * guessed from UI defaults.
     */
    function canvasCopySceneTemplate(template) {
      if (canvasPlainObject(template) === false) return { ok: false, detail: 'scene template is absent' };
      for (const key of Object.keys(template)) {
        if (key === 'sceneId') continue;
        if (CANVAS_SCENE_TEMPLATE_KEYS.includes(key) === false) return { ok: false, detail: 'unknown scene template field ' + key };
      }
      const titleLength = canvasTextLength(template.title);
      if (titleLength < 1 || titleLength > CANVAS_SCENE_TEXT_MAX) {
        return { ok: false, detail: 'scene title is invalid' };
      }
      if (canvasFiniteNumber(template.duration) === false || template.duration < 0.5 || template.duration > 60) {
        return { ok: false, detail: 'scene duration is invalid' };
      }
      const copy = { title: template.title, duration: template.duration };
      if (template.subtitle !== undefined) {
        const subtitleLength = canvasTextLength(template.subtitle);
        if (subtitleLength < 0 || subtitleLength > CANVAS_SCENE_TEXT_MAX) return { ok: false, detail: 'scene subtitle is invalid' };
        copy.subtitle = template.subtitle;
      }
      if (template.badge !== undefined) {
        const badgeLength = canvasTextLength(template.badge);
        if (badgeLength < 0 || badgeLength > CANVAS_SCENE_TEXT_MAX) return { ok: false, detail: 'scene badge is invalid' };
        copy.badge = template.badge;
      }
      for (const key of ['color', 'accent']) {
        if (template[key] === undefined) continue;
        if (typeof template[key] !== 'string' || CANVAS_SCENE_COLOR.test(template[key]) === false) return { ok: false, detail: 'scene ' + key + ' is invalid' };
        copy[key] = template[key];
      }
      for (const key of ['logo', 'shot']) {
        if (template[key] === undefined) continue;
        if (typeof template[key] !== 'string' || CANVAS_SCENE_ASSET.test(template[key]) === false) return { ok: false, detail: 'scene ' + key + ' is invalid' };
        copy[key] = template[key];
      }
      return { ok: true, template: copy };
    }

    /**
     * Copy the complete template for one Scene from one authoritative inspect
     * result, together with that inspect's revision (the expectedRevision for the
     * immediately following scene.update).
     */
    function canvasSceneTemplate(inspected, sceneId) {
      if (canvasPlainObject(inspected) === false) return { ok: false, code: 'E_SCENE_TEMPLATE', detail: 'inspect result is unavailable' };
      if (typeof inspected.revision !== 'string' || CANVAS_REVISION.test(inspected.revision) === false) {
        return { ok: false, code: 'E_SCENE_TEMPLATE', detail: 'authoritative revision is unavailable' };
      }
      if (Array.isArray(inspected.scenes) === false) return { ok: false, code: 'E_SCENE_TEMPLATE', detail: 'scenes are unavailable' };
      const scene = inspected.scenes.find(function findScene(candidate) {
        return canvasPlainObject(candidate) && candidate.sceneId === sceneId;
      });
      if (scene === undefined) return { ok: false, code: 'E_SCENE_NOT_FOUND', detail: 'scene is no longer present' };
      const copied = canvasCopySceneTemplate(scene.template);
      if (copied.ok === false) return { ok: false, code: 'E_SCENE_TEMPLATE', detail: copied.detail };
      return { ok: true, revision: inspected.revision, sceneId: sceneId, template: copied.template };
    }

    function canvasNormalizedColor(value) {
      return typeof value === 'string' && CANVAS_SCENE_COLOR.test(value) ? value.toLowerCase() : null;
    }

    function canvasNormalizedAssetPath(value) {
      return typeof value === 'string' && CANVAS_SCENE_ASSET.test(value) ? value : null;
    }

    function canvasIsRevisionConflict(error) {
      return canvasPlainObject(error) && error.code === 'E_REVISION_CONFLICT';
    }

    //#endregion

    //#region components
    function StyleTag() {
      return h('style', {
        'data-dsh-video': 'styles',
        dangerouslySetInnerHTML: { __html: CSS },
      });
    }

    /** Local slot component: the embedded occurrence shows only the Chat view. */
    function SessionChatView(props) {
      if (props === null || typeof props !== 'object' || typeof props.renderSlot !== 'function') return null;
      return props.renderSlot('conversation.session', { view: 'chat' });
    }

    /**
     * Render the native Conversation content Factory for the bound Session.
     * `hero:false` is mandatory: the hero workspace chip navigates the host's
     * main conversation. `widthControls` is intentionally omitted so the
     * embedded occurrence has no resize handles.
     */
    function SessionConversationContent(props) {
      if (typeof props.renderFactorySlot !== 'function') return null;
      return h('div', { className: 'dv-conversation' }, props.renderFactorySlot(
        'conversation.content',
        { variant: 'embedded', phase: props.phase === 'active' ? 'active' : 'settling', hero: false },
        { slots: { views: SessionChatView } }
      ));
    }

    /** Observe a sessions.list source without requiring the host kit. */
    function useSessionListSnapshot(sessions) {
      let source = null;
      try {
        source = sessions && sessions.list ? sessions.list : null;
      } catch (_error) {
        source = null;
      }
      if (source === null || typeof source.getSnapshot !== 'function') return null;
      const subscribe = typeof source.subscribe === 'function'
        ? function subscribeSessionList(listener) { return source.subscribe(listener); }
        : function subscribeNothing() { return function unsubscribeNothing() {}; };
      const getSnapshot = function getSessionListSnapshot() { return source.getSnapshot(); };
      try {
        return React.useSyncExternalStore(subscribe, getSnapshot);
      } catch (_error) {
        try {
          return source.getSnapshot();
        } catch (_ignored) {
          return null;
        }
      }
    }

    /** Host-list title projection for one mapped Session, with a stable fallback. */
    function sessionTitleFromSnapshot(snapshot, sessionId) {
      try {
        const record = snapshot && snapshot.projectionsBySession ? snapshot.projectionsBySession[sessionId] : null;
        const title = record && record.values && typeof record.values.title === 'string' ? record.values.title : '';
        if (title.length > 0) return title;
      } catch (_error) {
        /* fall through to the identity */
      }
      return sessionId;
    }

    /**
     * One owned SessionReference and the native Conversation occurrence.
     *
     * Acquisition and release are deliberately split from the parent panel:
     * changing `sessionId` re-keys this component, so React unmounts (and the
     * cleanup releases) the old reference before the new one is created. No
     * Provider is ever rendered with a released reference.
     */
    function SessionConversationHost(props) {
      const t = props.t;
      const sessions = props.sessions;
      const sessionId = props.sessionId;
      const SessionProvider = props.SessionProvider;
      const renderFactorySlot = props.renderFactorySlot;
      const hostConversationOpen = props.hostConversationOpen === true;
      const onRetry = props.onRetry;
      const [reference, setReference] = React.useState(null);
      const [phase, setPhase] = React.useState('loading');
      const [failure, setFailure] = React.useState(null);

      React.useEffect(function acquireSession() {
        let cancelled = false;
        let handle = null;
        let unsubscribe = null;
        setReference(null);
        setFailure(null);
        setPhase('loading');
        if (sessions === null || typeof sessions.retain !== 'function') {
          setFailure({ code: 'E_SESSION_UNAVAILABLE', message: t('video.ai.unavailable') });
          return function cleanupUnavailable() {};
        }
        try {
          handle = sessions.retain(sessionId, { source: SESSION_SOURCE });
        } catch (error) {
          setFailure(hostError(error));
          return function cleanupFailed() {};
        }
        setReference(handle);
        function readSnapshot() {
          if (cancelled || handle === null) return;
          let binding = null;
          try {
            binding = handle.binding !== undefined && handle.binding !== null ? handle.binding : null;
          } catch (_error) {
            binding = null;
          }
          const face = binding !== null && binding.session ? binding.session : null;
          if (face === null) return;
          let snapshot = null;
          try {
            snapshot = typeof face.getSnapshot === 'function' ? face.getSnapshot() : null;
          } catch (_error) {
            snapshot = null;
          }
          if (snapshot === null || typeof snapshot !== 'object') return;
          if (snapshot.openState === 'error') {
            setPhase('error');
            setFailure({ code: 'E_SESSION_OPEN', message: '' });
            return;
          }
          if (snapshot.openState === 'open') setPhase('active');
          else setPhase('settling');
        }
        Promise.resolve(handle.ready).then(function sessionReady(binding) {
          if (cancelled) return;
          const face = binding !== null && binding !== undefined && binding.session ? binding.session : null;
          if (face !== null && typeof face.subscribe === 'function') {
            try {
              unsubscribe = face.subscribe(readSnapshot);
            } catch (_error) {
              unsubscribe = null;
            }
          }
          readSnapshot();
        }).catch(function sessionFailed(error) {
          if (cancelled) return;
          setFailure(hostError(error));
          setPhase('error');
        });
        return function cleanupSession() {
          cancelled = true;
          if (typeof unsubscribe === 'function') {
            try {
              unsubscribe();
            } catch (_error) {
              /* observed source cleanup is best effort */
            }
          }
          if (handle !== null) {
            try {
              handle.release();
            } catch (_error) {
              /* release is idempotent at the controller boundary */
            }
          }
        };
      }, [sessionId]);

      if (hostConversationOpen) {
        return h('p', { className: 'dv-ai-notice', role: 'status' }, t('video.ai.hostOpen'));
      }
      if (failure !== null) {
        return h(
          'div',
          { className: 'dv-ai-error', role: 'alert' },
          h('p', { className: 'dv-error' }, errorText(failure, t)),
          typeof onRetry === 'function'
            ? h('button', { type: 'button', className: 'dv-button dv-button-quiet', onClick: onRetry }, t('video.ai.retry'))
            : null
        );
      }
      if (reference === null) {
        return h('p', { className: 'dv-ai-loading', role: 'status' }, t('video.ai.loading'));
      }
      if (typeof SessionProvider !== 'function' || typeof renderFactorySlot !== 'function') {
        return h('p', { className: 'dv-ai-error', role: 'alert' }, t('video.ai.unavailable'));
      }
      return h(
        SessionProvider,
        { session: reference },
        h(SessionConversationContent, { renderFactorySlot: renderFactorySlot, phase: phase })
      );
    }

    //#region P3-008 canvas workspace
    // The canvas is a sandboxed snapshot document plus a fixed Host-injected
    // runtime. This component owns only the editor layer: letterbox mapping,
    // selection, inline text, drag/resize commits, playback control and the
    // material drawer. Project/revision truth stays in the Host worker.
    function canvasInstanceId() {
      const random = Math.random().toString(36).slice(2, 10);
      return ('dvcanvas-' + random).padEnd(12, '0').slice(0, 32);
    }

    function canvasNonce() {
      const values = new Uint8Array(16);
      try {
        if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
          globalThis.crypto.getRandomValues(values);
        } else {
          for (let index = 0; index < values.length; index += 1) values[index] = Math.floor(Math.random() * 256);
        }
      } catch (_error) {
        for (let index = 0; index < values.length; index += 1) values[index] = Math.floor(Math.random() * 256);
      }
      return Array.prototype.map.call(values, function hex(value) {
        return value.toString(16).padStart(2, '0');
      }).join('');
    }

    function canvasNumber(value, fallback) {
      return Number.isFinite(Number(value)) ? Number(value) : fallback;
    }

    function usePanelDismiss(onClose, trigger) {
      const panel = React.useRef(null), close = React.useRef(onClose);
      close.current = onClose;
      React.useEffect(() => {
        const node = panel.current;
        if (!node) return;
        const owner = node.ownerDocument;
        const opener = owner.activeElement;
        const outside = e => {
          if (node.contains(e.target) || e.target.closest?.('[data-panel-trigger="' + trigger + '"]')) return;
          close.current();
        };
        const keyboard = e => {
          if (e.key !== 'Escape' || e.isComposing) return;
          e.preventDefault(); e.stopPropagation(); close.current();
          if (opener?.getAttribute('data-panel-trigger') === trigger) opener.focus();
        };
        owner.addEventListener('pointerdown', outside, true);
        owner.addEventListener('keydown', keyboard, true);
        return () => { owner.removeEventListener('pointerdown', outside, true); owner.removeEventListener('keydown', keyboard, true); };
      }, [trigger]);
      return panel;
    }

    async function updateRequest(action,extra){
      const response=await fetch('api/dsh-video/updates',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...extra})});
      if(!response.ok)throw new Error('Update request failed');return response.json();
    }
    function UpdatePanel(props){
      const h=React.createElement,t=props.t,ref=usePanelDismiss(props.onClose,'updates'),v=props.value;
      return h('section',{className:'dv-update-panel',ref,role:'dialog','aria-label':t('video.update.title')},
        h('header',null,h('strong',null,t('video.update.title')),h('button',{className:'dv-icon-button',onClick:props.onClose,'aria-label':t('video.update.close')},'×')),
        h('small',null,t('video.update.version')+' '+(v.currentVersion||'…')),
        h('p',{role:'status'},t('video.update.'+v.phase)),
        v.latestVersion?h('strong',null,'v'+v.latestVersion):null,
        v.releaseUrl?h('a',{href:v.releaseUrl,target:'_blank',rel:'noopener noreferrer'},t('video.update.notes')):null,
        h('footer',null,h('button',{className:'dv-button',disabled:['checking','installing','installed','restart-required'].includes(v.phase),onClick:props.onCheck},t('video.update.check')),['available','failed'].includes(v.phase)&&v.latestVersion?h('button',{className:'dv-button dv-button-primary',onClick:props.onInstall,disabled:props.busy,title:props.busy?t('video.update.busy'):undefined},t('video.update.install')):null));
    }
    function UpdateControl(props){
      const h=React.createElement,t=props.t,[open,setOpen]=React.useState(false),[value,setValue]=React.useState({phase:'idle'}),alive=React.useRef(true);
      async function request(action,extra){try{const next=await updateRequest(action,extra);if(alive.current)setValue(next);}catch{if(alive.current)setValue(v=>({...v,phase:action==='install'?'failed':'check-failed'}));}}
      React.useEffect(()=>{alive.current=true;const timer=setTimeout(()=>void request('check'),15000);return()=>{alive.current=false;clearTimeout(timer);};},[]);
      React.useEffect(()=>{if(value.phase!=='installing')return;const timer=setInterval(()=>void request('status'),1000);return()=>clearInterval(timer);},[value.phase]);
      const check=()=>{setValue(v=>({...v,phase:'checking'}));void request('check');};
      return h('div',{className:'dv-update-control'},h('button',{className:'dv-button dv-button-quiet','data-panel-trigger':'updates','aria-expanded':open,'aria-label':t('video.update.title'),onClick:()=>{setOpen(!open);if(!open&&value.phase==='idle')check();}},t(value.phase==='available'?'video.update.availableButton':'video.update.title')),
        open?h(UpdatePanel,{t,value,busy:props.busy,onClose:()=>setOpen(false),onCheck:check,onInstall:()=>{setValue(v=>({...v,phase:'installing'}));void request('install',{version:value.latestVersion,confirm:true});}}):null);
    }

    function MediaLibraryPanel(props) {
      const panelRef = usePanelDismiss(props.onClose, "media");
      const [referenceRevision,setReferenceRevision]=React.useState('');
      React.useEffect(()=>{let stop=false;void hostRequest('timeline.inspect',{projectId:props.projectId,limit:1}).then(r=>{if(!stop)setReferenceRevision(r.revision);}).catch(()=>{});return()=>{stop=true;};},[props.projectId]);
      const t = props.t,
        projectId = props.projectId;
      const [assets, setAssets] = React.useState([]),
        [kind, setKind] = React.useState(''),
        [query, setQuery] = React.useState('');
      const [cursor, setCursor] = React.useState(null),
        [selected, setSelected] = React.useState(null),
        [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(false),
        [upload, setUpload] = React.useState(null),
        [confirmRemove, setConfirmRemove] = React.useState(false);
      const [cacheVersion, setCacheVersion] = React.useState(0),
        [deriveBusy, setDeriveBusy] = React.useState(false);
      const [derivedReady, setDerivedReady] = React.useState({});
      const deriveSeen = React.useRef({});
      const [proxyReady, setProxyReady] = React.useState({});
      const requestSerial = React.useRef(0),
        uploadRef = React.useRef(null),
        alive = React.useRef(true);
      function mediaUrl(asset, derived) {
        return (
          'api/dsh-video/' +
          (derived ? 'derived' : 'media') +
          '?projectId=' +
          encodeURIComponent(projectId) +
          '&assetId=' +
          encodeURIComponent(asset.assetId) +
          (derived ? '&kind=' + derived : '')
        );
      }
      async function load(nextCursor) {
        const serial = ++requestSerial.current;
        setLoading(true);
        setError(null);
        try {
          const page = await hostRequest('asset.list', {
            projectId: projectId,
            limit: 30,
            ...(kind ? { kind: kind } : {}),
            ...(query.trim() ? { query: query.trim() } : {}),
            ...(nextCursor ? { cursor: nextCursor } : {}),
          });
          if (!alive.current || serial !== requestSerial.current) return;
          setAssets((previous) => (nextCursor ? previous.concat(page.assets) : page.assets));
          setCursor(page.nextCursor);
        } catch (e) {
          if (alive.current && serial === requestSerial.current) setError(hostError(e));
        } finally {
          if (alive.current && serial === requestSerial.current) setLoading(false);
        }
      }
      React.useEffect(
        function mediaLoad() {
          alive.current = true;
          setSelected(null);
          const timer = setTimeout(() => {
            void load(null);
          }, 150);
          return () => {
            clearTimeout(timer);
            requestSerial.current++;
          };
        },
        [projectId, kind, query],
      );
      React.useEffect(
        function mediaDerivatives() {
          let cancelled = false;
          void (async () => {
            for (const asset of assets) {
              if (cancelled || deriveSeen.current[asset.assetId]) continue;
              deriveSeen.current[asset.assetId] = true;
              try {
                await hostRequest('asset.derive', {
                  projectId: projectId,
                  assetId: asset.assetId,
                  kind: asset.kind === 'audio' ? 'waveform' : 'thumb',
                });
                if (alive.current) setDerivedReady((previous) => ({ ...previous, [asset.assetId]: true }));
              } catch (e) {
                delete deriveSeen.current[asset.assetId];
              }
            }
          })();
          return () => {
            cancelled = true;
          };
        },
        [assets, projectId],
      );
      React.useEffect(function mediaCleanup() {
        return () => {
          alive.current = false;
          requestSerial.current++;
          if (uploadRef.current) uploadRef.current.abort();
        };
      }, []);
      async function derive(asset) {
        setDeriveBusy(true);
        setError(null);
        try {
          await hostRequest('asset.derive', {
            projectId: projectId,
            assetId: asset.assetId,
            kind: asset.kind === 'audio' ? 'waveform' : 'thumb',
          });
          if (alive.current) {
            setCacheVersion((v) => v + 1);
            setDerivedReady((previous) => ({ ...previous, [asset.assetId]: true }));
          }
        } catch (e) {
          if (alive.current) setError(hostError(e));
        } finally {
          if (alive.current) setDeriveBusy(false);
        }
      }
      async function compatibilityPreview(asset) {
        setDeriveBusy(true);
        setError(null);
        try {
          await hostRequest('asset.derive', { projectId: projectId, assetId: asset.assetId, kind: 'proxy' });
          if (alive.current) setProxyReady((previous) => ({ ...previous, [asset.assetId]: true }));
        } catch (e) {
          if (alive.current) setError(hostError(e));
        } finally {
          if (alive.current) setDeriveBusy(false);
        }
      }
      function choose(asset) {
        setSelected(asset);
        setConfirmRemove(false);
        void derive(asset);
      }
      async function removeSelected() {
        if (!selected) return;
        setError(null);
        try {
          await hostRequest('asset.remove', {
            projectId: projectId,
            assetId: selected.assetId,
            operationId: operationId(),
          });
          if (alive.current) {
            setSelected(null);
            setConfirmRemove(false);
            await load(null);
          }
        } catch (e) {
          if (alive.current) setError(hostError(e));
        }
      }
      async function importFiles(files) {
        if (uploadRef.current || !files || !files.length) return;
        setError(null);
        try {
          for (const file of Array.from(files)) {
            if (!alive.current) break;
            const receipt = await new Promise((yes, no) => {
              const xhr = new XMLHttpRequest();
              uploadRef.current = xhr;
              xhr.open('POST', 'api/dsh-video/asset-upload');
              xhr.withCredentials = true;
              xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
              xhr.setRequestHeader('x-dsh-project-id', projectId);
              xhr.setRequestHeader('x-dsh-file-name', encodeURIComponent(file.name));
              setUpload({ name: file.name, percent: 0, processing: false });
              xhr.upload.onprogress = (e) => {
                if (alive.current && e.lengthComputable)
                  setUpload({ name: file.name, percent: Math.round((e.loaded / e.total) * 100), processing: false });
              };
              xhr.onerror = () => no({ code: 'E_ASSET_UPLOAD', message: t('video.media.failed') });
              xhr.onabort = () => no({ code: 'E_CANCELLED', message: t('video.media.cancelled') });
              xhr.onload = () => {
                try {
                  const value = JSON.parse(xhr.responseText);
                  xhr.status >= 200 && xhr.status < 300 ? yes(value) : no(value.error || value);
                } catch (e) {
                  no(e);
                }
              };
              xhr.send(file);
            });
            uploadRef.current = null;
            if (!alive.current) break;
            setUpload({ name: file.name, percent: 100, processing: true });
            await hostRequest('asset.importMedia', {
              projectId: projectId,
              receiptId: receipt.receiptId,
              operationId: operationId(),
            });
            if (alive.current) await load(null);
          }
        } catch (e) {
          if (alive.current) setError(hostError(e));
        } finally {
          uploadRef.current = null;
          if (alive.current) setUpload(null);
        }
      }
      const busy = upload !== null;
      return h(
        'aside',
        {
          className: 'dv-drawer dv-media-library', ref: panelRef, role: 'dialog',
          'aria-label': t('video.canvas.materials'),
          onDragOver: (e) => {
            e.preventDefault();
          },
          onDrop: (e) => {
            e.preventDefault();
            if (!busy) void importFiles(e.dataTransfer.files);
          },
        },
        h(
          'div',
          { className: 'dv-drawer-head' },
          h('strong', null, t('video.canvas.materials')),
          h(
            'button',
            { type: 'button', className: 'dv-icon-button', onClick: props.onClose, 'aria-label': t('video.canvas.close') },
            '×',
          ),
        ),
        h(
          'label',
          { className: 'dv-upload' },
          t('video.media.import'),
          h('input', {
            type: 'file',
            multiple: true,
            accept: '.mp4,.mov,.m4v,.webm,.mp3,.wav,.m4a,.aac,.flac,.png,.jpg,.jpeg',
            disabled: busy,
            onChange: (e) => {
              void importFiles(e.target.files);
              e.target.value = '';
            },
          }),
        ),
        h('input', {
          type: 'search',
          className: 'dv-media-search',
          value: query,
          maxLength: 120,
          placeholder: t('video.media.search'),
          'aria-label': t('video.media.search'),
          onChange: (e) => setQuery(e.target.value),
        }),
        h(
          'div',
          { className: 'dv-media-filters', role: 'group', 'aria-label': t('video.media.filter') },
          ['', 'video', 'image', 'audio'].map((k) =>
            h(
              'button',
              {
                key: k,
                type: 'button',
                className: 'dv-button dv-button-quiet',
                'aria-pressed': kind === k ? 'true' : 'false',
                onClick: () => setKind(k),
              },
              t('video.media.' + (k || 'all')),
            ),
          ),
        ),
        busy
          ? h(
              'div',
              { role: 'status', className: 'dv-media-progress' },
              h('span', null, upload.name),
              h('progress', { max: 100, value: upload.processing ? undefined : upload.percent }),
              h('span', null, upload.processing ? t('video.media.processing') : upload.percent + '%'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dv-button dv-button-quiet',
                  disabled: upload.processing,
                  onClick: () => uploadRef.current?.abort(),
                },
                t('video.media.cancel'),
              ),
            )
          : null,
        error
          ? h(
              'div',
              { role: 'alert', className: 'dv-tool-error' },
              errorText(error, t),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dv-button dv-button-quiet',
                  onClick: () => {
                    void load(null);
                  },
                },
                t('video.media.retry'),
              ),
            )
          : null,
        loading && assets.length === 0
          ? h('p', { className: 'dv-tool-hint', role: 'status' }, t('video.media.loading'))
          : null,
        !loading && assets.length === 0 ? h('p', { className: 'dv-tool-hint' }, t('video.media.empty')) : null,
        h(
          'div',
          { className: 'dv-media-grid' },
          assets.map((asset) =>
            h(
              'button',
              {
                key: asset.assetId,
                type: 'button',
                draggable:true,onDragStart:e=>e.dataTransfer.setData('application/x-dsh-asset',asset.assetId),className: 'dv-media-tile',
                'aria-pressed': selected?.assetId === asset.assetId ? 'true' : 'false',
                onClick: () => choose(asset),
              },
              derivedReady[asset.assetId]
                ? h('img', {
                    src: mediaUrl(asset, asset.kind === 'audio' ? 'waveform' : 'thumb'),
                    alt: '',
                    loading: 'lazy',
                  })
                : h(
                    'span',
                    { className: 'dv-media-placeholder', 'aria-hidden': 'true' },
                    asset.kind === 'video' ? '▷' : '♪',
                  ),
              h('span', { className: 'dv-media-name', title: asset.name }, asset.name),
              h(
                'small',
                null,
                asset.kind === 'image'
                  ? (asset.media?.width || '—') + ' × ' + (asset.media?.height || '—')
                  : formatSeconds(asset.media?.durationSec || 0),
              ),
            ),
          ),
        ),
        cursor
          ? h(
              'button',
              {
                type: 'button',
                className: 'dv-button dv-button-quiet',
                disabled: loading,
                onClick: () => {
                  void load(cursor);
                },
              },
              t('video.media.more'),
            )
          : null,
        selected
          ? h(
              'section',
              { className: 'dv-media-detail', key: selected.assetId },
              h('strong', null, selected.name),
              props.onAdd?h('button',{className:'dv-button dv-button-primary',onClick:()=>props.onAdd(selected)},t('video.timeline.add')):null,
              selected.kind === 'image'
                ? h('img', { className: 'dv-media-preview', src: mediaUrl(selected), alt: selected.name })
                : h(selected.kind === 'audio' ? 'audio' : 'video', {
                    className: 'dv-media-preview',
                    src: mediaUrl(selected, proxyReady[selected.assetId] ? 'proxy' : undefined),
                    controls: true,
                    preload: 'metadata',
                  }),
              h('img', {
                className: 'dv-media-derived',
                key: cacheVersion,
                src: mediaUrl(selected, selected.kind === 'audio' ? 'waveform' : 'thumb') + '#v=' + cacheVersion,
                alt: t('video.media.' + (selected.kind === 'audio' ? 'waveform' : 'thumbnail')),
                onError: (e) => {
                  e.target.style.visibility = 'hidden';
                },
                onLoad: (e) => {
                  e.target.style.visibility = 'visible';
                },
              }),
              h(
                'p',
                null,
                Math.round(selected.bytes / 1024) +
                  ' KiB · ' +
                  (selected.media?.width ? selected.media.width + ' × ' + selected.media.height + ' · ' : '') +
                  (selected.kind === 'image' ? '' : formatSeconds(selected.media?.durationSec || 0)),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dv-button dv-button-quiet',
                  disabled: deriveBusy,
                  onClick: () => {
                    void derive(selected);
                  },
                },
                t(deriveBusy ? 'video.media.processing' : 'video.media.rebuild'),
              ),
              selected.kind !== 'image'
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dv-button dv-button-quiet',
                      disabled: deriveBusy,
                      onClick: () => {
                        void compatibilityPreview(selected);
                      },
                    },
                    t('video.media.compatibility'),
                  )
                : null,
              h(
                'label',
                { className: 'dv-media-reference' },
                t('video.media.reference'),
                h('input', {
                  readOnly: true,
                  value: referenceText(referenceToken(props.projectId,'asset',selected.assetId,referenceRevision)),
                  onFocus: (e) => e.target.select(),
                  'aria-label': t('video.media.reference'),
                }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dv-button dv-button-quiet',
                  onClick: () => {
                    if (confirmRemove) void removeSelected();
                    else setConfirmRemove(true);
                  },
                },
                t(confirmRemove ? 'video.media.confirmRemove' : 'video.media.remove'),
              ),
              confirmRemove
                ? h(
                    'button',
                    { type: 'button', className: 'dv-button dv-button-quiet', onClick: () => setConfirmRemove(false) },
                    t('video.media.cancel'),
                  )
                : null,
            )
          : null,
      );
    }

    function ReferencePanel(props) {
      const panelRef = usePanelDismiss(props.onClose, 'references');
      const searchInput = React.useRef(null);
      React.useEffect(() => { searchInput.current?.focus(); }, []);
      const h = React.createElement,
        t = props.t;
      const [query, setQuery] = React.useState(''),
        [data, setData] = React.useState(null),
        [selected, setSelected] = React.useState(null),
        [notice, setNotice] = React.useState(''),
        [offset, setOffset] = React.useState(0);
      const [from, setFrom] = React.useState('0'),
        [to, setTo] = React.useState('5');
      const [refreshTick,setRefreshTick]=React.useState(0);
      const tokenInput=React.useRef(null);
      React.useEffect(()=>{if(selected&&tokenInput.current){tokenInput.current.focus();tokenInput.current.select();}},[selected]);
      React.useEffect(() => {
        let stopped = false;
        setData(null);
        setSelected(null);
        const timer = setTimeout(() => {
          void hostRequest('timeline.references', {
            projectId: props.projectId,
            query,
            offset,
            limit: 24,
          })
            .then((r) => {
              if (!stopped) {
                setData(r);
                setNotice('');
              }
            })
            .catch(() => {
              if (!stopped) setNotice(t('video.reference.failed'));
            });
        }, 100);
        return () => {
          stopped = true;
          clearTimeout(timer);
        };
      }, [props.projectId, props.revision, query, offset, refreshTick]);
      async function select(item) {
        setNotice('');
        try {
          const r = await hostRequest('timeline.resolve', {
            projectId: props.projectId,
            refs: [{ kind: 'token', token: item.token }],
          });
          const match = r.matches[0];
          if (match.status !== 'resolved') {
            setSelected(null);
            setNotice(match.message || t('video.reference.failed'));
            return;
          }
          setSelected(item);
        } catch (_error) {
          setNotice(t('video.reference.failed'));
        }
      }
      function range() {
        const a = Math.round(Number(from) * 30),
          b = Math.round(Number(to) * 30);
        if (
          !data ||
          !Number.isInteger(a) ||
          !Number.isInteger(b) ||
          a < 0 ||
          b <= a ||
          b > data.durationFrames
        ) {
          setNotice(t('video.reference.rangeInvalid'));
          return;
        }
        void select({
          kind: 'range',
          label: t('video.reference.range'),
          token: referenceToken(
            props.projectId,
            'range',
            a + '-' + b,
            data.revision,
          ),
        });
      }
      return h(
        'section',
        {
          className: 'dv-reference-panel', ref: panelRef, role: 'dialog',
          'aria-label': t('video.reference.title'),
          onKeyDown: (e) => {
            if (e.key === 'Escape') props.onClose();
          },
        },
        h(
          'div',
          { className: 'dv-reference-head' },
          h('strong', null, t('video.reference.title')),
          h('div', {className:'dv-panel-actions'},
          h('button',{className:'dv-icon-button','aria-label':t('video.reference.refresh'),title:t('video.reference.refresh'),onClick:()=>{setOffset(0);setRefreshTick(v=>v+1);}},'↻'),
          h(
            'button',
            {
              className: 'dv-icon-button',
              'aria-label': t('video.canvas.close'),
              onClick: props.onClose,
            },
            '×',
          ),
        ),
        ),
        h('input', {
          type: 'search',
          ref: searchInput,
          value: query,
          maxLength: 120,
          'aria-label': t('video.reference.search'),
          placeholder: t('video.reference.search'),
          onChange: (e) => {
            setQuery(e.target.value);
            setOffset(0);
          },
        }),
        h('p', { className: 'dv-reference-help' }, t('video.reference.help')),
        selected
          ? h(
              'label',
              { className: 'dv-reference-token' },
              selected.label,
              h('input', {
                readOnly: true,
                value: referenceText(selected.token),
                ref: tokenInput,
                'aria-label': t('video.media.reference'),
                onFocus: (e) => e.target.select(),
              }),
            )
          : null,
        h(
          'div',
          { className: 'dv-reference-items' },
          data?.items.map((item) =>
            h(
              'button',
              {
                key: item.token,
                className: 'dv-reference-item',
                'aria-pressed': selected?.token === item.token,
                onClick: () => select(item),
              },
              h(
                'span',
                null,
                item.label,
              ),
              h('small', null, h('em', {className:'dv-reference-kind'},t('video.reference.' + item.kind)), item.detail ? ' · ' + item.detail : ''),
            ),
          ),
        ),
        data && !data.items.length
          ? h('p', null, t('video.reference.empty'))
          : null,
        h(
          'div',
          { className: 'dv-reference-pages' },
          offset > 0
            ? h(
                'button',
                {
                  className: 'dv-button dv-button-quiet',
                  onClick: () => setOffset(Math.max(0, offset - 24)),
                },
                t('video.reference.previous'),
              )
            : null,
          data?.nextOffset !== null && data?.nextOffset !== undefined
            ? h(
                'button',
                {
                  className: 'dv-button dv-button-quiet',
                  onClick: () => setOffset(data.nextOffset),
                },
                t('video.media.more'),
              )
            : null,
        ),
        h(
          'details',
          { className: 'dv-reference-range-wrap' },
          h('summary',null,t('video.reference.customRange')),
          h('div',{className:'dv-reference-range'},
          h('input', {
            'aria-label': t('video.reference.from'),
            type: 'number',
            min: 0,
            step: 0.1,
            value: from,
            onChange: (e) => setFrom(e.target.value),
          }),
          h('span', null, '–'),
          h('input', {
            'aria-label': t('video.reference.to'),
            type: 'number',
            min: 0,
            step: 0.1,
            value: to,
            onChange: (e) => setTo(e.target.value),
          }),
          h('span', null, 's'),
          h(
            'button',
            {
              className: 'dv-button dv-button-quiet',
              disabled: !data,
              onClick: range,
            },
            t('video.reference.range'),
          ),
        ),
        ),
        h('p', { role: 'status' }, notice),
      );
    }
    function TimelinePopover(props) {
      const nodeRef=React.useRef(null);
      const hidePopup=()=>{const menu=nodeRef.current?.children[1];if(menu?.hasAttribute('popover'))menu.hidePopover?.();};
      React.useEffect(()=>{
        const node=nodeRef.current,owner=node.ownerDocument;
        const close=()=>{hidePopup();node.open=false;};
        const outside=e=>{if(node.open&&!node.contains(e.target))close();};
        const escape=e=>{if(node.open&&e.key==='Escape'&&!e.isComposing){e.preventDefault();e.stopPropagation();close();node.firstElementChild?.focus();}};
        owner.addEventListener('pointerdown',outside,true);
        owner.addEventListener('keydown',escape,true);
        return()=>{owner.removeEventListener('pointerdown',outside,true);owner.removeEventListener('keydown',escape,true);};
      },[]);
      React.useEffect(()=>{
        const node=nodeRef.current,menu=node.children[1];
        if(!props.requestOpen||!menu)return;
        node.open=true;
        // The top layer uses viewport coordinates even inside transformed host panels.
        menu.setAttribute('popover','manual');
        menu.style.margin='0';menu.style.right='auto';menu.style.bottom='auto';menu.style.color='inherit';
        menu.style.maxWidth='calc(100vw - 16px)';menu.style.maxHeight='calc(100vh - 16px)';
        menu.showPopover?.();
        const place=()=>{const view=node.ownerDocument.defaultView,r=menu.getBoundingClientRect(),{x,y}=props.requestOpen;
          menu.style.left=Math.max(8,Math.min(x+r.width<=view.innerWidth-8?x:x-r.width,view.innerWidth-r.width-8))+'px';
          menu.style.top=Math.max(8,Math.min(y+r.height<=view.innerHeight-8?y:y-r.height,view.innerHeight-r.height-8))+'px';};
        place();const observer=new ResizeObserver(place);observer.observe(menu);
        const view=node.ownerDocument.defaultView;view.addEventListener('resize',place);
        return()=>{observer.disconnect();view.removeEventListener('resize',place);menu.hidePopover?.();menu.removeAttribute('popover');};
      },[props.requestOpen]);
      return React.createElement('details',{className:props.className,style:props.style,ref:nodeRef,onToggle:()=>{if(!nodeRef.current.open){hidePopup();props.onClosed?.();}},onClick:e=>{if(props.closeOnAction&&e.target.closest('button')){hidePopup();nodeRef.current.open=false;props.onClosed?.();nodeRef.current.firstElementChild?.focus();}}},props.children);
    }

    function TrackDeleteConfirmation(props) {
      const panel=usePanelDismiss(props.onCancel,'track-delete');
      return React.createElement('div',{className:'dv-track-delete-confirm',ref:panel,role:'alertdialog','aria-label':props.t('video.timeline.removeTrack')},
        React.createElement('strong',null,props.t('video.timeline.removeTrack')+' · '+props.name),
        React.createElement('p',null,props.t('video.timeline.removeTrackHelp')),
        React.createElement('button',{className:'dv-button',disabled:props.busy,onClick:props.onCancel},props.t('video.timeline.cancelDelete')),
        React.createElement('button',{className:'dv-button',disabled:props.busy,onClick:props.onConfirm},props.t('video.timeline.confirmDelete')));
    }

    function ClipVisuals(props) {
      const h=React.createElement,root=React.useRef(null),canvas=React.useRef(null);
      const [view,setView]=React.useState(null),[result,setResult]=React.useState(null);
      React.useEffect(()=>{
        const el=root.current;
        let timer;const measure=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(!el)return;if(el.ownerDocument.hidden){setView(null);return;}const r=el.getBoundingClientRect(),v=el.closest('.dv-timeline')?.getBoundingClientRect();if(!v||r.bottom<v.top||r.top>v.bottom||r.right<v.left+156||r.left>v.right){setView(null);return;}const left=Math.max(0,v.left+156-r.left),right=Math.min(r.width,v.right-r.left);if(right<=left)return;setView({left,right,width:r.width});},180);};
        const observer=new ResizeObserver(measure);if(el)observer.observe(el);el?.ownerDocument.addEventListener('scroll',measure,true);el?.ownerDocument.addEventListener('visibilitychange',measure);measure();
        return()=>{clearTimeout(timer);observer.disconnect();el?.ownerDocument.removeEventListener('scroll',measure,true);el?.ownerDocument.removeEventListener('visibilitychange',measure);};
      },[props.zoom,props.revision]);
      React.useEffect(()=>{
        if(!view||props.playing)return;let dead=false,taskId;const c=props.clip;
        const cancel=()=>{dead=true;if(taskId)void hostRequest('timeline.visuals.cancel',{projectId:props.projectId,taskId}).catch(()=>{});};
        (async()=>{try{
          const visibleStart=Math.max(c.startFrame,Math.floor(c.startFrame+view.left/props.zoom*30)),visibleEnd=Math.min(c.startFrame+c.durationFrames,Math.ceil(c.startFrame+view.right/props.zoom*30));
          const count=Math.max(1,Math.min(24,Math.ceil((view.right-view.left)/88))),batches=Math.ceil(count/4);
          let jobs=result?.revision===props.revision?result.jobs.filter(j=>j.endFrame>visibleStart&&j.startFrame<visibleEnd):[];
          for(let batch=0;batch<batches&&!dead;batch++){
            const startFrame=Math.floor(visibleStart+(visibleEnd-visibleStart)*batch/batches),endFrame=Math.floor(visibleStart+(visibleEnd-visibleStart)*(batch+1)/batches);
            if(endFrame<=startFrame)continue;
            const sampleCount=Math.min(4,count-batch*4);
            if(jobs.some(j=>j.startFrame===startFrame&&j.endFrame===endFrame&&j.count===sampleCount))continue;
            const request=await hostRequest('timeline.visuals.request',{projectId:props.projectId,expectedRevision:props.revision,clipId:c.clipId,startFrame,endFrame,count:sampleCount});taskId=request.taskId;
            if(dead){void hostRequest('timeline.visuals.cancel',{projectId:props.projectId,taskId}).catch(()=>{});break;}
            let status=request;
            while(!dead&&!['complete','failed','cancelled'].includes(status.status)){await new Promise(resolve=>setTimeout(resolve,180));if(dead)break;status=await hostRequest('timeline.visuals.status',{projectId:props.projectId,taskId});}
            if(dead)break;
            if(status.status==='complete'&&status.revision===props.revision){jobs=jobs.filter(j=>j.endFrame<=startFrame||j.startFrame>=endFrame);jobs.push({...status.result,startFrame,endFrame,count:sampleCount});setResult({jobs:[...jobs],revision:props.revision});}
          }
        }catch{/* Name and editing remain available when derivation fails. */}})();return cancel;
      },[view,props.revision,props.clip.clipId,props.projectId,props.playing]);
      function drawEnvelope(el){
        if(!el||!view||result?.revision!==props.revision)return;
        const height=props.audio?32:16,width=Math.max(1,Math.ceil(view.right-view.left));el.width=width*2;el.height=height*2;const ctx=el.getContext('2d');ctx.scale(2,2);ctx.clearRect(0,0,width,height);ctx.fillStyle='#c8f4e1';
        for(const job of result.jobs){const wave=job.waveform;if(!wave)continue;const gain=Math.min(8,1/Math.max(.125,wave.materialPeak)),effective=10**(((props.clip.volumeDb??0)+(props.track.gainDb??0)+(props.clip.sourceGainDb??0))/20);for(let x=0;x<width;x++){const frame=props.clip.startFrame+(view.left+x)/props.zoom*30;if(frame<job.startFrame||frame>=job.endFrame)continue;const index=Math.min(255,Math.floor((frame-job.startFrame)/(job.endFrame-job.startFrame)*256));let fade=1;if(props.clip.fadeInFrames)fade=Math.min(fade,(frame-props.clip.startFrame)/props.clip.fadeInFrames);if(props.clip.fadeOutFrames)fade=Math.min(fade,(props.clip.startFrame+props.clip.durationFrames-frame)/props.clip.fadeOutFrames);const value=Math.min(1,Math.max(0,wave.peaks[index]*gain*effective*fade))**.65,half=value*(height/2-1);ctx.fillRect(x,height/2-half,1,Math.max(.5,half*2));}}
      }
      React.useEffect(()=>drawEnvelope(canvas.current),[result,view,props.audio,props.clip,props.track,props.revision]);
      return h('div',{ref:root,className:'dv-clip-visuals'+(props.audio?' is-audio-visual':'')+(props.hasAudio?' has-original-audio':''),'aria-hidden':true},
        result?.revision===props.revision?result.jobs.map((job,j)=>h('div',{key:j,className:'dv-filmstrip',style:{left:(job.startFrame-props.clip.startFrame)/30*props.zoom,width:(job.endFrame-job.startFrame)/30*props.zoom}},job.thumbnails.map((image,k)=>h('img',{key:k,src:image.data,alt:'',draggable:false})))):null,
        props.hasAudio&&view?h('canvas',{ref:el=>{canvas.current=el;drawEnvelope(el);},className:'dv-clip-envelope',style:{left:view.left,width:view.right-view.left}}):null);
    }

    /**
     * Plugin settings: the ONLY place users configure music models, API keys,
     * base URLs and the appended system prompt. The Host persists what is
     * saved here; no file editing is ever required and keys never re-render.
     */
    function SettingsDialog(props) {
      const h = React.createElement, t = props.t;
      const panelRef = usePanelDismiss(props.onClose, 'settings');
      const firstField = React.useRef(null);
      const [tab, setTab] = React.useState('models');
      const [settings, setSettings] = React.useState(null);
      const [promptText, setPromptText] = React.useState('');
      const [promptMax, setPromptMax] = React.useState(2000);
      const [promptLoaded, setPromptLoaded] = React.useState(false);
      const [draft, setDraft] = React.useState(null);
      const [keyOpen, setKeyOpen] = React.useState(false);
      const [keyInput, setKeyInput] = React.useState('');
      const [confirmRemove, setConfirmRemove] = React.useState(null);
      const [notice, setNotice] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      React.useEffect(() => { if (draft || keyOpen) firstField.current?.focus(); }, [draft, keyOpen]);
      React.useEffect(() => {
        let stopped = false;
        hostRequest('audio.settings', {}).then(r => { if (!stopped) setSettings(r); }).catch(e => { if (!stopped) setNotice(errorText(hostError(e), t)); });
        hostRequest('prompt.get', {}).then(r => { if (!stopped) { setPromptText(typeof r.text === 'string' ? r.text : ''); setPromptMax(Number(r.maxCharacters) || 2000); setPromptLoaded(true); } }).catch(e => { if (!stopped) setNotice(errorText(hostError(e), t)); });
        return () => { stopped = true; };
      }, []);
      async function call(method, params) {
        if (busy) return null;
        setBusy(true); setNotice('');
        try {
          return await hostRequest(method, params);
        } catch (e) {
          setNotice(errorText(hostError(e), t));
          return null;
        } finally { setBusy(false); }
      }
      async function saveModel() {
        if (!draft) return;
        const model = { name: draft.name, protocol: draft.protocol, baseUrl: draft.baseUrl, remoteModel: draft.remoteModel, ...(draft.id ? { id: draft.id } : {}) };
        const key = String(draft.apiKey || '');
        const r = await call('audio.model.save', { model, ...(key.length > 0 ? { apiKey: key } : {}) });
        if (r) { setSettings(r); setDraft(null); setNotice(t('video.settings.saved')); }
      }
      async function setDefault(modelId) {
        const r = await call('audio.model.default', { modelId });
        if (r) { setSettings(r); setNotice(t('video.settings.defaultSet')); }
      }
      async function removeModel(model) {
        setConfirmRemove(null);
        const r = await call('audio.model.remove', { modelId: model.id });
        if (r) { setSettings(r); setDraft(null); setNotice(t('video.settings.removed')); }
      }
      async function testModel(modelId) {
        const r = await call('audio.check', modelId ? { modelId } : {});
        if (r) { setSettings(prev => ({ ...prev, musicModels: r.musicModels ?? prev?.musicModels, defaultMusicModelId: r.defaultMusicModelId ?? prev?.defaultMusicModelId })); setNotice(t('video.settings.testOk') + (r.note ? ' · ' + r.note : '')); }
      }
      async function savePrompt(text) {
        const r = await call('prompt.set', { text });
        if (r) { setPromptText(typeof r.text === 'string' ? r.text : ''); setNotice(text.length === 0 ? t('video.settings.promptReset') : t('video.settings.saved')); }
      }
      async function saveBuiltInKey() {
        const r = await call('audio.configure', { apiKey: keyInput });
        if (r) { setSettings(r); setKeyOpen(false); setKeyInput(''); setNotice(t('video.settings.saved')); }
      }
      const PROTOCOL_OPTIONS = [
        ['qianwen-sync', t('video.settings.protocolSync'), '', '', ''],
        ['qianwen-async', t('video.settings.protocolAsync'), '', '', ''],
        ['stepfun', t('video.settings.protocolStepfun'), 'https://api.stepfun.com', 'stepaudio-3-music-preview', 'video.settings.hintStepfun'],
        ['suno-inspiration', t('video.settings.protocolSunoInspiration'), 'https://www.suno-api.io', 'suno-v6', 'video.settings.hintSuno'],
        ['suno-custom', t('video.settings.protocolSunoCustom'), 'https://www.suno-api.io', 'suno-v6', 'video.settings.hintSuno'],
        ['minimax', t('video.settings.protocolMinimax'), 'https://api.minimax.cn', 'music-3.0', 'video.settings.hintMinimax'],
      ];
      const protocolInfo = p => PROTOCOL_OPTIONS.find(x => x[0] === p) || PROTOCOL_OPTIONS[0];
      const protocolLabel = p => protocolInfo(p)[1];
      const switchProtocol = next => {
        const [, , base, model] = protocolInfo(next);
        const previousBase = protocolInfo(draft.protocol)[2];
        const previousModel = protocolInfo(draft.protocol)[3];
        setDraft({
          ...draft,
          protocol: next,
          baseUrl: !draft.baseUrl || draft.baseUrl === previousBase ? base : draft.baseUrl,
          remoteModel: !draft.remoteModel || draft.remoteModel === previousModel ? model : draft.remoteModel,
        });
      };
      return h('section', {
        className: 'dv-reference-panel dv-settings-panel', ref: panelRef, role: 'dialog', 'aria-label': t('video.settings.title'), tabIndex: -1,
        onKeyDown: e => { if (e.key === 'Escape') props.onClose(); },
      },
        h('div', { className: 'dv-reference-head' },
          h('strong', null, t('video.settings.title')),
          h('div', { className: 'dv-panel-actions' },
            h('button', { className: 'dv-icon-button', 'aria-label': t('video.canvas.close'), onClick: props.onClose }, '×'),
          ),
        ),
        h('div', { className: 'dv-settings-tabs', role: 'tablist' },
          h('button', { role: 'tab', 'aria-selected': tab === 'models', className: tab === 'models' ? 'is-active' : '', onClick: () => setTab('models') }, t('video.settings.tabModels')),
          h('button', { role: 'tab', 'aria-selected': tab === 'prompt', className: tab === 'prompt' ? 'is-active' : '', onClick: () => setTab('prompt') }, t('video.settings.tabPrompt')),
        ),
        tab === 'models' ? h('div', { className: 'dv-settings-body' },
          h('p', { className: 'dv-settings-help' }, t('video.settings.modelsHelp')),
          !settings ? h('p', { role: 'status' }, t('video.timeline.loading')) : h('ul', { className: 'dv-settings-list' },
            (settings.musicModels || []).map(m => h('li', { key: m.id, 'data-default': m.default ? 'true' : 'false' },
              h('div', { className: 'dv-settings-item-main' },
                h('strong', { title: m.name }, m.name),
                m.default ? h('em', { className: 'dv-settings-badge' }, t('video.settings.default')) : null,
                m.builtIn ? h('em', { className: 'dv-settings-badge' }, t('video.settings.builtIn')) : null,
                h('small', null, protocolLabel(m.protocol) + ' · ' + (m.hasKey ? t('video.settings.hasKey') : t('video.settings.noKey'))),
                m.baseUrl ? h('small', { className: 'dv-settings-url', title: m.baseUrl }, m.baseUrl + (m.remoteModel ? ' · ' + m.remoteModel : '')) : null,
                m.note ? h('small', null, m.note) : null,
              ),
              h('div', { className: 'dv-settings-item-actions' },
                m.default ? null : h('button', { className: 'dv-button dv-button-quiet', disabled: busy, onClick: () => void setDefault(m.id) }, t('video.settings.setDefault')),
                h('button', { className: 'dv-button dv-button-quiet', disabled: busy, onClick: () => void testModel(m.id) }, t('video.settings.test')),
                m.builtIn ? h('button', { className: 'dv-button dv-button-quiet', disabled: busy, onClick: () => { setKeyOpen(true); setDraft(null); } }, t('video.settings.apiKey')) : h('button', { className: 'dv-button dv-button-quiet', disabled: busy, onClick: () => { setDraft({ id: m.id, name: m.name, protocol: m.protocol, baseUrl: m.baseUrl, remoteModel: m.remoteModel, apiKey: '' }); setKeyOpen(false); } }, t('video.settings.edit')),
                m.builtIn ? null : (confirmRemove && confirmRemove.id === m.id
                  ? h('button', { className: 'dv-button dv-button-danger', disabled: busy, onClick: () => void removeModel(m) }, t('video.settings.confirmRemove'))
                  : h('button', { className: 'dv-button dv-button-quiet', disabled: busy, onClick: () => setConfirmRemove({ id: m.id, revision: 0 }) }, t('video.settings.remove'))),
              ),
            )),
          ),
          keyOpen ? h('div', { className: 'dv-settings-form', role: 'group', 'aria-label': t('video.settings.apiKey') },
            h('label', null, 'API Key', h('input', { ref: firstField, type: 'password', autoComplete: 'new-password', value: keyInput, maxLength: 512, placeholder: t('video.settings.builtInKeyHelp'), onChange: e => setKeyInput(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && keyInput) void saveBuiltInKey(); } })),
            h('div', { className: 'dv-settings-form-actions' },
              h('button', { className: 'dv-button', disabled: busy || keyInput.length === 0, onClick: () => void saveBuiltInKey() }, t('video.settings.save')),
              h('button', { className: 'dv-button dv-button-quiet', disabled: busy, onClick: () => { setKeyOpen(false); setKeyInput(''); } }, t('video.settings.cancel')),
            ),
          ) : null,
          draft ? h('div', { className: 'dv-settings-form', role: 'group', 'aria-label': draft.id ? t('video.settings.edit') : t('video.settings.add') },
            h('label', null, t('video.settings.name'), h('input', { ref: firstField, value: draft.name, maxLength: 80, onChange: e => setDraft({ ...draft, name: e.target.value }) })),
            h('label', null, t('video.settings.protocol'), h('select', { value: draft.protocol, onChange: e => switchProtocol(e.target.value) },
              PROTOCOL_OPTIONS.map(([value, label]) => h('option', { key: value, value }, label)),
            )),
            protocolInfo(draft.protocol)[4] ? h('p', { className: 'dv-settings-help' }, t(protocolInfo(draft.protocol)[4])) : null,
            h('label', null, 'Base URL', h('input', { value: draft.baseUrl, maxLength: 2048, placeholder: protocolInfo(draft.protocol)[2] || 'https://service.example.com', onChange: e => setDraft({ ...draft, baseUrl: e.target.value }) })),
            h('label', null, t('video.settings.remoteModel'), h('input', { value: draft.remoteModel, maxLength: 128, placeholder: protocolInfo(draft.protocol)[3] || t('video.settings.remoteModel'), onChange: e => setDraft({ ...draft, remoteModel: e.target.value }) })),
            h('label', null, 'API Key', h('input', { type: 'password', autoComplete: 'new-password', value: draft.apiKey, maxLength: 512, placeholder: t('video.settings.apiKeyKeep'), onChange: e => setDraft({ ...draft, apiKey: e.target.value }) })),
            h('div', { className: 'dv-settings-form-actions' },
              h('button', { className: 'dv-button', disabled: busy || !draft.name || !draft.baseUrl || !draft.remoteModel, onClick: () => void saveModel() }, t('video.settings.save')),
              h('button', { className: 'dv-button dv-button-quiet', disabled: busy, onClick: () => { setDraft(null); setConfirmRemove(null); } }, t('video.settings.cancel')),
            ),
          ) : h('button', { className: 'dv-button dv-button-quiet dv-settings-add', disabled: busy || !settings || (settings.musicModels || []).filter(m => !m.builtIn).length >= 20, onClick: () => setDraft({ name: '', protocol: 'qianwen-sync', baseUrl: '', remoteModel: '', apiKey: '' }) }, t('video.settings.add')),
        ) : h('div', { className: 'dv-settings-body' },
          h('p', { className: 'dv-settings-help' }, t('video.settings.promptHelp')),
          h('p', { className: 'dv-settings-fixed' }, t('video.settings.promptFixed')),
          !promptLoaded ? h('p', { role: 'status' }, t('video.timeline.loading')) : h(React.Fragment, null,
            h('textarea', { className: 'dv-settings-prompt', value: promptText, maxLength: promptMax, rows: 10, 'aria-label': t('video.settings.tabPrompt'), placeholder: t('video.settings.promptPlaceholder'), onChange: e => setPromptText(e.target.value) }),
            h('div', { className: 'dv-settings-form-actions' },
              h('span', { className: 'dv-settings-count' }, String(promptText.length) + ' / ' + String(promptMax)),
              h('button', { className: 'dv-button', disabled: busy, onClick: () => void savePrompt(promptText) }, t('video.settings.save')),
              h('button', { className: 'dv-button dv-button-quiet', disabled: busy || promptText.length === 0, onClick: () => void savePrompt('') }, t('video.settings.promptReset')),
            ),
          ),
        ),
        h('p', { role: 'status', className: 'dv-settings-notice' }, notice),
      );
    }

    /** Clipboard helper for panels outside the main component scope. */
    async function copyTextLocally(value) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(value);
          return true;
        }
      } catch (_error) {
        /* fall through to the legacy path */
      }
      try {
        if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
          const area = document.createElement('textarea');
          area.value = value;
          area.setAttribute('readonly', 'readonly');
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.documentElement.appendChild(area);
          area.select();
          const ok = document.execCommand('copy');
          document.documentElement.removeChild(area);
          return ok;
        }
      } catch (_error) {
        /* clipboard unavailable */
      }
      return false;
    }
    function TimelinePanel(props) {
      const h = React.createElement,
        t = props.t;
      const [data, setData] = React.useState(null),
        [selected, setSelected] = React.useState(null),
        [busy, setBusy] = React.useState(false),
        [notice, setNotice] = React.useState(""),
        [manualZoom, setZoom] = React.useState(36),
        [fit, setFit] = React.useState(true),
        [viewWidth,setViewWidth]=React.useState(620),
        [compact, setCompact] = React.useState(false),
        [waveVersion,setWaveVersion]=React.useState(0),
        [levelDrafts,setLevelDrafts]=React.useState({}),
        [snap, setSnap] = React.useState(true),
        [drag, setDrag] = React.useState(null),
        [scrub,setScrub]=React.useState(null),
        [rangeMode,setRangeMode]=React.useState(false),
        [range,setRange]=React.useState(null),
        [rangeDraft,setRangeDraft]=React.useState(null),
        [rangeFrom,setRangeFrom]=React.useState(''),
        [rangeTo,setRangeTo]=React.useState(''),
        [rangeNote,setRangeNote]=React.useState(''),
        [sending,setSending]=React.useState(false);
      /** Last send attempt so a lost acknowledgement replays the same request id. */
      const rangeSendRef=React.useRef(null);
      const [recovery,setRecovery]=React.useState(null);
      const [selectedTrack,setSelectedTrack]=React.useState(null),[removeTrack,setRemoveTrack]=React.useState(null),[trackContext,setTrackContext]=React.useState(null),[clipContext,setClipContext]=React.useState(null);
      const gutter=156;
      const waves=React.useRef(new Set());
      const alive = React.useRef(true),
        current = React.useRef(null),
        viewport = React.useRef(null),timelineRef=React.useRef(null),rulerRef=React.useRef(null),scrubRef=React.useRef(null),gestureRef=React.useRef(null),laneRefs=React.useRef(new Map()),gestureMoved=React.useRef(false),rangeRef=React.useRef(null),rangeModeRef=React.useRef(false);
      rangeModeRef.current=rangeMode;
      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);
      async function load() {
        let page = await hostRequest("timeline.inspect", {
          projectId: props.projectId,
          limit: 100,
        });
        const loadRevision=page.revision;
        let tracks = page.tracks;
        while (page.nextOffset !== null) {
          page = await hostRequest("timeline.inspect", {
            projectId: props.projectId,
            offset: page.nextOffset,
            limit: 100,
          });
          if(page.revision!==loadRevision)throw {code:'E_REVISION_CONFLICT',message:'作品已更新，请刷新时间线'};
          tracks = tracks.map((tr) => ({
            ...tr,
            clips: [
              ...tr.clips,
              ...(page.tracks.find((x) => x.trackId === tr.trackId)?.clips || []),
            ],
          }));
        }
        const next = { ...page, tracks };
        if (alive.current) {
          current.current = next;
          setData(next);
        }
        return next;
      }
      React.useEffect(() => {
        let stop = false;
        (async () => {
          try {
            const initial=await load();
            if(!stop&&(initial.settings.durationMode!=='auto'||initial.settings.durationFrames!==Math.max(1,...initial.tracks.flatMap(tr=>tr.clips.map(c=>c.startFrame+c.durationFrames)))))await write([{op:'timeline.settings',durationMode:'auto'}],undefined,true);
            else if(!stop)await props.onReload();
          } catch (e) {
            if (!stop) setNotice(errorText(hostError(e), t));
          }
        })();
        return () => {
          stop = true;
        };
      }, [props.projectId]);
      React.useEffect(() => {
        if (current.current && props.revision !== current.current.revision)
          void load().catch((e) => setNotice(errorText(hostError(e), t)));
      }, [props.revision]);
      async function sendAttempt(attempt) {
        if (busy) return;
        setBusy(true);
        setNotice('');
        try {
          const result = await hostRequest(attempt.method, attempt.params);
          if (!alive.current) return;
          setRecovery(null);
          setNotice(attempt.quiet?'':result.changeSummary?.summary || t('video.timeline.saved'));
          const fresh=await load();
          await props.onReload();
          const detached=attempt.params.ops?.find(o=>o.op==='clip.detachAudio');
          if(detached){const track=fresh.tracks.find(tr=>tr.clips.some(c=>c.detachedFrom===detached.clipId));const clip=track?.clips.find(c=>c.detachedFrom===detached.clipId);if(clip){setSelected(clip.clipId);setSelectedTrack(track.trackId);requestAnimationFrame(()=>laneRefs.current.get(track.trackId)?.scrollIntoView({block:'nearest',inline:'nearest'}));}}
          return result;
        } catch (e) {
          if (alive.current) {
            const error = hostError(e);
            setNotice(errorText(error, t));
            if(error.code==='E_REVISION_CONFLICT'&&attempt.quiet){
              const fresh=await load();
              if(fresh.settings.durationMode==='auto'){setRecovery(null);setNotice('');await props.onReload();return;}
            }
            if (error.code === 'E_REVISION_CONFLICT') {
              setRecovery({ ...attempt, status: 'conflict', preview: null });
              try {await load();await props.onReload();}catch(refreshError){setNotice(errorText(hostError(refreshError),t));}
            } else if (
              error.uncertain ||
              error.code === 'E_NETWORK' ||
              error.code === 'E_FETCH'
            )
              setRecovery({ ...attempt, status: 'retry', preview: null });
          }
        } finally {
          if (alive.current) setBusy(false);
        }
      }
      async function write(ops, action, quiet=false) {
        if (busy || !current.current || recovery) return;
        if(ops&&current.current.settings.durationMode!=='auto'&&!ops.some(o=>o.op==='timeline.settings'&&o.durationMode==='auto'))ops=[{op:'timeline.settings',durationMode:'auto'},...ops];
        return sendAttempt({
          method: action || 'timeline.apply',
          quiet,
          params: {
            projectId: props.projectId,
            expectedRevision: current.current.revision,
            operationId: operationId(),
            ...(action
              ? {
                  expectedHistoryCursor: current.current.historyCursor,
                  ...(current.current.lastChange?.operationId
                    ? { expectedOperationId: current.current.lastChange.operationId }
                    : {}),
                }
              : {}),
            ...(ops ? { ops } : {}),
          },
        });
      }
      async function previewRecovery() {
        if(busy||!recovery?.params.ops)return;
        setBusy(true);
        try {
          const fresh=await load();
          const attempt={method:recovery.method,params:{...recovery.params,expectedRevision:fresh.revision,operationId:operationId()}};
          const preview=await hostRequest(attempt.method,{...attempt.params,dryRun:true});
          if(alive.current)setRecovery({...attempt,status:'preview',preview});
        }catch(e){if(alive.current){setNotice(errorText(hostError(e),t));setRecovery({...recovery,status:'conflict',preview:null});}}
        finally{if(alive.current)setBusy(false);}
      }
      React.useEffect(() => {
        if (props.assetToAdd && data && !busy && !recovery) {
          const a = props.assetToAdd;
          props.onAssetConsumed();
          const tr = data.tracks.find((x) => x.kind === (a.kind === 'audio' ? 'audio' : 'video') && !x.locked);
          if (!tr) {
            if(a.kind==='audio'&&data.tracks.filter(x=>x.kind==='audio').length<3){void (async()=>{const result=await write([{op:'track.add',kind:'audio'}]);if(result)props.onQueueAsset?.(a);})();}
            else setNotice(t("video.timeline.needTrack"));
            return;
          }
          const start = Math.max(
            0,
            ...tr.clips.map((c) => c.startFrame + c.durationFrames),
          );
          void write([
            {
              op: "clip.insert",
              assetId: a.assetId,
              trackId: tr.trackId,
              startFrame: start,
              ...(a.kind === "image" ? { durationFrames: 150 } : {}),
              mode: "ripple",
            },
          ]);
        }
      }, [props.assetToAdd, data, busy, recovery]);
      React.useEffect(()=>{setLevelDrafts({});gestureRef.current=null;setDrag(null);if(scrubRef.current)finishScrub();cancelRange();
        // A range belongs to one exact project/revision pair. Any change
        // invalidates it; the stale selection is never applied silently.
        if(range){setRange(null);setRangeFrom('');setRangeTo('');}
        setActiveRangeCandidate(null);
      },[data?.revision]);
      React.useEffect(()=>{
        setRange(null);setRangeFrom('');setRangeTo('');cancelRange();
        setActiveRangeCandidate(null);
        return ()=>{setActiveRangeCandidate(null);};
      },[props.projectId]);
      React.useEffect(()=>{if(!rangeDraft)return;const view=timelineRef.current?.ownerDocument.defaultView;const stop=()=>cancelRange();view?.addEventListener('blur',stop);let raf;const scroll=()=>{const g=rangeRef.current,el=viewport.current;if(g&&el){const r=el.getBoundingClientRect(),x=g.clientX;const delta=x<r.left+gutter+24?-Math.min(18,Math.ceil((r.left+gutter+24-x)/2)):x>r.right-24?Math.min(18,Math.ceil((x-r.right+24)/2)):0;const before=el.scrollLeft;if(delta){el.scrollLeft+=delta;if(before!==el.scrollLeft)moveRange(x);}}raf=requestAnimationFrame(scroll);};raf=requestAnimationFrame(scroll);return()=>{cancelAnimationFrame(raf);view?.removeEventListener('blur',stop);};},[Boolean(rangeDraft)]);
      React.useEffect(()=>{if(!scrub)return;const view=timelineRef.current?.ownerDocument.defaultView;const stop=()=>finishScrub();view?.addEventListener('blur',stop);let raf;const scroll=()=>{const g=scrubRef.current,el=viewport.current;if(g&&el){const r=el.getBoundingClientRect(),x=g.clientX;const delta=x<r.left+gutter+24?-Math.min(18,Math.ceil((r.left+gutter+24-x)/2)):x>r.right-24?Math.min(18,Math.ceil((x-r.right+24)/2)):0;const before=el.scrollLeft;if(delta){el.scrollLeft+=delta;if(before!==el.scrollLeft)moveScrub(x);}}raf=requestAnimationFrame(scroll);};raf=requestAnimationFrame(scroll);return()=>{cancelAnimationFrame(raf);view?.removeEventListener('blur',stop);};},[Boolean(scrub)]);
      // Keep Escape within this timeline even when selecting a clip inserts toolbar controls.
      React.useEffect(()=>{if(drag)timelineRef.current?.focus({preventScroll:true});},[drag]);
      React.useEffect(()=>{
        if(!drag)return;
        let raf;
        function scrollDrag(){
          const gesture=gestureRef.current,el=viewport.current;
          if(gesture?.lifted&&!gesture.edge&&el){
            const r=el.getBoundingClientRect(),x=gesture.pointerX,y=gesture.pointerY;
            if(x>=r.left+gutter&&x<=r.right&&y>=r.top&&y<=r.bottom){
              const speed=(p,lo,hi)=>p<lo+24?-Math.ceil((lo+24-p)/2):p>hi-24?Math.ceil((p-hi+24)/2):0,
                left=el.scrollLeft,top=el.scrollTop;
              el.scrollLeft+=speed(x,r.left+gutter,r.right);el.scrollTop+=speed(y,r.top,r.bottom);
              if(left!==el.scrollLeft||top!==el.scrollTop){const next=dragPosition({clientX:x,clientY:y},gesture);gestureRef.current=next;setDrag(next);}
            }
          }
          raf=requestAnimationFrame(scrollDrag);
        }
        raf=requestAnimationFrame(scrollDrag);return ()=>cancelAnimationFrame(raf);
      },[Boolean(drag)]);

      React.useEffect(()=>{
        const el=viewport.current;if(!el)return;
        const observer=new ResizeObserver(()=>setViewWidth(el.clientWidth));
        setViewWidth(el.clientWidth);observer.observe(el);return ()=>observer.disconnect();
      },[Boolean(data),Boolean(removeTrack),data?.tracks.length]);
      if (!data)
        return h(
          "section",
          { className: "dv-timeline", role: "status" },
          t("video.timeline.loading"),
        );
      const clips = data.tracks.flatMap((tr) =>
          tr.clips.map((c) => ({ ...c, trackId: tr.trackId })),
        ),
        chosen = clips.find((c) => c.clipId === selected),
        activeTrack=data.tracks.find(tr=>tr.trackId===(selectedTrack||chosen?.trackId)),
        frame = Math.round((scrub?.time??props.time) * 30),
        duration = data.settings.durationFrames,
        zoom = scrub?.zoom ?? drag?.zoom ?? (fit ? Math.max(.05,(viewWidth-gutter-24)/Math.max(1,duration/30)) : manualZoom),
        width = Math.max(viewWidth-gutter, (Math.max(duration,drag?.nextDuration??duration) / 30) * zoom + (drag?.lifted?160:24)),
        tickStep = [1,2,5,10,15,30,60,120,300,600,1800,3600].find(x=>x*zoom>=48) || Math.ceil(48/zoom/3600)*3600;
      function moveScrub(clientX) {
        const g=scrubRef.current,ruler=rulerRef.current;if(!g||!ruler)return;
        const rect=ruler.getBoundingClientRect();
        const time=Math.max(0,Math.min(g.duration,Math.round((clientX-rect.left)/g.zoom*30)))/30;
        const next={...g,clientX,time};scrubRef.current=next;setScrub(next);props.onSeek(time);
      }
      function finishScrub(restore=false) {
        const g=scrubRef.current;if(!g)return;
        const time=Math.max(0,Math.min((data?.settings.durationFrames??g.duration)/30,restore?g.startTime:g.time));scrubRef.current=null;setScrub(null);
        props.onScrubEnd?.(time);if(!props.onScrubEnd)props.onSeek(time);
        const node=timelineRef.current;if(node?.hasPointerCapture?.(g.pointerId))node.releasePointerCapture(g.pointerId);
      }
      function startScrub(e) {
        if(e.button!==0||gestureRef.current||scrubRef.current)return;
        e.preventDefault();e.stopPropagation();
        const g={pointerId:e.pointerId,startTime:props.time,time:props.time,zoom,duration,clientX:e.clientX};
        scrubRef.current=g;setScrub(g);props.onScrubStart?.();
        timelineRef.current?.focus({preventScroll:true});timelineRef.current?.setPointerCapture(e.pointerId);
        moveScrub(e.clientX);
      }
      // ── Range selection (框选配乐): ruler drag in range mode ──
      function rangeFrame(clientX){
        const ruler=rulerRef.current;if(!ruler)return 0;
        const rect=ruler.getBoundingClientRect();
        return Math.max(0,Math.min(duration,Math.round((clientX-rect.left)/zoom*30)));
      }
      function startRange(e) {
        if(e.button!==0||gestureRef.current||scrubRef.current||rangeRef.current)return;
        e.preventDefault();e.stopPropagation();
        const f=rangeFrame(e.clientX);
        const g={pointerId:e.pointerId,anchor:f,fromFrame:f,toFrame:f,clientX:e.clientX};
        rangeRef.current=g;setRangeDraft(g);
        timelineRef.current?.focus({preventScroll:true});timelineRef.current?.setPointerCapture(e.pointerId);
      }
      function moveRange(clientX) {
        const g=rangeRef.current;if(!g)return;
        const f=rangeFrame(clientX);
        const next={...g,clientX,fromFrame:Math.min(g.anchor,f),toFrame:Math.max(g.anchor,f)};
        rangeRef.current=next;setRangeDraft(next);
      }
      function cancelRange() {
        const g=rangeRef.current;if(!g)return;
        rangeRef.current=null;setRangeDraft(null);
        const node=timelineRef.current;if(node?.hasPointerCapture?.(g.pointerId))node.releasePointerCapture(g.pointerId);
      }
      function finishRange() {
        const g=rangeRef.current;if(!g)return;
        rangeRef.current=null;setRangeDraft(null);
        const node=timelineRef.current;if(node?.hasPointerCapture?.(g.pointerId))node.releasePointerCapture(g.pointerId);
        // A single click keeps a minimum one-frame range; both bounds stay
        // inside the film so scoring can never extend the project duration.
        const from=Math.max(0,Math.min(duration-1,g.fromFrame));
        const to=Math.min(duration,Math.max(from+1,g.toFrame));
        commitRange({fromFrame:from,toFrame:to});
      }
      function commitRange(sel) {
        const token=referenceToken(props.projectId,'range',sel.fromFrame+'-'+sel.toFrame,data.revision);
        if(!token){setNotice(t('video.timeline.rangeInvalid'));return;}
        const label=(t('video.timeline.rangeLabel')||'').replace('{from}',(sel.fromFrame/30).toFixed(2)).replace('{to}',(sel.toFrame/30).toFixed(2));
        const next={...sel,token,revision:data.revision,project:props.projectId,label,description:t('video.timeline.rangeDescription')};
        setRange(next);setRangeFrom((sel.fromFrame/30).toFixed(2));setRangeTo((sel.toFrame/30).toFixed(2));
        setActiveRangeCandidate(next);
        setNotice(t('video.timeline.rangeReady'));
      }
      function applyRangeInputs() {
        const a=Math.round(Number(rangeFrom)*30),b=Math.round(Number(rangeTo)*30);
        if(!Number.isInteger(a)||!Number.isInteger(b)||a<0||b<=a||b>duration){setNotice(t('video.timeline.rangeInvalid'));return;}
        commitRange({fromFrame:a,toFrame:b});
      }
      function clearRange() {setRange(null);setRangeFrom('');setRangeTo('');setRangeNote('');setActiveRangeCandidate(null);rangeSendRef.current=null;}
      async function copyRangeReference() {
        if(!range)return;
        const ok=await copyTextLocally(referenceText(range.token));
        setNotice(t(ok?'video.timeline.rangeCopied':'video.timeline.rangeCopyFailed'));
      }
      /** One chat message: the exact range reference plus the user's scene note. */
      function rangeMessage() {
        if(!range)return null;
        const note=String(rangeNote||'').replace(/[\r\n]+/g,' ').trim();
        if(!note)return null;
        return referenceText(range.token)+'\n'+note;
      }
      /**
       * Admit the message through the Host's public session prompt path. A lost
       * acknowledgement replays the same request id instead of sending twice, so a
       * retry can never put the same scoring request in the conversation twice.
       */
      async function sendRangeToChat() {
        const message=rangeMessage();
        if(!message){setNotice(t('video.timeline.rangeNoteRequired'));return;}
        if(sending)return;
        const key=props.projectId+'\n'+message;
        const previous=rangeSendRef.current;
        const requestId=previous&&previous.key===key
          ? previous.requestId
          : 'dsh-range-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
        rangeSendRef.current={key,requestId};
        setSending(true);
        try {
          const r=await hostRequest('session.send',{projectId:props.projectId,requestId,text:message});
          setNotice(t(r&&r.accepted===true?'video.timeline.rangeSent':'video.timeline.rangeSendFailed'));
        } catch (_error) {
          setNotice(t('video.timeline.rangeSendFailed'));
        } finally {
          if(alive.current)setSending(false);
        }
      }
      function seekAtLane(clientX,lane){
        if(!lane)return;
        const raw=(clientX-lane.getBoundingClientRect().left)/zoom;
        const time=Math.max(0,Math.min(duration/30,Math.round(raw*30)/30));
        props.onScrubStart?.();props.onScrubEnd?.(time);if(!props.onScrubEnd)props.onSeek(time);
      }
      function scrubKey(e) {
        const step=e.shiftKey?30:1;
        const next=e.key==='Home'?0:e.key==='End'?duration:e.key==='ArrowLeft'?frame-step:e.key==='ArrowRight'?frame+step:null;
        if(next===null)return;e.preventDefault();e.stopPropagation();
        const time=Math.max(0,Math.min(duration,next))/30;props.onScrubStart?.();props.onScrubEnd?.(time);if(!props.onScrubEnd)props.onSeek(time);
      }
      function nearest(raw, except) {
        let value = Math.max(0, Math.round(raw));
        if (!snap) return value;
        const points = [
          0,
          frame,
          ...clips
            .filter((c) => c.clipId !== except)
            .flatMap((c) => [c.startFrame, c.startFrame + c.durationFrames]),
        ];
        const at = points.filter(x=>Math.abs(x-value)<=180/zoom).sort((a,b)=>Math.abs(a-value)-Math.abs(b-value))[0];
        return at ?? value;
      }
      function cut() {
        if (
          chosen &&
          frame > chosen.startFrame &&
          frame < chosen.startFrame + chosen.durationFrames
        )
          void write([{ op: "clip.split", clipId: chosen.clipId, atFrame: frame }]);
        else setNotice(t("video.timeline.cutHint"));
      }
      function moveOrder(delta) {
        if (!chosen) return;
        const tr = data.tracks.find((tr) => tr.trackId === chosen.trackId),
          ids = tr.clips.map((c) => c.clipId),
          i = ids.indexOf(chosen.clipId),
          j = i + delta;
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        void write([{ op: "clip.reorder", trackId: tr.trackId, clipIds: ids }]);
      }
      function movePlan(clipId,trackId,startFrame) {
        return planTimelineMove(data,clipId,trackId,startFrame,{snap,zoom,playheadFrame:frame});
      }
      function commitMove(plan){if(!plan.valid){setNotice(t('video.timeline.move.'+plan.reason));return;}if(plan.ops.length)void write(plan.ops);}
      // Coordinates include scroll displacement; the exact same plan is committed on release.
      function dragPosition(e,gesture) {
        const c=clips.find(x=>x.clipId===gesture.clipId);if(!c)return {...gesture,valid:false};
        const dx=e.clientX-gesture.x+(viewport.current?.scrollLeft??0)-gesture.scrollLeft,
          dy=e.clientY-gesture.y+(viewport.current?.scrollTop??0)-gesture.scrollTop,
          delta=Math.round(dx/gesture.zoom*30),r=viewport.current?.getBoundingClientRect(),
          lane=r&&e.clientX>=r.left+gutter&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom?
            [...laneRefs.current.values()].find(el=>{const b=el.getBoundingClientRect();return e.clientY>=b.top&&e.clientY<=b.bottom;}):null,
          plan=planTimelineMove(data,c.clipId,lane?.dataset.trackId,c.startFrame+delta,{snap:gesture.snap,zoom:gesture.zoom,playheadFrame:gesture.playheadFrame});
        return {...gesture,...plan,trackId:lane?.dataset.trackId,delta,dx,dy,pointerX:e.clientX,pointerY:e.clientY,
          lifted:gesture.lifted||Math.hypot(e.clientX-gesture.x,e.clientY-gesture.y)>=4};
      }
      function pointerDown(e,c,edge){
        if(e.button!==0||busy||data.tracks.find(tr=>tr.clips.some(x=>x.clipId===c.clipId))?.locked)return;
        const clickTime=Math.max(0,Math.min(duration/30,Math.round((c.startFrame/30+(e.clientX-e.currentTarget.getBoundingClientRect().left)/zoom)*30)/30));
        e.preventDefault();e.stopPropagation();setSelected(c.clipId);setSelectedTrack(c.trackId||data.tracks.find(x=>x.clips.some(v=>v.clipId===c.clipId))?.trackId);timelineRef.current.focus({preventScroll:true});timelineRef.current.setPointerCapture(e.pointerId);
        gestureMoved.current=false;
        const gesture={clipId:c.clipId,clickTime,x:e.clientX,y:e.clientY,pointerX:e.clientX,pointerY:e.clientY,edge,delta:0,dx:0,dy:0,lifted:false,
          scrollLeft:viewport.current?.scrollLeft??0,scrollTop:viewport.current?.scrollTop??0,revision:data.revision,zoom,snap,playheadFrame:frame};
        gestureRef.current=gesture;setDrag(gesture);
      }
      function pointerMove(e){const gesture=gestureRef.current;if(!gesture)return;const next=dragPosition(e,gesture);gestureRef.current=next;setDrag(next);}
      function pointerUp(e,c){
        const gesture=gestureRef.current;if(!gesture)return;
        const final=dragPosition(e,gesture);gestureRef.current=null;setDrag(null);
        if(gesture.revision!==data.revision)return;
        if(!final.lifted){if(!gesture.edge){props.onScrubStart?.();props.onScrubEnd?.(gesture.clickTime);if(!props.onScrubEnd)props.onSeek(gesture.clickTime);}gestureMoved.current=true;return;}
        gestureMoved.current=true;
        if(final.edge){if(final.delta)void write([{op:'clip.trim',clipId:c.clipId,edge:final.edge,deltaFrames:final.delta}]);}
        else commitMove(final);
      }
      function tool(label,path,onClick,disabled){return h('button',{className:'dv-timeline-tool',title:label,'aria-label':label,onClick,disabled},h('svg',{viewBox:'0 0 24 24',width:16,height:16,fill:'none',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:path})),h('span',{className:'dv-sr-only'},label));}
      return h(
        "section",
        {
          className: "dv-timeline" + (compact ? " dv-timeline-compact" : ""),
          ref:timelineRef,
          'data-duration-mode':data.settings.durationMode,
          'data-duration-frames':duration,
          'data-scrubbing':scrub?'true':'false',
          'data-range-mode':rangeMode?'true':'false',
          'data-range-selecting':(rangeDraft||range)?'true':'false',
          onPointerMove:e=>{if(rangeRef.current){if(e.pointerId===rangeRef.current.pointerId){e.preventDefault();moveRange(e.clientX);}}else if(scrubRef.current){if(e.pointerId===scrubRef.current.pointerId){e.preventDefault();moveScrub(e.clientX);}}else pointerMove(e);},
          onPointerUp:e=>{if(rangeRef.current){if(e.pointerId===rangeRef.current.pointerId){moveRange(e.clientX);finishRange();}return;}if(scrubRef.current){if(e.pointerId===scrubRef.current.pointerId){moveScrub(e.clientX);finishScrub();}return;}const c=clips.find(c=>c.clipId===gestureRef.current?.clipId);if(c)pointerUp(e,c);},
          onPointerCancel:()=>{cancelRange();finishScrub();gestureMoved.current=true;gestureRef.current=null;setDrag(null);},
          onLostPointerCapture:()=>{cancelRange();finishScrub();gestureRef.current=null;setDrag(null);},
          onBlur:e=>{if(scrubRef.current&&!e.currentTarget.contains(e.relatedTarget))finishScrub();if(drag&&!e.currentTarget.contains(e.relatedTarget)){gestureMoved.current=true;gestureRef.current=null;setDrag(null);}},
          "aria-label": t("video.timeline.title"),"aria-busy":busy?"true":"false",
          tabIndex: 0,
          onKeyDown: (e) => {
            if(rangeRef.current){if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancelRange();}return;}
            if(scrubRef.current){if(e.key==='Escape'){e.preventDefault();e.stopPropagation();finishScrub(true);}return;}
            if(drag){if(e.key==='Escape'){e.preventDefault();e.stopPropagation();gestureMoved.current=true;gestureRef.current=null;setDrag(null);}return;}
            if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")
              return;
            if (e.key === "Delete" || e.key === "Backspace") {
              e.preventDefault();
              if (chosen)
                void write([
                  { op: "clip.delete", clipId: chosen.clipId, ripple: false },
                ]);
            }
            if (e.key === "s" && !e.metaKey && !e.ctrlKey) cut();
            if ((e.metaKey || e.ctrlKey) && e.key === "z") {
              e.preventDefault();
              void write(null, e.shiftKey ? "timeline.redo" : "timeline.undo");
            }
          },
        },
        h(
          "div",
          { className: "dv-timeline-toolbar" },
          h('span',{className:'dv-timeline-heading'},t('video.timeline.title')),
          tool(t('video.canvas.undo'),'M9 5 4 10l5 5M4 10h9a6 6 0 0 1 0 12',()=>write(null,'timeline.undo'),busy||!data.undoHint.canUndo),
          tool(t('video.canvas.redo'),'m15 5 5 5-5 5m5-5h-9a6 6 0 0 0 0 12',()=>write(null,'timeline.redo'),busy||!data.undoHint.canRedo),
          h('span',{className:'dv-tool-divider'}),
          tool(t('video.timeline.split'),'M9 9 20 3M9 15l11 6M12 12l-3-3M12 12l-3 3M6 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6M6 12a3 3 0 1 0 0 6 3 3 0 0 0 0-6',cut,busy||!chosen),
          tool(t('video.timeline.delete'),'M4 6h16M9 6V3h6v3M7 6l1 15h8l1-15',()=>chosen&&write([{op:'clip.delete',clipId:chosen.clipId,ripple:false}]),busy||!chosen),
          h(TimelinePopover,{className:'dv-timeline-more',closeOnAction:true,requestOpen:clipContext||trackContext,onClosed:()=>{setTrackContext(null);setClipContext(null);},style:(clipContext||trackContext)?{position:'static'}:undefined},h('summary',{'aria-label':t('video.audio.more'),title:t('video.audio.more')},'···'),h('div',{key:clipContext?'clip-context-menu':trackContext?'track-context-menu':'edit-menu',className:'dv-timeline-menu',style:(clipContext||trackContext)?{position:'fixed',left:(clipContext||trackContext).x,top:(clipContext||trackContext).y,bottom:'auto',maxHeight:'calc(100vh - 24px)',overflowY:'auto'}:undefined},
            !trackContext&&chosen&&!chosen.audioOnly&&data.assets.find(a=>a.assetId===chosen.assetId)?.kind==='video'?h('button',{key:'detach',disabled:busy||!data.assets.find(a=>a.assetId===chosen.assetId)?.hasAudio||clips.some(c=>c.detachedFrom===chosen.clipId),title:t(!data.assets.find(a=>a.assetId===chosen.assetId)?.hasAudio?'video.timeline.noAudio':clips.some(c=>c.detachedFrom===chosen.clipId)?'video.timeline.alreadyDetached':'video.timeline.detachAudioHelp'),onClick:()=>write([{op:'clip.detachAudio',clipId:chosen.clipId}])},t('video.timeline.detachAudio')):null,
            !trackContext&&chosen?.kind==='media'&&(data.assets.find(a=>a.assetId===chosen.assetId)?.hasAudio||chosen.audioOnly||data.assets.find(a=>a.assetId===chosen.assetId)?.kind==='audio')?h('button',{key:'clip-sound',disabled:busy,title:clips.some(c=>c.detachedFrom===chosen.clipId)?t('video.timeline.doubleAudio'):undefined,onClick:()=>write([{op:'clip.set',clipId:chosen.clipId,patch:{muted:!chosen.muted}}])},t('video.timeline.'+(!chosen.audioOnly&&data.assets.find(a=>a.assetId===chosen.assetId)?.kind==='video'?(chosen.muted?'enableOriginal':'disableOriginal'):(chosen.muted?'enableClipSound':'disableClipSound')))):null,
            !trackContext?h('button',{key:'duplicate',disabled:busy||!chosen,onClick:()=>chosen&&write([{op:'clip.duplicate',clipId:chosen.clipId,mode:'ripple'}])},t('video.timeline.duplicate')):null,
            !trackContext?h('button',{key:'previous',disabled:busy||!chosen||data.tracks.find(tr=>tr.trackId===chosen.trackId)?.clips[0]?.clipId===chosen.clipId,onClick:()=>moveOrder(-1)},t('video.timeline.swapPrevious')):null,
            !trackContext?h('button',{key:'next',disabled:busy||!chosen||data.tracks.find(tr=>tr.trackId===chosen.trackId)?.clips.at(-1)?.clipId===chosen.clipId,onClick:()=>moveOrder(1)},t('video.timeline.swapNext')):null,
            trackContext&&activeTrack?h('strong',{key:'name',className:'dv-track-menu-title'},activeTrack.name):null,
            trackContext&&activeTrack?.kind==='video'?h('button',{key:'visibility',disabled:busy,onClick:()=>write([{op:'track.update',trackId:activeTrack.trackId,patch:{hidden:!activeTrack.hidden}}])},t(activeTrack.hidden?'video.timeline.showTrack':'video.timeline.hideTrack')):null,
            trackContext&&activeTrack?h('button',{key:'sound',disabled:busy,onClick:()=>write([{op:'track.update',trackId:activeTrack.trackId,patch:{muted:!activeTrack.muted}}])},t(activeTrack.muted?'video.audio.unmute':'video.audio.mute')):null,
            h('button',{key:'add-video',disabled:busy,onClick:()=>write([{op:'track.add',kind:'video'}])},t('video.timeline.addTrack')),
            h('button',{key:'add-audio',disabled:busy,onClick:()=>write([{op:'track.add',kind:'audio'}])},t('video.audio.addTrack')),
            !trackContext?h('button',{key:'compact','aria-pressed':compact,onClick:()=>setCompact(!compact)},t('video.timeline.compact')):null,
            h('button',{key:'remove',className:'dv-track-remove',disabled:busy||!activeTrack,title:activeTrack?.name,onClick:()=>{if(activeTrack.clips.length)setRemoveTrack({trackId:activeTrack.trackId,revision:data.revision});else void write([{op:'track.remove',trackId:activeTrack.trackId}]);}},t('video.timeline.removeTrack')))),
          data.lastChange?.written?h(TimelinePopover,{className:'dv-timeline-history'},h('summary',{'aria-label':t('video.timeline.history'),title:t('video.timeline.history')},h('svg',{viewBox:'0 0 24 24',width:15,height:15,fill:'none',stroke:'currentColor',strokeWidth:1.5,'aria-hidden':true},h('path',{d:'M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v6l4 2'}))),h('div',{className:'dv-change-receipt',role:'status','data-operation-id':data.lastChange.operationId},
          h('span',{title:data.lastChange.changeSummary?.summary},data.lastChange.changeSummary?.summary),
          data.undoHint?.canUndo&&data.lastChange.revision===data.revision&&data.lastChange.undoHint?.historyCursor===data.historyCursor&&data.lastChange.changeSummary?.opCount>0?h('button',{className:'dv-button dv-button-quiet',disabled:busy||!!recovery,onClick:()=>write(null,'timeline.undo')},t('video.change.undo')):null)):null,
          h('span',{className:'dv-timeline-spacer'}),
          chosen ? h(TimelinePopover,{className:'dv-clip-settings',key:selected},
            h('summary',{title:t('video.timeline.properties')},h('svg',{viewBox:'0 0 24 24',width:16,height:16,fill:'none',stroke:'currentColor',strokeWidth:1.5,'aria-hidden':true},h('path',{d:'M4 7h16M4 17h16M8 4v6m8 4v6'})),h('span',null,t('video.timeline.properties'))),h(
              "div",
              { className: "dv-timeline-inspector" },
              h("span", {className:'dv-inspector-name',title:chosen.clipId}, chosen.label || t('video.timeline.title')),
              h("span", null, (chosen.durationFrames / 30).toFixed(2) + "s"),
              h('input',{className:'dv-clip-reference',readOnly:true,value:referenceText(referenceToken(props.projectId,'clip',chosen.clipId,data.revision)),'aria-label':t('video.media.reference'),title:t('video.reference.help'),onFocus:e=>e.target.select()}),
              h(
                "label",
                null,
                t("video.timeline.track"),
                h(
                  "select",
                  {
                    value: chosen.trackId,
                    disabled: busy,
                    onChange:e=>commitMove(planTimelineMove(data,chosen.clipId,e.target.value,chosen.startFrame,{snap:false})),
                  },
                  data.tracks
                    .filter((x) => x.kind === data.tracks.find(tr=>tr.trackId===chosen.trackId)?.kind)
                    .map((tr) =>
                      h("option", { key: tr.trackId, value: tr.trackId }, tr.name),
                    ),
                ),
              ),
              h(
                "label",
                null,
                t("video.timeline.speed"),
                h(
                  "select",
                  {
                    value: chosen.speed || 1,
                    disabled: busy || chosen.kind !== "media",
                    onChange: (e) =>
                      write([
                        {
                          op: "clip.speed",
                          clipId: chosen.clipId,
                          speed: Number(e.target.value),
                          ripple: true,
                        },
                      ]),
                  },
                  [0.25, 0.5, 1, 1.5, 2, 4].map((x) =>
                    h("option", { key: x, value: x }, x + "×"),
                  ),
                ),
              ),
              chosen.kind==='media'?h(React.Fragment,null,
                ...[['video.audio.volume','volumeDb',-60,12,1],['video.audio.fadeIn','fadeInFrames',0,chosen.durationFrames/30,0.1],['video.audio.fadeOut','fadeOutFrames',0,chosen.durationFrames/30,0.1]].map(([label,key,min,max,step])=>h('label',{key},t(label),h('input',{type:'text',inputMode:'decimal',key:chosen.clipId+':'+key+':'+data.revision,value:levelDrafts[key]??(key==='volumeDb'?(chosen[key]??0):(chosen[key]??0)/30),onChange:e=>setLevelDrafts({...levelDrafts,[key]:e.target.value}),min,max,step,'aria-label':t(label),disabled:busy,onBlur:e=>{const value=Number(e.target.value);if(e.target.value===''||!Number.isFinite(value))return;if((key==='volumeDb'?value:Math.round(value*30))===(chosen[key]??0))return;void write([key==='volumeDb'?{op:'clip.volume',clipId:chosen.clipId,volumeDb:value}:{op:'clip.fade',clipId:chosen.clipId,inFrames:key==='fadeInFrames'?Math.round(value*30):chosen.fadeInFrames??0,outFrames:key==='fadeOutFrames'?Math.round(value*30):chosen.fadeOutFrames??0}]);}}),key==='volumeDb'?'dB':'s')),
                h('label',null,t('video.audio.gain'),h('input',{type:'text',inputMode:'decimal',key:chosen.trackId+':'+data.revision,value:levelDrafts.gain??data.tracks.find(tr=>tr.trackId===chosen.trackId)?.gainDb??0,onChange:e=>setLevelDrafts({...levelDrafts,gain:e.target.value}),min:-60,max:12,step:1,'aria-label':t('video.audio.gain'),disabled:busy,onBlur:e=>{const gainDb=Number(e.target.value);if(e.target.value!==''&&Number.isFinite(gainDb)&&gainDb!==(data.tracks.find(tr=>tr.trackId===chosen.trackId)?.gainDb??0))void write([{op:'track.update',trackId:chosen.trackId,patch:{gainDb}}]);}}),'dB')):null,
            )
          ) : null,

          h('label',{className:'dv-snap-toggle',title:t(snap?'video.timeline.snapOn':'video.timeline.snapOff')},h('input',{type:'checkbox',checked:snap,'aria-label':t('video.timeline.snap'),onChange:e=>setSnap(e.target.checked)}),h('svg',{viewBox:'0 0 24 24',width:15,height:15,fill:'none',stroke:'currentColor',strokeWidth:1.5,'aria-hidden':true},h('path',{d:'M5 4v9a7 7 0 0 0 14 0V4h-4v9a3 3 0 0 1-6 0V4zM5 8h4m6 0h4'})),h('span',{className:'dv-snap-state','aria-hidden':true},snap?'✓':'')),
          h('input',{type:'range',className:'dv-timeline-zoom',min:1,max:100,value:Math.max(1,Math.min(100,zoom)),'aria-label':t('video.timeline.zoom'),onChange:e=>{setFit(false);setZoom(Number(e.target.value));}}),
          tool(t('video.timeline.fit'),'M8 4H4v16h4m8-16h4v16h-4M8 12h8m-6-3-3 3 3 3m4-6 3 3-3 3',()=>setFit(true),false),
          h('button',{key:'range-tool',className:'dv-timeline-tool dv-range-tool','aria-pressed':rangeMode?'true':'false',title:t('video.timeline.rangeScore'),'aria-label':t('video.timeline.rangeScore'),onClick:()=>setRangeMode(v=>!v)},h('svg',{viewBox:'0 0 24 24',width:16,height:16,fill:'none',stroke:'currentColor',strokeWidth:1.5,'aria-hidden':true},h('path',{d:'M3 3h6v6H3zM15 15h6v6h-6zM9 6h9M6 9v9'})),h('span',{className:'dv-sr-only'},t('video.timeline.rangeScore'))),
        ),
        range?h('div',{className:'dv-range-bar',role:'group','aria-label':t('video.timeline.rangeTitle')},
          h('strong',null,t('video.timeline.rangeTitle')),
          h('span',{className:'dv-range-label'},range.label),
          h('input',{type:'number',min:0,max:duration/30,step:0.1,value:rangeFrom,'aria-label':t('video.timeline.rangeFrom'),onChange:e=>setRangeFrom(e.target.value),onKeyDown:e=>{if(e.key==='Enter'){e.preventDefault();applyRangeInputs();}}}),
          h('span',null,'–'),
          h('input',{type:'number',min:0,max:duration/30,step:0.1,value:rangeTo,'aria-label':t('video.timeline.rangeTo'),onChange:e=>setRangeTo(e.target.value),onKeyDown:e=>{if(e.key==='Enter'){e.preventDefault();applyRangeInputs();}}}),
          h('span',null,'s'),
          h('button',{className:'dv-button dv-button-quiet',onClick:applyRangeInputs},t('video.reference.range')),
          h('input',{className:'dv-range-note',type:'text',maxLength:600,value:rangeNote,placeholder:t('video.timeline.rangeNote'),'aria-label':t('video.timeline.rangeNote'),onChange:e=>{setRangeNote(e.target.value);rangeSendRef.current=null;},onKeyDown:e=>{if(e.key==='Enter'){e.preventDefault();void sendRangeToChat();}}}),
          h('button',{className:'dv-button',disabled:sending||!rangeNote.trim(),onClick:()=>void sendRangeToChat()},t(sending?'video.timeline.rangeSending':'video.timeline.rangeSend')),
          h('button',{className:'dv-button dv-button-quiet',onClick:()=>void copyRangeReference()},t('video.timeline.rangeCopy')),
          h('button',{className:'dv-button dv-button-quiet',onClick:clearRange},t('video.timeline.rangeClear')),
        ):null,
        removeTrack?h(TrackDeleteConfirmation,{t,busy,name:data.tracks.find(tr=>tr.trackId===removeTrack.trackId)?.name||'',onCancel:()=>setRemoveTrack(null),onConfirm:()=>{const target=removeTrack;setRemoveTrack(null);if(target.revision!==data.revision){setNotice(t('video.canvas.revisionRefreshed'));return;}void write([{op:'track.remove',trackId:target.trackId,force:true}]);}}):null,
        h(
          "div",
          { key:"track-scroll",className: "dv-timeline-scroll", ref: viewport },
          h(
            "div",
            { className: "dv-timeline-content", style: { width: width + gutter } },
            h(
              "div",
              {
                className: "dv-timeline-ruler",ref:rulerRef,
                style: { marginLeft: gutter, width },
                onPointerDown:e=>{if(rangeModeRef.current)startRange(e);else startScrub(e);},
              },
              Array.from(
                { length: Math.min(1000, Math.ceil(duration / 30 / tickStep) + 1) },
                (_, i) =>
                  h(
                    "span",
                    { key: i, style: { left: i * tickStep * zoom } },
                    Math.floor(i*tickStep/60)+":"+String(i*tickStep%60).padStart(2,"0"),
                  ),
              ),
            ),
            data.tracks
              .map((tr) =>
                h(
                  "div",
                  { key: tr.trackId, className: "dv-timeline-track", "data-kind":tr.kind,onContextMenu:e=>{e.preventDefault();e.stopPropagation();setSelectedTrack(tr.trackId);setClipContext(null);setTrackContext({x:e.clientX,y:e.clientY});} },
                  h("div", { className: "dv-timeline-track-name",'data-selected':activeTrack?.trackId===tr.trackId?'true':'false',onClick:()=>setSelectedTrack(tr.trackId) },
                    h('button',{className:'dv-track-name-text',title:tr.name,onClick:()=>setSelectedTrack(tr.trackId),'aria-pressed':activeTrack?.trackId===tr.trackId?'true':'false'}, /^(视频轨|音频轨)(\s*\d+)?$/.test(tr.name)?t(tr.kind==='audio'?'video.timeline.audioTrack':'video.timeline.videoTrack').replace('轨道','轨')+' '+(data.tracks.filter(x=>x.kind===tr.kind).indexOf(tr)+1):tr.name),
                    tr.kind==='video'?h('button',{className:'dv-track-visibility','aria-label':t(tr.hidden?'video.timeline.showTrack':'video.timeline.hideTrack')+' '+tr.name,title:t(tr.hidden?'video.timeline.showTrack':'video.timeline.hideTrack')+' · '+tr.name,'aria-pressed':tr.hidden?'false':'true',disabled:busy,onClick:()=>write([{op:'track.update',trackId:tr.trackId,patch:{hidden:!tr.hidden}}])},h(StudioIcon,{name:tr.hidden?'video-off':'video'})):null,
                    h('button',{className:'dv-track-mute','aria-label':t(tr.muted?'video.audio.unmute':'video.audio.mute')+' '+tr.name,title:t(tr.muted?'video.audio.unmute':'video.audio.mute')+' · '+tr.name,'aria-pressed':tr.muted?'true':'false',disabled:busy,onClick:()=>write([{op:'track.update',trackId:tr.trackId,patch:{muted:!tr.muted}}])},h(StudioIcon,{name:tr.muted?'speaker-off':'speaker'}))),
                  h(
                    "div",
                    {
                      className: "dv-timeline-lane"+(drag?.lifted&&!drag.edge&&drag.trackId===tr.trackId?(drag.valid?" is-drop-target":" is-drop-invalid"):""),ref:el=>{if(el)laneRefs.current.set(tr.trackId,el);else laneRefs.current.delete(tr.trackId);},
                      "data-track-id": tr.trackId,
                      onClick:e=>{if(e.target===e.currentTarget){setSelectedTrack(tr.trackId);seekAtLane(e.clientX,e.currentTarget);}},
                      style: { width },
                      onDragOver: (e) => e.preventDefault(),
                      onDrop: (e) => {
                        e.preventDefault();
                        const clipId = e.dataTransfer.getData(
                          "application/x-dsh-clip",
                        );
                        const a = e.dataTransfer.getData("application/x-dsh-asset");
                        const rect = e.currentTarget.getBoundingClientRect(),
                          startFrame = nearest(
                            ((e.clientX - rect.left) / zoom) * 30,
                            clipId,
                          );
                        if (clipId)commitMove(movePlan(clipId,tr.trackId,((e.clientX-rect.left)/zoom)*30));
                        else if (a)
                          void write([
                            {
                              op: "clip.insert",
                              assetId: a,
                              trackId: tr.trackId,
                              startFrame,
                              mode: "ripple",
                            },
                          ]);
                      },
                    },
                    drag?.lifted&&!drag.edge&&tr.clips.some(c=>c.clipId===drag.clipId)?h('div',{className:'dv-drag-origin','aria-hidden':true,style:{left:clips.find(c=>c.clipId===drag.clipId).startFrame/30*zoom,width:Math.max(8,clips.find(c=>c.clipId===drag.clipId).durationFrames/30*zoom)}}):null,
                    drag?.lifted&&!drag.edge&&drag.trackId===tr.trackId?h('div',{className:'dv-drop-preview'+(drag.valid?'':' is-invalid'),'aria-hidden':true,'data-start-frame':drag.startFrame,'data-next-duration':drag.nextDuration,style:{left:drag.startFrame/30*zoom,width:Math.max(8,clips.find(c=>c.clipId===drag.clipId).durationFrames/30*zoom)}},h('span',null,drag.valid?tr.name+' · '+formatSeconds(drag.startFrame/30)+(drag.nextDuration>duration?' · '+t('video.timeline.move.extend')+' '+formatSeconds(drag.nextDuration/30):''):t('video.timeline.move.'+drag.reason))):null,
                    tr.clips.map((c) =>
                      h(
                        "div",
                        {
                          key: c.clipId,
                          className:
                            "dv-timeline-clip" + (tr.kind==='audio'?' is-audio':'') + ((tr.muted||c.muted)?' is-muted':'') +
                            (selected === c.clipId ? " is-selected" : "") +
                            (drag?.clipId===c.clipId&&drag.lifted&&!drag.edge?" is-dragging"+(!drag.valid?" is-invalid":""):""),
                          "data-clip-id": c.clipId,
                          onContextMenu:e=>{e.preventDefault();e.stopPropagation();setSelected(c.clipId);setSelectedTrack(tr.trackId);setTrackContext(null);setClipContext({x:e.clientX,y:e.clientY});},
                          tabIndex: 0,
                          role: "button",
                          "aria-label": c.label || c.clipId,
                          "aria-pressed": selected === c.clipId,
                          onClick: (e) => {
                            if(gestureMoved.current){gestureMoved.current=false;return;}
                            setSelected(c.clipId);setSelectedTrack(tr.trackId);
                            seekAtLane(e.clientX,e.currentTarget.parentElement);
                          },
                          onKeyDown:e=>{if(e.target!==e.currentTarget)return;if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(c.clipId);setSelectedTrack(tr.trackId);props.onSeek(c.startFrame/30);}},
                          onPointerDown: (e) => pointerDown(e, c, null),
                          style: {
                            left: ((c.startFrame+(drag?.clipId===c.clipId&&drag.edge==="in"?drag.delta:0)) / 30) * zoom,
                            width: Math.max(8, ((c.durationFrames+(drag?.clipId===c.clipId&&drag.edge?(drag.edge==="in"?-drag.delta:drag.delta):0)) / 30) * zoom),
                            transform:
                              drag?.clipId === c.clipId && drag.lifted && !drag.edge
                                ? "translate3d("+drag.dx+"px,"+(drag.dy-4)+"px,0) scale(1.015)"
                                : undefined,
                          },
                        },
                        h(ClipVisuals,{projectId:props.projectId,revision:data.revision,clip:c,track:tr,zoom,playing:props.playing,audio:tr.kind==='audio',hasAudio:tr.kind==='audio'||(data.assets.find(a=>a.assetId===c.assetId)?.hasAudio&&!(c.muted&&clips.some(audio=>audio.detachedFrom===c.clipId)))}),
                        h("span", {
                          className: "dv-timeline-edge",
                          role: "slider",
                          tabIndex: 0,
                          "aria-label": t("video.timeline.trimIn"),
                          "aria-valuenow": c.startFrame,
                          onPointerDown: (e) => pointerDown(e, c, "in"),
                          onKeyDown: (e) => {
                            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                              e.preventDefault();
                              e.stopPropagation();
                              void write([
                                {
                                  op: "clip.trim",
                                  clipId: c.clipId,
                                  edge: "in",
                                  deltaFrames: e.key === "ArrowLeft" ? -1 : 1,
                                },
                              ]);
                            }
                          },
                        }),
                        h(
                          "span",
                          { className: "dv-timeline-clip-label" },
                          c.label || c.clipId,
                        ),
                        h("span", {
                          className: "dv-timeline-edge dv-timeline-edge-out",
                          role: "slider",
                          tabIndex: 0,
                          "aria-label": t("video.timeline.trimOut"),
                          "aria-valuenow": c.durationFrames,
                          onPointerDown: (e) => pointerDown(e, c, "out"),
                          onKeyDown: (e) => {
                            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                              e.preventDefault();
                              e.stopPropagation();
                              void write([
                                {
                                  op: "clip.trim",
                                  clipId: c.clipId,
                                  edge: "out",
                                  deltaFrames: e.key === "ArrowLeft" ? -1 : 1,
                                },
                              ]);
                            }
                          },
                        }),
                      ),
                    ),
                  ),
                ),
              ),
            (rangeDraft||range)?(()=>{const sel=rangeDraft??range;return h('div',{className:'dv-timeline-range','data-draft':rangeDraft?'true':'false','aria-hidden':'true',style:{left:gutter+sel.fromFrame/30*zoom,width:Math.max(2,(sel.toFrame-sel.fromFrame)/30*zoom)}});})():null,
            drag?.lifted&&!drag.edge&&drag.valid&&drag.snapFrame!==null?h('div',{className:'dv-drop-guide','aria-hidden':true,style:{left:gutter+drag.snapFrame/30*zoom}}):null,
            h("div", {
              className: "dv-timeline-playhead",role:"slider",tabIndex:0,
              "aria-label":t("video.timeline.playhead"),"aria-valuemin":0,"aria-valuemax":duration/30,"aria-valuenow":frame/30,"aria-valuetext":formatSeconds(frame/30),
              onPointerDown:e=>{if(rangeModeRef.current)startRange(e);else startScrub(e);},onKeyDown:scrubKey,
              style: { left: gutter + (scrub?.time??props.time) * zoom },
            },h("span",{className:"dv-playhead-handle","aria-hidden":true})),
          ),
        ),
        recovery?h('div',{className:'dv-change-recovery',role:'alert','data-recovery':recovery.status},
          h('p',null,recovery.status==='preview'?recovery.preview.changeSummary.summary:t(recovery.status==='retry'?'video.change.uncertain':'video.change.conflict')),
          recovery.status==='retry'?h('button',{className:'dv-button dv-button-quiet',disabled:busy,onClick:()=>sendAttempt(recovery)},t('video.change.retry')):recovery.status==='preview'?h('button',{className:'dv-button dv-button-primary',disabled:busy,onClick:()=>sendAttempt(recovery)},t('video.change.apply')):recovery.params.ops?h('button',{className:'dv-button dv-button-quiet',disabled:busy,onClick:previewRecovery},t('video.change.preview')):null,
          h('button',{className:'dv-button dv-button-quiet',disabled:busy,onClick:()=>setRecovery(null)},t('video.change.dismiss'))):null,
        busy || notice ? h(
          "div",
          { className: "dv-timeline-notice", role: "status" },
          busy ? t("video.timeline.saving") : notice,
        ) : null,
      );
    }

    function CanvasWorkspace(props) {
      const t = props.t;
      const projectId = props.projectId;
      const inspected = props.inspected;
      const onReload = props.onReload;
      const onError = props.onError;
      // The product workspace mounts the canvas read-only (`previewOnly: true`):
      // snapshot load/retry, the fixed runtime contract, play/pause, seek and the
      // revision/phase markers stay, while every manual-edit affordance and every
      // user gesture that could issue a write is not rendered. The default stays
      // false so the reviewed P3-008 manual path is unchanged for its browser
      // harness and component-level contract tests.
      const previewOnly = props.previewOnly === true;
      const scenes = Array.isArray(inspected.scenes) ? inspected.scenes : [];
      const elements = Array.isArray(inspected.elements) ? inspected.elements : [];
      const files = Array.isArray(inspected.files) ? inspected.files : [];
      const images = files.filter(function imageAsset(file) {
        return typeof file.path === 'string' && /\.(png|jpe?g)$/i.test(file.path);
      });

      // R2 retention contract. `active` is the last ready snapshot actually
      // displayed and playable; `candidate` is a hidden preloading snapshot for
      // the requested revision; `targetRevision` is the latest requested
      // revision. `phase` is derived from those: loading (no active yet) / ready
      // (an active composition is shown, a candidate may be pending) / error (no
      // active and the load failed). A candidate only replaces the active
      // composition after its runtime reports ready.
      const [active, setActive] = React.useState(null);
      const [candidate, setCandidate] = React.useState(null);
      const [visibleSlot, setVisibleSlot] = React.useState(0);
      const [targetRevision, setTargetRevision] = React.useState(inspected.revision);
      const [phase, setPhase] = React.useState('loading');
      const [frameError, setFrameError] = React.useState(null);
      const [previewNotice, setPreviewNotice] = React.useState(null);
      const [previewAttempt, setPreviewAttempt] = React.useState({ revision: null, attempt: 0 });
      const [previewRetrying, setPreviewRetrying] = React.useState(false);
      const [previewDiagnostics, setPreviewDiagnostics] = React.useState([]);
      const pendingRequestRef = React.useRef(null);
      const [time, setTime] = React.useState(0);
      const [playing, setPlaying] = React.useState(false);
      const timelineScrubRef=React.useRef(null);
      React.useEffect(()=>{timelineScrubRef.current=null;},[projectId]);
      const [selected, setSelected] = React.useState(null);
      const [drag, setDrag] = React.useState(null);
      const [editor, setEditor] = React.useState(null);
      const [editorNotice, setEditorNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [actionError, setActionError] = React.useState(null);
      const [stageSize, setStageSize] = React.useState({ width: 0, height: 0 });
      const [assetToAdd,setAssetToAdd]=React.useState(null);
      const [drawerOpen, setDrawerOpen] = React.useState(false);
      const [uploadBusy, setUploadBusy] = React.useState(false);
      const [sceneChoice, setSceneChoice] = React.useState(scenes[0] ? scenes[0].sceneId : null);
      const [sceneColor, setSceneColor] = React.useState('#1d4ed8');
      const [styleColor, setStyleColor] = React.useState('#ffffff');
      const [styleSize, setStyleSize] = React.useState(64);
      const [exportState, setExportState] = React.useState(null);

      // Two physical, permanently keyed iframe slots: the visible slot renders
      // `active`, the hidden slot preloads `candidate`. Promotion flips the slot
      // roles instead of swapping src, so the already-ready candidate DOM iframe
      // is never reloaded. The old messages are routed only to the instance that
      // owns the matching slot/ledger.
      const iframeRef = React.useRef(null);
      const slot1Ref = React.useRef(null);
      const stageRef = React.useRef(null);
      const wrapRef = React.useRef(null);
      const overlayRef = React.useRef(null);
      const activeRef = React.useRef(null);
      const candidateRef = React.useRef(null);
      const visibleSlotRef = React.useRef(0);
      const slotInstancesRef = React.useRef([null, null]);
      const editorRef = React.useRef(null);
      const timeRef = React.useRef(0);
      const playingRef = React.useRef(false);
      const soundEnabledRef = React.useRef(false);
      const selectedRef = React.useRef(null);
      const readyRef = React.useRef(false);
      const snapshotToken = React.useRef(0);
      const suppressClickRef = React.useRef(false);
      const pollRef = React.useRef(null);
      const unmountEpochRef = React.useRef(0);
      // P3-017 B1: bounded per-revision attempt bookkeeping, one pending auto
      // retry timer, and the restore payload captured for that retry. The
      // diagnostics ring is bounded; nothing here can grow with time.
      const attemptRef = React.useRef({ revision: null, attempt: 0 });
      const diagnosticsRef = React.useRef([]);
      const retryTimerRef = React.useRef(null);
      const retryRestoreRef = React.useRef(null);
      // The pending revision debounce is owned by a ref (not by an effect
      // cleanup), so a parent re-render can never silently re-arm it. It is
      // cleared when a newer revision arrives, the target loads, or on unmount.
      const debounceRef = React.useRef({ revision: null, timer: null });
      const targetRevisionRef = React.useRef(targetRevision);
      const firstLoadRef = React.useRef(true);
      const lastProjectIdRef = React.useRef(projectId);
      const inspectedMetaRef = React.useRef(new Map());
      const revision = inspected.revision;
      // R2F: geometry/duration belong to each preview instance, never to the
      // latest target props. The latest inspected metadata only seeds the map
      // entry for the revision being requested (kept per revision so a retry of a
      // previously failed target still uses that revision's own geometry).
      const inspectedMeta = {
        width: canvasNumber(inspected.width, 1280),
        height: canvasNumber(inspected.height, 720),
        duration: Math.max(0, canvasNumber(inspected.duration, 0)),
      };
      if (typeof inspected.revision === 'string' && inspected.revision.length > 0) {
        inspectedMetaRef.current.set(inspected.revision, inspectedMeta);
        if (inspectedMetaRef.current.size > 64) {
          const oldest = inspectedMetaRef.current.keys().next();
          if (oldest.done === false && oldest.value !== inspected.revision) inspectedMetaRef.current.delete(oldest.value);
        }
      }
      const displayMeta = active !== null ? active : candidate !== null ? candidate : inspectedMeta;
      const displayWidthPx = displayMeta.width;
      const displayHeightPx = displayMeta.height;
      const displayDuration = displayMeta.duration;
      const scale = stageSize.width > 0 && stageSize.height > 0 ? Math.min(stageSize.width / displayWidthPx, stageSize.height / displayHeightPx) : 0;
      const displayWidth = scale > 0 ? displayWidthPx * scale : 0;
      const displayHeight = scale > 0 ? displayHeightPx * scale : 0;

      timeRef.current = time;
      playingRef.current = playing;
      selectedRef.current = selected;
      editorRef.current = editor;
      activeRef.current = active;
      candidateRef.current = candidate;
      visibleSlotRef.current = visibleSlot;
      targetRevisionRef.current = targetRevision;
      slotInstancesRef.current = [
        visibleSlot === 0 ? active : candidate,
        visibleSlot === 1 ? active : candidate,
      ];

      function setSelectedSafe(next) {
        selectedRef.current = next;
        setSelected(next);
        if (next !== null && next.style) {
          setStyleColor(typeof next.style.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(next.style.color) ? next.style.color : '#ffffff');
          setStyleSize(canvasNumber(next.style.fontSize, 64));
        }
      }

      // Settle one runtime instance explicitly: resolve every still pending
      // command promise with null, clear its timers, drop its waiter map and
      // revoke its ledger. Never leave a dangling promise when an instance is
      // unbound, replaced or destroyed (the reviewed P3-005-B requirement). The
      // active and candidate instances own separate ledgers/waiters, so settling
      // one can never disturb the other.
      function settleInstance(instance) {
        if (instance === null || instance === undefined) return;
        const pending = instance.pending;
        if (pending !== null && pending !== undefined) {
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.resolve(null);
          }
          pending.clear();
        }
        if (instance.ledger !== null && instance.ledger !== undefined) instance.ledger.revoke();
      }

      function slotFrame(index) {
        return index === 0 ? iframeRef.current : slot1Ref.current;
      }

      function settleInstanceWaiter(instance, seq, payload) {
        const pending = instance !== null && instance !== undefined ? instance.pending : null;
        if (pending === null || pending === undefined) return;
        const entry = pending.get(seq);
        if (entry === undefined) return;
        pending.delete(seq);
        clearTimeout(entry.timer);
        entry.resolve(payload);
      }

      function postSlotCommand(index, type, payload) {
        return new Promise(function commandPromise(resolve) {
          const frame = slotFrame(index);
          const instances = slotInstancesRef.current;
          const instance = instances !== null && instances !== undefined ? instances[index] : null;
          const ledger = instance !== null && instance !== undefined ? instance.ledger : null;
          if (frame === null || frame === undefined || ledger === null || typeof frame.contentWindow === 'undefined') {
            resolve(null);
            return;
          }
          let message;
          try {
            message = ledger.command(type, payload || {});
          } catch (_error) {
            // The UI only constructs contract commands; an invalid one is a bug,
            // not something to post to the sandbox.
            resolve(null);
            return;
          }
          const pending = instance.pending;
          const timer = setTimeout(function timeout() {
            if (pending.has(message.seq) === false) return;
            pending.delete(message.seq);
            ledger.expire(Date.now() + 1);
            resolve(null);
          }, 4000);
          pending.set(message.seq, { resolve: resolve, timer: timer });
          try {
            frame.contentWindow.postMessage(message, '*');
          } catch (_error) {
            clearTimeout(timer);
            pending.delete(message.seq);
            ledger.expire(Date.now() + 1);
            resolve(null);
          }
        });
      }

      function postActiveCommand(type, payload) {
        return postSlotCommand(visibleSlotRef.current, type, payload);
      }

      function hideSelection() {
        setSelectedSafe(null);
        setEditor(null);
        setDrag(null);
      }

      function selectedElement() {
        if (selected === null) return null;
        return elements.find(function same(element) {
          return element.stableId === selected.stableId;
        }) || null;
      }

      function isTextSelected() {
        const element = selectedElement();
        return element !== null && Array.isArray(element.capabilities) && element.capabilities.includes('text');
      }

      function isLayoutSelected() {
        const element = selectedElement();
        return element !== null && Array.isArray(element.capabilities) && element.capabilities.includes('layout');
      }

      function isStyleSelected() {
        const element = selectedElement();
        return element !== null && Array.isArray(element.capabilities) && element.capabilities.includes('style');
      }

      function currentScene() {
        const found = scenes.find(function contains(scene) {
          return time >= scene.start && time < scene.start + scene.duration;
        });
        return found || scenes[0] || null;
      }

      React.useEffect(
        function measureStage() {
          const element = wrapRef.current;
          if (element === null || element === undefined) return function noMeasure() {};
          function measure() {
            try {
              const rect = element.getBoundingClientRect();
              setStageSize({ width: Math.max(0, rect.width), height: Math.max(0, rect.height) });
            } catch (_error) {
              /* A non-DOM test host has no box; render the composition at its
                 natural aspect so the canvas still mounts for contract tests. */
              setStageSize({ width: Math.max(320, canvasNumber(inspected.width, 1280)), height: Math.max(180, canvasNumber(inspected.height, 720)) });
            }
          }
          measure();
          let observer = null;
          if (typeof ResizeObserver === 'function' && element !== null) {
            observer = new ResizeObserver(measure);
            observer.observe(element);
          } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('resize', measure);
          }
          return function stopMeasure() {
            if (observer !== null) observer.disconnect();
            else if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('resize', measure);
          };
        },
        []
      );

      // Fire-and-forget Host snapshot release: retention is only needed while an
      // instance may still load/play. Errors are ignored (the worker TTL and the
      // Host route cap clean up).
      function releaseSnapshot(instance) {
        if (instance === null || instance === undefined) return;
        if (typeof instance.snapshotId !== 'string' || instance.snapshotId.length === 0) return;
        hostRequest('preview.release', { snapshotId: instance.snapshotId }).catch(function ignoreRelease() {});
      }

      /** Metadata of the revision being requested, independent of later props. */
      function metadataForRevision(revisionId) {
        const known = inspectedMetaRef.current.get(revisionId);
        if (known !== undefined && known !== null) return known;
        if (inspected.revision === revisionId) return inspectedMeta;
        if (activeRef.current !== null) {
          return { width: activeRef.current.width, height: activeRef.current.height, duration: activeRef.current.duration };
        }
        if (candidateRef.current !== null) {
          return { width: candidateRef.current.width, height: candidateRef.current.height, duration: candidateRef.current.duration };
        }
        return inspectedMeta;
      }

      function snapshotInstance(next, restore, metadata) {
        const instanceId = canvasInstanceId();
        const nonce = canvasNonce();
        const meta = metadata !== null && metadata !== undefined ? metadata : inspectedMeta;
        return {
          snapshotId: next.snapshotId,
          revision: next.revision,
          entryUrl: next.entryUrl,
          routeBase: next.routeBase,
          src: next.entryUrl + '?instance=' + encodeURIComponent(instanceId) + '&nonce=' + nonce,
          instanceId: instanceId,
          nonce: nonce,
          restore: restore || null,
          // R2F: this instance's own composition metadata. The visible display,
          // seek range and coordinate mapping never read another instance's
          // values, so a failed/delayed candidate cannot resize the active one.
          width: canvasNumber(meta.width, 1280),
          height: canvasNumber(meta.height, 720),
          duration: Math.max(0, canvasNumber(meta.duration, 0)),
          ledger: canvasMessageLedger({ instanceId: instanceId, nonce: nonce, timeoutMs: 4000 }),
          pending: new Map(),
        };
      }

      function discardCandidate() {
        const current = candidateRef.current;
        if (current === null) return;
        candidateRef.current = null;
        settleInstance(current);
        releaseSnapshot(current);
        setCandidate(null);
        setPreviewNotice(null);
      }

      // Snapshot request failure or candidate runtime error: keep the last ready
      // composition visible/playable. With an active composition a compact notice
      // + retry appears next to the stage; without one (first load) the existing
      // full recoverable status is shown.
      function failCandidate(error) {
        const current = candidateRef.current;
        if (current !== null) {
          candidateRef.current = null;
          settleInstance(current);
          releaseSnapshot(current);
        }
        setCandidate(null);
        if (activeRef.current !== null) {
          setPreviewNotice(hostError(error));
          setPhase('ready');
        } else {
          setPhase('error');
          setFrameError(hostError(error));
        }
      }

      function clearRetryTimer() {
        if (retryTimerRef.current !== null) {
          clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
      }

      function clearDebounceTimer() {
        if (debounceRef.current.timer !== null) clearTimeout(debounceRef.current.timer);
        debounceRef.current = { revision: null, timer: null };
      }

      function releaseUnusedSnapshot(value) {
        if (value !== null && typeof value === 'object' && typeof value.snapshotId === 'string') {
          hostRequest('preview.release', { snapshotId: value.snapshotId }).catch(function ignoreRelease() {});
        }
      }

      // P3-017 B1 bounded diagnostics: the newest PREVIEW_DIAGNOSTIC_LIMIT
      // attempts, each with revision, attempt number, snapshot/ready durations and
      // error code. Exposed as one data attribute (and one console line per failed
      // attempt); the ring never grows with session length.
      function recordPreviewDiagnostic(entry) {
        const next = diagnosticsRef.current.concat([entry]).slice(-PREVIEW_DIAGNOSTIC_LIMIT);
        diagnosticsRef.current = next;
        setPreviewDiagnostics(next);
      }

      function previewDiagnosticsText() {
        return diagnosticsRef.current.map(function diagnosticLine(entry) {
          const revisionId = typeof entry.revision === 'string' ? entry.revision.slice(0, 8) : '';
          const attempt = Number.isFinite(entry.attempt) ? String(entry.attempt) : '-';
          const snapshotMs = Number.isFinite(entry.snapshotMs) ? String(Math.round(entry.snapshotMs)) : '-';
          const readyMs = Number.isFinite(entry.readyMs) ? String(Math.round(entry.readyMs)) : '-';
          return revisionId + ':' + attempt + ':' + snapshotMs + ':' + readyMs + ':' + (entry.errorCode || 'ok');
        }).join('|');
      }

      function resetPreviewAttempt(revisionId) {
        attemptRef.current = { revision: revisionId, attempt: 0 };
        setPreviewAttempt({ revision: revisionId, attempt: 0 });
      }

      // P3-017 B1: one automatic retry with a fresh snapshot before the honest
      // failure is shown. The active composition is never unmounted here; while
      // the retry is pending it stays visible/playable and the non-blocking
      // "updating preview" marker names the pending revision.
      function handlePreviewAttemptFailure(error, detail) {
        const meta = detail !== null && typeof detail === 'object' ? detail : {};
        const failure = hostError(error);
        const revisionId = typeof meta.revision === 'string' && meta.revision.length > 0 ? meta.revision : targetRevisionRef.current;
        const attempt = attemptRef.current.revision === revisionId ? attemptRef.current.attempt : 0;
        recordPreviewDiagnostic({
          revision: revisionId,
          attempt: attempt,
          snapshotMs: Number.isFinite(meta.snapshotMs) ? meta.snapshotMs : null,
          readyMs: Number.isFinite(meta.readyMs) ? meta.readyMs : null,
          errorCode: failure.code,
        });
        if (attempt > 0 && attempt <= PREVIEW_RETRY_LIMIT) {
          clearRetryTimer();
          setPreviewRetrying(true);
          setPreviewNotice(null);
          if (activeRef.current !== null) {
            setPhase('ready');
          } else {
            setPhase('loading');
            setFrameError(null);
          }
          console.warn('[dsh-video] preview attempt failed; retrying once', {
            revision: revisionId,
            attempt: attempt,
            snapshotMs: Number.isFinite(meta.snapshotMs) ? Math.round(meta.snapshotMs) : null,
            readyMs: Number.isFinite(meta.readyMs) ? Math.round(meta.readyMs) : null,
            code: failure.code,
          });
          retryTimerRef.current = setTimeout(function autoRetryPreview() {
            retryTimerRef.current = null;
            if (activeRef.current === null) setPhase('loading');
            void loadTarget(revisionId, retryRestoreRef.current);
          }, PREVIEW_RETRY_DELAY_MS);
          return;
        }
        setPreviewRetrying(false);
        console.warn('[dsh-video] preview failed', {
          revision: revisionId,
          attempt: attempt,
          snapshotMs: Number.isFinite(meta.snapshotMs) ? Math.round(meta.snapshotMs) : null,
          readyMs: Number.isFinite(meta.readyMs) ? Math.round(meta.readyMs) : null,
          code: failure.code,
        });
        failCandidate(error);
      }

      function promoteCandidate(instance) {
        if (candidateRef.current !== instance) return;
        const previous = activeRef.current;
        const hiddenIndex = 1 - visibleSlotRef.current;
        const restore = instance.restore;
        // The restored playback position is clamped to the NEW instance's own
        // duration; the outgoing instance's duration is no longer authoritative.
        const restoreTime = restore !== null && restore !== undefined && Number.isFinite(restore.time)
          ? Math.min(restore.time, instance.duration)
          : Math.min(timeRef.current, instance.duration);
        const clampedTime = Math.min(timeRef.current, instance.duration);
        // The preloaded runtime is already ready: carry the playback position (and
        // on the manual path the selection) over before the slot roles swap.
        void postSlotCommand(hiddenIndex, 'seek', { time: restoreTime });
        if (soundEnabledRef.current) void postSlotCommand(hiddenIndex,'enableSound');
        if (playingRef.current === true) void postSlotCommand(hiddenIndex, 'play');
        if (restore !== null && restore !== undefined && typeof restore.stableId === 'string') {
          const element = elements.find(function same(item) {
            return item.stableId === restore.stableId;
          });
          if (element !== undefined && element.layout && Number.isFinite(element.layout.left) && Number.isFinite(element.layout.top)) {
            const rect = element.layout;
            if (rect.width > 0 && rect.height > 0) {
              void postSlotCommand(hiddenIndex, 'hitTest', { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }).then(function applyHit(payload) {
                if (payload && payload.hit) setSelectedSafe(payload.hit);
              });
            }
          }
        }
        activeRef.current = instance;
        candidateRef.current = null;
        visibleSlotRef.current = hiddenIndex;
        setVisibleSlot(hiddenIndex);
        setActive(instance);
        setCandidate(null);
        setPhase('ready');
        setFrameError(null);
        setPreviewNotice(null);
        setTime(clampedTime);
        readyRef.current = true;
        if (previous !== null) {
          // Release the outgoing instance only after the successful switch.
          settleInstance(previous);
          releaseSnapshot(previous);
        }
      }

      async function loadTarget(requested, restore, options) {
        const target = typeof requested === 'string' && requested.length > 0 ? requested : revision;
        const settings = options !== null && typeof options === 'object' ? options : {};
        // Idempotent for the requested revision: an already in-flight request,
        // an already preloading candidate and the displayed composition are never
        // fetched a second time (a re-render or a poll cannot disturb them, and no
        // duplicate snapshot is created).
        const inFlight = pendingRequestRef.current;
        if (inFlight !== null && inFlight.revision === target) return;
        if (candidateRef.current !== null && candidateRef.current.revision === target) {
          setTargetRevision(target);
          return;
        }
        if (activeRef.current !== null && activeRef.current.revision === target) {
          setTargetRevision(target);
          setPreviewNotice(null);
          setPreviewRetrying(false);
          setPhase('ready');
          return;
        }
        // One attempt is one snapshot request. A fresh cycle (a new revision, a
        // new project or an explicit user retry) restarts the retry allowance.
        if (settings.fresh === true || attemptRef.current.revision !== target) resetPreviewAttempt(target);
        const attempt = attemptRef.current.attempt + 1;
        attemptRef.current = { revision: target, attempt: attempt };
        setPreviewAttempt({ revision: target, attempt: attempt });
        clearRetryTimer();
        clearDebounceTimer();
        if (restore !== null && restore !== undefined) retryRestoreRef.current = restore;
        const token = ++snapshotToken.current;
        // Capture the requested revision's metadata before any async work: later
        // props.inspected updates for a newer revision must not leak into this
        // instance (and retries reuse the per-revision map entry).
        const targetMeta = metadataForRevision(target);
        pendingRequestRef.current = { revision: target, token: token };
        setTargetRevision(target);
        setPreviewNotice(null);
        setPreviewRetrying(false);
        // A newer request supersedes a still-preloading candidate.
        discardCandidate();
        if (activeRef.current === null) {
          setPhase('loading');
          setFrameError(null);
        }
        // The snapshot has its own independent budget, measured from the request
        // itself. A timed-out request keeps running in the background; if it ever
        // resolves afterwards the unused snapshot is released instead of leaking.
        const startedAt = Date.now();
        let next = null;
        let failure = null;
        const request = hostRequest('preview.snapshot', { projectId: projectId, revision: target, ttlMs: 300000 });
        const timedOut = await new Promise(function snapshotBudget(resolve) {
          let settled = false;
          const timer = setTimeout(function snapshotTimedOut() {
            if (settled === true) return;
            settled = true;
            resolve(true);
          }, PREVIEW_SNAPSHOT_TIMEOUT_MS);
          request.then(
            function snapshotReady(value) {
              clearTimeout(timer);
              if (settled === true) {
                releaseUnusedSnapshot(value);
                return;
              }
              settled = true;
              next = value;
              resolve(false);
            },
            function snapshotFailed(error) {
              clearTimeout(timer);
              if (settled === true) return;
              settled = true;
              failure = error;
              resolve(false);
            }
          );
        });
        const snapshotMs = Date.now() - startedAt;
        if (token !== snapshotToken.current) {
          // Superseded while in flight: the snapshot we just obtained is unused;
          // release it without touching the displayed composition.
          if (pendingRequestRef.current !== null && pendingRequestRef.current.token === token) pendingRequestRef.current = null;
          releaseUnusedSnapshot(next);
          return;
        }
        pendingRequestRef.current = null;
        if (timedOut === true) {
          handlePreviewAttemptFailure(
            { code: 'E_PREVIEW_TIMEOUT', message: t('video.canvas.loadTimeout') },
            { revision: target, snapshotMs: snapshotMs, phase: 'snapshot' }
          );
          return;
        }
        if (failure !== null) {
          handlePreviewAttemptFailure(failure, { revision: target, snapshotMs: snapshotMs, phase: 'snapshot' });
          return;
        }
        if (next === null || typeof next !== 'object' || typeof next.snapshotId !== 'string' || typeof next.entryUrl !== 'string') {
          handlePreviewAttemptFailure(
            { code: 'E_SNAPSHOT', message: 'The preview snapshot was invalid' },
            { revision: target, snapshotMs: snapshotMs, phase: 'snapshot' }
          );
          return;
        }
        const instance = snapshotInstance(next, restore || retryRestoreRef.current || null, targetMeta);
        instance.snapshotMs = snapshotMs;
        instance.mountedAt = Date.now();
        candidateRef.current = instance;
        setCandidate(instance);
      }

      React.useEffect(
        function reloadOnRevision() {
          const projectChanged = lastProjectIdRef.current !== projectId;
          lastProjectIdRef.current = projectId;
          const restore = {
            time: timeRef.current,
            stableId: selectedRef.current ? selectedRef.current.stableId : null,
            playing: playingRef.current,
          };
          retryRestoreRef.current = restore;
          // The first load and a project switch are immediate. A later published
          // revision is debounced (~1s of stability) so a burst of Agent publishes
          // settles on the last revision instead of racing several snapshots; the
          // target marker names the pending revision right away. The hidden manual
          // path (previewOnly=false) keeps its reviewed immediate reload because its
          // writes are user-initiated and never arrive in bursts.
          if (firstLoadRef.current === true || projectChanged === true || previewOnly === false) {
            firstLoadRef.current = false;
            clearDebounceTimer();
            void loadTarget(revision, restore);
            return function stopImmediateLoad() {};
          }
          setTargetRevision(revision);
          // The ref owns the timer exactly once per pending revision, so a parent
          // re-render cannot push the debounce deadline back indefinitely.
          if (debounceRef.current.revision === revision && debounceRef.current.timer !== null) {
            return function keepDebouncedLoad() {};
          }
          clearDebounceTimer();
          const timer = setTimeout(function debouncedPreviewLoad() {
            debounceRef.current = { revision: null, timer: null };
            void loadTarget(revision, restore);
          }, PREVIEW_DEBOUNCE_MS);
          debounceRef.current = { revision: revision, timer: timer };
          return function keepDebouncedLoad() {};
        },
        [projectId, revision]
      );

      // P3-017 B1: the ready budget starts only after a snapshot resolved AND its
      // candidate is actually mounted. A missing runtime handshake expires exactly
      // this attempt: settle/release the candidate and let the normal one-retry
      // path apply. A late ready from the discarded instance can never promote.
      React.useEffect(function boundReadyWait() {
        if (candidate === null) return function noReadyWait() {};
        const instance = candidate;
        const startedAt = Number.isFinite(instance.mountedAt) ? instance.mountedAt : Date.now();
        const timer = setTimeout(function previewNotReady() {
          if (candidateRef.current !== instance) return;
          discardCandidate();
          handlePreviewAttemptFailure(
            { code: 'E_PREVIEW_TIMEOUT', message: t('video.canvas.loadTimeout') },
            { revision: instance.revision, snapshotMs: instance.snapshotMs, readyMs: Date.now() - startedAt, phase: 'ready' }
          );
        }, PREVIEW_READY_TIMEOUT_MS);
        return function stopReadyWait() { clearTimeout(timer); };
      }, [candidate]);

      function syncRuntimeTime(time) {
        const fence=timelineScrubRef.current;
        if(fence?.held)return false;
        if(fence&&Date.now()<fence.until&&(!Number.isFinite(time)||Math.abs(time-fence.time)>1/30))return false;
        timelineScrubRef.current=null;if(Number.isFinite(time))setTime(time);return true;
      }
      function handleActiveRuntimeEvent(instance, outcome) {
        if (activeRef.current !== instance) return;
        const payload = outcome.payload;
        if (outcome.type === 'ready') {
          readyRef.current = true;
          setPhase('ready');
        } else if (outcome.type === 'seeked' || outcome.type === 'state') {
          const accepted=syncRuntimeTime(payload.time);
          if (accepted&&typeof payload.playing === 'boolean') setPlaying(payload.playing);
          readyRef.current = true;
        } else if(outcome.type==='soundEnabled'){
          soundEnabledRef.current=true;
        } else if (outcome.type === 'playing') {
          if(!timelineScrubRef.current)setPlaying(true);
        } else if (outcome.type === 'paused') {
          setPlaying(false);
          syncRuntimeTime(payload.time);
        } else if (outcome.type === 'hit') {
          setSelectedSafe(payload.hit || null);
        } else if (outcome.type === 'error') {
          setActionError({ code: payload.code, message: payload.message });
        } else if (outcome.type === 'destroyed') {
          settleInstance(instance);
        }
      }

      function handleCandidateRuntimeEvent(instance, outcome) {
        // Only the currently tracked candidate may promote; an old/revoked
        // candidate's ready or error can never affect the displayed composition.
        if (candidateRef.current !== instance) return;
        const payload = outcome.payload;
        if (outcome.type === 'ready' || outcome.type === 'state') {
          promoteCandidate(instance);
        } else if (outcome.type === 'error') {
          // The mounted candidate failed before ready: release it, then apply the
          // same one-retry policy as a snapshot failure.
          const readyMs = Number.isFinite(instance.mountedAt) ? Date.now() - instance.mountedAt : null;
          discardCandidate();
          handlePreviewAttemptFailure(
            { code: payload.code, message: payload.message },
            { revision: instance.revision, snapshotMs: instance.snapshotMs, readyMs: readyMs, phase: 'runtime' }
          );
        } else if (outcome.type === 'destroyed') {
          settleInstance(instance);
        }
      }

      React.useEffect(
        function bindRuntimeMessages() {
          if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return function noWindow() {};
          function handleMessage(event) {
            const instances = slotInstancesRef.current;
            for (let index = 0; index < 2; index += 1) {
              const frame = slotFrame(index);
              if (frame === null || frame === undefined) continue;
              if (event.source !== frame.contentWindow) continue;
              const instance = instances !== null && instances !== undefined ? instances[index] : null;
              if (instance === null || instance === undefined) return;
              const role = index === visibleSlotRef.current ? 'active' : 'candidate';
              const outcome = instance.ledger.accept(event.data, { sourceOk: true });
              if (outcome.accepted === false) return;
              if (outcome.replyTo !== null) {
                settleInstanceWaiter(instance, outcome.replyTo, outcome.type === 'error' ? null : outcome.payload);
              }
              if (role === 'candidate') handleCandidateRuntimeEvent(instance, outcome);
              else handleActiveRuntimeEvent(instance, outcome);
              return;
            }
          }
          window.addEventListener('message', handleMessage);
          return function unbind() {
            window.removeEventListener('message', handleMessage);
          };
        },
        []
      );

      // Release the displayed/preloading snapshots only when the component is
      // really unmounting. In the Node smoke shim effect cleanups also run on
      // re-render, so a re-armed epoch distinguishes a re-render from an unmount
      // without releasing routes that are still displayed.
      React.useEffect(
        function releaseOnUnmount() {
          const epoch = ++unmountEpochRef.current;
          return function scheduleRelease() {
            void Promise.resolve().then(function releaseIfStillUnmounted() {
              if (unmountEpochRef.current !== epoch) return;
              // Stop any pending automatic retry/debounce and invalidate an
              // in-flight snapshot so a late result is released instead of leaking.
              clearRetryTimer();
              clearDebounceTimer();
              snapshotToken.current += 1;
              pendingRequestRef.current = null;
              if (candidateRef.current !== null) {
                const next = candidateRef.current;
                candidateRef.current = null;
                settleInstance(next);
                releaseSnapshot(next);
              }
              if (activeRef.current !== null) {
                const current = activeRef.current;
                activeRef.current = null;
                settleInstance(current);
                releaseSnapshot(current);
              }
              readyRef.current = false;
            });
          };
        },
        []
      );

      React.useEffect(
        function pollDuringPlayback() {
          if (!playing) return function noPoll() {};
          const timer = setInterval(function pollState() {
            void postActiveCommand('state');
          }, 33);
          return function stopPoll() {
            clearInterval(timer);
          };
        },
        [playing]
      );

      function stagePoint(event) {
        const stage = stageRef.current;
        if (stage === null || scale <= 0) return null;
        const rect = stage.getBoundingClientRect();
        const x = (event.clientX - rect.left) / scale;
        const y = (event.clientY - rect.top) / scale;
        if (x < 0 || y < 0 || x > displayWidthPx || y > displayHeightPx) return null;
        return { x: x, y: y };
      }

      function onOverlayClick(event) {
        if (editor !== null || drag !== null) return;
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        const point = stagePoint(event);
        if (point === null) return;
        void postActiveCommand('hitTest', point).then(function applyHit(payload) {
          setSelectedSafe(payload && payload.hit ? payload.hit : null);
        });
      }

      function beginDrag(event, mode) {
        if (selected === null || playing || isLayoutSelected() === false) return;
        const point = stagePoint(event);
        if (point === null) return;
        event.preventDefault();
        event.stopPropagation();
        if (overlayRef.current !== null && typeof overlayRef.current.setPointerCapture === 'function') {
          try {
            overlayRef.current.setPointerCapture(event.pointerId);
          } catch (_error) {
            /* pointer capture is best effort */
          }
        }
        const rect = canvasValidRect(selected.rect);
        if (rect === null) return;
        // The static base is the authoritative inspected layout, never the
        // animated getBoundingClientRect the runtime reported for the hit.
        const element = selectedElement();
        const base = element !== null ? canvasStaticBase(element.layout) : canvasStaticBase(null);
        setEditor(null);
        setEditorNotice(null);
        setDrag({
          mode: mode,
          pointerId: event.pointerId,
          start: point,
          rect: rect,
          base: base,
          preview: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          stableId: selected.stableId,
          moved: false,
        });
      }

      function onOverlayPointerMove(event) {
        if (drag === null) return;
        const point = stagePoint(event);
        if (point === null) return;
        const dx = point.x - drag.start.x;
        const dy = point.y - drag.start.y;
        let next = { x: drag.rect.x, y: drag.rect.y, width: drag.rect.width, height: drag.rect.height };
        if (drag.mode === 'move') {
          next.x = Math.max(0, Math.min(displayWidthPx - next.width, drag.rect.x + dx));
          next.y = Math.max(0, Math.min(displayHeightPx - next.height, drag.rect.y + dy));
        } else {
          if (drag.mode.includes('w')) {
            const x = Math.max(0, Math.min(drag.rect.x + dx, drag.rect.x + drag.rect.width - 1));
            next.x = x;
            next.width = drag.rect.x + drag.rect.width - x;
          }
          if (drag.mode.includes('e')) next.width = Math.max(1, Math.min(displayWidthPx - next.x, drag.rect.width + dx));
          if (drag.mode.includes('n')) {
            const y = Math.max(0, Math.min(drag.rect.y + dy, drag.rect.y + drag.rect.height - 1));
            next.y = y;
            next.height = drag.rect.y + drag.rect.height - y;
          }
          if (drag.mode.includes('s')) next.height = Math.max(1, Math.min(displayHeightPx - next.y, drag.rect.height + dy));
        }
        const moved = Math.abs(dx) > 1 || Math.abs(dy) > 1;
        setDrag({ ...drag, preview: next, moved: drag.moved || moved });
      }

      async function commitLayout(current) {
        const element = selectedRef.current;
        if (element === null || current === null) return;
        const plan = canvasLayoutPatch({
          mode: current.mode,
          base: current.base,
          animated: current.rect,
          preview: current.preview,
          composition: { width: displayWidthPx, height: displayHeightPx },
        });
        if (plan.ok === false) {
          // Unknown static origin/scale: refuse loudly instead of persisting the
          // animated rectangle. The selection keeps its pre-drag rect (the drag
          // preview was already cleared) and no request is sent.
          setActionError({
            code: plan.code,
            message: t(plan.code === 'E_LAYOUT_SCALE' ? 'video.canvas.layoutScaleUnknown' : 'video.canvas.layoutRefused'),
          });
          return;
        }
        setBusy('layout');
        setActionError(null);
        try {
          await hostRequest('edit', {
            projectId: projectId,
            expectedRevision: revision,
            operationId: operationId(),
            ops: [
              {
                type: 'layout',
                target: element.stableId,
                unit: 'composition-px',
                box: plan.patch,
              },
            ],
          });
          await onReload();
        } catch (error) {
          setActionError(hostError(error));
          onError(hostError(error));
        } finally {
          setBusy(null);
        }
      }

      function onOverlayPointerUp(event) {
        if (drag === null) return;
        const current = drag;
        setDrag(null);
        if (current.moved) {
          suppressClickRef.current = true;
          void commitLayout(current);
        }
      }

      // ---- inline text write attempts ---------------------------------------
      // One operationId binds exactly ONE immutable request. The worker caches
      // results by operationId + canonical request signature and checks that
      // cache BEFORE the revision, so:
      //   - replaying the exact frozen request after a lost response returns the
      //     cached success (applied once);
      //   - the same operationId with a different request is E_OPERATION_REUSED;
      //   - a stale expectedRevision without a cache entry is
      //     E_REVISION_CONFLICT.
      // A changed draft therefore settles the old frozen attempt first and only
      // then starts a new attempt with a new operationId and the settled
      // revision. The id is never switched while the old outcome is unknown.
      function makeTextAttempt(stableId, expectedRevision, value) {
        // One immutable text operation id per attempt: an exact retry replays
        // this request; a changed intent always gets a fresh textOperationId.
        const textOperationId = operationId();
        return {
          operationId: textOperationId,
          expectedRevision: expectedRevision,
          ops: [{ type: 'text', target: stableId, text: value }],
          value: value,
        };
      }

      function sendTextAttempt(attempt) {
        return hostRequest('edit', {
          projectId: projectId,
          expectedRevision: attempt.expectedRevision,
          operationId: attempt.operationId,
          ops: attempt.ops,
        });
      }

      function isRecoverableAttemptError(failure) {
        return canvasIsRevisionConflict(failure) || failure.code === 'E_OPERATION_REUSED';
      }

      function showAttemptFailure(failure, freezeAttempt) {
        setActionError(failure);
        setEditor(function keepDraftAndAttempt(previous) {
          if (previous === null) return null;
          if (isRecoverableAttemptError(failure)) {
            // Recoverable, but never auto-overwritten: reset the attempt and use
            // the explicit refresh path. A later explicit submit creates a new
            // id at the refreshed revision.
            return Object.assign({}, previous, { attempt: null, error: failure, refreshRequired: true });
          }
          // Uncertain/definite failure: the frozen request is kept so the next
          // explicit submit re-sends exactly this request (same id/ops/revision).
          return Object.assign({}, previous, { attempt: freezeAttempt, error: failure, refreshRequired: false });
        });
        onError(failure);
      }

      async function submitText() {
        if (editor === null || busy !== null) return;
        if (editor.refreshRequired === true) {
          // The previous explicit submit hit a revision conflict (or a
          // recoverable E_OPERATION_REUSED). Retrying now refreshes the
          // authoritative revision only and resets the attempt: the user has to
          // submit again afterwards, so a newer project is never overwritten
          // silently and nothing is replayed automatically.
          setBusy('text');
          setActionError(null);
          try {
            await onReload();
            setEditor(function clearConflict(previous) {
              if (previous === null) return null;
              return Object.assign({}, previous, { attempt: null, refreshRequired: false, error: null });
            });
            setEditorNotice(t('video.canvas.revisionRefreshed'));
          } catch (reloadError) {
            setActionError(hostError(reloadError));
            onError(hostError(reloadError));
          } finally {
            setBusy(null);
          }
          return;
        }
        const value = editor.value;
        const stableId = editor.stableId;
        const frozen = editor.attempt;
        let pendingAttempt = frozen;
        setBusy('text');
        setActionError(null);
        try {
          if (frozen !== null && value !== frozen.value) {
            // The retained draft changed after an unknown outcome. A user-
            // initiated submit first settles the OLD attempt by re-sending its
            // exact frozen request; only its result unlocks a new intent/id.
            let settled = null;
            try {
              settled = await sendTextAttempt(frozen);
            } catch (settleError) {
              showAttemptFailure(hostError(settleError), frozen);
              return;
            }
            // If the user closed the editor while the settle was in flight, the
            // old attempt was settled (applied at most once) and the new intent
            // stays unsent: never write new text after an explicit cancel.
            if (editorRef.current === null) return;
            const settledRevision =
              canvasPlainObject(settled) && typeof settled.revision === 'string' ? settled.revision : revision;
            const nextAttempt = makeTextAttempt(stableId, settledRevision, value);
            pendingAttempt = nextAttempt;
            setEditor(function storeNextAttempt(previous) {
              if (previous === null) return null;
              return Object.assign({}, previous, { attempt: nextAttempt, error: null, refreshRequired: false });
            });
            await sendTextAttempt(nextAttempt);
            setEditor(null);
            setEditorNotice(null);
            await onReload();
            return;
          }
          const attempt = frozen !== null ? frozen : makeTextAttempt(stableId, revision, value);
          pendingAttempt = attempt;
          if (frozen === null) {
            setEditor(function storeAttempt(previous) {
              if (previous === null) return null;
              return Object.assign({}, previous, { attempt: attempt, error: null, refreshRequired: false });
            });
          }
          await sendTextAttempt(attempt);
          setEditor(null);
          setEditorNotice(null);
          await onReload();
        } catch (error) {
          // Keep the draft and its target visible; no automatic retry and no
          // silent close. The frozen attempt is preserved on uncertain failures.
          showAttemptFailure(hostError(error), pendingAttempt);
        } finally {
          setBusy(null);
        }
      }

      async function applyStyle() {
        if (selected === null || busy !== null) return;
        setBusy('style');
        setActionError(null);
        try {
          const styles = {};
          if (/^#[0-9a-fA-F]{6}$/.test(styleColor)) styles.color = styleColor;
          const fontSize = Number(styleSize);
          if (Number.isFinite(fontSize) && fontSize >= 8 && fontSize <= 256) styles.fontSize = fontSize;
          if (Object.keys(styles).length === 0) throw { code: 'E_PARAMS', message: t('video.canvas.invalidStyle') };
          await hostRequest('edit', {
            projectId: projectId,
            expectedRevision: revision,
            operationId: operationId(),
            ops: [{ type: 'style', target: selected.stableId, styles: styles }],
          });
          await onReload();
        } catch (error) {
          setActionError(hostError(error));
          onError(hostError(error));
        } finally {
          setBusy(null);
        }
      }

      async function applySceneColor() {
        const scene = currentScene();
        if (scene === null || busy !== null) return;
        const color = canvasNormalizedColor(sceneColor);
        if (color === null) {
          setActionError({ code: 'E_PARAMS', message: t('video.canvas.invalidColor') });
          return;
        }
        setBusy('scene');
        setActionError(null);
        try {
          // A fresh authoritative inspect right before the write: scene.update
          // replaces the complete template, so the copy must come from the
          // current project state and the write must use this revision.
          const fresh = await hostRequest('inspect', { projectId: projectId });
          const prepared = canvasSceneTemplate(fresh, scene.sceneId);
          if (prepared.ok === false) {
            // Refuse instead of destructive guessing: no scene.update is sent.
            setActionError({ code: prepared.code, message: t('video.canvas.templateUnavailable') });
            return;
          }
          const template = prepared.template;
          template.color = color;
          await hostRequest('scene.update', {
            projectId: projectId,
            expectedRevision: prepared.revision,
            operationId: operationId(),
            sceneId: prepared.sceneId,
            template: template,
          });
          await onReload();
        } catch (error) {
          setActionError(hostError(error));
          onError(hostError(error));
        } finally {
          setBusy(null);
        }
      }

      async function addScene() {
        if (busy !== null) return;
        setBusy('scene-add');
        setActionError(null);
        try {
          await hostRequest('scene.create', {
            projectId: projectId,
            expectedRevision: revision,
            operationId: operationId(),
            template: { title: t('video.canvas.newSceneTitle'), duration: 5 },
          });
          await onReload();
        } catch (error) {
          setActionError(hostError(error));
          onError(hostError(error));
        } finally {
          setBusy(null);
        }
      }

      async function historyStep(kind) {
        if (busy !== null) return;
        setBusy(kind);
        setActionError(null);
        try {
          const history = await hostRequest('history', { projectId: projectId, limit: 20 });
          await hostRequest(kind, {
            projectId: projectId,
            expectedRevision: history.revision,
            operationId: operationId(),
          });
          await onReload();
        } catch (error) {
          setActionError(hostError(error));
          onError(hostError(error));
        } finally {
          setBusy(null);
        }
      }

      async function uploadImage(event) {
        const input = event.target;
        const file = input && input.files && input.files[0];
        if (!file) return;
        setUploadBusy(true);
        setActionError(null);
        try {
          const response = await fetch('api/dsh-video/asset-upload', {
            method: 'POST',
            headers: {
              'content-type': file.type || 'application/octet-stream',
              'x-dsh-project-id': projectId,
              'x-dsh-file-name': file.name,
            },
            credentials: 'same-origin',
            body: file,
          });
          const receipt = await response.json();
          if (response.ok === false || !receipt || typeof receipt.receiptId !== 'string') {
            throw (receipt && receipt.error) || { code: 'E_ASSET_UPLOAD', message: t('video.canvas.uploadFailed') };
          }
          await hostRequest('asset.import', {
            projectId: projectId,
            expectedRevision: revision,
            operationId: operationId(),
            receiptId: receipt.receiptId,
          });
          await onReload();
        } catch (error) {
          setActionError(hostError(error));
          onError(hostError(error));
        } finally {
          setUploadBusy(false);
          try {
            input.value = '';
          } catch (_error) {
            /* file input reset is best effort */
          }
        }
      }

      async function useAsset(assetPath) {
        const scene = currentScene();
        if (scene === null || busy !== null) return;
        const shot = canvasNormalizedAssetPath(assetPath);
        if (shot === null) {
          setActionError({ code: 'E_PARAMS', message: t('video.canvas.invalidAsset') });
          return;
        }
        setBusy('asset-use');
        setActionError(null);
        try {
          // Same fresh-inspect rule as the background change: copy the complete
          // authoritative template and change only the shot. The UI colour state
          // must never leak into an unrelated Scene write.
          const fresh = await hostRequest('inspect', { projectId: projectId });
          const prepared = canvasSceneTemplate(fresh, scene.sceneId);
          if (prepared.ok === false) {
            setActionError({ code: prepared.code, message: t('video.canvas.templateUnavailable') });
            return;
          }
          const template = prepared.template;
          template.shot = shot;
          await hostRequest('scene.update', {
            projectId: projectId,
            expectedRevision: prepared.revision,
            operationId: operationId(),
            sceneId: prepared.sceneId,
            template: template,
          });
          await onReload();
        } catch (error) {
          setActionError(hostError(error));
          onError(hostError(error));
        } finally {
          setBusy(null);
        }
      }

      async function exportVideo() {
        if (busy !== null) return;
        setBusy('render');
        setActionError(null);
        setExportState({ state: 'running' });
        try {
          const job = await hostRequest('render', { projectId: projectId, revision: revision });
          const jobId = job.jobId;
          let result = job;
          for (let attempt = 0; attempt < 240; attempt += 1) {
            await new Promise(function wait(resolve) {
              setTimeout(resolve, 500);
            });
            result = await hostRequest('status', { jobId: jobId });
            if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(result.state)) break;
          }
          if (result.state !== 'succeeded') throw { code: 'E_RENDER', message: t('video.canvas.exportFailed') };
          setExportState({ state: 'ready', jobId: jobId, url: 'api/dsh-video/artifact?jobId=' + encodeURIComponent(jobId) });
        } catch (error) {
          setExportState({ state: 'error' });
          setActionError(hostError(error));
          onError(hostError(error));
        } finally {
          setBusy(null);
        }
      }

      function togglePlayback() {
        timelineScrubRef.current=null;
        if (playing) {
          setPlaying(false);
          void postActiveCommand('pause');
        } else {
          setPlaying(true);
          void postActiveCommand('play');
        }
      }

      function seekTo(nextTime) {
        const value = Math.max(0, Math.min(displayDuration, Number(nextTime) || 0));
        setTime(value);
        void postActiveCommand('seek', { time: value });
      }

      // Open the in-place text editor for one inspected text-capable element.
      // `hit` is a runtime hit (or the current selection): the text content is
      // authoritative from the runtime, the element only proves the capability.
      function openEditorForHit(hit) {
        if (canvasPlainObject(hit) === false || typeof hit.stableId !== 'string' || hit.stableId.length === 0) return;
        if (editorRef.current !== null) return;
        const element = elements.find(function same(item) {
          return item.stableId === hit.stableId;
        });
        const capabilities = element !== null && Array.isArray(element.capabilities) ? element.capabilities : [];
        if (capabilities.includes('text') === false) return;
        const rect = canvasValidRect(hit.rect);
        if (rect === null) return;
        setSelectedSafe(hit);
        setPlaying(false);
        void postActiveCommand('pause');
        setEditorNotice(null);
        setEditor({
          stableId: hit.stableId,
          value: typeof hit.text === 'string' ? hit.text : element !== null && typeof element.text === 'string' ? element.text : '',
          rect: rect,
          // `attempt` freezes exactly ONE immutable write request when the user
          // first submits. It stays null while the editor only holds a draft.
          attempt: null,
          error: null,
          refreshRequired: false,
        });
      }

      function openTextEditor() {
        if (selected === null || isTextSelected() === false) return;
        openEditorForHit(selected);
      }

      function pointInsideRect(point, rect) {
        return (
          point !== null &&
          point.x >= rect.x &&
          point.x <= rect.x + rect.width &&
          point.y >= rect.y &&
          point.y <= rect.y + rect.height
        );
      }

      // A real double-click cannot rely on the selection node as its target:
      // beginDrag sets pointer capture on the overlay, so pointerup (and per
      // spec click/dblclick) retarget to the nearest common ancestor, the
      // overlay. Handle the gesture there; keep the selection-node handler as a
      // compatibility path for synthetic events and capture-less browsers.
      function onOverlayDoubleClick(event) {
        if (editorRef.current !== null || drag !== null) return;
        if (
          event !== null &&
          typeof event === 'object' &&
          event.target !== undefined &&
          event.currentTarget !== undefined &&
          event.target !== event.currentTarget
        ) {
          return;
        }
        const point = stagePoint(event);
        if (point === null) return;
        const current = selected;
        const currentRect = current !== null ? canvasValidRect(current.rect) : null;
        if (current !== null && isTextSelected() && currentRect !== null && pointInsideRect(point, currentRect)) {
          openEditorForHit(current);
          return;
        }
        void postActiveCommand('hitTest', point).then(function openOnHit(payload) {
          if (editorRef.current !== null || drag !== null) return;
          openEditorForHit(payload !== null && typeof payload === 'object' && payload.hit ? payload.hit : null);
        });
      }

      function selectionRect() {
        if (drag !== null) return drag.preview;
        return selected === null ? null : selected.rect;
      }

      const selectedBox = selectionRect();
      const selectedScale = scale;

      // One physical iframe per slot: `active` occupies the visible slot and the
      // preloading `candidate` the hidden one. The candidate is mounted at the
      // same composition size so its fixed runtime loads, but is invisible and
      // cannot receive pointer input.
      function slotFrameNode(index) {
        const instance = index === visibleSlot ? active : candidate;
        if (instance === null) return null;
        const visible = index === visibleSlot && active !== null;
        // R2F: size/scale the iframe from ITS OWN metadata so the hidden
        // candidate loads at its own composition viewport without touching the
        // displayed (active) geometry.
        const instanceScale = stageSize.width > 0 && stageSize.height > 0
          ? Math.min(stageSize.width / instance.width, stageSize.height / instance.height)
          : 0;
        return h('iframe', {
          key: 'slot-' + index,
          ref: index === 0 ? iframeRef : slot1Ref,
          className: visible ? 'dv-stage-frame' : 'dv-stage-frame dv-stage-frame-candidate',
          title: t('video.canvas.frameTitle'),
          src: instance.src,
          // The sandbox document must keep its composition viewport: the
          // runtime's hitTest uses the iframe document's CSS pixels, so a
          // letterboxed (smaller) viewport would clip the frame and silently
          // miss composition coordinates beyond it. Keep the element at the
          // composition size and scale the whole element visually instead.
          style: {
            width: instance.width + 'px',
            height: instance.height + 'px',
            transformOrigin: 'top left',
            transform: 'scale(' + (instanceScale > 0 ? instanceScale : 1) + ')',
            visibility: visible ? 'visible' : 'hidden',
            pointerEvents: visible ? 'auto' : 'none',
          },
          'aria-hidden': visible ? 'false' : 'true',
          sandbox: 'allow-scripts',
          allow: 'autoplay *',
          referrerPolicy: 'no-referrer',
          onLoad: function runtimeLoaded() {
            setTimeout(function recoverState() {
              void postSlotCommand(index, 'state');
            }, 120);
          },
        });
      }

      function retryRequestedRevision() {
        // An explicit user retry restarts the automatic-retry allowance.
        const restore = {
          time: timeRef.current,
          stableId: selectedRef.current ? selectedRef.current.stableId : null,
          playing: playingRef.current,
        };
        retryRestoreRef.current = restore;
        attemptRef.current = { revision: targetRevision, attempt: 0 };
        setPreviewAttempt({ revision: targetRevision, attempt: 0 });
        void loadTarget(targetRevision, restore);
      }

      // Compact in-place feedback next to the stage when a candidate revision
      // fails while an active composition is still displayed.
      function previewNoticeNode() {
        if (previewNotice === null) return null;
        return h(
          'div',
          { className: 'dv-preview-notice', role: 'alert', key: 'preview-notice' },
          h('span', { className: 'dv-preview-notice-text' }, errorText(previewNotice, t)),
          h(
            'button',
            { type: 'button', className: 'dv-button dv-button-quiet dv-preview-notice-retry', onClick: retryRequestedRevision },
            t('video.canvas.retry')
          )
        );
      }

      function canvasBody() {
        if (phase === 'error' && active === null) {
          // First load failed: no composition was ever displayed, so the full
          // recoverable error remains the honest state.
          return h(
            'div',
            { className: 'dv-canvas-status', role: 'alert' },
            h('p', null, errorText(frameError || { code: 'E_SNAPSHOT' }, t)),
            h(
              'button',
              {
                type: 'button',
                className: 'dv-button dv-button-quiet',
                onClick: retryRequestedRevision,
              },
              t('video.canvas.retry')
            )
          );
        }
        if ((active === null && candidate === null) || displayWidth === 0 || displayHeight === 0) {
          return h('p', { className: 'dv-canvas-status', role: 'status' }, h('span', { className: 'dv-loader', 'aria-hidden': 'true' }), t('video.canvas.loading'));
        }
        return h(
          'div',
          {
            className: 'dv-stage dv-canvas-stage',
            'data-ready': active !== null ? 'true' : 'false',
            ref: stageRef,
            style: { width: displayWidth + 'px', height: displayHeight + 'px' },
          },
          slotFrameNode(0),
          slotFrameNode(1),
          active === null
            ? h(
                'p',
                { className: 'dv-canvas-status dv-canvas-status-overlay', role: 'status', 'data-overlay': 'true' },
                h('span', { className: 'dv-loader', 'aria-hidden': 'true' }),
                t('video.canvas.loading')
              )
            : null,
          previewOnly
            ? null
            : h(
            'div',
            {
              className: 'dv-overlay',
              ref: overlayRef,
              onClick: onOverlayClick,
              onDoubleClick: onOverlayDoubleClick,
              onPointerMove: onOverlayPointerMove,
              onPointerUp: onOverlayPointerUp,
              onPointerCancel: function cancelPointer() {
                setDrag(null);
              },
            },
            selectedBox !== null
              ? h(
                  'div',
                  {
                    className: 'dv-selection',
                    style: {
                      left: selectedBox.x * selectedScale + 'px',
                      top: selectedBox.y * selectedScale + 'px',
                      width: selectedBox.width * selectedScale + 'px',
                      height: selectedBox.height * selectedScale + 'px',
                    },
                    onPointerDown: function startMove(event) {
                      beginDrag(event, 'move');
                    },
                    onDoubleClick: openTextEditor,
                  },
                  ['nw', 'ne', 'sw', 'se'].map(function handle(position) {
                    return h('span', {
                      key: position,
                      className: 'dv-handle ' + 'dv-handle-' + position,
                      onPointerDown: function startResize(event) {
                        beginDrag(event, position);
                      },
                    });
                  })
                )
              : null,
            editor !== null
              ? h('textarea', {
                  className: 'dv-inline-editor',
                  style: {
                    left: editor.rect.x * selectedScale + 'px',
                    top: editor.rect.y * selectedScale + 'px',
                    width: Math.max(80, editor.rect.width * selectedScale) + 'px',
                    height: Math.max(28, editor.rect.height * selectedScale) + 'px',
                  },
                  value: editor.value,
                  autoFocus: true,
                  onChange: function updateEditor(event) {
                    const nextValue = event.target.value;
                    setEditor(function updateDraft(previous) {
                      if (previous === null) return null;
                      return Object.assign({}, previous, { value: nextValue });
                    });
                  },
                  onKeyDown: function editorKeys(event) {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setEditor(null);
                      setEditorNotice(null);
                    } else if (event.key === 'Enter' && event.shiftKey === false) {
                      event.preventDefault();
                      void submitText();
                    }
                  },
                })
              : null,
            editor !== null && (editor.error !== null || editorNotice !== null || editor.refreshRequired === true)
              ? h(
                  'div',
                  {
                    className: 'dv-editor-actions',
                    style: {
                      left: editor.rect.x * selectedScale + 'px',
                      top: (editor.rect.y + editor.rect.height) * selectedScale + 4 + 'px',
                    },
                  },
                  editor.error !== null ? h('span', { className: 'dv-tool-error', role: 'alert' }, errorText(editor.error, t)) : null,
                  editorNotice !== null ? h('span', { className: 'dv-tool-hint' }, editorNotice) : null,
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dv-button dv-button-quiet dv-editor-retry',
                      onClick: function retryTextSave() {
                        void submitText();
                      },
                      disabled: busy !== null,
                    },
                    t('video.canvas.retryText')
                  )
                )
              : null
          )
        );
      }

      const scene = currentScene();
      return h(
        'section',
        {
          className: 'dv-canvas-shell',
          // Truthful markers: the revision marker names only the ACTIVE displayed
          // composition (empty before the first ready), while the target marker
          // names the requested revision being loaded/pending/failed.
          'data-canvas-revision': active !== null ? active.revision : '',
          'data-canvas-target-revision': targetRevision === null || targetRevision === undefined ? '' : String(targetRevision),
          'data-canvas-phase': phase,
          'data-preview-only': previewOnly ? 'true' : 'false',
          'data-preview-pending': active !== null && active.revision !== targetRevision && previewNotice === null ? 'true' : 'false',
          // P3-017 B1 diagnostics: the current attempt for the target revision and
          // a bounded ring of the most recent attempts (revision:attempt:
          // snapshotMs:readyMs:errorCode separated by "|").
          'data-preview-attempt': (previewAttempt.revision === null ? '' : String(previewAttempt.revision).slice(0, 8) + ':' + String(previewAttempt.attempt)),
          'data-preview-retrying': previewRetrying ? 'true' : 'false',
          'data-preview-diagnostics': previewDiagnosticsText(),
        },
        previewOnly ? h('nav',{className:'dv-resource-bar','aria-label':t('video.canvas.resources')},
          h('button',{type:'button',className:'dv-resource-tab','data-panel-trigger':'media','aria-label':t('video.canvas.materials'),'aria-expanded':drawerOpen?'true':'false',onClick:()=>{setDrawerOpen(!drawerOpen);}},h(StudioIcon,{name:'media'}),h('span',null,t('video.canvas.materials')))
        ) : null,
        h('div', { className: 'dv-canvas-wrap', ref: wrapRef }, canvasBody()),
        previewNoticeNode(),
        active !== null && active.revision !== targetRevision && previewNotice === null ? h('span', { className: 'dv-preview-progress', role: 'status' }, h('span', { className: 'dv-status-dot', 'aria-hidden': 'true' }), t('video.canvas.updatingPreview')) : null,
        h(
          'div',
          { className: 'dv-canvas-bar' },
          h('button', { type: 'button', className: 'dv-button dv-button-quiet dv-play', onClick: togglePlayback, disabled: phase !== 'ready', 'aria-label': playing ? t('video.canvas.pause') : t('video.canvas.play'), title: playing ? t('video.canvas.pause') : t('video.canvas.play') }, h(StudioIcon, { name: playing ? 'pause' : 'play' }), h('span', { className: 'dv-sr-only' }, playing ? t('video.canvas.pause') : t('video.canvas.play'))),
          h(
            'input',
            {
              className: 'dv-seek',
              type: 'range',
              min: '0',
              max: String(displayDuration || 1),
              step: '0.01',
              value: String(Math.min(time, displayDuration || 1)),
              'aria-label': t('video.canvas.timeline'),
              disabled: phase !== 'ready',
              onChange: function seek(event) {
                seekTo(event.target.value);
              },
            }
          ),
          h('span', { className: 'dv-time' }, formatSeconds(time) + ' / ' + formatSeconds(displayDuration)),
          previewOnly ? null : h('button', { type: 'button', className: 'dv-button dv-button-quiet', onClick: function undo() { void historyStep('undo'); }, disabled: busy !== null, title: t('video.canvas.undo') }, t('video.canvas.undo')),
          previewOnly ? null : h('button', { type: 'button', className: 'dv-button dv-button-quiet', onClick: function redo() { void historyStep('redo'); }, disabled: busy !== null, title: t('video.canvas.redo') }, t('video.canvas.redo')),
          previewOnly ? null : h('button',{type:'button',className:'dv-button dv-button-quiet',onClick:()=>setDrawerOpen(!drawerOpen),'aria-expanded':drawerOpen},t('video.canvas.materials')),
          previewOnly ? null : h('button', { type: 'button', className: 'dv-button dv-button-quiet', onClick: function add() { void addScene(); }, disabled: busy !== null }, t('video.canvas.addScene')),
          previewOnly
            ? null
            : exportState && exportState.state === 'ready'
            ? h('a', { className: 'dv-button dv-button-primary dv-export-link', href: exportState.url, download: 'dsh-video.mp4' }, t('video.canvas.download'))
            : h('button', { type: 'button', className: 'dv-button dv-button-primary', onClick: function render() { void exportVideo(); }, disabled: busy !== null }, exportState && exportState.state === 'running' ? t('video.canvas.exporting') : t('video.canvas.export'))
        ),
        previewOnly ? null : h(
          'div',
          { className: 'dv-canvas-tools' },
          scene === null
            ? null
            : h(
                'label',
                { className: 'dv-tool-field' },
                h('span', null, t('video.canvas.sceneColor')),
                h('input', {
                  type: 'color',
                  value: sceneColor,
                  onChange: function pickSceneColor(event) {
                    setSceneColor(event.target.value);
                  },
                }),
                h('button', { type: 'button', className: 'dv-button dv-button-quiet', onClick: function applyScene() { void applySceneColor(); }, disabled: busy !== null }, t('video.canvas.apply'))
              ),
          isTextSelected() && selected !== null
            ? h(
                'div',
                { className: 'dv-tool-field' },
                h('span', null, t('video.canvas.textStyle')),
                h('input', { type: 'color', value: styleColor, onChange: function pickColor(event) { setStyleColor(event.target.value); } }),
                h('input', {
                  className: 'dv-size-input',
                  type: 'number',
                  min: '8',
                  max: '256',
                  step: '1',
                  value: String(styleSize),
                  onChange: function pickSize(event) {
                    setStyleSize(Number(event.target.value));
                  },
                }),
                h('button', { type: 'button', className: 'dv-button dv-button-quiet', onClick: function apply() { void applyStyle(); }, disabled: busy !== null }, t('video.canvas.apply'))
              )
            : h('span', { className: 'dv-tool-hint' }, t('video.canvas.hint')),
          actionError !== null ? h('span', { className: 'dv-tool-error', role: 'alert' }, errorText(actionError, t)) : null,
          busy !== null ? h('span', { className: 'dv-tool-hint' }, t('video.canvas.busy')) : null
        ),
        previewOnly && props.timelineEnabled!==false ? h(TimelinePanel,{key:"timeline:"+projectId,t,projectId,revision:inspected.revision,time,playing,onSeek:seekTo,onScrubStart:()=>{timelineScrubRef.current={held:true};setPlaying(false);void postActiveCommand('pause');},onScrubEnd:value=>{timelineScrubRef.current={held:false,time:value,until:Date.now()+1500};seekTo(value);},onReload,assetToAdd,onAssetConsumed:()=>setAssetToAdd(null),onQueueAsset:setAssetToAdd}) : null,
        drawerOpen && previewOnly ? h(MediaLibraryPanel,{key:"media:"+projectId,t:t,projectId:projectId,onClose:()=>setDrawerOpen(false),onAdd:asset=>{setAssetToAdd(asset);setDrawerOpen(false);}}) : null,
        drawerOpen && previewOnly === false
          ? h(
              'aside',
              { className: 'dv-drawer', 'aria-label': t('video.canvas.materials') },
              h(
                'div',
                { className: 'dv-drawer-head' },
                h('span', null, t('video.canvas.materials')),
                h('button', { type: 'button', className: 'dv-icon-button', onClick: function close() { setDrawerOpen(false); }, 'aria-label': t('video.canvas.close') }, '×')
              ),
              h(
                'label',
                { className: 'dv-upload' },
                uploadBusy ? t('video.canvas.uploading') : t('video.canvas.upload'),
                h('input', { type: 'file', accept: 'image/png,image/jpeg', onChange: uploadImage, disabled: uploadBusy })
              ),
              images.length === 0
                ? h('p', { className: 'dv-tool-hint' }, t('video.canvas.noAssets'))
                : h(
                    'ul',
                    { className: 'dv-asset-list' },
                    images.map(function assetRow(file) {
                      return h(
                        'li',
                        { key: file.path, className: 'dv-asset-row' },
                        h('span', { className: 'dv-asset-name', title: file.path }, file.path.split('/').pop()),
                        h('button', { type: 'button', className: 'dv-button dv-button-quiet', onClick: function use() { void useAsset(file.path); }, disabled: busy !== null }, t('video.canvas.useAsset'))
                      );
                    })
                  )
            )
          : null
      );
    }
    //#endregion

    function VideoWorkspace(props) {
      const t = props.t;
      const onBack = props.onBack;
      const sessions = props.sessions !== undefined && props.sessions !== null ? props.sessions : null;
      const layout = props.layout !== undefined && props.layout !== null ? props.layout : null;
      const sessionKitAvailable = typeof props.SessionProvider === 'function' && typeof props.renderFactorySlot === 'function';
      const ui = usePluginState();
      // P3-016 resizable right pane: a reflected inline CSS variable; pointer
      // and keyboard updates never touch project/revision authority.
      const [aiPaneRatio, setAiPaneRatio] = React.useState(readAiPaneRatio);
      // M1-05: Host ui-state (last project / layout) + visible save status.
      const [uiStateSupported, setUiStateSupported] = React.useState(true);
      const [saveStatus, setSaveStatus] = React.useState('idle');
      const [saveRetryToken, setSaveRetryToken] = React.useState(0);
      const aiPaneRatioRef = React.useRef(aiPaneRatio);
      aiPaneRatioRef.current = aiPaneRatio;
      const [resizing, setResizing] = React.useState(false);
      const dragRef = React.useRef(null);
      const mainRef = React.useRef(null);
      // P3-016: the work name is the inline-rename trigger; the arrow opens the
      // project picker so clicking the name can never silently switch projects.
      const [projectMenuOpen, setProjectMenuOpen] = React.useState(false);
      const [renameDraft, setRenameDraft] = React.useState(null);
      const [renameBusy, setRenameBusy] = React.useState(false);
      const [renameError, setRenameError] = React.useState(null);
      const [folderBusy, setFolderBusy] = React.useState(null);
      const [folderNotice, setFolderNotice] = React.useState(null);
      const projectToggleRef = React.useRef(null);
      const projectItemRef = React.useRef(null);
      const projectNameRef = React.useRef(null);
      const renameInputRef = React.useRef(null);
      const focusNameAfterRenameRef = React.useRef(false);

      // Panel-switch memory keeps only the visible view: the Host worker stays the
      // authority for project/revision/session truth. On a later mount the
      // remembered project is re-validated against `project.list` before it opens.
      const remembered = editorMemory === null ? {} : editorMemory;
      const [project, setProject] = React.useState(remembered.project || null);
      const [boot, setBoot] = React.useState('idle');
      const [error, setError] = React.useState(remembered.error || null);
      const [projectId, setProjectId] = React.useState(typeof remembered.projectId === 'string' ? remembered.projectId : '');
      const [projectChoices, setProjectChoices] = React.useState([]);
      const projectTitlesRef = React.useRef(new Map(Array.isArray(remembered.projectTitles) ? remembered.projectTitles : []));
      if (project !== null && projectId !== '') {
        projectTitlesRef.current.set(projectId, studioProjectTitle(project, t('video.project.untitled')));
        if (projectTitlesRef.current.size > 64) projectTitlesRef.current.delete(projectTitlesRef.current.keys().next().value);
      }
      const [projectBusy, setProjectBusy] = React.useState(null);
      const projectIdRef = React.useRef(projectId);
      projectIdRef.current = projectId;
      const latestRevisionRef = React.useRef(remembered.project && typeof remembered.project.revision === 'string' ? remembered.project.revision : null);
      if (project !== null && typeof project.revision === 'string') latestRevisionRef.current = project.revision;
      const [sessionState, setSessionState] = React.useState(remembered.sessionState || { status: 'idle', items: [], activeSessionId: null, error: null });
      const [activeSessionId, setActiveSessionId] = React.useState(typeof remembered.activeSessionId === 'string' ? remembered.activeSessionId : null);
      const [sessionBusy, setSessionBusy] = React.useState(null);
      const [historyOpen, setHistoryOpen] = React.useState(false);
      const [referencesOpen,setReferencesOpen]=React.useState(false);
      const [settingsOpen,setSettingsOpen]=React.useState(false);
      const [hostConversationOpen, setHostConversationOpen] = React.useState(false);
      const [retryTick, setRetryTick] = React.useState(0);
      const [sessionDiagnostic, setSessionDiagnostic] = React.useState(null);
      const [preview, setPreview] = React.useState(null);
      const previewToken = React.useRef(0);
      const activeSessionIdRef = React.useRef(null);
      activeSessionIdRef.current = activeSessionId;
      const sessionListToken = React.useRef(0);
      const sessionSwitchToken = React.useRef(0);
      const sessionCreatePending = React.useRef(false);
      const aliveRef = React.useRef(true);
      // P3-017 B3 product export: one render bound to the revision inspected when
      // the button was pressed. Later AI publishes never change what is exported;
      // the worker's real stage/progress feed the visible progress text, and the
      // elapsed time is derived from the real start timestamp.
      const [exportState, setExportState] = React.useState(null);
      const [exportElapsed, setExportElapsed] = React.useState(0);
      const exportToken = React.useRef(0);
      const exportStateRef = React.useRef(null);
      exportStateRef.current = exportState;
      // Synchronous in-flight gate: two clicks in the same tick cannot both pass
      // the state check before the first render (state itself is async).
      const exportInFlightRef = React.useRef(false);
      const exportRunning = exportState !== null && exportState.phase === 'running';
      const bootToken = React.useRef(0);
      const bootStarted = React.useRef(false);
      const autoProvisionedRef = React.useRef(false);
      const autoSessionProjectRef = React.useRef(null);
      const sessionListSnapshot = useSessionListSnapshot(sessions);

      React.useEffect(
        function keepAlive() {
          aliveRef.current = true;
          return function cleanupWorkspace() {
            aliveRef.current = false;
            // Never leave a render job running with no UI left to cancel it.
            exportInFlightRef.current = false;
            const current = exportStateRef.current;
            if (current !== null && current.phase === 'running' && typeof current.jobId === 'string') {
              hostRequest('cancel', { jobId: current.jobId }).catch(function ignoreExportCancel() {});
            }
          };
        },
        []
      );

      // Advance the elapsed label while a render is running; the interval only
      // re-renders the label and stops with the terminal state.
      React.useEffect(
        function tickExportElapsed() {
          if (exportRunning === false) return function noExportTick() {};
          const startedAt = exportState === null || !Number.isFinite(exportState.startedAt) ? Date.now() : exportState.startedAt;
          setExportElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
          const timer = setInterval(function tickElapsed() {
            const current = exportStateRef.current;
            if (current === null || current.phase !== 'running') return;
            setExportElapsed(Math.max(0, Math.floor((Date.now() - current.startedAt) / 1000)));
          }, 1000);
          return function stopExportTick() {
            clearInterval(timer);
          };
        },
        [exportRunning]
      );

      // The host main conversation is outside this panel; when it is the visible
      // main panel we must not mount a second editable root for the same
      // Session. Subscribe instead of checking once: the host panel can change
      // while the plugin stays mounted in its declaration lifetime.
      React.useEffect(
        function watchHostConversation() {
          if (layout === null || typeof layout !== 'object' || !layout.panelInfo || typeof layout.panelInfo.getSnapshot !== 'function') {
            return function noPanelInfo() {};
          }
          function readPanelInfo() {
            try {
              const snapshot = layout.panelInfo.getSnapshot();
              setHostConversationOpen(Boolean(snapshot && snapshot.activePanelId === 'conversation'));
            } catch (_error) {
              /* the host panel source is advisory; embedding still needs the reference */
            }
          }
          readPanelInfo();
          let unsubscribe = null;
          if (typeof layout.panelInfo.subscribe === 'function') {
            try {
              unsubscribe = layout.panelInfo.subscribe(readPanelInfo);
            } catch (_error) {
              unsubscribe = null;
            }
          }
          return function stopPanelInfo() {
            if (typeof unsubscribe !== 'function') return;
            try {
              unsubscribe();
            } catch (_error) {
              /* observed source cleanup is best effort */
            }
          };
        },
        []
      );

      // Conversation-first boot: one `project.list` decides whether the
      // remembered / most recent managed project opens or a first project is
      // provisioned. The guard ref keeps a re-rendered effect from issuing the
      // creation pair twice.
      React.useEffect(
        function prepareWorkspace() {
          if (bootStarted.current) return;
          bootStarted.current = true;
          void bootstrap();
        },
        []
      );

      // Read-only installation preflight: kit presence is checked locally and
      // the Host reports only safe status/version facts (no messages, titles or
      // credentials). It never enables anything; failures stay advisory.
      React.useEffect(
        function diagnoseCreationSessions() {
          void diagnoseSessions();
        },
        []
      );

      // Automatic preview follow: while a project is loaded the panel polls the
      // worker revision (exactly like the Host reports it) and swaps in the new
      // snapshot. This is the only UI-side trigger for a publish: an AI Tool
      // `project.compose` appears here without a manual refresh.
      React.useEffect(
        function followPublishedRevision() {
          const followedProjectId = projectId;
          if (typeof followedProjectId !== 'string' || followedProjectId.length === 0 || project === null) return function noRevisionPoll() {};
          let cancelled = false;
          async function inspectCurrent() {
            let next;
            try {
              next = await hostRequest('inspect', { projectId: followedProjectId });
            } catch (_pollError) {
              /* A transient poll failure keeps the last valid preview mounted. */
              return;
            }
            // Late responses may only update the same project this poll belongs
            // to; a stale project's result can never overwrite the current one.
            if (cancelled || !aliveRef.current || projectIdRef.current !== followedProjectId) return;
            if (next === null || typeof next !== 'object' || typeof next.revision !== 'string') return;
            if (next.revision !== latestRevisionRef.current) {
              latestRevisionRef.current = next.revision;
              setProject(next);
            }
          }
          void inspectCurrent();
          const timer = setInterval(function pollRevision() {
            void inspectCurrent();
          }, REVISION_POLL_MS);
          return function stopRevisionPoll() {
            cancelled = true;
            clearInterval(timer);
          };
        },
        [projectId, project === null]
      );

      // A panel switch is a view switch: the worker keeps the project and the
      // mapped Sessions, and this memory restores the visible view instead of
      // silently clearing progress.
      React.useEffect(function rememberVisibleState() {
        editorMemory = {
          project: project,
          error: error,
          projectId: projectId,
          projectTitles: Array.from(projectTitlesRef.current.entries()),
          sessionState: sessionState,
          activeSessionId: activeSessionId,
        };
      });

      // M1-05: Host ui-state writes are scheduled imperatively by the event that
      // changed the state (no effect churn). The save indicator stays visible;
      // an older Host without ui-state degrades silently to local view memory.
      const uiStateSupportedRef = React.useRef(true);
      const lastProjectSaveTimer = React.useRef(null);
      const paneRatioSaveTimer = React.useRef(null);
      const lastWrittenProjectId = React.useRef('');

      function markUiStateSupport(value) {
        uiStateSupportedRef.current = value;
        setUiStateSupported(value);
      }

      function classifyUiStateError(error) {
        const code = error && error.code;
        if (code === 'E_METHOD' || code === 'E_UI_STATE_CONFIG' || code === 'E_CONFIGURATION' || code === 'E_UI_STATE_UNAVAILABLE') {
          markUiStateSupport(false);
          return 'unsupported';
        }
        return 'failed';
      }

      function scheduleLastProjectWrite(targetProjectId) {
        if (typeof targetProjectId !== 'string' || targetProjectId === '') return;
        if (uiStateSupportedRef.current === false) return;
        if (lastWrittenProjectId.current === targetProjectId) return;
        lastWrittenProjectId.current = targetProjectId;
        if (lastProjectSaveTimer.current !== null) clearTimeout(lastProjectSaveTimer.current);
        setSaveStatus('saving');
        lastProjectSaveTimer.current = setTimeout(function writeLastProject() {
          lastProjectSaveTimer.current = null;
          hostRequest('ui.state.set', { patch: { lastProjectId: targetProjectId } }).then(
            function saved() {
              if (aliveRef.current) setSaveStatus('saved');
            },
            function failed(error) {
              if (!aliveRef.current) return;
              const kind = classifyUiStateError(error);
              setSaveStatus(kind === 'unsupported' ? 'idle' : 'failed');
            }
          );
        }, 250);
      }

      function schedulePaneRatioWrite(ratio) {
        if (uiStateSupportedRef.current === false) return;
        if (typeof ratio !== 'number' || Number.isFinite(ratio) === false) return;
        if (paneRatioSaveTimer.current !== null) clearTimeout(paneRatioSaveTimer.current);
        paneRatioSaveTimer.current = setTimeout(function writeLayout() {
          paneRatioSaveTimer.current = null;
          hostRequest('ui.state.set', { patch: { layout: { aiPaneRatio: ratio } } }).catch(function failed(error) {
            if (aliveRef.current) classifyUiStateError(error);
          });
        }, 400);
      }

      function retrySaveLastProject() {
        if (saveStatus !== 'failed') return;
        setSaveStatus('saving');
        const target = projectIdRef.current;
        if (typeof target !== 'string' || target === '') {
          setSaveStatus('idle');
          return;
        }
        lastWrittenProjectId.current = '';
        scheduleLastProjectWrite(target);
      }

      // Focus management for the project picker menu: opening moves focus onto
      // the current project item; Escape/Tab close it and return focus to the
      // arrow button (never left on the removed node). Only element-level
      // handlers are used, so unmount cannot leak a global listener.
      React.useEffect(
        function focusOpenProjectItem() {
          if (!projectMenuOpen || projectItemRef.current === null || typeof projectItemRef.current.focus !== 'function') return;
          try {
            projectItemRef.current.focus();
          } catch (_error) {
            /* focus is best-effort; the menu stays usable */
          }
        },
        [projectMenuOpen]
      );

      // Inline rename: focus (and select) the input when it appears.
      React.useEffect(
        function focusRenameInput() {
          if (renameDraft === null || renameInputRef.current === null) return;
          try {
            renameInputRef.current.focus();
            if (typeof renameInputRef.current.select === 'function') renameInputRef.current.select();
          } catch (_error) {
            /* focus is best-effort; the input stays usable */
          }
        },
        [renameDraft === null]
      );
      // After a save/cancel settles, focus goes back to the name button once the
      // input has been removed from the tree.
      React.useEffect(function restoreNameFocus() {
        if (focusNameAfterRenameRef.current === false || renameDraft !== null) return;
        focusNameAfterRenameRef.current = false;
        try {
          if (projectNameRef.current !== null && typeof projectNameRef.current.focus === 'function') {
            projectNameRef.current.focus();
          }
        } catch (_error) {
          /* focus is best-effort */
        }
      });

      function focusProjectToggle() {
        try {
          if (projectToggleRef.current !== null && typeof projectToggleRef.current.focus === 'function') {
            projectToggleRef.current.focus();
          }
        } catch (_error) {
          /* focus is best-effort; the menu is already closed */
        }
      }

      function closeProjectMenu() {
        setProjectMenuOpen(false);
        focusProjectToggle();
      }

      function toggleProjectMenu() {
        if (projectMenuOpen) {
          closeProjectMenu();
        } else {
          setFolderNotice(null);
          setProjectMenuOpen(true);
        }
      }

      function onProjectToggleKeyDown(event) {
        if (!event) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!projectMenuOpen) {
            setProjectMenuOpen(true);
            return;
          }
          if (projectItemRef.current !== null && typeof projectItemRef.current.focus === 'function') {
            projectItemRef.current.focus();
          }
        } else if (event.key === 'Escape' && projectMenuOpen) {
          event.preventDefault();
          closeProjectMenu();
        }
      }

      function onProjectMenuKeyDown(event) {
        if (!event) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          closeProjectMenu();
        } else if (event.key === 'Tab') {
          event.preventDefault();
          closeProjectMenu();
        }
      }

      // ── P3-016 inline project rename (presentation metadata only) ─────────
      function projectDisplayTitle() {
        return studioProjectTitle(project, t('video.project.untitled'));
      }

      function projectChoiceTitle(item, index) {
        if (item !== null && typeof item === 'object' && typeof item.title === 'string') {
          const stored = item.title.trim();
          if (stored.length > 0) return stored.slice(0, 120);
        }
        const rememberedTitle = item !== null && typeof item === 'object'
          ? projectTitlesRef.current.get(item.projectId)
          : null;
        if (typeof rememberedTitle === 'string' && rememberedTitle.length > 0) return rememberedTitle;
        return t('video.project.untitled') + (typeof index === 'number' ? ' ' + String(index + 1) : '');
      }

      function startRename() {
        if (renameBusy || projectBusy !== null || projectId === '') return;
        setProjectMenuOpen(false);
        setRenameError(null);
        setRenameDraft(projectDisplayTitle());
      }

      function cancelRename() {
        setRenameDraft(null);
        setRenameError(null);
        focusNameAfterRenameRef.current = true;
      }

      function onRenameChange(event) {
        const raw = event !== null && event.target !== undefined ? event.target.value : '';
        setRenameDraft(typeof raw === 'string' ? raw : '');
        if (renameError !== null) setRenameError(null);
      }

      function onRenameKeyDown(event) {
        if (!event) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          void submitRename();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelRename();
        }
      }

      async function submitRename() {
        if (renameBusy || renameDraft === null) return;
        const title = renameDraft.trim();
        if (title.length === 0) {
          setRenameError(t('video.project.renameEmpty'));
          return;
        }
        if (projectIdRef.current === '' || title === projectDisplayTitle()) {
          cancelRename();
          return;
        }
        setRenameBusy(true);
        setRenameError(null);
        const targetId = projectIdRef.current;
        try {
          const renamed = await hostRequest('project.rename', { projectId: targetId, title: title });
          if (!aliveRef.current) return;
          const renamedTitle = renamed !== null && typeof renamed === 'object' && typeof renamed.title === 'string' && renamed.title.length > 0
            ? renamed.title
            : title;
          setProject(function applyRenamedTitle(previous) {
            return previous === null || typeof previous !== 'object'
              ? previous
              : Object.assign({}, previous, { title: renamedTitle });
          });
          projectTitlesRef.current.set(targetId, renamedTitle);
          setProjectChoices(function applyRenamedChoice(list) {
            return list.map(function updateChoice(item) {
              return item !== null && typeof item === 'object' && item.projectId === targetId
                ? Object.assign({}, item, { title: renamedTitle })
                : item;
            });
          });
          setRenameDraft(null);
          focusNameAfterRenameRef.current = true;
        } catch (_error) {
          // Keep the draft and show a localized failure; the next Enter retries.
          if (aliveRef.current) setRenameError(t('video.project.renameFailed'));
        } finally {
          if (aliveRef.current) setRenameBusy(false);
        }
      }

      // ── P3-016 draggable split between stage and AI pane ──────────────────
      function setPaneRatio(next) {
        aiPaneRatioRef.current = next;
        setAiPaneRatio(next);
      }

      function onSplitterPointerDown(event) {
        const main = mainRef.current;
        if (main === null || typeof main.getBoundingClientRect !== 'function') return;
        const rect = main.getBoundingClientRect();
        if (!(Number(rect.width) > 0)) return;
        dragRef.current = { containerWidth: rect.width, right: rect.left + rect.width };
        setResizing(true);
        if (event === null || typeof event !== 'object') return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        const target = event.currentTarget;
        if (target !== null && target !== undefined && typeof target.setPointerCapture === 'function' && event.pointerId !== undefined) {
          try {
            target.setPointerCapture(event.pointerId);
          } catch (_error) {
            /* pointer capture is an enhancement; the drag still works */
          }
        }
      }

      function onSplitterPointerMove(event) {
        const drag = dragRef.current;
        if (drag === null || event === null || typeof event !== 'object') return;
        const pointerX = Number(event.clientX);
        if (Number.isFinite(pointerX) === false) return;
        const width = clampAiPaneWidth(drag.right - pointerX, drag.containerWidth);
        setPaneRatio(normalizeAiPaneRatio(width / drag.containerWidth));
      }

      function onSplitterPointerUp(event) {
        if (dragRef.current === null) return;
        dragRef.current = null;
        setResizing(false);
        if (event !== null && typeof event === 'object') {
          const target = event.currentTarget;
          if (target !== null && target !== undefined && typeof target.releasePointerCapture === 'function' && event.pointerId !== undefined) {
            try {
              target.releasePointerCapture(event.pointerId);
            } catch (_error) {
              /* capture cleanup is best effort */
            }
          }
        }
        writeLayoutPrefs(aiPaneRatioRef.current);
        schedulePaneRatioWrite(aiPaneRatioRef.current);
      }

      function resetAiPaneRatio() {
        setPaneRatio(AI_PANE_DEFAULT_RATIO);
        writeLayoutPrefs(AI_PANE_DEFAULT_RATIO);
        schedulePaneRatioWrite(AI_PANE_DEFAULT_RATIO);
      }

      function onSplitterKeyDown(event) {
        if (!event) return;
        let next = null;
        if (event.key === 'ArrowLeft') next = stepAiPaneRatio(aiPaneRatioRef.current, AI_PANE_KEYBOARD_STEP);
        else if (event.key === 'ArrowRight') next = stepAiPaneRatio(aiPaneRatioRef.current, -AI_PANE_KEYBOARD_STEP);
        else if (event.key === 'Home') next = AI_PANE_DEFAULT_RATIO;
        if (next === null) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        setPaneRatio(next);
        writeLayoutPrefs(next);
        schedulePaneRatioWrite(next);
      }

      /** Managed projects only: demo/legacy entries never reach the product UI. */
      function managedProjectChoices(result) {
        const list = result !== null && typeof result === 'object' && Array.isArray(result.projects) ? result.projects : [];
        const seen = new Set();
        const choices = [];
        for (const entry of list) {
          if (entry === null || typeof entry !== 'object') continue;
          const id = entry.projectId;
          if (typeof id !== 'string' || id.length === 0 || id === DEMO_PROJECT_ID || seen.has(id)) continue;
          seen.add(id);
          const updatedAt = Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : 0;
          // P3-016: optional host-reported display title; null keeps the
          // remembered/content-derived fallback for legacy projects.
          const title = typeof entry.title === 'string' && entry.title.trim().length > 0
            ? entry.title.trim().slice(0, 120)
            : null;
          choices.push({ projectId: id, updatedAt: updatedAt, title: title });
        }
        choices.sort(function recentFirst(left, right) {
          if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
          if (left.projectId === right.projectId) return 0;
          return left.projectId < right.projectId ? -1 : 1;
        });
        return choices;
      }

      async function refreshProjectChoices() {
        try {
          const result = await hostRequest('project.list', {});
          if (!aliveRef.current) return null;
          const items = managedProjectChoices(result);
          setProjectChoices(items);
          return items;
        } catch (_error) {
          /* the project list is advisory; the canvas state reports real errors */
          return null;
        }
      }

      async function bootstrap() {
        const token = ++bootToken.current;
        setBoot('loading');
        setError(null);
        // M1-05: the Host is authoritative for the last opened project and the
        // pane ratio; an older Host without ui-state falls back to the in-memory
        // view memory / localStorage silently.
        let restored = null;
        try {
          restored = await hostRequest('ui.state.get', {});
        } catch (_restoreError) {
          restored = null;
        }
        if (!aliveRef.current || token !== bootToken.current) return;
        if (restored !== null && typeof restored === 'object') {
          markUiStateSupport(true);
          if (restored.layout !== null && typeof restored.layout === 'object' && typeof restored.layout.aiPaneRatio === 'number') {
            try {
              setAiPaneRatio(normalizeAiPaneRatio(restored.layout.aiPaneRatio));
            } catch (_ratioError) {
              /* an invalid persisted ratio keeps the local preference */
            }
          }
        } else {
          markUiStateSupport(false);
        }
        const restoredLastProjectId = restored !== null && typeof restored === 'object' && typeof restored.lastProjectId === 'string'
          ? restored.lastProjectId
          : '';
        let listed = null;
        try {
          listed = await hostRequest('project.list', {});
        } catch (listError) {
          if (!aliveRef.current || token !== bootToken.current) return;
          setBoot('error');
          setError(hostError(listError));
          return;
        }
        if (!aliveRef.current || token !== bootToken.current) return;
        const choices = managedProjectChoices(listed);
        setProjectChoices(choices);
        const memoryId = typeof projectIdRef.current === 'string' && projectIdRef.current.length > 0 && projectIdRef.current !== DEMO_PROJECT_ID
          ? projectIdRef.current
          : '';
        const rememberedId = memoryId !== ''
          ? memoryId
          : (restoredLastProjectId !== '' && restoredLastProjectId !== DEMO_PROJECT_ID ? restoredLastProjectId : '');
        const rememberedAvailable = rememberedId !== '' && choices.some(function known(item) {
          return item.projectId === rememberedId;
        });
        let targetId = rememberedAvailable ? rememberedId : '';
        if (targetId === '' && listed !== null && typeof listed === 'object' && typeof listed.defaultProjectId === 'string') {
          const fromHost = choices.find(function hostDefault(item) {
            return item.projectId === listed.defaultProjectId;
          });
          if (fromHost !== undefined) targetId = fromHost.projectId;
        }
        if (targetId === '' && choices.length > 0) targetId = choices[0].projectId;
        if (targetId !== '') {
          await openProject(targetId, token);
          return;
        }
        await provisionProject(token);
      }

      function retryBoot() {
        autoProvisionedRef.current = false;
        void bootstrap();
      }

      async function provisionProject(token) {
        if (autoProvisionedRef.current) return;
        autoProvisionedRef.current = true;
        setProjectBusy('create');
        setError(null);
        try {
          const created = await hostRequest('project.create', {
            templateId: 'blank-v1',
            title: t('video.project.untitled'),
          });
          if (!aliveRef.current || token !== bootToken.current) return;
          autoSessionProjectRef.current = null;
          await openProject(created.projectId, token);
        } catch (createError) {
          autoProvisionedRef.current = false;
          if (!aliveRef.current || token !== bootToken.current) return;
          setBoot('error');
          setError(hostError(createError));
        } finally {
          if (aliveRef.current && token === bootToken.current) setProjectBusy(null);
        }
      }

      async function createManagedProject() {
        if (projectBusy !== null) return;
        const token = ++bootToken.current;
        autoProvisionedRef.current = true;
        setProjectBusy('create');
        setError(null);
        setBoot('loading');
        try {
          const created = await hostRequest('project.create', {
            templateId: 'blank-v1',
            title: t('video.project.untitled'),
          });
          if (!aliveRef.current || token !== bootToken.current) return;
          autoSessionProjectRef.current = null;
          await openProject(created.projectId, token);
          await refreshProjectChoices();
        } catch (createError) {
          if (!aliveRef.current || token !== bootToken.current) return;
          setBoot('error');
          setError(hostError(createError));
        } finally {
          if (aliveRef.current && token === bootToken.current) setProjectBusy(null);
        }
      }

      async function openProject(nextProjectId, token) {
        if (typeof nextProjectId !== 'string' || nextProjectId.length === 0) return;
        const activeToken = token === undefined ? ++bootToken.current : token;
        setBoot('loading');
        setError(null);
        setProjectBusy('open');
        // A project switch discards any in-flight title draft and picker menu.
        setRenameDraft(null);
        setRenameError(null);
        setProjectMenuOpen(false);
        try {
          const opened = await hostRequest('open', { projectId: nextProjectId });
          if (!aliveRef.current || activeToken !== bootToken.current) return;
          const inspected = await hostRequest('inspect', { projectId: opened.projectId });
          if (!aliveRef.current || activeToken !== bootToken.current) return;
          latestRevisionRef.current = typeof inspected.revision === 'string' ? inspected.revision : null;
          projectIdRef.current = opened.projectId;
          setProjectId(opened.projectId);
          lastWrittenProjectId.current = '';
          scheduleLastProjectWrite(opened.projectId);
          setProject(inspected);
          setBoot('ready');
          setActiveSessionId(null);
          setSessionState({ status: 'loading', items: [], activeSessionId: null, error: null });
          previewToken.current += 1;
          setPreview(null);
          const listedSessions = await loadSessionsFor(opened.projectId);
          if (!aliveRef.current || activeToken !== bootToken.current) return;
          await ensureProjectSession(opened.projectId, listedSessions);
          if (!aliveRef.current || activeToken !== bootToken.current) return;
          await refreshProjectChoices();
        } catch (openError) {
          if (!aliveRef.current || activeToken !== bootToken.current) return;
          setBoot('error');
          setError(hostError(openError));
        } finally {
          if (aliveRef.current && activeToken === bootToken.current) setProjectBusy(null);
        }
      }

      // A project without any mapped creation Session gets one automatically so a
      // first-time user lands directly in a working conversation. Once per
      // project: the guard survives re-renders and the Host also dedupes the
      // requestId, and a failed attempt resets the guard so retry can work.
      async function ensureProjectSession(targetProjectId, listedSessions) {
        if (sessionKitAvailable === false) return null;
        if (sessions === null || typeof sessions.retain !== 'function') return null;
        if (autoSessionProjectRef.current === targetProjectId) return null;
        const items = listedSessions !== null && listedSessions !== undefined && Array.isArray(listedSessions.sessions) ? listedSessions.sessions : null;
        if (items === null || items.length > 0) return null;
        if (listedSessions !== null && listedSessions !== undefined && typeof listedSessions.activeSessionId === 'string') return null;
        autoSessionProjectRef.current = targetProjectId;
        const created = await createSessionForProject(targetProjectId);
        if (created === null) autoSessionProjectRef.current = null;
        return created;
      }

      async function createSessionForProject(targetProjectId) {
        // A second click may arrive before React re-renders the disabled button;
        // the synchronous ref keeps creation single-flight in the interim.
        if (sessionCreatePending.current) return null;
        if (sessionKitAvailable === false) return null;
        sessionCreatePending.current = true;
        setSessionBusy('create');
        setError(null);
        try {
          const created = await hostRequest('session.create', { projectId: targetProjectId, requestId: operationId() });
          if (!aliveRef.current || projectIdRef.current !== targetProjectId) return null;
          const listed = await loadSessionsFor(targetProjectId);
          if (!aliveRef.current || projectIdRef.current !== targetProjectId) return null;
          const fallback = listed !== null && listed !== undefined && typeof listed.activeSessionId === 'string' ? listed.activeSessionId : null;
          previewToken.current += 1;
          setPreview(null);
          setActiveSessionId(typeof created.sessionId === 'string' ? created.sessionId : fallback);
          setHistoryOpen(false);
          return created;
        } catch (createError) {
          if (aliveRef.current) setError(hostError(createError));
          return null;
        } finally {
          sessionCreatePending.current = false;
          if (aliveRef.current) setSessionBusy(null);
        }
      }

      async function reloadCanvasProject() {
        const next = await hostRequest('inspect', { projectId: projectIdRef.current });
        if (aliveRef.current) setProject(next);
        return next;
      }

      // ---- P3-017 B3 product export ------------------------------------------
      function exportStageText(stage) {
        if (stage === 'snapshot') return t('video.export.stage.snapshot');
        if (stage === 'engine') return t('video.export.stage.engine');
        if (stage === 'capture') return t('video.export.stage.capture');
        if (stage === 'validate' || stage === 'sheet') return t('video.export.stage.validate');
        if (stage === 'finished') return t('video.export.stage.finished');
        return t('video.export.stage.queued');
      }

      // Presentation-only filename: the project title is already the honest name
      // shown in the UI (there is no separate title API in this branch). Unsafe
      // filesystem characters are stripped; a stable fallback is always used.
      function exportProductFileName() {
        const title = studioProjectTitle(project, t('video.project.untitled'));
        const safe = String(title).replace(/[\\/:*?"<>|]/g, ' ').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
        return (safe.length > 0 ? safe : 'dsh-video') + '.mp4';
      }

      function delayExportPoll(milliseconds) {
        return new Promise(function wait(resolve) {
          setTimeout(resolve, milliseconds);
        });
      }

      async function exportProductVideo() {
        if (project === null || projectIdRef.current === '') return;
        const current = exportStateRef.current;
        // One in-flight export only: a double click cannot start a second render.
        if (exportInFlightRef.current === true) return;
        if (current !== null && current.phase === 'running') return;
        const revisionAtClick = typeof project.revision === 'string' ? project.revision : null;
        if (revisionAtClick === null) return;
        exportInFlightRef.current = true;
        const token = ++exportToken.current;
        const startedAt = Date.now();
        setExportElapsed(0);
        setExportState({
          phase: 'running',
          jobId: null,
          revision: revisionAtClick,
          stage: 'queued',
          progress: 0,
          startedAt: startedAt,
          fileName: exportProductFileName(),
          error: null,
          cancelling: false,
        });
        function settleFailure(code) {
          if (exportToken.current !== token || !aliveRef.current) return;
          exportInFlightRef.current = false;
          setExportState(function keepFailure(previous) {
            if (previous === null) return previous;
            if (code === 'E_CANCELLED') {
              return Object.assign({}, previous, { phase: 'cancelled', error: null, cancelling: false });
            }
            return Object.assign({}, previous, { phase: 'error', error: code, cancelling: false });
          });
        }
        let job;
        try {
          job = await hostRequest('render', {
            projectId: projectIdRef.current,
            revision: revisionAtClick,
            timeoutMs: Math.min(21600000,Math.max(PRODUCT_RENDER_TIMEOUT_MS,60000+140*Math.round((project?.duration||0)*30))),
          });
        } catch (error) {
          settleFailure(error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'E_RENDER');
          return;
        }
        if (exportToken.current !== token || !aliveRef.current) return;
        if (job === null || typeof job !== 'object' || typeof job.jobId !== 'string') {
          settleFailure('E_RENDER');
          return;
        }
        const jobId = job.jobId;
        setExportState(function attachJob(previous) {
          if (previous === null) return previous;
          return Object.assign({}, previous, {
            jobId: jobId,
            stage: typeof job.stage === 'string' ? job.stage : 'queued',
            progress: Number.isFinite(job.progress) ? job.progress : 0,
          });
        });
        const deadline = startedAt + Math.max(PRODUCT_EXPORT_DEADLINE_MS,120000+140*Math.round((project?.duration||0)*30));
        let result = job;
        let consecutiveStatusErrors = 0;
        while (isTerminalJob(result) === false && Date.now() < deadline) {
          await delayExportPoll(PRODUCT_EXPORT_POLL_MS);
          if (exportToken.current !== token || !aliveRef.current) return;
          try {
            result = await hostRequest('status', { jobId: jobId });
            consecutiveStatusErrors = 0;
          } catch (_statusError) {
            // A transient status failure must not kill a minutes-long render; a
            // sustained failure does (the worker deadline still bounds the job).
            consecutiveStatusErrors += 1;
            if (consecutiveStatusErrors >= 5) {
              settleFailure('E_RENDER');
              return;
            }
            continue;
          }
          if (exportToken.current !== token || !aliveRef.current) return;
          // Exact binding: the job must still describe the revision captured when
          // the export started; anything else is treated as a failed export.
          if (result === null || typeof result !== 'object' || result.jobId !== jobId || result.revision !== revisionAtClick) {
            settleFailure('E_RENDER');
            return;
          }
          setExportState(function updateExportProgress(previous) {
            if (previous === null || previous.phase !== 'running') return previous;
            return Object.assign({}, previous, {
              stage: typeof result.stage === 'string' ? result.stage : previous.stage,
              progress: Number.isFinite(result.progress) ? result.progress : previous.progress,
            });
          });
        }
        if (isTerminalJob(result) === false) {
          // Client safety net above the Host limit: stop the job instead of
          // leaving it running with no owner.
          try {
            await hostRequest('cancel', { jobId: jobId });
          } catch (_cancelError) {
            /* best effort; the worker/Host limits still bound the job */
          }
          settleFailure('E_TIMEOUT');
          return;
        }
        if (result.state !== 'succeeded') {
          settleFailure(result.state === 'cancelled' ? 'E_CANCELLED' : 'E_RENDER');
          return;
        }
        exportInFlightRef.current = false;
        setExportState(function finishExport(previous) {
          if (previous === null) return previous;
          return Object.assign({}, previous, {
            phase: 'ready',
            stage: 'finished',
            progress: 1,
            url: ARTIFACT_ROUTE + '?jobId=' + encodeURIComponent(jobId),
            error: null,
            cancelling: false,
          });
        });
      }

      async function cancelProductExport() {
        const current = exportStateRef.current;
        if (current === null || current.phase !== 'running' || typeof current.jobId !== 'string') return;
        setExportState(function markCancelling(previous) {
          if (previous === null) return previous;
          return Object.assign({}, previous, { cancelling: true });
        });
        try {
          await hostRequest('cancel', { jobId: current.jobId });
        } catch (_cancelError) {
          // The running status poll settles the terminal cancelled state.
        }
      }

      // Topbar export control: button -> live stage/percent/elapsed + cancel ->
      // download link, with a concise retry state on failure/cancel.
      function exportControl() {
        if (project === null) return null;
        const state = exportState;
        if (state === null) {
          return h(
            'div',
            { className: 'dv-export', key: 'product-export' },
            h(
              'button',
              {
                type: 'button',
                className: 'dv-button dv-button-primary',
                onClick: function startProductExport() {
                  void exportProductVideo();
                },
                disabled: projectBusy !== null,
                title: t('video.canvas.export'),
              },
              t('video.canvas.export')
            )
          );
        }
        if (state.phase === 'running') {
          const percent = state.stage === 'capture' && Number.isFinite(state.progress) ? Math.round(state.progress * 100) : null;
          const elapsed = t('video.export.elapsed').replace('{seconds}', String(exportElapsed));
          const label = exportStageText(state.stage) + (percent === null ? '' : ' ' + String(percent) + '%') + ' · ' + elapsed;
          return h(
            'div',
            { className: 'dv-export', key: 'product-export' },
            h(
              'span',
              {
                className: 'dv-export-status',
                role: 'status',
                'aria-live': 'polite',
                'data-export-stage': state.stage,
                'data-export-progress': percent === null ? '' : String(percent),
                'data-export-elapsed': String(exportElapsed),
              },
              h('span', { className: 'dv-loader dv-export-spinner', 'aria-hidden': 'true' }),
              label
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dv-button dv-button-quiet dv-export-cancel',
                onClick: function cancelExport() {
                  void cancelProductExport();
                },
                disabled: state.cancelling === true,
                title: state.cancelling === true ? t('video.cancelling') : t('video.cancel'),
              },
              state.cancelling === true ? t('video.cancelling') : t('video.cancel')
            )
          );
        }
        if (state.phase === 'ready') {
          return h(
            'div',
            { className: 'dv-export', key: 'product-export' },
            h(
              'a',
              {
                className: 'dv-button dv-button-primary dv-export-link',
                href: state.url,
                download: state.fileName || 'dsh-video.mp4',
                title: state.fileName || t('video.canvas.download'),
                'data-export-ready': 'true',
              },
              t('video.canvas.download')
            ),
            // A finished export can be repeated for the same current revision.
            h(
              'button',
              {
                type: 'button',
                className: 'dv-button dv-button-quiet',
                onClick: function exportAgain() {
                  void exportProductVideo();
                },
                disabled: projectBusy !== null,
                title: t('video.canvas.export'),
              },
              t('video.canvas.export')
            )
          );
        }
        const note = state.phase === 'cancelled' ? t('video.export.cancelled') : t('video.canvas.exportFailed');
        return h(
          'div',
          { className: 'dv-export', key: 'product-export' },
          h('span', { className: 'dv-export-error', role: 'alert', 'data-export-error': state.error || '' }, note),
          h(
            'button',
            {
              type: 'button',
              className: 'dv-button dv-button-primary',
              onClick: function retryProductExport() {
                void exportProductVideo();
              },
              disabled: projectBusy !== null,
            },
            t('video.canvas.export')
          )
        );
      }

      async function loadSessionsFor(targetProjectId) {
        const token = ++sessionListToken.current;
        if (sessionKitAvailable === false) {
          setSessionState({ status: 'unavailable', items: [], activeSessionId: null, error: null });
          return null;
        }
        if (sessions === null || typeof sessions.retain !== 'function') {
          setSessionState({ status: 'unavailable', items: [], activeSessionId: null, error: null });
          return null;
        }
        try {
          const result = await hostRequest('session.list', { projectId: targetProjectId });
          if (token !== sessionListToken.current || !aliveRef.current) return null;
          const items = Array.isArray(result.sessions) ? result.sessions : [];
          const active = typeof result.activeSessionId === 'string' ? result.activeSessionId : null;
          setSessionState({ status: 'ready', items: items, activeSessionId: active, error: null, contract: result.contract || null });
          setActiveSessionId(function keepKnown(previous) {
            if (typeof previous === 'string' && items.some(function known(item) { return item.sessionId === previous; })) return previous;
            return active;
          });
          return result;
        } catch (requestError) {
          if (token !== sessionListToken.current || !aliveRef.current) return null;
          const code = requestError && requestError.code;
          setSessionState({
            status: code === 'E_SESSION_CONFIG' ? 'disabled' : 'error',
            items: [],
            activeSessionId: null,
            error: hostError(requestError),
          });
          return null;
        }
      }

      function refreshSessions() {
        return loadSessionsFor(projectIdRef.current);
      }

      async function diagnoseSessions() {
        if (sessionKitAvailable === false || sessions === null || typeof sessions.retain !== 'function') return;
        try {
          const result = await hostRequest('session.diagnose', {});
          if (aliveRef.current && result !== null && typeof result === 'object') setSessionDiagnostic(result);
        } catch (_error) {
          /* diagnosis is advisory; the visible list state already reports failures */
        }
      }

      async function chooseSession(sessionId) {
        setHistoryOpen(false);
        if (typeof sessionId !== 'string' || sessionId === activeSessionId) return;
        if (sessionBusy !== null) return;
        const token = ++sessionSwitchToken.current;
        setSessionBusy('select');
        setError(null);
        try {
          const result = await hostRequest('session.select', { projectId: projectIdRef.current, sessionId: sessionId });
          if (token !== sessionSwitchToken.current || !aliveRef.current) return;
          previewToken.current += 1;
          setPreview(null);
          setActiveSessionId(typeof result.activeSessionId === 'string' ? result.activeSessionId : sessionId);
        } catch (requestError) {
          if (token === sessionSwitchToken.current && aliveRef.current) setError(hostError(requestError));
        } finally {
          if (token === sessionSwitchToken.current && aliveRef.current) setSessionBusy(null);
        }
      }

      function closePreview() {
        previewToken.current += 1;
        setPreview(null);
      }

      // Open a file card or local image link in a plugin-owned overlay. The Host
      // route validates the owned Session, the trusted roots and the image bytes;
      // this surface never navigates to the conversation or mounts a third column.
      function openPreview(path) {
        const token = ++previewToken.current;
        const sessionId = activeSessionId;
        const fileName = previewFileName(path);
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          setPreview({ phase: 'error', sessionId: null, fileName: fileName, message: t('video.preview.denied') });
          return;
        }
        setPreview({ phase: 'loading', sessionId: sessionId, fileName: fileName });
        hostRequest('preview', { projectId: projectIdRef.current, sessionId: sessionId, path: path }).then(
          function previewReady(result) {
            if (token !== previewToken.current || !aliveRef.current || activeSessionIdRef.current !== sessionId) return;
            if (result === null || typeof result !== 'object' || typeof result.dataUrl !== 'string' || typeof result.mediaType !== 'string') {
              setPreview({ phase: 'error', sessionId: sessionId, fileName: fileName, message: t('video.preview.failed') });
              return;
            }
            setPreview({
              phase: 'ready',
              sessionId: sessionId,
              fileName: typeof result.fileName === 'string' && result.fileName.length > 0 ? result.fileName : fileName,
              mediaType: result.mediaType,
              dataUrl: result.dataUrl,
              size: Number(result.size) || 0,
              sha256: typeof result.sha256 === 'string' ? result.sha256 : '',
            });
          },
          function previewFailed(error) {
            if (token !== previewToken.current || !aliveRef.current || activeSessionIdRef.current !== sessionId) return;
            setPreview({ phase: 'error', sessionId: sessionId, fileName: fileName, message: previewErrorText(error, t) });
          }
        );
      }

      // P3-017 B2: a chat image already rendered by the browser (data:/blob:/remote
      // or same-origin chat route) is shown as-is in the same overlay. No Host read
      // happens and the native right-sidebar file opener is never involved.
      function openInlinePreview(src) {
        previewToken.current += 1;
        setPreview({
          phase: 'ready',
          local: true,
          sessionId: activeSessionId,
          fileName: '',
          mediaType: '',
          dataUrl: src,
          size: 0,
          sha256: '',
        });
      }

      function capturePreviewClick(event) {
        if (event === null || typeof event !== 'object') return;
        // An image target (read_image thumbnail/gallery) is browser-owned: show
        // its own source directly. This branch runs before the path/file-link
        // branches so an <img> inside a file-link container cannot be routed to
        // the native opener.
        const image = imagePreviewTarget(event.target);
        if (image !== null) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
          if (image.kind === 'host') openPreview(image.path);
          else openInlinePreview(image.src);
          return;
        }
        // File cards, Markdown links and host ToolRow fileLink summaries all end
        // in the plugin's own overlay, never the native right sidebar.
        const path = localPathFromTarget(event.target);
        if (path === null) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        openPreview(path);
      }

      function retrySession() {
        setRetryTick(function bump(value) {
          return value + 1;
        });
      }

      function errorNotice() {
        if (error === null) return null;
        return h(
          'div',
          { className: 'dv-error', role: 'alert', key: 'error' },
          errorText(error, t),
          ' ',
          h(
            'button',
            {
              type: 'button',
              className: 'dv-button dv-button-quiet',
              disabled: boot === 'loading' || projectBusy !== null,
              onClick: retryBoot,
            },
            t('video.preview.retry')
          )
        );
      }

      function navigationNotice() {
        if (ui.navigationError === null) return null;
        return h('p', { className: 'dv-error', role: 'alert', key: 'navigation-error' }, t('video.error.back'));
      }

      function sessionTitle(sessionId) {
        return sessionTitleFromSnapshot(sessionListSnapshot, sessionId);
      }

      function historyMenu() {
        const items = sessionState.items || [];
        return h(
          'div',
          { className: 'dv-history-menu', role: 'menu', 'aria-label': t('video.ai.history'), key: 'history' },
          items.length === 0
            ? h('p', { className: 'dv-ai-hint' }, t('video.ai.listEmpty'))
            : items.map(function historyRow(item) {
                const id = item.sessionId;
                const status = item.status;
                const meta = status === 'archived' ? t('video.ai.archived') : status === 'unavailable' ? t('video.ai.missing') : '';
                const disabled = status === 'archived' || status === 'unavailable' || sessionBusy !== null;
                return h(
                  'button',
                  {
                    type: 'button',
                    key: id,
                    className: 'dv-history-item',
                    role: 'menuitemradio',
                    'aria-checked': id === activeSessionId ? 'true' : 'false',
                    disabled: disabled,
                    onClick: function selectHistory() {
                      void chooseSession(id);
                    },
                  },
                  h('span', { className: 'dv-history-title' }, sessionTitle(id)),
                  meta === '' ? null : h('span', { className: 'dv-history-state' }, meta)
                );
              })
        );
      }

      function previewOverlay() {
        if (preview === null) return null;
        // A browser-owned inline image belongs to this panel, not to a Session
        // read token; only Host-backed previews are dropped on a Session switch.
        if (preview.local !== true && preview.sessionId !== activeSessionId) return null;
        const title = typeof preview.fileName === 'string' && preview.fileName.length > 0 ? preview.fileName : t('video.preview.title');
        const head = h(
          'div',
          { className: 'dv-preview-head', key: 'head' },
          h('span', { className: 'dv-preview-title', title: title, key: 'title' }, title),
          h(
            'button',
            {
              type: 'button',
              className: 'dv-preview-close',
              key: 'close',
              'aria-label': t('video.preview.close'),
              onClick: closePreview,
            },
            t('video.preview.close')
          )
        );
        let body;
        if (preview.phase === 'loading') {
          body = h('p', { className: 'dv-preview-status', role: 'status', key: 'loading' }, t('video.preview.loading'));
        } else if (preview.phase === 'error') {
          body = h(
            'p',
            { className: 'dv-preview-status', role: 'alert', 'data-error': 'true', key: 'error' },
            preview.message || t('video.preview.failed')
          );
        } else {
          body = h('img', {
            className: 'dv-preview-image',
            src: preview.dataUrl,
            alt: title,
            key: 'image',
          });
        }
        return h(
          'div',
          {
            className: 'dv-preview',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('video.preview.title'),
            key: 'preview',
            onKeyDown: function previewKeyDown(event) {
              if (event !== null && typeof event === 'object' && event.key === 'Escape') {
                if (typeof event.preventDefault === 'function') event.preventDefault();
                closePreview();
              }
            },
          },
          head,
          h('div', { className: 'dv-preview-body', key: 'body' }, body)
        );
      }

      function aiPanel() {
        const status = sessionKitAvailable === false ? 'unavailable' : sessionState.status;
        let body = null;
        if (status === 'idle' || status === 'loading') {
          body = h('p', { className: 'dv-ai-loading', role: 'status' }, t('video.ai.loading'));
        } else if (status === 'unavailable') {
          body = h('p', { className: 'dv-ai-hint' }, t('video.ai.unavailable'));
        } else if (status === 'disabled') {
          body = h('p', { className: 'dv-ai-hint' }, t('video.ai.disabled'));
        } else if (status === 'error') {
          body = h(
            'div',
            { className: 'dv-ai-error', role: 'alert' },
            h('p', { className: 'dv-error' }, errorText(sessionState.error, t)),
            h(
              'button',
              {
                type: 'button',
                className: 'dv-button dv-button-quiet',
                onClick: function retryList() {
                  void refreshSessions().then(function ensureSession(listed) {
                    if (listed !== null && listed !== undefined) void ensureProjectSession(projectIdRef.current, listed);
                  });
                },
              },
              t('video.ai.retry')
            )
          );
        } else if (activeSessionId === null) {
          body = h(
            'div',
            { className: 'dv-ai-empty' },
            h('p', { className: 'dv-ai-hint' }, t('video.ai.empty')),
            h(
              'button',
              {
                type: 'button',
                className: 'dv-button dv-button-primary',
                disabled: sessionBusy !== null || projectId === '',
                onClick: function create() {
                  void createSessionForProject(projectIdRef.current);
                },
              },
              sessionBusy === 'create' ? t('video.ai.creating') : t('video.ai.create')
            )
          );
        } else {
          body = h(SessionConversationHost, {
            key: activeSessionId + ':' + String(retryTick),
            sessionId: activeSessionId,
            sessions: sessions,
            SessionProvider: props.SessionProvider,
            renderFactorySlot: props.renderFactorySlot,
            t: t,
            hostConversationOpen: hostConversationOpen,
            onRetry: retrySession,
          });
        }
        return h(
          'aside',
          { className: 'dv-ai', 'aria-label': t('video.ai.title'), key: 'ai', onClickCapture: capturePreviewClick },
          h(
            'header',
            { className: 'dv-ai-head', 'aria-label': activeSessionId === null ? t('video.ai.title') : sessionTitle(activeSessionId) },
            h(
              'div',
              { className: 'dv-ai-heading' },
              h('span', { className: 'dv-ai-title' }, t('video.ai.title')),
              null
            ),
            h(
              'div',
              { className: 'dv-ai-actions' },
              h('button',{className:'dv-icon-button dv-settings-toggle','data-panel-trigger':'settings','aria-haspopup':'dialog','aria-label':t('video.settings.title'),title:t('video.settings.title'),'aria-expanded':settingsOpen?'true':'false',onClick:()=>{setSettingsOpen(!settingsOpen);setReferencesOpen(false);setHistoryOpen(false);}},h('svg',{viewBox:'0 0 24 24',width:18,height:18,fill:'none',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round','aria-hidden':'true'},h('path',{d:'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 3v3.5m0 7V19.5M3 12h3.5m7 0H19.5m-3.3-4.2-2.5 2.5m-5.4 5.4-2.5 2.5m0-10.4 2.5 2.5m5.4 5.4 2.5 2.5'})),h('span',{className:'dv-sr-only'},t('video.settings.title'))),
              h('button',{className:'dv-reference-toggle dv-icon-button','data-panel-trigger':'references',disabled:!projectId,'aria-haspopup':'dialog','aria-label':t('video.reference.title'),title:t('video.reference.title'),'aria-expanded':referencesOpen,onClick:()=>{setReferencesOpen(!referencesOpen);setHistoryOpen(false);setSettingsOpen(false);}},h(StudioIcon,{name:'reference'}),h('span',null,t('video.reference.title'))),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dv-icon-button dv-new-session',
                  'aria-label': t('video.ai.new'),
                  title: t('video.ai.new'),
                  disabled: sessionBusy !== null || status === 'disabled' || status === 'unavailable' || projectId === '',
                  onClick: function createNew() {
                    void createSessionForProject(projectIdRef.current);
                  },
                },
                h(StudioIcon, { name: 'new' }),
                h('span', { className: 'dv-sr-only' }, sessionBusy === 'create' ? t('video.ai.creating') : t('video.ai.new'))
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dv-icon-button dv-history-toggle',
                  'aria-haspopup': 'menu',
                  'aria-expanded': historyOpen ? 'true' : 'false',
                  'aria-label': t('video.ai.history'),
                  title: t('video.ai.history'),
                  disabled: status !== 'ready',
                  onClick: function toggleHistory() {
                    setHistoryOpen(!historyOpen);setReferencesOpen(false);
                  },
                },
                h(HistoryIcon)
              )
            )
          ),
          settingsOpen?h(SettingsDialog,{key:'dsh-video-settings',t,onClose:()=>setSettingsOpen(false)}):null,
          referencesOpen?h(ReferencePanel,{key:projectId,projectId,revision:project?.revision,t,onClose:()=>setReferencesOpen(false)}):null,
          historyOpen ? historyMenu() : null,
          h('div', { className: 'dv-ai-body' }, body),
          previewOverlay()
        );
      }

      // ── M1-04 project folder actions (Host-authoritative path) ─────────────
      function platformIsMac() {
        try {
          const platform = typeof navigator === 'undefined' ? '' : String(navigator.platform || '');
          if (/Mac|iPhone|iPad|iPod/.test(platform)) return true;
          if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string' && navigator.userAgent.indexOf('Macintosh') >= 0) return true;
        } catch (_error) {
          /* platform sniffing is presentation-only */
        }
        return false;
      }

      function folderRevealLabel() {
        return platformIsMac() ? t('video.project.reveal') : t('video.project.revealGeneric');
      }

      async function writeClipboardText(value) {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(value);
            return true;
          }
        } catch (_error) {
          /* fall through to the legacy path */
        }
        try {
          if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
            const area = document.createElement('textarea');
            area.value = value;
            area.setAttribute('readonly', 'readonly');
            area.style.position = 'fixed';
            area.style.opacity = '0';
            const host = document.documentElement || document;
            host.appendChild(area);
            const selected = typeof area.select === 'function' ? area.select() : false;
            const copied = selected !== false && document.execCommand('copy') === true;
            host.removeChild(area);
            return copied;
          }
        } catch (_error) {
          /* the caller shows the fallback toast */
        }
        return false;
      }

      async function revealProjectFolder() {
        if (folderBusy !== null || projectIdRef.current === '') return;
        setProjectMenuOpen(false);
        setFolderBusy('reveal');
        setFolderNotice(null);
        try {
          const result = await hostRequest('project.reveal', { projectId: projectIdRef.current });
          if (result === null || typeof result !== 'object' || result.opened !== true) throw new Error('reveal failed');
        } catch (_error) {
          if (aliveRef.current) setFolderNotice({ kind: 'error', text: t('video.project.revealFailed') });
        } finally {
          if (aliveRef.current) setFolderBusy(null);
        }
      }

      async function copyProjectPath() {
        if (folderBusy !== null || projectIdRef.current === '') return;
        setProjectMenuOpen(false);
        setFolderBusy('copy');
        setFolderNotice(null);
        let path = '';
        try {
          const result = await hostRequest('project.path', { projectId: projectIdRef.current });
          path = result !== null && typeof result === 'object' && typeof result.path === 'string' ? result.path : '';
          if (path === '') throw new Error('path unavailable');
          const copied = await writeClipboardText(path);
          if (!copied) throw new Error('clipboard unavailable');
          if (aliveRef.current) setFolderNotice({ kind: 'status', text: t('video.project.copyPathDone') });
        } catch (_error) {
          if (aliveRef.current) {
            setFolderNotice({ kind: 'error', text: t('video.project.copyPathFailed') + (path === '' ? '' : path) });
          }
        } finally {
          if (aliveRef.current) setFolderBusy(null);
        }
      }

      function projectMenu() {
        const options = projectChoices.slice();
        if (projectId !== '' && options.some(function has(item) { return item.projectId === projectId; }) === false) {
          options.unshift({ projectId: projectId, updatedAt: 0, title: null });
        }
        return h(
          'div',
          {
            className: 'dv-project-menu',
            id: 'dsh-video-project-menu',
            role: 'menu',
            'aria-label': t('video.project.open'),
            key: 'project-menu',
            onKeyDown: onProjectMenuKeyDown,
          },
          options.map(function projectRow(item, index) {
            const id = item.projectId;
            const active = id === projectId;
            const name = projectChoiceTitle(item, index);
            return h(
              'button',
              {
                type: 'button',
                key: id,
                ref: active ? projectItemRef : null,
                className: 'dv-project-item',
                role: 'menuitemradio',
                'aria-checked': active ? 'true' : 'false',
                disabled: projectBusy !== null,
                onClick: function switchProject() {
                  setProjectMenuOpen(false);
                  if (id === projectIdRef.current) return;
                  void openProject(id);
                },
              },
              h('span', { className: 'dv-project-item-title' }, name),
              active ? h('span', { className: 'dv-project-item-check', 'aria-hidden': 'true' }, '✓') : null
            );
          }),
          h('div', { className: 'dv-project-separator', key: 'separator', 'aria-hidden': 'true' }),
          h(
            'button',
            {
              type: 'button',
              key: '__reveal__',
              className: 'dv-project-item',
              'data-action': 'reveal',
              role: 'menuitem',
              disabled: projectBusy !== null || folderBusy !== null,
              onClick: function revealFolder() {
                void revealProjectFolder();
              },
            },
            h('span', { className: 'dv-project-item-title' }, folderRevealLabel())
          ),
          h(
            'button',
            {
              type: 'button',
              key: '__copy_path__',
              className: 'dv-project-item',
              'data-action': 'copy-path',
              role: 'menuitem',
              disabled: projectBusy !== null || folderBusy !== null,
              onClick: function copyFolderPath() {
                void copyProjectPath();
              },
            },
            h('span', { className: 'dv-project-item-title' }, t('video.project.copyPath'))
          ),
          h('div', { className: 'dv-project-separator', key: 'separator-new', 'aria-hidden': 'true' }),
          h(
            'button',
            {
              type: 'button',
              key: '__new__',
              className: 'dv-project-item',
              role: 'menuitem',
              disabled: projectBusy !== null,
              onClick: function newProject() {
                setProjectMenuOpen(false);
                void createManagedProject();
              },
            },
            '+ ' + t('video.project.new')
          )
        );
      }

      function projectBar() {
        if (projectId === '' && projectChoices.length === 0) return null;
        const name = projectDisplayTitle();
        const nameControl = renameDraft === null
          ? h(
              'button',
              {
                type: 'button',
                key: 'name',
                ref: projectNameRef,
                className: 'dv-project-name',
                disabled: projectBusy !== null,
                title: t('video.project.renameHint'),
                onClick: startRename,
              },
              name
            )
          : h('input', {
              type: 'text',
              key: 'name-input',
              ref: renameInputRef,
              className: 'dv-project-name-input',
              value: renameDraft,
              maxLength: 120,
              disabled: renameBusy,
              spellCheck: false,
              'aria-label': t('video.project.rename'),
              onChange: onRenameChange,
              onKeyDown: onRenameKeyDown,
              onBlur: cancelRename,
            });
        return h(
          'div',
          { className: 'dv-projectbar', key: 'projects' },
          nameControl,
          h(
            'button',
            {
              type: 'button',
              key: 'toggle',
              ref: projectToggleRef,
              className: 'dv-icon-button dv-project-toggle',
              'aria-haspopup': 'menu',
              'aria-expanded': projectMenuOpen ? 'true' : 'false',
              'aria-controls': 'dsh-video-project-menu',
              'aria-label': t('video.project.open'),
              title: t('video.project.open'),
              disabled: projectBusy !== null,
              onClick: toggleProjectMenu,
              onKeyDown: onProjectToggleKeyDown,
            },
            h(ChevronDownIcon)
          ),
          // M1-04: a visible, always-reachable folder button (the menu items are
          // the discoverable/copy-path fallback). Hidden when no project is open.
          projectId !== ''
            ? h(
                'button',
                {
                  type: 'button',
                  key: 'folder',
                  className: 'dv-icon-button dv-folder-button',
                  'data-action': 'reveal-folder',
                  'aria-label': folderRevealLabel(),
                  title: folderRevealLabel(),
                  disabled: projectBusy !== null || folderBusy !== null,
                  onClick: function revealFolder() {
                    setFolderNotice(null);
                    void revealProjectFolder();
                  },
                },
                h(FolderIcon)
              )
            : null,
          projectMenuOpen ? projectMenu() : null
        );
      }

      // Left side: one read-only, auto-playing preview of the revision the Host
      // reports. There is no project/empty choice UI for manual editing here and
      // no legacy PNG/form editor branch.
      function stageContent() {
        if (project === null) {
          const busyCreating = boot === 'loading' || boot === 'idle' || projectBusy !== null;
          return h(
            'div',
            { className: 'dv-emptywrap', key: 'empty' },
            navigationNotice(),
            errorNotice(),
            h('p', { className: 'dv-empty', role: 'status' }, busyCreating ? t('video.preview.booting') : t('video.preview.empty')),
            h(
              'div',
              { className: 'dv-empty-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dv-button dv-button-quiet',
                  disabled: busyCreating,
                  onClick: retryBoot,
                },
                t('video.preview.retry')
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dv-button dv-button-primary',
                  disabled: projectBusy !== null,
                  onClick: function createFromEmpty() {
                    void createManagedProject();
                  },
                },
                projectBusy === 'create' ? t('video.opening') : t('video.project.new')
              )
            )
          );
        }
        return h(
          'div',
          { className: 'dv-managed-stage', key: 'canvas' },
          errorNotice(),
          h(CanvasWorkspace, {
            t: t,
            projectId: projectId,
            inspected: project,
            previewOnly: true,
            timelineEnabled:props.timelineEnabled,
            onReload: reloadCanvasProject,
            onError: function canvasError(nextError) {
              setError(nextError);
            },
          })
        );
      }

      return h(
        'div',
        {
          className: 'dv-root',
          'data-panel': PANEL_ID,
          'data-project-id': projectId,
          'data-boot': boot,
          'data-session': sessionKitAvailable === false ? 'unavailable' : sessionState.status,
          'data-session-kit': sessionKitAvailable ? 'available' : 'missing',
          'data-session-active': activeSessionId === null ? '' : activeSessionId,
          'data-session-contract': sessionDiagnostic !== null && sessionDiagnostic.contract !== undefined ? String(sessionDiagnostic.contract) : '',
          'data-session-controller': sessionDiagnostic === null ? '' : sessionDiagnostic.controller === true ? 'available' : 'missing',
          'data-session-context': sessionDiagnostic === null ? '' : sessionDiagnostic.contextRegistered === true ? 'registered' : 'absent',
          // P3-017 B3 export markers: the visible phase plus the exact revision the
          // current/last export was bound to (never the latest published one).
          'data-export': exportState === null ? 'idle' : exportState.phase,
          'data-export-revision': exportState === null || exportState.revision === undefined ? '' : String(exportState.revision),
        },
        h(StyleTag, { key: 'style' }),
        h(
          'header',
          { className: 'dv-topbar', 'data-window-drag': true, key: 'topbar' },
          h(
            'button',
            {
              type: 'button',
              key: 'back',
              className: 'dv-back',
              onClick: onBack,
              'aria-label': t('video.back'),
              title: t('video.back'),
            },
            h(BackIcon, { key: 'icon' }),
            h('span', { className: 'dv-sr-only', key: 'label' }, t('video.back'))
          ),
          projectBar(),
          projectId !== '' && saveStatus !== 'idle'
            ? h(
                'button',
                {
                  type: 'button',
                  key: 'save-status',
                  className: 'dv-save-status',
                  'data-status': saveStatus,
                  role: saveStatus === 'failed' ? 'alert' : 'status',
                  disabled: saveStatus !== 'failed',
                  title: saveStatus === 'failed' ? t('video.save.retryHint') : t('video.save.saved'),
                  onClick: retrySaveLastProject,
                },
                saveStatus === 'saving'
                  ? t('video.save.saving')
                  : saveStatus === 'saved'
                    ? t('video.save.saved')
                    : t('video.save.failed')
              )
            : null,
          // P3-016: inline rename feedback stays next to the left-aligned project
          // name/arrow. P3-017: the product export control owns the right side.
          renameError !== null
            ? h('p', { className: 'dv-project-rename-error', role: 'alert', key: 'rename-error' }, renameError)
            : null,
          folderNotice !== null
            ? h(
                'p',
                {
                  className: 'dv-project-folder-notice',
                  key: 'folder-notice',
                  role: folderNotice.kind === 'error' ? 'alert' : 'status',
                  'data-kind': folderNotice.kind,
                },
                folderNotice.text
              )
            : null,
          h('span', { className: 'dv-spacer', key: 'spacer' }),
          h(UpdateControl,{key:'updates',t,busy:projectBusy!==null||exportState?.phase==='running'}),
          exportControl()
        ),
        h(
          'main',
          {
            className: 'dv-main',
            key: 'main',
            ref: mainRef,
            style: { '--dv-ai-width': aiPaneWidthCss(aiPaneRatio) },
            'data-resizing': resizing ? 'true' : 'false',
          },
          h('div', { className: 'dv-left', key: 'left' }, stageContent()),
          h('div', {
            className: 'dv-splitter',
            key: 'splitter',
            role: 'separator',
            tabIndex: 0,
            'aria-orientation': 'vertical',
            'aria-label': t('video.layout.resize'),
            'aria-valuemin': String(Math.round(AI_PANE_RATIO_MIN * 100)),
            'aria-valuemax': String(Math.round(AI_PANE_RATIO_MAX * 100)),
            'aria-valuenow': String(Math.round(aiPaneRatio * 100)),
            'data-dragging': resizing ? 'true' : 'false',
            onPointerDown: onSplitterPointerDown,
            onPointerMove: onSplitterPointerMove,
            onPointerUp: onSplitterPointerUp,
            onPointerCancel: onSplitterPointerUp,
            onDoubleClick: resetAiPaneRatio,
            onKeyDown: onSplitterKeyDown,
          }),
          aiPanel()
        )
      );
    }
    //#endregion


    //#region plugin
    const inject = ['slots', 'layout', 'locale', 'sessions'];

    function apply(ctx) {
      reportIssue = makeReporter(ctx);
      reportedCodes.clear();
      uiStore = createUiStore({ navigationError: null }, reportIssue);

      // Browser-owned Session service face used only to retain/release our own
      // project Sessions. It is optional: a host without it keeps the preview
      // and export path and shows a localized unavailable state for AI.
      let clientSessions = null;
      try {
        clientSessions = (typeof ctx.get === 'function' ? ctx.get('sessions') : null) || ctx.sessions || null;
      } catch (error) {
        clientSessions = null;
        reportOnce('sessions-service-unavailable', error);
      }
      installReferenceSource(ctx);
      const clientLayout = ctx.layout !== undefined && ctx.layout !== null ? ctx.layout : null;

      ctx.effect(
        function registerDictionaries() {
          try {
            return ctx.locale.register(NS, { zh: ZH, en: EN });
          } catch (error) {
            // Text falls back to dictionary keys; registration still proceeds.
            reportIssue('locale-register-failed', error);
            return function noopDispose() {};
          }
        },
        'dsh-video: dictionaries'
      );

      // Unload safety net: leaving the profile while the video panel is selected
      // must not leave a dead active key behind. Host `retainMainPanels` is the
      // primary mechanism (it reacts to the main-slot entries disappearing); this
      // cleanup only nudges the selection back when the host still reports video.
      ctx.effect(
        function leaveVideoOnUnload() {
          return function cleanupSelection() {
            try {
              const panelInfo = ctx.layout && ctx.layout.panelInfo;
              if (!panelInfo || typeof panelInfo.getSnapshot !== 'function') return;
              const snapshot = panelInfo.getSnapshot();
              if (snapshot && snapshot.activePanelId === PANEL_ID) ctx.layout.selectPanel(null);
            } catch (error) {
              reportOnce('unload-return-failed', error);
            }
          };
        },
        'dsh-video: leave video on unload'
      );

      // Locale-aware sidebar label. The host re-reads this thunk on every
      // projection (and after locale changes); the exact user-requested spelling
      // is also the fallback if the locale service is unavailable.
      let boundText = null;
      function sidebarLabel() {
        try {
          if (boundText === null && ctx.locale && typeof ctx.locale.bind === 'function') {
            boundText = ctx.locale.bind(NS);
          }
          if (typeof boundText === 'function') {
            const text = boundText('nav.label');
            if (typeof text === 'string' && text !== '' && text !== 'nav.label') return text;
          }
        } catch (error) {
          reportOnce('sidebar-label-failed', error);
        }
        return 'dsh-video-editor';
      }

      function navigation() {
        return {
          sessions: clientSessions,
          layout: clientLayout,
          onBack: function onBack() {
            setNavigationError(null);
            try {
              if (typeof ctx.layout.selectPanel !== 'function') {
                throw new Error('layout.selectPanel is unavailable');
              }
              ctx.layout.selectPanel(null);
            } catch (error) {
              setNavigationError('back');
              reportOnce('navigation-failed', error);
            }
          },
        };
      }

      // Ask the host to leave our panel when its entry disappears mid-selection.
      function settleSelection() {
        try {
          const panelInfo = ctx.layout && ctx.layout.panelInfo;
          if (!panelInfo || typeof panelInfo.getSnapshot !== 'function') return;
          const snapshot = panelInfo.getSnapshot();
          if (snapshot && snapshot.activePanelId === PANEL_ID) ctx.layout.selectPanel(null);
        } catch (error) {
          reportOnce('fallback-return-failed', error);
        }
      }

      // 1. One `main` declaration lifetime owns a chain. Inside that chain each
      //    `sidebar.panellist` declaration lifetime re-acquires one atomic pair:
      //    the video panel is registered first, then the sidebar row. A refused
      //    or failed entry disposes the panel synchronously; a lost leading or
      //    sidebar declaration releases both. A later declaration retries, so no
      //    reachable row ever points at a missing main panel.
      let mainController = null;

      function registerPanelAndEntry() {
        const initialMainOccupants = findOccupants(ctx, 'main', 'key', PANEL_ID);
        if (initialMainOccupants === null) {
          reportIssue('main-entries-unavailable');
          return function noopDispose() {};
        }
        if (initialMainOccupants.length > 0) {
          reportIssue('main-key-conflict:' + String(initialMainOccupants.length));
          return function noopDispose() {};
        }

        let closed = false;
        let sidebarRegistered = false;
        let sidebarController = null;
        let cycle = null;

        function releaseCycle(target) {
          if (target === null || target.disposed === true) return;
          target.disposed = true;
          if (cycle === target) cycle = null;
          sidebarRegistered = false;
          // Drop the navigation row first: the video panel must never be left
          // registered without its reachable entry, and the row must never stay
          // clickable after its panel is gone.
          try {
            if (target.sidebarDispose !== null) {
              const dispose = target.sidebarDispose;
              target.sidebarDispose = null;
              dispose();
            }
          } catch (error) {
            reportOnce('sidebar-cleanup-failed', error);
          }
          try {
            if (target.mainDispose !== null) {
              const dispose = target.mainDispose;
              target.mainDispose = null;
              dispose();
            }
          } catch (error) {
            reportOnce('main-cleanup-failed', error);
          }
          settleSelection();
        }

        function acquirePair() {
          if (closed) return function noopDispose() {};
          if (cycle !== null) releaseCycle(cycle);

          const sidebarEntries = findOccupants(ctx, 'sidebar.panellist', null, null);
          if (sidebarEntries === null) {
            reportIssue('sidebar-entries-unavailable');
            reportIssue('sidebar-entry-unavailable');
            return function noopDispose() {};
          }
          const ourSidebarEntries = sidebarEntries.filter(function ours(entry) {
            return entry !== null && typeof entry === 'object' && entry.options && entry.options.id === PANEL_ID;
          });
          if (ourSidebarEntries.length > 0) {
            reportIssue('sidebar-entry-conflict:' + String(ourSidebarEntries.length));
            reportIssue('sidebar-entry-unavailable');
            return function noopDispose() {};
          }
          // Re-check the main key right before committing the pair: a competitor
          // may have registered while declarations were being processed.
          const mainOccupants = findOccupants(ctx, 'main', 'key', PANEL_ID);
          if (mainOccupants === null) {
            reportIssue('main-entries-unavailable');
            return function noopDispose() {};
          }
          if (mainOccupants.length > 0) {
            reportIssue('main-key-conflict:' + String(mainOccupants.length));
            return function noopDispose() {};
          }

          let mainDispose = null;
          let sidebarDispose = null;
          try {
            mainDispose = ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                locale: NS,
                // A private session-scope child makes the renderer synthesize
                // SessionProvider (and renderSlot) into this entry's kit. No
                // occupant is registered for it: the Conversation Factory is
                // rendered directly inside the explicit Provider.
                children: (function () {
                  const children = {};
                  children[SESSION_CHILD_SLOT] = { kind: 'single', scope: 'session' };
                  return children;
                })(),
                inject: navigation,
              },
              VideoWorkspace
            );
          } catch (error) {
            reportIssue('main-register-failed', error);
            return function noopDispose() {};
          }
          try {
            sidebarDispose = ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: SIDEBAR_ORDER, label: sidebarLabel, locale: NS },
              SidebarVideoIcon
            );
          } catch (error) {
            reportIssue('sidebar-register-failed', error);
            reportIssue('sidebar-entry-unavailable');
            try {
              mainDispose();
            } catch (cleanupError) {
              reportOnce('main-cleanup-failed', cleanupError);
            }
            return function noopDispose() {};
          }

          sidebarRegistered = true;
          const acquired = {
            disposed: false,
            mainDispose: mainDispose,
            sidebarDispose: sidebarDispose,
            inner: null,
          };
          acquired.inner = function releaseSidebarDeclaration() {
            releaseCycle(acquired);
          };
          cycle = acquired;
          return acquired.inner;
        }

        function closeChain() {
          if (closed) return;
          closed = true;
          try {
            if (sidebarController !== null) {
              const dispose = sidebarController;
              sidebarController = null;
              dispose();
            }
          } catch (error) {
            reportOnce('sidebar-cleanup-failed', error);
          }
          releaseCycle(cycle);
        }

        try {
          sidebarController = ctx.slots.inject('sidebar.panellist', acquirePair);
        } catch (error) {
          reportIssue('sidebar-inject-failed', error);
          closeChain();
          return function noopDispose() {};
        }

        if (isSlotDeclared(ctx, 'sidebar.panellist') !== false && sidebarRegistered !== true && cycle === null) {
          // The seat exists but our pair was refused. No video panel was
          // registered in this order, so there is nothing left to retract; a
          // later sidebar declaration retries the acquisition.
          reportIssue('sidebar-entry-unavailable');
        }

        return closeChain;
      }

      try {
        mainController = ctx.slots.inject('main', registerPanelAndEntry);
      } catch (error) {
        reportIssue('main-inject-failed', error);
        return;
      }
    }

    return { inject: inject, apply: apply };
    //#endregion
  },
});
