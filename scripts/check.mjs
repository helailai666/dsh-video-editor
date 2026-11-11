#!/usr/bin/env node
/**
 * Local, zero-dependency pre-install checks for the dsh-video bundle.
 *
 * Verifies that package.json, cordis.patch.yml, the two plugin halves and the
 * shipped files agree with each other and with the browser module format. This is
 * a static check only: it does not install, enable or execute anything inside DSH.
 *
 * Run: node scripts/check.mjs   (or npm run check)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const passes = [];

function check(name, fn) {
  try {
    const detail = fn();
    passes.push([name, detail === undefined ? 'ok' : String(detail)]);
  } catch (error) {
    failures.push([name, error instanceof Error ? error.message : String(error)]);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function exists(relativePath) {
  return existsSync(join(ROOT, relativePath));
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

/** Match a package.json `files` entry, which may contain one simple `*` glob. */
function listMatchingFiles(pattern) {
  if (!pattern.includes('*')) return exists(pattern) ? [pattern] : [];
  const star = pattern.indexOf('*');
  const directory = pattern.slice(0, star).replace(/\/$/, '');
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (directory === '' || !exists(directory) || !statSync(join(ROOT, directory)).isDirectory()) return [];
  return readdirSync(join(ROOT, directory))
    .map((name) => `${directory}/${name}`)
    .filter((candidate) => candidate.startsWith(prefix) && candidate.endsWith(suffix) && exists(candidate));
}

const pkg = readJson('package.json');
const clientSource = read('client.js');
const hostSource = read('index.js');
const patchSource = read('cordis.patch.yml');
const readme = read('README.md');
const previewSource = read('host/preview.js');
const sessionsSource = read('host/sessions.js');
const assetSource = read('host/asset-inbox.js');

const moduleIdMatch = clientSource.match(/__ModuleLoader__\.load\(\{\s*\n?\s*id:\s*['"]([^'"]+)['"]/);
const moduleId = moduleIdMatch === null ? undefined : moduleIdMatch[1];

check('package name identifies one unique bundle', () => {
  assert(typeof pkg.name === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(pkg.name), 'package name is missing or not a plain lowercase package id');
  assert(pkg.private === false, 'distribution bundle must be publishable');
  return pkg.name;
});

check('client module id equals package name', () => {
  assert(moduleId !== undefined, 'window.__ModuleLoader__.load({ id: ... }) id not found in client.js');
  assert(moduleId === pkg.name, `client id "${moduleId}" !== package name "${pkg.name}"`);
  return moduleId;
});

check('client half uses the browser module format', () => {
  assert(/window\.__ModuleLoader__\.load\(\{/.test(clientSource), 'missing window.__ModuleLoader__.load registration');
  assert(/factory\s*(?:\(\s*require\s*\)|:\s*\(?\s*require\s*\)?\s*=>)/.test(clientSource), 'factory(require) not found');
  assert(/^\s*import\s+/m.test(clientSource) === false, 'client bundle must not use ESM import');
  assert(/^\s*export\s+/m.test(clientSource) === false, 'client bundle must not use ESM export');
  return 'load/factory present, no ESM syntax';
});

check('client half imports only the platform seed module', () => {
  const allowed = new Set(['react']);
  const specifiers = [...clientSource.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
  assert(specifiers.length > 0, 'client.js never requires react');
  for (const specifier of specifiers) {
    assert(allowed.has(specifier), `unexpected external require("${specifier}"); allowlist: ${[...allowed].join(', ')}`);
  }
  return [...new Set(specifiers)].join(', ');
});

check('client half avoids forbidden host surfaces', () => {
  const forbidden = [
    ['document.body', 'must not touch document.body'],
    ['querySelector', 'must not read host DOM geometry'],
    ['@deepseek-ai/', 'must not import internal DSH client packages'],
    ['session/event', 'must not publish session events'],
  ];
  for (const [needle, reason] of forbidden) {
    assert(clientSource.includes(needle) === false, `client.js contains "${needle}": ${reason}`);
  }
  return 'no document.body / host DOM reads / internal imports / session events';
});

check('host half exports a Cordis plugin body and declares required services', () => {
  assert(/export\s+function\s+apply\s*\(/.test(hostSource), 'index.js must export function apply()');
  assert(/export\s+const\s+inject\s*=\s*\[\s*'connection'\s*,\s*'tools'\s*,\s*'subprocess'\s*\]/.test(hostSource), 'index.js must declare connection/tools/subprocess injection');
  assert(/@deepseek-ai\//.test(hostSource) === false, 'index.js must not import @deepseek-ai/* (profile path packages cannot resolve them)');
  for (const module of ['host/bridge.js', 'host/audio.js', 'host/routes.js', 'host/tool.js', 'host/config.js', 'host/env.js', 'host/errors.js', 'host/engine.js', 'host/limits.js', 'host/sessions.js', 'host/session-state.js', 'host/data-root.js', 'host/ui-state.js']) {
    assert(exists(module), `missing Host module ${module}`);
  }
  return 'apply(), inject, nine Host modules';
});

check('bundle manifest declares patch and client', () => {
  assert(pkg.dsh && typeof pkg.dsh === 'object', 'missing dsh manifest block');
  assert(pkg.dsh.manifestVersion === 1, 'dsh.manifestVersion must be 1');
  assert(pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', 'dsh.bundle.patch must point at ./cordis.patch.yml');
  assert(pkg.dsh.client && pkg.dsh.client.platform === 'web', 'dsh.client.platform must be "web"');
  assert(pkg.dsh.client.immediately === true, 'dsh.client.immediately should be true so the sidebar entry registers before first navigation');
  assert(Array.isArray(pkg.dsh.client.inject), 'dsh.client.inject must be an array');
  for (const entry of pkg.dsh.client.inject) assert(typeof entry === 'string', 'dsh.client.inject entries must be package names');
  assert(
    pkg.dsh.client.inject.indexOf('@deepseek-ai/dsh-client-ui-conversation') === -1,
    'P0-005 no longer registers into the conversation header; drop the ui-conversation activation dependency'
  );
  return `platform=web, inject=[${pkg.dsh.client.inject.join(', ')}]`;
});

check('package version advanced for the 1.0.2 vendor-model release', () => {
  assert(pkg.version === '1.0.2', `expected version 1.0.2, found "${pkg.version}"`);
  return pkg.version;
});

check('patch inserts exactly one dsh-video row', () => {
  assert(/^-\s*insert:\s*$/m.test(patchSource), 'cordis.patch.yml must contain an "insert:" list');
  const rowIds = [...patchSource.matchAll(/^\s*-\s*id:\s*['"]?([^'"\s#]+)['"]?\s*$/gm)].map((match) => match[1]);
  assert(rowIds.length === 1, `expected exactly one row id, found ${rowIds.length}`);
  assert(rowIds[0] === pkg.name, `row id "${rowIds[0]}" !== package name "${pkg.name}"`);
  const names = [...patchSource.matchAll(/^\s+name:\s*['"]?([^'"\s#]+)['"]?\s*$/gm)].map((match) => match[1]);
  assert(names.length === 1 && names[0] === pkg.name, `row name must be "${pkg.name}", found [${names.join(', ')}]`);
  return `row id=${rowIds[0]}, name=${names[0]}`;
});

check('entrypoints and exports resolve to shipped files', () => {
  const rawTargets = [pkg.main];
  for (const value of Object.values(pkg.exports || {})) {
    rawTargets.push(typeof value === 'string' ? value : value && value.default);
  }
  const checked = new Set();
  for (const rawTarget of rawTargets) {
    assert(typeof rawTarget === 'string' && rawTarget.length > 0, `bad export target: ${String(rawTarget)}`);
    const target = rawTarget.startsWith('./') ? rawTarget : `./${rawTarget}`;
    if (target.includes('*')) {
      const matches = listMatchingFiles(target.slice(2));
      assert(matches.length > 0, `export wildcard "${target}" matches no file`);
      checked.add(`${target} -> ${matches.length} file(s)`);
    } else {
      assert(exists(target.slice(2)), `export target "${target}" does not exist`);
      checked.add(target);
    }
  }
  assert(exists('index.js'), 'index.js missing');
  assert(exists('client.js'), 'client.js missing');
  return `${checked.size} export target(s)`;
});

check('package files list covers every shipped artifact', () => {
  assert(Array.isArray(pkg.files) && pkg.files.length > 0, 'package.json needs a files list for a reproducible install');
  const required = ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json', 'README.md', 'host/bridge.js', 'host/audio.js', 'host/routes.js', 'host/tool.js', 'host/config.js', 'host/env.js', 'host/errors.js', 'host/engine.js', 'host/limits.js', 'host/sessions.js', 'host/session-state.js', 'host/preview.js', 'host/snapshot.js', 'host/asset-inbox.js', 'host/canvas-runtime.js', 'host/data-root.js', 'host/ui-state.js'];
  for (const artifact of required) {
    const covered = pkg.files.some((pattern) => listMatchingFiles(pattern).includes(artifact));
    assert(covered, `files list does not cover required artifact "${artifact}"`);
  }
  const extra = ['scripts/check.mjs', 'scripts/smoke-client.mjs', 'scripts/check-host.mjs', 'scripts/stage-dev.mjs', 'scripts/test-host-engine.mjs', 'scripts/test-stage-version.mjs', 'scripts/lib/staged-host.mjs', 'scripts/lib/stage-version.mjs', 'scripts/test-canvas-chain.mjs', 'scripts/test-canvas-browser.mjs', 'scripts/test-canvas-workspace.mjs', 'scripts/lib/react-dom-lite.mjs', 'scripts/lib/canvas-harness-page.js', 'scripts/lib/canvas-harness-page.html', 'scripts/test-v1-storage.mjs'];
  for (const tool of extra) {
    assert(exists(tool), `local check tool "${tool}" is missing from the workspace`);
    const packaged = pkg.files.some((pattern) => listMatchingFiles(pattern).includes(tool));
    assert(packaged === false, `"${tool}" must not be packaged into the installable bundle`);
  }
  return `${pkg.files.length} pattern(s)`;
});

check('icon is a local file within the size limit', () => {
  assert(pkg.icon === './icon.svg', 'package.json icon must be "./icon.svg"');
  assert(exists('icon.svg'), 'icon.svg missing');
  const size = statSync(join(ROOT, 'icon.svg')).size;
  assert(size <= 256 * 1024, `icon is ${size} bytes, limit is 262144`);
  assert(/<svg[\s>]/.test(read('icon.svg')), 'icon.svg is not an SVG document');
  return `${size} bytes`;
});

check('locale files carry display metadata', () => {
  for (const locale of ['en', 'zh']) {
    const document = readJson(`locale/${locale}.json`);
    assert(document.meta && typeof document.meta === 'object', `locale/${locale}.json needs a meta object`);
    assert(typeof document.meta.title === 'string' && document.meta.title.length > 0, `locale/${locale}.json meta.title missing`);
    assert(typeof document.meta.description === 'string' && document.meta.description.length > 0, `locale/${locale}.json meta.description missing`);
    assert(Object.keys(document).length === 1, `locale/${locale}.json should only contain display metadata (UI strings live in client.js)`);
  }
  return 'en + zh';
});

check('README documents install, disable and rollback', () => {
  for (const needle of ['安装', '停用', '回滚']) {
    assert(readme.includes(needle), `README must document ${needle} steps`);
  }
  assert(readme.includes('dsh-video'), 'README must name the bundle');
  return 'install / disable / rollback sections present';
});

check('locale dictionaries and used keys agree', () => {
  function dictionaryKeys(declaration) {
    const start = clientSource.indexOf(`const ${declaration} = {`);
    const end = clientSource.indexOf('\n    };', start);
    assert(start >= 0 && end > start, `${declaration} dictionary block not found`);
    const block = clientSource.slice(start, end);
    return new Set([...block.matchAll(/^\s*'([^']+)':/gm)].map((match) => match[1]));
  }
  const zh = dictionaryKeys('ZH');
  const en = dictionaryKeys('EN');
  assert(zh.size > 0 && en.size > 0, 'locale dictionaries are empty');
  const missingEn = [...zh].filter((key) => en.has(key) === false);
  const missingZh = [...en].filter((key) => zh.has(key) === false);
  assert(missingEn.length === 0, `EN is missing keys: ${missingEn.join(', ')}`);
  assert(missingZh.length === 0, `ZH is missing keys: ${missingZh.join(', ')}`);
  const used = new Set([...clientSource.matchAll(/\bt\('([^']+)'\)/g)].map((match) => match[1]));
  const missing = [...used].filter((key) => zh.has(key) === false);
  assert(missing.length === 0, `t() keys missing from dictionaries: ${missing.join(', ')}`);
  return `${zh.size} keys used in both languages (${used.size} referenced)`;
});

check('component class names exist in the stylesheet', () => {
  const declared = new Set([...clientSource.matchAll(/\.(dv-[a-z0-9-]+)/g)].map((match) => match[1]));
  const used = new Set();
  for (const match of clientSource.matchAll(/className:\s*'([^']+)'/g)) {
    for (const name of match[1].split(/\s+/)) if (name.length > 0) used.add(name);
  }
  assert(used.size > 0, 'no className strings found');
  const missing = [...used].filter((name) => declared.has(name) === false);
  assert(missing.length === 0, `class names without CSS rules: ${missing.join(', ')}`);
  return `${used.size} class names, ${declared.size} styled`;
});

check('inline stylesheet is structurally sane', () => {
  const start = clientSource.indexOf('const CSS = `');
  const end = clientSource.indexOf('`;\n    //#endregion', start);
  assert(start >= 0 && end > start, 'CSS template literal not found');
  const css = clientSource.slice(start, end);
  assert(css.includes('${') === false, 'CSS template literal contains ${} interpolation');
  let depth = 0;
  for (const character of css) {
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    assert(depth >= 0, 'unbalanced CSS closing brace');
  }
  assert(depth === 0, `unbalanced CSS braces (depth ${depth})`);
  for (const token of ['--dsw-alias-', '--dsh-frame-leading-clearance', 'prefers-reduced-motion']) {
    assert(css.includes(token), `stylesheet is missing expected token/guard "${token}"`);
  }
  return `${Math.round(css.length / 1024)} KiB CSS, balanced braces`;
});

check('P0-005: sidebar entry registration matches the verified list contract', () => {
  assert(clientSource.includes("name: 'sidebar.panellist'"), 'sidebar entry registration not found');
  assert(clientSource.includes('id: PANEL_ID'), 'sidebar entry must address the same id as the main panel');
  assert(clientSource.includes('order: SIDEBAR_ORDER'), 'sidebar entry must declare its native order');
  assert(clientSource.includes('label: sidebarLabel'), 'sidebar entry must declare the locale-aware label thunk');
  assert(clientSource.includes('const SIDEBAR_ORDER = 30'), 'sidebar order should sit after the shipped panel rows (0/10/20)');
  assert(clientSource.includes("ctx.slots.inject('sidebar.panellist'"), 'sidebar entry must follow declaration lifetimes through slots.inject');
  assert(clientSource.includes("ctx.slots.inject('main'"), 'main panel declaration hook missing');
  assert(clientSource.includes("name: 'main'") && clientSource.includes('key: PANEL_ID'), 'main panel key must stay dsh-video');
  assert(clientSource.includes("'nav.label': 'dsh-video-editor'"), 'exact user-requested label spelling missing from locale dictionaries');
  assert(clientSource.indexOf("'nav.label': 'dsh-video-editor'") !== clientSource.lastIndexOf("'nav.label': 'dsh-video-editor'"), 'label must exist in both shipped dictionaries');
  return 'native sidebar.panellist id/order/label + main key';
});

check('P0-005: the video panel and sidebar entry form one atomic pair', () => {
  const applyStart = clientSource.indexOf('function apply(ctx)');
  const applyEnd = clientSource.indexOf('return { inject: inject, apply: apply }');
  assert(applyStart >= 0 && applyEnd > applyStart, 'apply body not found');
  const applyBody = clientSource.slice(applyStart, applyEnd);
  const entryStart = applyBody.indexOf('function registerPanelAndEntry()');
  assert(entryStart >= 0, 'missing declaration-scoped registration entry point');
  const entryEnd = applyBody.indexOf('mainController = ctx.slots.inject', entryStart);
  assert(entryEnd > entryStart, 'main registration call site not found');
  const entryBody = applyBody.slice(entryStart, entryEnd);
  const panelIndex = entryBody.indexOf("name: 'main'");
  const sidebarIndex = entryBody.indexOf("name: 'sidebar.panellist'");
  assert(panelIndex >= 0, 'main panel registration missing from the declaration path');
  assert(sidebarIndex > panelIndex, 'the sidebar entry must only be registered after the video panel');
  assert(entryBody.includes('releaseCycle'), 'missing atomic pair release path');
  const sidebarRelease = entryBody.indexOf('target.sidebarDispose');
  const panelRelease = entryBody.indexOf('target.mainDispose');
  assert(sidebarRelease >= 0 && panelRelease > sidebarRelease, 'the sidebar entry must be released before the video panel');
  assert(entryBody.includes('settleSelection'), 'missing conversation fallback when the entry is lost');
  assert(entryBody.includes('sidebar-entry-unavailable'), 'missing unreachable-panel guard');
  assert(entryBody.includes('sidebar-register-failed'), 'missing sidebar registration failure containment');
  return 'panel -> entry pair, entry released first, retried per declaration';
});

check('P0-005: the old top capsule and its presentation machinery are gone', () => {
  const removed = ['dv-mode', 'thumbOrigin', 'conversation.header.leading', 'LeadingModeSwitch', 'dv-simplify'];
  for (const needle of removed) assert(clientSource.includes(needle) === false, `client.js still contains removed capsule code "${needle}"`);
  return 'no mode capsule / thumb origin / leading seat / stage framing code';
});

check('P0-005: panel transition is short and honours the system reductions', () => {
  assert(clientSource.includes('animation:dv-panel-in var(--dv-dur-med)'), 'panel entry must use the short motion token');
  assert(clientSource.includes('--dv-dur-med:160ms'), 'panel transition should stay within the 120-180ms range');
  assert(clientSource.includes('@media (prefers-reduced-motion: reduce)'), 'reduced-motion media query missing');
  assert(clientSource.includes('@media (prefers-reduced-transparency: reduce)'), 'reduced-transparency media query missing');
  return '160ms panel fade; system reduced-motion/reduced-transparency honoured';
});

check('P0-005: empty state is one exact sentence with no future-feature copy', () => {
  assert(clientSource.includes("'video.empty': '尚无工程'"), 'the empty state must be exactly 尚无工程');
  assert(clientSource.includes("'video.empty': 'No project yet'"), 'English empty state missing');
  const forbidden = ['空工作区', '从一个想法', '视频工作区已经接入', '当前阶段只验证', '工程创建将在后续阶段开放', '尚未包含工程', 'DSH Video · 原生工作区'];
  for (const needle of forbidden) assert(clientSource.includes(needle) === false, `client.js still contains removed copy "${needle}"`);
  return 'one empty-state sentence; old explanatory copy removed';
});

check('P3-016: the plugin display settings and their preference storage are gone', () => {
  for (const needle of [
    'simplifiedEffects',
    'data-simplified',
    'video.display.label',
    'video.display.simplified',
    'dsh-video.ui.v1',
    'DisplayOptionsIcon',
    'dv-menu-item',
    'menuitemcheckbox',
  ]) {
    assert(clientSource.includes(needle) === false, `removed display-setting code is still present: ${needle}`);
  }
  // The system preferences remain the only reduction source.
  assert(clientSource.includes('@media (prefers-reduced-motion: reduce)') && clientSource.includes('@media (prefers-reduced-transparency: reduce)'), 'system reduction adapters were removed with the plugin setting');
  return 'gear menu / simplified effects / UI preference storage removed; system reductions kept';
});

check('P3-016: the AI pane is draggable, keyboard-adjustable, resettable and persisted', () => {
  for (const marker of [
    'function normalizeAiPaneRatio(',
    'function aiPaneWidthCss(',
    'function stepAiPaneRatio(',
    'function clampAiPaneWidth(',
    'AI_PANE_DEFAULT_RATIO = 0.42',
    'AI_PANE_MIN_WIDTH = 320',
    'AI_PANE_MAX_WIDTH = 720',
    'LEFT_PANE_MIN_WIDTH = 360',
    "LAYOUT_PREFS_KEY = 'dsh-video.layout.v1'",
    "role: 'separator'",
    "'aria-orientation': 'vertical'",
    'onSplitterPointerDown',
    'onSplitterPointerMove',
    'onSplitterPointerUp',
    'onDoubleClick: resetAiPaneRatio',
    'onKeyDown: onSplitterKeyDown',
    "event.key === 'ArrowLeft'",
    "event.key === 'ArrowRight'",
    'writeLayoutPrefs(aiPaneRatioRef.current)',
    "style: { '--dv-ai-width': aiPaneWidthCss(aiPaneRatio) }",
    'width:var(--dv-ai-width, clamp(320px, 42%, min(720px, calc(100% - 360px))))',
  ]) {
    assert(clientSource.includes(marker), `resizable AI pane marker missing: ${marker}`);
  }
  assert(clientSource.includes('width:clamp(340px, 34%, 440px)') === false, 'the old fixed AI width is still present');
  // The narrow container keeps the stacked layout and hides the horizontal hand.
  assert(clientSource.includes('.dv-splitter{display:none;}'), 'the splitter must disappear when the panes stack');
  assert(clientSource.includes('document.addEventListener') === false, 'no document listener is allowed');
  const canvasStart = clientSource.indexOf('function CanvasWorkspace');
  const canvasEnd = clientSource.indexOf('function VideoWorkspace');
  assert(canvasStart >= 0 && canvasEnd > canvasStart, 'canvas component boundary not found for listener audit');
  const outsideCanvas = clientSource.slice(0, canvasStart) + clientSource.slice(canvasEnd);
  assert(outsideCanvas.includes('window.addEventListener') === false, 'global listeners outside the scoped canvas runtime channel are forbidden');
  return '42% default / 720px cap / left floor / double-click reset / arrow keys / versioned ratio; no global listeners';
});

check('P3-016: the topbar renames the project inline and keeps the picker separate', () => {
  for (const marker of [
    "hostRequest('project.rename'",
    "className: 'dv-project-name'",
    "className: 'dv-project-name-input'",
    'dv-project-toggle',
    'function projectMenu()',
    'function projectChoiceTitle(',
    'function startRename()',
    'function cancelRename()',
    'async function submitRename()',
    'onKeyDown: onRenameKeyDown',
    "event.key === 'Enter'",
    "event.key === 'Escape'",
    "t('video.project.renameHint')",
    "t('video.project.renameEmpty')",
    "'data-project-id': projectId",
    'const title = typeof entry.title ===',
    'if (typeof project.title ===',
  ]) {
    assert(clientSource.includes(marker), `project title/rename marker missing: ${marker}`);
  }
  assert(clientSource.includes("'video.project.rename':"), 'rename action copy is missing from the dictionaries');
  // Rename must never be wired to a project/revision write path.
  const renameStart = clientSource.indexOf('async function submitRename()');
  const renameEnd = clientSource.indexOf('// ── P3-016 draggable split', renameStart);
  assert(renameStart >= 0 && renameEnd > renameStart, 'rename implementation boundary missing');
  const renameBody = clientSource.slice(renameStart, renameEnd);
  for (const forbidden of ['project.compose', 'edit', 'expectedRevision', 'operationId', 'preview.snapshot']) {
    assert(renameBody.includes(forbidden) === false, `rename must stay metadata-only; found "${forbidden}"`);
  }
  return 'left-aligned name -> inline rename (Enter/Esc) + separate picker; metadata-only request';
});

check('P3-016: Host rename is UI-only and project.list reports the optional title', () => {
  const bridge = read('host/bridge.js');
  assert(bridge.includes("'project.rename'"), 'Host request allowlist is missing project.rename');
  assert(bridge.includes("'project.rename': ['projectId', 'title']"), 'Host params allowlist is missing project.rename');
  assert(bridge.includes('if (method === \'project.rename\')') && bridge.includes('is a UI-only action'), 'rename is not gated as a UI-only action');
  assert(bridge.includes('Project renaming is a UI-only action'), 'rename Tool-source rejection copy missing');
  assert(bridge.includes('async function readManifestTitle('), 'project.list title reader missing');
  assert(bridge.includes('projects.push({ projectId, updatedAt, title })'), 'project.list does not expose the optional title');
  assert(bridge.includes('title: projectTitle(params.title)'), 'rename params are not normalized to the trimmed title');
  return 'UI-only project.rename with trimmed title; project.list title is advisory';
});

check('P0-005: sidebar icon follows the host owner props and native stroke', () => {
  assert(clientSource.includes('function SidebarVideoIcon(props)'), 'sidebar icon component missing');
  assert(clientSource.includes('props.size'), 'sidebar icon must honour the host-provided square edge');
  assert(clientSource.includes("stroke: 'currentColor'"), 'sidebar icon must follow the row colour with currentColor');
  assert(clientSource.includes("viewBox: '0 0 16 16'"), 'sidebar icon should use the host 16-unit line-icon grid');
  assert(clientSource.includes("'aria-hidden': 'true'"), 'sidebar icon must be hidden from the accessible name (the host row carries the label)');
  return '16-viewBox currentColor line glyph sized by the host';
});

check('P2-002-B: committed runtime carries no development/deployment absolute paths', () => {
  const runtime = ['index.js', 'client.js'];
  for (const name of readdirSync(join(ROOT, 'host')).filter((entry) => entry.endsWith('.js'))) runtime.push('host/' + name);
  for (const name of runtime) {
    const source = read(name);
    for (const forbidden of ['/Users/', '/Applications/', 'process.execPath']) {
      assert(source.includes(forbidden) === false, `${name} hard-codes or adopts unsupported runtime detail "${forbidden}"`);
    }
  }
  assert(!Object.values(pkg.dependencies||{}).some(value=>/^(file:|link:|\/)/.test(value)), 'published dependencies must not use local filesystem paths');
  return `${runtime.length} runtime files, no absolute dev/deployment paths`;
});

// P2-004 R1 (one manual title/timing target) is superseded by P3-012: the manual
// property form is no longer rendered in the product UI. The single-target
// helpers stay in the hidden default-false canvas path and are asserted as such.
check('P3-012: the product workspace is a read-only auto preview', () => {
  assert(clientSource.includes('function CanvasWorkspace'), 'canvas preview component missing');
  assert(clientSource.includes('const previewOnly = props.previewOnly === true'), 'CanvasWorkspace must default previewOnly to false and enable the read-only mode only when asked');
  assert(clientSource.includes("'data-preview-only'"), 'the preview-only marker is missing');
  assert(clientSource.includes('previewOnly: true'), 'the product workspace must mount the canvas read-only');
  assert(clientSource.includes('const REVISION_POLL_MS = 1500'), 'the read-only preview must follow the Host revision on the 1.5s poll');
  assert(clientSource.includes('setInterval(function pollRevision()'), 'automatic revision polling effect missing');
  assert(clientSource.includes("hostRequest('preview.snapshot'"), 'the preview does not request worker snapshots');
  assert(clientSource.includes("hostRequest('inspect'"), 'revision polling does not inspect the project');
  assert(clientSource.includes('project.scenes.length > 0') === false, 'the preview must not be gated on the legacy Scenes list');
  assert(clientSource.includes('data-canvas-revision') && clientSource.includes('data-canvas-phase'), 'canvas revision/phase markers missing');
  return 'previewOnly canvas + 1500ms inspect poll + snapshot follow';
});

check('P3-012: an AI publish appears automatically and failures stay recoverable', () => {
  assert(clientSource.includes('next.revision !== latestRevisionRef.current'), 'a changed revision must replace the preview state');
  assert(clientSource.includes('projectIdRef.current !== followedProjectId'), 'late/stale poll results must not overwrite the current project');
  assert(clientSource.includes('A transient poll failure keeps the last valid preview mounted'), 'poll failure handling comment/behaviour missing');
  assert(clientSource.includes("t('video.canvas.retry')"), 'preview retry affordance missing');
  assert(clientSource.includes('setProject(next)'), 'the changed revision is not adopted');
  assert(clientSource.includes("'video.frame.empty':") && clientSource.includes("t('video.frame.empty')") === false, 'the removed legacy no-frame copy is still rendered');
  assert(clientSource.includes("t('video.preview.retry')"), 'recoverable project/preview retry copy missing');
  return 'revision poll swaps the snapshot; recoverable failure copy + retry';
});

check('R2: the last valid preview survives candidate load/failure (dual-instance handoff)', () => {
  // Hidden candidate iframe + visible active iframe, same composition size.
  assert(clientSource.includes('dv-stage-frame-candidate'), 'hidden candidate iframe class is missing');
  assert((clientSource.match(/visibility: visible \? 'visible' : 'hidden'/g) || []).length >= 1, 'the candidate iframe is not visually hidden');
  assert((clientSource.match(/'aria-hidden': visible \? 'false' : 'true'/g) || []).length >= 1, 'the candidate iframe is not aria-hidden');
  assert(clientSource.includes("'data-canvas-target-revision'"), 'the requested revision marker is missing');
  assert(clientSource.includes("'data-canvas-revision': active !== null ? active.revision : ''"), 'the revision marker must name only the active displayed composition');
  assert(clientSource.includes("'data-canvas-phase': phase"), 'the phase marker is missing');
  // Promotion only on the candidate runtime ready proof; failure keeps the active.
  assert(clientSource.includes('function promoteCandidate('), 'candidate promotion gate is missing');
  assert(clientSource.includes("outcome.type === 'ready' || outcome.type === 'state'"), 'the candidate is not promoted on a runtime ready proof');
  assert(clientSource.includes('function failCandidate('), 'retention failure path is missing');
  assert(clientSource.includes("if (activeRef.current !== null) {\n          setPreviewNotice(hostError(error));\n          setPhase('ready');"), 'a candidate failure with an active composition does not stay ready with a notice');
  assert(clientSource.includes("className: 'dv-preview-notice', role: 'alert'"), 'compact candidate-failure notice is missing');
  assert(clientSource.includes("if (phase === 'error' && active === null)"), 'the first-load full recoverable error path is missing');
  // Release the outgoing snapshot only after a successful switch.
  const promoteIndex = clientSource.indexOf('function promoteCandidate(');
  const promoteBody = clientSource.slice(promoteIndex, clientSource.indexOf('async function loadTarget(', promoteIndex));
  assert(promoteBody.includes('setActive(instance)') && promoteBody.includes('settleInstance(previous)'), 'the outgoing instance is not released inside the successful switch');
  assert(promoteBody.indexOf('releaseSnapshot(previous)') > promoteBody.indexOf('setActive(instance)'), 'the outgoing snapshot is released before the successful switch');
  assert(clientSource.includes("hostRequest('preview.release'"), 'the old Host snapshot is never released');
  assert(clientSource.includes('function snapshotInstance(') && clientSource.includes('instance.ledger.accept('), 'runtime messages are not routed to their own instance ledger');
  assert(clientSource.includes("unmountEpochRef"), 'unmount release is not guarded against test/re-render cleanups');
  return 'hidden candidate preload, ready-gated promotion, retained active on failure, notice+retry, post-switch release';
});

check('R2F: preview geometry/duration is per instance, not taken from the latest target props', () => {
  // Each snapshot instance owns its composition metadata, captured from the
  // requested revision's inspected metadata and reused by retries.
  assert(clientSource.includes('function metadataForRevision(revisionId)'), 'per-revision metadata lookup is missing');
  assert(clientSource.includes('inspectedMetaRef.current.set(inspected.revision, inspectedMeta)'), 'the inspected revision metadata is not recorded per revision');
  assert(clientSource.includes('function snapshotInstance(next, restore, metadata)'), 'snapshot instances do not capture their own metadata');
  assert(clientSource.includes("width: canvasNumber(meta.width, 1280)"), 'snapshot instance width is not bound to the requested revision');
  assert(clientSource.includes("height: canvasNumber(meta.height, 720)"), 'snapshot instance height is not bound to the requested revision');
  assert(clientSource.includes('duration: Math.max(0, canvasNumber(meta.duration, 0))'), 'snapshot instance duration is not bound to the requested revision');
  // The visible display derives from the ACTIVE instance; the candidate may only
  // drive the display while no active composition exists yet.
  assert(clientSource.includes('const displayMeta = active !== null ? active : candidate !== null ? candidate : inspectedMeta;'), 'display metadata is not derived from the active instance');
  assert(clientSource.includes('const displayDuration = displayMeta.duration;'), 'display duration is not derived per instance');
  assert(clientSource.includes('max: String(displayDuration || 1)'), 'seek.max is not driven by the active instance duration');
  assert(clientSource.includes("formatSeconds(time) + ' / ' + formatSeconds(displayDuration)"), 'the duration label is not driven by the active instance duration');
  assert(clientSource.includes('Math.min(displayDuration, Number(nextTime) || 0)'), 'seek-time clamp is not driven by the active instance duration');
  assert(clientSource.includes("width: instance.width + 'px'") && clientSource.includes("height: instance.height + 'px'"), 'the visible candidate iframe is not sized from its own metadata');
  assert(clientSource.includes('stageSize.width / instance.width, stageSize.height / instance.height'), 'per-instance iframe scaling is missing');
  assert(clientSource.includes('x > displayWidthPx || y > displayHeightPx'), 'hit-test mapping is not using the active display metadata');
  assert(clientSource.includes('composition: { width: displayWidthPx, height: displayHeightPx }'), 'manual layout mapping is not using the displayed composition box');
  // Promotion clamps/restores against the new instance's own duration and swaps
  // the display metadata in the same state update.
  assert(clientSource.includes('Math.min(restore.time, instance.duration)') && clientSource.includes('Math.min(timeRef.current, instance.duration)'), 'promotion does not clamp to the new instance duration');
  assert(clientSource.includes('setTime(clampedTime)'), 'promotion does not switch the time atomically with the display metadata');
  // Regressions of the old global-prop behaviour must stay gone.
  assert(clientSource.includes("width: width + 'px'") === false && clientSource.includes("height: height + 'px'") === false, 'the iframe still uses the latest target props geometry');
  assert(clientSource.includes('max: String(duration || 1)') === false, 'the seek range still uses the latest target props duration');
  assert(clientSource.includes("formatSeconds(time) + ' / ' + formatSeconds(duration)") === false, 'the duration label still uses the latest target props duration');
  return 'per-instance metadata map + active-driven display + per-instance candidate sizing + atomic promotion switch';
});

check('P3-012: first open auto-opens or provisions a working creation conversation', () => {
  assert(clientSource.includes("hostRequest('project.list'"), 'the workspace must list projects on mount');
  assert(clientSource.includes('managedProjectChoices'), 'the managed-project filter is missing');
  assert(clientSource.includes('id === DEMO_PROJECT_ID'), 'demo/legacy projects must be filtered out of the product list');
  assert(clientSource.includes('rememberedAvailable'), 'the remembered project must be validated against the current list');
  assert(clientSource.includes('listed.defaultProjectId'), 'the Host default project is not honoured');
  assert(clientSource.includes('provisionProject'), 'auto-provisioning path missing');
  assert(clientSource.includes("hostRequest('project.create'"), 'auto-provision must use the existing project.create');
  assert(clientSource.includes("hostRequest('session.create', { projectId: targetProjectId, requestId: operationId() })"), 'auto-provision must create one Session with a dedupe requestId');
  assert(clientSource.includes('autoProvisionedRef'), 'auto-provisioning must be guarded against a double effect');
  assert(clientSource.includes('autoSessionProjectRef') && clientSource.includes('ensureProjectSession'), 'one auto Session per project is not guarded');
  assert(clientSource.includes("hostRequest('open'"), 'the selected project is not opened on the Host');
  return 'project.list -> remembered/default/most recent -> open + bound Session (auto-create once)';
});

check('P3-012: the legacy PNG/form editor and demo entry are gone from the product UI', () => {
  const removed = [
    "className: 'dv-editor'",
    "className: 'dv-stagebar'",
    'dsh-video-target',
    'dsh-video-title',
    'dsh-video-frame-time',
    'openSample',
    '"data-project-title"',
  ];
  for (const needle of removed) assert(clientSource.includes(needle) === false, `product client still renders/uses removed editor surface "${needle}"`);
  for (const key of ['video.open', 'video.update', 'video.save', 'video.export', 'video.details', 'video.target', 'video.frameTime']) {
    assert(clientSource.includes(`t('${key}')`) === false, `product UI still references removed manual-editing copy key "${key}"`);
  }
  // The native conversation, its history and the file-preview overlay stay.
  for (const kept of ['h(SessionConversationHost', 'function historyMenu', 'function previewOverlay', 'onClickCapture: capturePreviewClick']) {
    assert(clientSource.includes(kept), `native conversation surface is missing "${kept}"`);
  }
  // The hidden default-false manual canvas path must stay intact.
  for (const helper of ['function commitLayout', 'function submitText', 'function addScene', 'function historyStep', 'function exportVideo', 'function beginDrag', 'function openTextEditor']) {
    assert(clientSource.includes(helper), `hidden manual canvas helper was deleted instead of hidden: ${helper}`);
  }
  return 'no legacy editor/demo entry; native conversation kept; manual path retained behind previewOnly=false';
});

check('P2-004 R2: Tool result budget is one raw UTF-8 byte constant without truncation', () => {
  const tool = read('host/tool.js');
  assert(read('host/limits.js').includes('TOOL_RESULT_BYTES = 64 * 1024'), 'shared UTF-8 byte budget missing');
  assert(tool.includes('TOOL_RESULT_BYTES'), 'Tool does not use the shared byte budget');
  assert(tool.includes('slice(0, 8000)') === false && tool.includes('TEXT_LIMIT') === false, 'Tool still truncates at an 8000-character limit');
  assert(tool.includes('E_RESULT_LIMIT'), 'over-budget Tool result lacks E_RESULT_LIMIT');
  return 'shared 64KiB UTF-8 budget; explicit E_RESULT_LIMIT';
});

check('P2-004 R3: real-engine runner imports staged Host and verifies integrity', () => {
  const runner = read('scripts/test-host-engine.mjs');
  assert(runner.includes("from '../host/bridge.js'") === false, 'real-engine runner still imports the development worktree Host');
  assert(runner.includes('loadStagedHost('), 'real-engine runner does not use the staged Host loader');
  assert(read('scripts/lib/staged-host.mjs').includes('hostModuleSha256'), 'staged Host verifier does not record the executed Host digest');
  return 'staged host module + INTEGRITY digest verification';
});

check('P2-004 R4: client version gate is a strict complete semver comparison', () => {
  const bridge = read('host/bridge.js');
  assert(bridge.includes('MIN_EXPLICIT_SPAWN_CLIENT'), 'minimum explicit-spawn client version missing');
  assert(bridge.includes('compareVersion(parsed, MIN_EXPLICIT_SPAWN_CLIENT)'), 'semantic version comparison missing');
  assert(bridge.includes('Number(part) || 0') === false, 'version parsing still coerces invalid parts to 0');
  return '>=0.1.1 complete semver; no coercion';
});

check('P2-002-B: Host modules do not import DSH-internal packages', () => {
  for (const name of readdirSync(join(ROOT, 'host')).filter((entry) => entry.endsWith('.js'))) {
    const source = read('host/' + name);
    assert(source.includes('@deepseek-ai/') === false, `host/${name} imports a DSH-internal package`);
  }
  return 'node builtins + explicit engine package specifiers only';
});

// P2-006 R2/R3 are superseded by P3-012: frame/render jobs and the manual
// title/timing form left the product UI (manual editing deferred). The hidden
// default-false canvas keeps its own copy; the product preview error path is
// asserted by the P3-012 checks and the smoke test.
check('P3-012: the product panel renders no deferred manual-editing controls', () => {
  assert((clientSource.match(/previewOnly \? null : h\('button'/g) || []).length >= 3, 'undo/redo/add-scene buttons are not gated by previewOnly');
  assert(clientSource.includes('drawerOpen && previewOnly === false'), 'the manual materials drawer is not gated by previewOnly');
  assert(clientSource.includes("previewOnly ? null : h(\n          'div',\n          { className: 'dv-canvas-tools' }"), 'the manual tools row is not gated by previewOnly');
  assert(clientSource.includes("const previewOnly = props.previewOnly === true"), 'previewOnly mode flag missing');
  for (const manual of ['video.canvas.undo', 'video.canvas.redo', 'video.canvas.materials', 'video.canvas.addScene', 'video.canvas.export', 'video.canvas.sceneColor', 'video.canvas.textStyle']) {
    assert(clientSource.includes(`t('${manual}')`), `hidden manual capability was deleted instead of hidden: ${manual}`);
  }
  // The rendered product marks its mode so the smoke test can prove absence.
  assert(clientSource.includes("'data-preview-only': previewOnly ? 'true' : 'false'"), 'preview-only marker not exposed on the canvas shell');
  return 'manual controls exist only behind previewOnly=false; product mode marker exposed';
});

check('P3-012: read-only preview copy exists at dictionary parity', () => {
  for (const key of ['video.preview.booting', 'video.preview.empty', 'video.preview.retry']) {
    const occurrences = (clientSource.match(new RegExp("'" + key.replace(/\./g, '\\.') + "':", 'g')) || []).length;
    assert(occurrences === 2, `locale key ${key} must exist in both dictionaries (found ${occurrences})`);
  }
  for (const key of ['video.canvas.play', 'video.canvas.pause', 'video.canvas.timeline', 'video.canvas.loading', 'video.canvas.retry']) {
    assert(clientSource.includes(`t('${key}')`), `read-only preview control copy missing: ${key}`);
  }
  return 'booting/empty/retry keys in both dictionaries; play/pause/seek reused';
});

check('P2-005 R1: primary button uses existing paired host tokens', () => {
  assert(clientSource.includes('--dsw-alias-label-on-brand') === false, 'primary button still uses the nonexistent label-on-brand token');
  const start = clientSource.indexOf('.dv-button-primary{');
  const end = clientSource.indexOf('.dv-button-quiet', start);
  assert(start >= 0 && end > start, 'primary button CSS block not found');
  const block = clientSource.slice(start, end);
  for (const token of ['--dsw-alias-button-primary-fill', '--dsw-alias-button-primary-hover', '--dsw-alias-button-primary-dimmed', '--dsw-alias-label-primary-foreground']) {
    assert(block.includes(token), `primary button is missing paired host token ${token}`);
  }
  assert(/color:var\(--dsw-alias-label-primary-foreground/.test(block), 'primary button foreground is not the paired inverted/foreground token');
  return 'button-primary-fill/hover/dimmed + label-primary-foreground';
});

check('P3-012: the Host project.list contract is tolerated defensively', () => {
  assert(clientSource.includes('Array.isArray(result.projects)'), 'project.list projects array is not defended');
  assert(clientSource.includes('Number.isFinite(Number(entry.updatedAt))'), 'a missing/stat-failure updatedAt must default to 0');
  assert(clientSource.includes('choices.sort'), 'managed projects are not sorted for auto-open');
  assert(clientSource.includes("typeof listed.defaultProjectId === 'string'"), 'the Host defaultProjectId is not read defensively');
  assert(clientSource.includes("hostRequest('project.list'"), 'the workspace does not call the project list');
  assert(clientSource.includes('function stageContent'), 'the left preview surface component is missing');
  return 'projects/updatedAt/defaultProjectId defended; sorted managed choices';
});

check('P0-005: mode wiring is host-owned and has no local mode source', () => {
  assert(clientSource.includes("const PANEL_ID = 'dsh-video'"), 'main-panel key must be dsh-video');
  assert(clientSource.includes('selectPanel'), 'navigation must go through ctx.layout.selectPanel');
  assert(clientSource.includes('usePanelInfo') === false, 'the sidebar row already owns selection; no panel-local mode hook is needed');
  assert(clientSource.includes('sidebar.panellist') === true && clientSource.includes('shell.overlay') === false, 'must use the supported sidebar list, not an overlay');
  return 'host-owned selection, native sidebar list, no local mode boolean';
});

check('P3-006-A: the panel embeds the native Conversation through a private session child', () => {
  const bridge = read('host/bridge.js');
  assert(clientSource.includes("const SESSION_SOURCE = 'videoView'"), 'the plugin must retain with its own videoView source, never mainView');
  assert(clientSource.includes("const SESSION_CHILD_SLOT = 'dsh-video.chat'"), 'the private session child slot name is missing');
  assert(clientSource.includes('children[SESSION_CHILD_SLOT] = { kind: \'single\', scope: \'session\' }'), 'the main registration must declare a session-scope private child for the kit');
  assert(clientSource.includes('renderFactorySlot(\n        \'conversation.content\''), 'the native conversation.content Factory is not rendered');
  assert(clientSource.includes("variant: 'embedded'"), 'the plugin must render the embedded occurrence');
  assert(clientSource.includes('hero: false'), 'embedded occurrence must never enable the hero workspace navigation');
  assert(clientSource.includes("props.renderSlot('conversation.session', { view: 'chat' })"), 'the embedded local view must lock the Chat view');
  assert(clientSource.includes('hostConversationOpen'), 'the panel must guard a visible host conversation');
  assert(clientSource.includes('data-session-kit'), 'the read-only session kit preflight marker is missing');
  assert(bridge.includes("'session.list'") && bridge.includes("'session.diagnose'"), 'the Host bridge does not allowlist the session methods');
  return 'videoView source, private child, embedded/hero:false/Chat, kit preflight';
});

check('P3-006-A: Tool scope comes from the trusted Agent, not from tool arguments', () => {
  const tool = read('host/tool.js');
  const bridge = read('host/bridge.js');
  const sessions = read('host/sessions.js');
  assert(tool.includes('agentSessionIdFromToolExec(exec)'), 'the Tool does not extract the trusted Agent identity');
  assert(tool.includes("source: 'tool', agentSessionId"), 'the Tool does not pass the trusted identity to the dispatcher');
  assert(bridge.includes('async assertToolScope('), 'the bridge does not enforce the Session/project mapping');
  assert(bridge.includes("E_AGENT_REQUIRED") && bridge.includes("E_PROJECT_SCOPE") && bridge.includes("E_SESSION_NOT_BOUND"), 'scope rejection codes are missing');
  assert(sessions.includes('agentSessionIdFromToolExec') && sessions.includes('agent.session.id'), 'the central Agent identity adapter is missing');
  assert(bridge.includes('projectFacts(') && sessions.includes('systemPrompt.context('), 'live project context wiring is missing');
  return 'trusted exec.agent session, mapping check, job owner check, live context';
});

check('P3-006-A: Host session state is versioned, trusted and atomically written', () => {
  const state = read('host/session-state.js');
  const config = read('host/config.js');
  const sessions = read('host/sessions.js');
  assert(config.includes("'sessionStatePath'") && config.includes("'sessionCwd'"), 'trusted session configuration keys are missing');
  assert(state.includes('SESSION_STATE_VERSION = 1'), 'session state is not versioned');
  assert(state.includes('rename(temporary, this.path)'), 'session state is not written through write-temp + rename');
  assert(state.includes('E_SESSION_STATE_CORRUPT') && state.includes('E_SESSION_STATE_VERSION'), 'corrupt/unknown-version state is not typed');
  assert(sessions.includes('controller.create({ cwd })'), 'Session creation does not use the trusted controller/cwd');
  assert(sessions.includes('this.store.addSession(projectId, sessionId, true)'), 'the returned Session id is not persisted before success');
  assert(state.includes('E_SESSION_ALREADY_BOUND'), 'cross-project binding rejection is missing');
  return 'sessionStatePath/sessionCwd, v1 atomic store, controller creation, mapping write-back';
});

check('P3-006-C: embedded file preview is local, Session-scoped and byte-bounded', () => {
  const bridge = read('host/bridge.js');
  const preview = read('host/preview.js');
  const config = read('host/config.js');
  const routes = read('host/routes.js');
  assert(clientSource.includes('onClickCapture: capturePreviewClick'), 'the embedded AI surface does not intercept file preview clicks locally');
  assert(clientSource.includes("hostRequest('preview'"), 'the client does not call the bounded preview route');
  assert(clientSource.includes('sidebarRight') === false, 'the client must not patch or call the global sidebarRight service');
  assert(clientSource.includes('dv-preview-image') && clientSource.includes("'video.preview.denied'"), 'preview overlay or explicit error copy is missing');
  assert(bridge.includes("'preview'") && bridge.includes('readPreviewFile') && bridge.includes('E_PROJECT_SCOPE'), 'Host preview route is not Session/project scoped');
  assert(bridge.includes("settings.source === 'tool'") && bridge.includes('Preview is a UI-only action'), 'preview must stay out of the model Tool surface');
  assert(preview.includes('IMAGE_EXTENSIONS') && preview.includes('sniffImageMediaType') && preview.includes('realpath('), 'preview does not validate image bytes and canonical roots');
  assert(config.includes("'maxPreviewBytes'"), 'the trusted preview byte limit is missing');
  assert(routes.includes('E_PREVIEW_DENIED') && routes.includes('E_PREVIEW_UNSUPPORTED') && routes.includes('E_PREVIEW_LIMIT'), 'preview error statuses are missing');
  return 'local capture, session/project scope, realpath roots, magic-byte validation, byte limit';
});

check('P3-008: managed canvas is snapshot-bound, sandboxed and Host-authoritative', () => {
  const bridge = read('host/bridge.js');
  const snapshot = read('host/snapshot.js');
  const stage = read('scripts/stage-dev.mjs');
  assert(clientSource.includes('function CanvasWorkspace'), 'canvas workspace component missing');
  assert(clientSource.includes("sandbox: 'allow-scripts'"), 'snapshot iframe must use allow-scripts only');
  assert(clientSource.includes('postSlotCommand') && clientSource.includes('postActiveCommand') && clientSource.includes('hitTest'), 'runtime command channel is missing');
  assert(clientSource.includes('preview.snapshot'), 'client does not request worker snapshots');
  assert(clientSource.includes('event.source !== frame.contentWindow'), 'canvas messages are not bound to the iframe WindowProxy');
  assert(clientSource.includes('data-canvas-revision'), 'canvas does not expose its snapshot revision');
  assert(bridge.includes("'project.create'") && bridge.includes("'scene.create'") && bridge.includes("'preview.snapshot'") && bridge.includes("'asset.import'"), 'Host managed method allowlist is incomplete');
  assert(bridge.includes('readManagedProjectMap') && bridge.includes('discoverManagedProjects'), 'managed project registry/allowlist discovery missing');
  assert(snapshot.includes('content-security-policy') && snapshot.includes("connect-src 'none'") && snapshot.includes('inlineScriptHashes'), 'snapshot route is missing CSP/hash hardening');
  assert(stage.includes('REVIEWED_ENGINE_PAIRS') && stage.includes("'0.4.0'") && stage.includes('MANAGED_ENGINE_VERSIONS') && stage.includes('projectsRoot'), 'staging does not restrict the reviewed engine pairs and prepare managed 0.4.0 snapshots');
  return 'snapshot iframe, fixed runtime/route CSP, managed project discovery, Host methods';
});

check('P3-008 R1: destructive Scene writes copy the complete authoritative template', () => {
  assert(clientSource.includes('function canvasCopySceneTemplate('), 'complete scene.template copier missing');
  assert(clientSource.includes('function canvasSceneTemplate('), 'scene.template copy helper missing');
  assert(clientSource.includes("hostRequest('inspect'"), 'Scene colour/shot writes must refresh the authoritative inspect first');
  assert(clientSource.includes('template.color = color') && clientSource.includes('template.shot = shot'), 'Scene writes do not change only their intended field');
  assert(clientSource.includes("'video.canvas.templateUnavailable'"), 'missing-template refusal copy is missing');
  assert(clientSource.includes('{ title: scene.title, duration: scene.duration, color: sceneColor }') === false, 'the old partial Scene template write is still present');
  // P3-008 review 02 R1: the client copy and the Host validator must accept the
  // frozen engine 0.3.2 long-text contract (UTF-16 length, title 1..2048,
  // subtitle/badge 0..2048) instead of the old 200/300/48 projection limits.
  assert(clientSource.includes('CANVAS_SCENE_TEXT_MAX = 2048') && (clientSource.match(/CANVAS_SCENE_TEXT_MAX/g) || []).length >= 4, 'client Scene template text bound is not the frozen 0.3.2 2048 limit');
  assert(clientSource.includes('value.title.length > 200') === false && clientSource.includes('value.subtitle.length > 300') === false && clientSource.includes('value.badge.length > 48') === false, 'client still rejects long text with the old 200/300/48 limits');
  const bridgeSource = read('host/bridge.js');
  assert(bridgeSource.includes('SCENE_TEXT_MAX = 2048') && (bridgeSource.match(/SCENE_TEXT_MAX/g) || []).length >= 4, 'Host Scene template text bound is not the frozen 0.3.2 2048 limit');
  assert(bridgeSource.includes('title.length > 200') === false && bridgeSource.includes('subtitle.length > 300') === false && bridgeSource.includes('badge.length > 48') === false, 'Host still rejects long text with the old 200/300/48 limits');
  return 'fresh inspect + complete frozen template copy + explicit refusal + 0.3.2 long-text limits';
});

check('P3-008 R2: layout writes are inverse-mapped from the inspected static base', () => {
  assert(clientSource.includes('function canvasStaticBase(') && clientSource.includes('function canvasLayoutPatch('), 'inverse-mapped layout helpers missing');
  assert(clientSource.includes('base: base'), 'drag capture does not keep the inspected static layout base');
  assert(clientSource.includes('canvasLayoutPatch({'), 'commitLayout does not use the inverse-mapped helper');
  assert(clientSource.includes('height: Math.round(preview.height * 1000) / 1000') === false, 'commitLayout still bakes the animated rect into the layout box');
  // R2F: the iframe is still kept at ITS composition size and CSS-scaled, but the
  // scale is now derived from the instance's own metadata (active vs candidate).
  assert(clientSource.includes("transformOrigin: 'top left'") && clientSource.includes("transform: 'scale(' + (instanceScale > 0 ? instanceScale : 1) + ')'"), 'the preview iframe is not kept at its composition size and CSS-scaled (runtime hit tests would use a letterboxed viewport)');
  assert(clientSource.includes('.dv-stage-frame{position:absolute;inset:0;width:100%;height:100%;') === false, 'the iframe stylesheet still stretches the iframe to the letterboxed stage');
  return 'static base + animation inverse mapping; composition-sized scaled iframe; no animated rect persisted';
});

check('P3-008 R5: inline text save binds one immutable attempt and keeps the draft', () => {
  assert(clientSource.includes('dv-editor-retry') && clientSource.includes('dv-editor-actions'), 'explicit retry affordance is missing from the inline editor');
  assert(clientSource.includes('function canvasIsRevisionConflict('), 'revision-conflict classification missing');
  assert(clientSource.includes('refreshRequired'), 'revision conflict does not require an explicit refresh step');
  assert(clientSource.includes('Keep the draft'), 'failure path does not document keeping the draft');
  // P3-008 review 02 R5: the operationId is bound to one frozen request, so an
  // exact retry replays the same operationId/expectedRevision/ops and a changed
  // draft settles the old attempt before a new id is minted.
  for (const marker of ['function makeTextAttempt(', 'function sendTextAttempt(', 'const frozen = editor.attempt', 'attempt: null', 'settledRevision', 'showAttemptFailure(']) {
    assert(clientSource.includes(marker), `immutable write-attempt marker missing: ${marker}`);
  }
  assert(clientSource.includes('The id is never switched while the old outcome is unknown'), 'immutable attempt comment missing');
  assert(clientSource.includes('frozen !== null && value !== frozen.value'), 'changed-draft settle branch is missing');
  assert(/sendTextAttempt\(frozen\)/.test(clientSource), 'exact frozen request is not re-sent before a new intent');
  assert(clientSource.includes('settledRevision = value') || clientSource.includes('const settledRevision ='), 'new intent does not use the settled revision');
  return 'frozen attempt id/expectedRevision/ops; exact retry replays it; changed draft settles then new id';
});

check('P3-008 R6: the parent restores the reviewed strict runtime message contract', () => {
  for (const marker of ['function canvasValidateEvent(', 'function canvasValidateCommand(', 'function canvasMessageLedger(', 'function settleInstance(instance)', 'CANVAS_EVENT_TYPES', 'E_STALE_SEQ', 'E_LATE_RESPONSE', 'E_UNCORRELATED']) {
    assert(clientSource.includes(marker), `strict runtime message marker missing: ${marker}`);
  }
  assert(clientSource.includes('event.source !== frame.contentWindow'), 'runtime events are not bound to the exact iframe WindowProxy');
  assert(clientSource.includes('function settleInstance(instance)') && (clientSource.match(/settleInstance\(/g) || []).length >= 5, 'pending commands are not explicitly settled per runtime instance');
  assert(clientSource.includes('function settleInstanceWaiter(instance, seq, payload)'), 'correlated waiters are not settled per instance');
  assert(clientSource.includes('const role = index === visibleSlotRef.current ? \'active\' : \'candidate\''), 'runtime events are not routed to the instance that owns the source iframe');
  return 'v1 envelope/allowlist/payload/seq + correlated replies + explicit pending settlement';
});

check('P3-008 R3: preview authorization is per project/Session provenance', () => {
  const bridge = read('host/bridge.js');
  assert(bridge.includes('async previewRoots(') && bridge.includes('artifactOwnedBy(') && bridge.includes('sessionReferencesPath('), 'project/Session provenance roots are missing from the Host bridge');
  assert(bridge.includes("kind: 'legacy'") && bridge.includes('inside(owned, canonical)'), 'legacy shared-root files are not isolated from per-project session roots');
  assert(sessionsSource.includes('projectSessionRoot(') && sessionsSource.includes('sessionEventsReferencePath'), 'per-project Session root or bounded legacy reference verification is missing');
  assert(previewSource.includes('entry.verify') || previewSource.includes('roots'), 'preview reader does not require caller-computed owned roots');
  assert(bridge.includes('sessionCwd: config.sessionCwd,') === false || bridge.includes('artifactRoot: config.artifactRoot,') === false, 'the old blanket session/artifact root authorization still exists');
  return 'project dir + per-project session root + job/receipt provenance + verified legacy references';
});

check('P3-008 R4: accepted requests and uploads are admitted, drained and cleaned', () => {
  const bridge = read('host/bridge.js');
  assert(bridge.includes('async dispatch(') && bridge.includes('this.inFlight.add(task)'), 'unified synchronous admission wrapper missing');
  assert(bridge.includes('await Promise.allSettled([...this.inFlight])'), 'dispose does not drain accepted work before teardown');
  assert(bridge.includes('releaseWorkerSnapshot('), 'a late preview snapshot is not released instead of published');
  assert(assetSource.includes('isTrustedProject') && assetSource.includes('this.handlers') && assetSource.includes('this.activeReaders') && assetSource.includes('this.ownedFiles'), 'asset inbox lifecycle (trusted project/admission/abort/cleanup) missing');
  assert(assetSource.includes('unlinkQuietly(receipt.target)') && assetSource.includes('this.disposed'), 'expiry/dispose does not unlink owned inbox copies');
  return 'single inFlight drain + trusted upload lifecycle + no publication after dispose';
});

check('M1: the stable data root is authoritative and the worker registry format is unchanged', () => {
  const config = read('host/config.js');
  const dataRoot = read('host/data-root.js');
  const bridge = read('host/bridge.js');
  const stage = read('scripts/stage-dev.mjs');
  const pkg = JSON.parse(read('package.json'));
  for (const key of ["'dataRoot'", "'legacyDataRoots'", "'browserPath'"]) {
    assert(config.includes(key), `trusted config key ${key} is missing`);
  }
  assert(dataRoot.includes('export function resolveDataRoot('), 'data-root resolver missing');
  assert(dataRoot.includes("env && typeof env.DSH_VIDEO_DATA_ROOT === 'string'"), 'DSH_VIDEO_DATA_ROOT override missing');
  assert(dataRoot.includes("join(home, ...DEFAULT_SEGMENTS)") && dataRoot.includes("'Movies', 'DSH Video'"), 'default ~/Movies/DSH Video root missing');
  assert(dataRoot.includes('export async function ensureDataRoot(') && dataRoot.includes('0o700'), 'ensureDataRoot/permissions missing');
  assert(dataRoot.includes('export async function migrateLegacyRoots('), 'legacy migration missing');
  assert(dataRoot.includes('export async function scanProjectsRoot('), 'disk-scan registry fallback missing');
  assert(dataRoot.includes('workerRegistry') || dataRoot.includes("registryPath: paths.projectsRegistryPath"), 'data-root worker registry wiring missing');
  // The frozen worker managed schema (5 keys) must stay unchanged: no version/managed on registry.json.
  assert(dataRoot.includes("const workerRegistry = {") && dataRoot.includes('projectsRoot: paths.projectsRoot'), 'worker managed registry is not derived from the data root');
  assert(bridge.includes('ensureDataRoot(') && bridge.includes('migrateLegacyRoots('), 'bridge does not prepare/migrate the data root');
  assert(bridge.includes('dataRootLayout(') && bridge.includes('sessionStatePath: layout.sessionStatePath'), 'session store is not rooted at the data root');
  assert(bridge.includes('const registryPath = await canonicalFile(paths.registryPath'), 'bridge does not resolve the worker registry from the data root');
  assert(bridge.includes('registryPath: runtime.registryPath'), 'worker is not started with the data-root registry');
  assert(stage.includes("'host/data-root.js'") && stage.includes("'host/ui-state.js'"), 'staging runtime paths are missing the new Host files');
  assert(stage.includes('legacyDataRoots') && stage.includes('--legacy-data-root') && stage.includes('dataRoot'), 'staging config injection is missing dataRoot/legacy sources');
  assert(Array.isArray(pkg.files) && pkg.files.includes('host/*.js'), 'package files do not ship the Host modules');
  // stage-dev: dataRoot only injected when explicitly requested; legacy roots are
  // always explicit build inputs (never a hardcoded user home path).
  assert(stage.includes('...(args.dataRoot === undefined ? {} : { dataRoot: args.dataRoot })'), 'stage-dev does not gate dataRoot injection');
  assert(stage.includes('legacyDataRoots: [...new Set([...args.legacyDataRoots, out])]'), 'stage-dev does not inject legacyDataRoots');
  assert(stage.includes("'--legacy-data-root'") && stage.includes("'--migrate-from'"), 'stage-dev legacy CLI arguments are missing');
  // L3 harnesses must isolate the data root instead of writing the real home.
  assert(existsSync('scripts/lib/data-root-isolation.mjs'), 'L3 data-root isolation helper missing');
  const isolation = read('scripts/lib/data-root-isolation.mjs');
  assert(isolation.includes('exports') === false && isolation.includes('supportsDataRoot(') && isolation.includes('legacyDataRoots'), 'L3 isolation helper does not gate on M1 configs');
  const harness = read('scripts/lib/conversation-harness.mjs');
  assert(harness.includes('dataRootSupported') && harness.includes('dataRoot,') && harness.includes("legacyDataRoots: []"), 'conversation harness does not isolate dataRoot');
  const canvas = read('scripts/test-canvas-workspace.mjs');
  assert(canvas.includes('dataRootSupported') && canvas.includes('assertStateRootIsolation('), 'canvas workspace harness does not isolate dataRoot');
  for (const runner of ['scripts/test-host-engine.mjs', 'scripts/test-canvas-chain.mjs', 'scripts/test-canvas-browser.mjs']) {
    const source = read(runner);
    assert(source.includes('isolateStagedConfig(') && source.includes('assertRealDataRootUnchanged('), runner + ' does not isolate/verify the data root');
  }
  return 'dataRoot priority/ensure/migration/scan; frozen 5-key worker registry; staging injection; L3 isolation';
});

check('M1: registry/session/ui-state corruption degrades without deleting user evidence', () => {
  const dataRoot = read('host/data-root.js');
  const bridge = read('host/bridge.js');
  const state = read('host/session-state.js');
  const uiState = read('host/ui-state.js');
  assert(dataRoot.includes('corrupt-') && dataRoot.includes('quarantineCorruptFile'), 'corrupt files are not preserved');
  assert(bridge.includes("registryRecovery") && bridge.includes("'scanned'"), 'registry scan recovery evidence missing');
  assert(bridge.includes('E_PROJECT_UNAVAILABLE') && bridge.includes('quarantined'), 'project quarantine contract missing');
  assert(state.includes('recoverIfNeeded(') && state.includes(".corrupt-"), 'session-state recovery/backup missing');
  assert(state.includes('mergeLegacyState('), 'legacy session merge missing');
  assert(uiState.includes('UI_STATE_VERSION = 1') && uiState.includes('.corrupt-'), 'ui-state recovery/versioning missing');
  assert(uiState.includes("'lastProjectId'") && uiState.includes("'aiPaneRatio'"), 'ui-state whitelist missing');
  return 'preserve corrupt evidence; scan/bak recovery; quarantine; session/ui-state rebuild';
});

check('M1: folder actions are UI-only, argv-based and never expose paths through the Tool', () => {
  const bridge = read('host/bridge.js');
  const client = read('client.js');
  const routes = read('host/routes.js');
  assert(bridge.includes("'project.path'") && bridge.includes("'project.reveal'"), 'folder Host methods missing');
  assert(bridge.includes("'ui.state.get'") && bridge.includes("'ui.state.set'"), 'ui-state Host methods missing');
  assert(bridge.includes('Project folders are a UI-only action'), 'folder actions are not gated from the Tool');
  assert(bridge.includes('Panel state is a UI-only action'), 'ui-state is not gated from the Tool');
  assert(bridge.includes('E_REVEAL_FAILED'), 'reveal failure code missing');
  assert(bridge.includes("spawn(command, [directory], { detached: true, stdio: 'ignore' })") || (bridge.includes('this.spawnImpl(command, [directory]') && bridge.includes('detached: true')), 'reveal is not argv-form detached spawn');
  assert(/spawn\([^)]*\+\s*directory/.test(bridge) === false && /open \$\{|shell: true/.test(bridge) === false, 'reveal must never compose a shell string');
  assert(routes.includes('E_REVEAL_FAILED') && routes.includes('E_PROJECT_UNAVAILABLE'), 'route status mapping is missing the new errors');
  assert(client.includes("'project.reveal'") && client.includes("'project.path'"), 'client folder actions are missing');
  assert(client.includes('writeClipboardText') && client.includes('document.execCommand') , 'clipboard fallback missing');
  assert(client.includes("data-action': 'reveal'") || client.includes('data-action') , 'folder menu items are not testable');
  assert(client.includes("video.project.copyPath") && client.includes("video.project.reveal"), 'folder action copy is missing');
  assert(client.includes('document.body') === false, 'client touches document.body (static scope gate)');
  return 'UI-only path/reveal/ui-state, argv spawn, clipboard fallback, localized copy';
});

check('M1: panel state is whitelisted, atomic and UI-only; boot restores it', () => {
  const uiState = read('host/ui-state.js');
  const bridge = read('host/bridge.js');
  const client = read('client.js');
  assert(uiState.includes('MAX_UI_STATE_BYTES') && uiState.includes('rename(temporary, this.path)'), 'ui-state atomic bounded write missing');
  assert(uiState.includes('E_UI_STATE_PARAMS'), 'ui-state rejects unknown fields');
  assert(bridge.includes('ui.state.get') && bridge.includes('ui.state.set'), 'Host ui-state dispatcher missing');
  assert(client.includes("hostRequest('ui.state.get'") && client.includes("hostRequest('ui.state.set'"), 'client does not use the Host ui-state');
  assert(client.includes('lastProjectId') && client.includes('video.save.saving') && client.includes('video.save.failed'), 'last-project restore/save indicator missing');
  assert(client.includes('readAiPaneRatio') && client.includes('schedulePaneRatioWrite'), 'pane ratio Host persistence fallback wiring missing');
  return 'whitelist/atomic UI state, boot restore, save indicator, layout fallback';
});

for (const [name, detail] of passes) console.log(`PASS  ${name}${detail === 'ok' ? '' : `  [${detail}]`}`);
for (const [name, message] of failures) console.error(`FAIL  ${name}: ${message}`);
console.log(`\n${passes.length} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
