#!/usr/bin/env node
/**
 * Local smoke test for the dsh-video Client half (P0-005 sidebar entry).
 *
 * Executes the real `client.js` in a Node VM with a minimal fake Slot runtime and
 * a minimal React-compatible hook shim. The fake runtime models the verified
 * 0.2.0-rc.2 contract that matters here:
 *
 *   - `ctx.slots.inject(key, callback)` WAITS while the slot is undeclared and
 *     runs the callback on every declaration lifetime (no throw for "not yet");
 *   - a collapsed declaration disposes the effect (and its registrations);
 *   - `ctx.slots.entries()` is the live occupant list used for conflict checks;
 *   - `main` is keyed, `sidebar.panellist` is a list keyed by `id` (0.2.0-rc.2
 *     source: ui-slots registers one cell per list id at one priority);
 *   - a sidebar row points at the matching `main` id, so both must be an atomic
 *     pair: the panel first, the entry only after it, and both released together.
 *
 * Covered here: registration shape, the panel -> sidebar atomic lifecycle under
 * late/repeated/collapsed declarations, failure rollback, coexistence with the
 * shipped rows, unload fallback without stealing another panel, restrained boot
 * state, display-menu semantics, preference persistence and corruption safety,
 * the sidebar icon owner-props contract, the P3-012 conversation-first flow
 * (project.list -> remembered/default/most-recent auto-open, auto-provision +
 * guarded single auto-Session, 1500 ms inspect poll adopting a published
 * revision, recoverable preview failure + retry, absence of deferred manual
 * controls in the rendered product, read-only previewOnly component), the R2
 * dual-instance preview retention contract (hidden candidate preload, promotion
 * only on runtime ready, last-ready composition kept on snapshot/runtime
 * failure with a compact notice+retry, truthful active/target revision markers,
 * post-switch preview.release), the
 * native conversation/history/file-preview surfaces, and (P3-008 R1/R2/R5/R6)
 * the reviewed runtime message contract, the static-base inverse-mapped
 * drag/resize patches, the frozen Scene template copy/refusal path and the
 * inline-editor failure recovery with operationId reuse. The P3-008 manual
 * canvas path is mounted directly with `previewOnly: false` (the reviewed
 * default) exactly like its browser harness; the product never renders it.
 *
 * Not covered / not claimed: real browser rendering, CSS animation playback,
 * layout, the exact host row pixels, installation or any live host verification.
 *
 * Run: node scripts/smoke-client.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SOURCE = readFileSync(join(ROOT, 'client.js'), 'utf8');
const LAYOUT_PREFS_KEY = 'dsh-video.layout.v1';
const PANEL_ID = 'dsh-video';
const SIDEBAR_SLOT = 'sidebar.panellist';

const passes = [];
const failures = [];
const tests = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function test(name, fn) {
  tests.push([name, fn]);
}

function translate(key) {
  return key;
}

//#region minimal React shim + renderer
function createReact(runtime) {
  let currentRuntime = null;
  const capture = runtime || null;

  function fakeRect(node) {
    const style = (node.props && node.props.style) || {};
    function px(value) {
      return typeof value === 'string' && /^-?(?:\d+|\d*\.\d+)px$/.test(value) ? parseFloat(value) : null;
    }
    const width = px(style.width);
    const height = px(style.height);
    if (width !== null && height !== null) return { left: 0, top: 0, width: width, height: height };
    const className = typeof node.props.className === 'string' ? node.props.className : '';
    if (className.split(/\s+/).includes('dv-canvas-wrap') && capture !== null) {
      return { left: 0, top: 0, width: capture.stageSize.width, height: capture.stageSize.height };
    }
    return { left: 0, top: 0, width: 0, height: 0 };
  }

  function currentScope() {
    if (currentRuntime === null) throw new Error('hook called outside a component render');
    return currentRuntime;
  }

  function renderNode(node, context) {
    if (node === null || node === undefined || node === false || node === true) return null;
    if (typeof node === 'string' || typeof node === 'number') return { type: '#text', text: String(node), props: {} };
    if (Array.isArray(node)) return node.map((child) => renderNode(child, context));
    if (typeof node !== 'object') return null;
    const { type, props } = node;
    if (typeof type === 'function') {
      const previous = currentRuntime;
      const scopes = context.componentScopes;
      let scope;
      if (scopes !== undefined && scopes !== null) {
        scope = scopes.get(type);
        if (scope === undefined) {
          scope = { hooks: {}, hookIndex: 0, effects: [] };
          scopes.set(type, scope);
        } else {
          scope.hookIndex = 0;
          scope.effects = [];
        }
      } else {
        scope = { hooks: {}, hookIndex: 0, effects: [] };
      }
      currentRuntime = scope;
      let rendered;
      try {
        rendered = type(props || {});
      } finally {
        currentRuntime = previous;
      }
      for (const effect of scope.effects) context.effects.push(effect);
      return renderNode(rendered, context);
    }
    const domNode = { type, props: props || {}, children: renderNode((props || {}).children, context) };
    domNode.getBoundingClientRect = function boundingRect() {
      return fakeRect(domNode);
    };
    if (type === 'iframe' && capture !== null) {
      // A minimal WindowProxy stand-in: the canvas posts contract commands into
      // it and the smoke test answers them through window "message" listeners.
      domNode.contentWindow = {
        postMessage(message) {
          capture.commands.push(message);
        },
      };
      capture.iframes.push(domNode);
    }
    const forwardedRef = domNode.props.ref;
    if (forwardedRef !== undefined && forwardedRef !== null) {
      domNode.focus = function focus() {
        context.activeElement = domNode;
      };
      if (typeof forwardedRef === 'function') forwardedRef(domNode);
      else if (typeof forwardedRef === 'object') forwardedRef.current = domNode;
    }
    return domNode;
  }

  const react = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const nextProps = Object.assign({}, props);
      if (children.length === 1) nextProps.children = children[0];
      else if (children.length > 1) nextProps.children = children;
      return { type, props: nextProps };
    },
    useState(initial) {
      const scope = currentScope();
      const index = scope.hookIndex++;
      if (!(index in scope.hooks)) scope.hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [
        scope.hooks[index],
        function setState(next) {
          scope.hooks[index] = typeof next === 'function' ? next(scope.hooks[index]) : next;
        },
      ];
    },
    useEffect(effect) {
      currentScope().effects.push(effect);
    },
    useRef(initial) {
      const scope = currentScope();
      const index = scope.hookIndex++;
      if (!(index in scope.hooks)) scope.hooks[index] = { current: initial };
      return scope.hooks[index];
    },
    useCallback(callback) {
      currentScope();
      return callback;
    },
    useMemo(factory) {
      currentScope();
      return factory();
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      currentScope();
      return getSnapshot();
    },
    renderInteractive(component, props) {
      const scope = { hooks: {}, hookIndex: 0, effects: [] };
      const context = { effects: [], cleanups: [], activeElement: null, componentScopes: new WeakMap() };
      let currentTree = null;
      function renderOnce() {
        for (const cleanup of context.cleanups.splice(0).reverse()) {
          try {
            cleanup();
          } catch (_error) {
            /* cleanup is best effort in the shim */
          }
        }
        scope.hookIndex = 0;
        scope.effects = [];
        const previous = currentRuntime;
        currentRuntime = scope;
        let rendered;
        try {
          rendered = component(props);
        } finally {
          currentRuntime = previous;
        }
        context.effects = [];
        for (const effect of scope.effects.splice(0)) context.effects.push(effect);
        currentTree = renderNode(rendered, context);
        for (const effect of context.effects.splice(0)) {
          let cleanup;
          try {
            cleanup = effect();
          } catch (_error) {
            /* effects are best effort in the shim */
          }
          if (typeof cleanup === 'function') context.cleanups.push(cleanup);
        }
        return currentTree;
      }
      let disposed = false;
      return {
        render: renderOnce,
        rerender: renderOnce,
        tree: () => currentTree,
        activeElement: () => context.activeElement,
        unmount() {
          if (disposed) return;
          disposed = true;
          for (const cleanup of context.cleanups.splice(0).reverse()) {
            try {
              cleanup();
            } catch (_error) {
              /* cleanup is best effort in the shim */
            }
          }
        },
      };
    },
    render(element) {
      const context = { effects: [], cleanups: [] };
      const tree = renderNode(element, context);
      for (const effect of context.effects) {
        const cleanup = effect();
        if (typeof cleanup === 'function') context.cleanups.push(cleanup);
      }
      return { tree, cleanups: context.cleanups };
    },
  };

  return react;
}

function walk(node, visitor) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visitor);
    return;
  }
  if (typeof node !== 'object') return;
  visitor(node);
  if (node.children !== undefined) walk(node.children, visitor);
}

function find(node, predicate) {
  let found = null;
  walk(node, (candidate) => {
    if (found === null && predicate(candidate)) found = candidate;
  });
  return found;
}

function findAll(node, predicate) {
  const found = [];
  walk(node, (candidate) => {
    if (predicate(candidate)) found.push(candidate);
  });
  return found;
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node !== 'object') return '';
  const own = node.type === '#text' ? node.text : '';
  return own + (node.children !== undefined ? textOf(node.children) : '');
}
//#endregion

//#region fake DSH client slot runtime (declaration lifetime aware)
function createMemoryStorage(initial, behavior) {
  const map = new Map(Object.entries(initial || {}));
  const options = behavior || {};
  return {
    map,
    getItem(key) {
      if (options.getThrows) throw new Error('storage read blocked by test');
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (options.setThrows) throw new Error('storage write blocked by test');
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

function createFakeEnvironment(options) {
  const config = options || {};
  const declared = {};
  const initialDeclared = Object.assign({ main: 'keyed', [SIDEBAR_SLOT]: 'list' }, config.declaredSlots || {});
  for (const [slot, kind] of Object.entries(initialDeclared)) {
    if (kind !== false) declared[slot] = kind;
  }
  const entriesBySlot = {
    main: (config.mainOccupants || []).slice(),
    [SIDEBAR_SLOT]: (config.sidebarOccupants || []).slice(),
  };
  const services = config.services || {};
  const events = {
    registrations: [],
    errors: [],
    warnings: [],
    locale: [],
    panelCalls: [],
    injections: [],
    effectDisposers: [],
  };
  let activePanelId = config.activePanelId === undefined ? null : config.activePanelId;
  let currentLocale = config.locale === undefined ? 'zh' : config.locale;
  const controllersBySlot = new Map();

  function entriesFor(slot) {
    if (entriesBySlot[slot] === undefined) entriesBySlot[slot] = [];
    return entriesBySlot[slot];
  }

  function activateController(controller) {
    controller.running = true;
    try {
      const inner = controller.callback();
      controller.inner = typeof inner === 'function' ? inner : null;
      controller.active = true;
    } finally {
      controller.running = false;
    }
  }

  function deactivateController(controller) {
    if (!controller.active) return;
    controller.active = false;
    const inner = controller.inner;
    controller.inner = null;
    if (typeof inner === 'function') inner();
  }

  function disposeController(controller) {
    controller.stopped = true;
    deactivateController(controller);
  }

  const slots = {
    entries(slot) {
      if (config.entriesUnavailable) throw new Error('entries unavailable by test');
      return entriesFor(slot).slice();
    },
    spec(slot) {
      return declared[slot] === undefined ? undefined : { kind: declared[slot] };
    },
    specDynamic(slot) {
      return slots.spec(slot);
    },
    inject(slot, callback) {
      const controller = { slot, callback, active: false, running: false, stopped: false, inner: null };
      const list = controllersBySlot.get(slot) || [];
      list.push(controller);
      controllersBySlot.set(slot, list);
      events.injections.push(controller);
      if (declared[slot] !== undefined) {
        try {
          activateController(controller);
        } catch (error) {
          controller.stopped = true;
          throw error;
        }
      }
      return function disposeInjection() {
        disposeController(controller);
      };
    },
    register(registration, component) {
      const kind = declared[registration.name];
      if (kind === undefined) throw new Error(`slot "${registration.name}" is not declared`);
      if (config.registerThrows && config.registerThrows[registration.name]) {
        throw new Error(`registration blocked for "${registration.name}" by test`);
      }
      const list = entriesFor(registration.name);
      if (kind === 'single' && list.length > 0) {
        throw new Error(`single slot "${registration.name}" already has a registration`);
      }
      if (kind === 'keyed') {
        if (registration.key === undefined) throw new Error(`keyed slot "${registration.name}" requires key`);
        if (list.some((entry) => entry.options.key === registration.key)) {
          throw new Error(`keyed slot "${registration.name}" already has key "${registration.key}"`);
        }
      }
      if (kind === 'list') {
        if (registration.id === undefined) throw new Error(`list slot "${registration.name}" requires an id`);
        if (list.some((entry) => entry.options.id === registration.id && (entry.options.priority || 0) === (registration.priority || 0))) {
          throw new Error(`list slot "${registration.name}" already has an entry with id "${registration.id}"`);
        }
      }
      const record = { options: Object.assign({}, registration), component, live: true };
      list.push(record);
      events.registrations.push(record);
      return function unregister() {
        const index = list.indexOf(record);
        if (index >= 0) list.splice(index, 1);
        record.live = false;
      };
    },
  };

  function runWaitingControllers(slot) {
    for (const controller of controllersBySlot.get(slot) || []) {
      if (controller.stopped || controller.active || controller.running) continue;
      try {
        activateController(controller);
      } catch (error) {
        events.errors.push(['host: injection callback threw', error]);
      }
    }
  }

  function declareSlot(slot, kind) {
    if (declared[slot] !== undefined) return;
    declared[slot] = kind || (slot === 'main' ? 'keyed' : slot === SIDEBAR_SLOT ? 'list' : 'single');
    runWaitingControllers(slot);
  }

  function collapseSlot(slot) {
    if (declared[slot] === undefined) return;
    delete declared[slot];
    for (const controller of controllersBySlot.get(slot) || []) deactivateController(controller);
  }

  const ctx = {
    logger: {
      error(...args) {
        events.errors.push(args);
      },
      warn(...args) {
        events.warnings.push(args);
      },
    },
    effect(callback, label) {
      const dispose = callback();
      events.effectDisposers.push(dispose);
      return dispose;
    },
    locale: {
      register(ns, dicts) {
        events.locale.push({ ns, dicts });
        return function unregisterLocale() {};
      },
      bind(ns) {
        return function resolve(key) {
          const record = [...events.locale].reverse().find((entry) => entry.ns === ns);
          const dictionary = record && record.dicts ? record.dicts[currentLocale] || record.dicts.zh : null;
          return dictionary && typeof dictionary[key] === 'string' ? dictionary[key] : key;
        };
      },
      getSnapshot() {
        return { locale: currentLocale, revision: 0 };
      },
      subscribe() {
        return function unsubscribe() {};
      },
    },
    layout: {
      panelInfo: {
        getSnapshot() {
          return { activePanelId };
        },
        subscribe() {
          return function unsubscribe() {};
        },
      },
      selectPanel(panelId) {
        if (config.selectPanelThrows) throw new Error('layout.selectPanel: main panel not registered (test)');
        activePanelId = panelId;
        events.panelCalls.push(panelId);
      },
    },
    slots,
    get(name) {
      return services[name];
    },
  };

  return {
    ctx,
    events,
    entriesBySlot,
    declared,
    declareSlot,
    collapseSlot,
    setActivePanel(panelId) {
      activePanelId = panelId;
    },
    getActivePanel() {
      return activePanelId;
    },
    setLocale(locale) {
      currentLocale = locale;
    },
    disposeAllInjections() {
      for (const controller of events.injections.slice().reverse()) disposeController(controller);
    },
    disposeAllEffects() {
      for (const dispose of events.effectDisposers.slice().reverse()) {
        if (typeof dispose === 'function') dispose();
      }
    },
  };
}
//#endregion

//#region module loading
const RUNTIMES = [];

function loadClient(options) {
  const config = options || {};
  const registrations = [];
  const frames = [];
  const runtime = {
    listeners: [],
    commands: [],
    iframes: [],
    timers: new Set(),
    intervals: new Set(),
    stageSize: config.stageSize || { width: 1280, height: 720 },
  };
  RUNTIMES.push(runtime);
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          registrations.push(registration);
        },
      },
      addEventListener(type, listener) {
        if (type === 'message' && typeof listener === 'function') runtime.listeners.push(listener);
      },
      removeEventListener(type, listener) {
        if (type !== 'message') return;
        const index = runtime.listeners.indexOf(listener);
        if (index >= 0) runtime.listeners.splice(index, 1);
      },
    },
    localStorage: config.storage,
    fetch: typeof config.fetch === 'function' ? config.fetch : undefined,
    console: { log() {}, warn() {}, error() {} },
    setTimeout(callback, delay, ...args) {
      // Contract budgets (snapshot and ready waits) are the only >=15s timers in
      // the preview state machine; tests shrink them through one knob.
      const budget = config.previewTimeoutMs !== undefined && delay >= 15000 ? config.previewTimeoutMs : delay;
      const handle = setTimeout(callback, budget, ...args);
      runtime.timers.add(handle);
      return handle;
    },
    clearTimeout(handle) {
      runtime.timers.delete(handle);
      clearTimeout(handle);
    },
    // The product workspace follows the published revision on a 1.5s poll; the
    // sandbox models the browser timer pair and tracks intervals for teardown.
    setInterval(callback, delay, ...args) {
      const handle = setInterval(callback, delay, ...args);
      runtime.intervals.add(handle);
      return handle;
    },
    clearInterval(handle) {
      runtime.intervals.delete(handle);
      clearInterval(handle);
    },
    requestAnimationFrame(callback) {
      if (config.queueFrames !== true) {
        callback();
        return 0;
      }
      const token = { callback, cancelled: false };
      frames.push(token);
      return token;
    },
    cancelAnimationFrame(token) {
      if (token && typeof token === 'object') token.cancelled = true;
    },
  };
  if (typeof config.matchMedia === 'function') sandbox.window.matchMedia = config.matchMedia;
  const context = vm.createContext(sandbox);
  vm.runInContext(CLIENT_SOURCE, context, { filename: 'client.js' });
  assert(registrations.length === 1, `expected one module registration, got ${registrations.length}`);
  const registration = registrations[0];
  const react = createReact(runtime);
  const exportsObject = registration.factory((specifier) => {
    if (specifier === 'react') return react;
    throw new Error(`unexpected external require("${specifier}")`);
  });
  return {
    registration,
    react,
    exports: exportsObject,
    sandbox,
    context,
    runtime,
    flushFrames(rounds = 8) {
      for (let round = 0; round < rounds; round += 1) {
        const batch = frames.splice(0);
        if (batch.length === 0) return;
        for (const token of batch) {
          if (!token.cancelled && typeof token.callback === 'function') token.callback();
        }
      }
    },
  };
}

function loadClientWithStorage(storage, options) {
  const loaded = loadClient(options);
  loaded.sandbox.localStorage = storage;
  return loaded;
}

function mount(react, component, props) {
  return react.render(react.createElement(component, props)).tree;
}

function registrationOf(env, slotName) {
  return env.events.registrations.find((entry) => entry.options.name === slotName);
}

function dictionaryOf(env, locale) {
  const record = env.events.locale[0];
  return record && record.dicts ? record.dicts[locale || 'zh'] || {} : {};
}

function translateFor(env, locale) {
  const dictionary = dictionaryOf(env, locale);
  return function t(key) {
    return typeof dictionary[key] === 'string' ? dictionary[key] : key;
  };
}

function mountPanel(loaded, env) {
  const registration = registrationOf(env, 'main');
  assert(registration !== undefined, 'main panel is not registered');
  const props = Object.assign({ t: translateFor(env) }, registration.options.inject());
  return mount(loaded.react, registration.component, props);
}

function mountInteractivePanel(loaded, env) {
  const registration = registrationOf(env, 'main');
  assert(registration !== undefined, 'main panel is not registered');
  const props = Object.assign({ t: translateFor(env) }, registration.options.inject());
  return loaded.react.renderInteractive(registration.component, props);
}

function mountSidebarIcon(loaded, env, ownerProps) {
  const registration = registrationOf(env, SIDEBAR_SLOT);
  assert(registration !== undefined, 'sidebar entry is not registered');
  const props = Object.assign({ size: 16, active: false }, ownerProps || {});
  return mount(loaded.react, registration.component, props);
}

function sidebarEntryOf(env) {
  return registrationOf(env, SIDEBAR_SLOT);
}

function navigationOf(env) {
  const main = registrationOf(env, 'main');
  assert(main !== undefined, 'main panel is not registered');
  return main.options.inject();
}

function activationErrors(env) {
  return env.events.errors
    .map((args) => String(args[0]))
    .concat(env.events.warnings.map((args) => String(args[0])));
}

function liveRegistrations(env) {
  return env.events.registrations.filter((entry) => entry.live);
}

function liveMain(env) {
  return liveRegistrations(env).filter((entry) => entry.options.name === 'main');
}

function liveSidebar(env) {
  return liveRegistrations(env).filter((entry) => entry.options.name === SIDEBAR_SLOT);
}

function findNode(tree, predicate) {
  return find(tree, predicate);
}

function findNodes(tree, predicate) {
  return findAll(tree, predicate);
}

function panelButton(tree, className) {
  return findNode(tree, (node) => node.type === 'button' && node.props && node.props.className === className);
}

function panelMenuItem(tree) {
  return findNode(tree, (node) => node.type === 'button' && node.props && node.props.role === 'menuitemcheckbox');
}

function projectMenu(tree) {
  return findNode(tree, (node) => node.props && node.props.className === 'dv-project-menu');
}

function projectMenuItems(tree) {
  return findNodes(tree, (node) => node.type === 'button' && node.props && (node.props.role === 'menuitemradio' || node.props.role === 'menuitem'));
}

function projectToggle(tree) {
  return findNode(tree, (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes('dv-project-toggle'));
}

function projectNameButton(tree) {
  return findNode(tree, (node) => node.type === 'button' && node.props && node.props.className === 'dv-project-name');
}

function projectNameInput(tree) {
  return findNode(tree, (node) => node.type === 'input' && node.props && node.props.className === 'dv-project-name-input');
}

function splitterOf(tree) {
  return findNode(tree, (node) => node.props && node.props.className === 'dv-splitter');
}

function mainSplit(tree) {
  return findNode(tree, (node) => node.props && node.props.className === 'dv-main');
}

function aiWidthCss(tree) {
  const main = mainSplit(tree);
  return main !== null && main.props.style ? main.props.style['--dv-ai-width'] : undefined;
}

function panelButtonByText(tree, label) {
  return findNode(tree, (node) => node.type === 'button' && textOf(node) === label);
}

function elementById(tree, id) {
  return findNode(tree, (node) => node.props && node.props.id === id);
}

function buttonByText(tree, label) {
  return findNode(tree, (node) => node.type === 'button' && textOf(node) === label);
}

function makeHostFetch(handler) {
  const calls = [];
  async function hostFetch(url, init) {
    const request = {
      url,
      method: init && init.method,
      headers: init && init.headers,
      body: init && typeof init.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(request);
    const result = await handler(request);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  hostFetch.calls = calls;
  return hostFetch;
}

async function settle(rounds) {
  for (let index = 0; index < (rounds || 8); index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function sampleInspect(overrides) {
  const base = {
    projectId: 'demo',
    revision: 'a'.repeat(64),
    width: 1280,
    height: 720,
    duration: 5,
    elements: [
      {
        stableId: 'hf-eyebrow',
        text: 'DSH VIDEO / ENGINE STUDY',
        capabilities: ['text'],
      },
      {
        stableId: 'hf-title',
        text: '让创意成为影像',
        timing: { start: 0, duration: 5 },
        capabilities: ['text', 'timing'],
      },
      {
        stableId: 'hf-subtitle',
        text: '原生工程 · 确定性时间 · 自由修改',
        capabilities: ['text'],
      },
    ],
  };
  return Object.assign(base, overrides || {});
}

function sampleJob(jobId) {
  return {
    jobId,
    projectId: 'demo',
    revision: 'a'.repeat(64),
    kind: 'frame',
    state: 'queued',
    stage: 'snapshot',
    progress: 0,
  };
}

function makeSessionsService(options) {
  const config = options || {};
  const retained = [];
  const released = [];
  let retainInfoCalls = 0;
  const listSnapshot = { ids: (config.list || []).slice(), byId: {}, projectionsBySession: {} };
  for (const id of listSnapshot.ids) {
    listSnapshot.byId[id] = { sessionId: id, blank: false };
    listSnapshot.projectionsBySession[id] = {
      values: { title: config.titles && config.titles[id] ? config.titles[id] : id },
      state: 'ready',
      error: null,
    };
  }
  const list = { getSnapshot: () => listSnapshot, subscribe: () => () => {} };
  function faceFor(id) {
    const override = (config.faces && config.faces[id]) || {};
    const state = Object.assign({ sessionId: id, openState: 'open', openError: null, running: false, blank: false }, override);
    return { getSnapshot: () => state, subscribe: () => () => {} };
  }
  return {
    list,
    retained,
    released,
    get retainInfoCalls() {
      return retainInfoCalls;
    },
    retain(target, options) {
      const id = typeof target === 'string' ? target : target.sessionId;
      const binding = { sessionId: id, session: faceFor(id) };
      const ref = {
        sessionId: id,
        binding,
        ready: Promise.resolve(binding),
        released: false,
        release() {
          if (ref.released) return;
          ref.released = true;
          released.push(id);
        },
      };
      retained.push({ id, options, ref });
      return ref;
    },
    using(target, options, operation) {
      const ref = this.retain(target, options);
      return Promise.resolve(operation(ref)).finally(() => ref.release());
    },
    retainInfo() {
      retainInfoCalls += 1;
      const retainedBy = config.mainViewRetained === true ? { mainView: 1 } : {};
      return { getSnapshot: () => ({ referenceCount: config.mainViewRetained === true ? 1 : 0, retainedBy }), subscribe: () => () => {} };
    },
    binding(id) {
      const found = retained.find((entry) => entry.id === id && entry.ref.released === false);
      return found ? found.ref.binding : undefined;
    },
  };
}

function makeSessionKit() {
  const calls = [];
  function SessionProvider(props) {
    calls.push({ type: 'session-provider', session: props.session });
    return props.children;
  }
  function renderFactorySlot(name, input, occurrence) {
    calls.push({ type: 'factory', name, input, occurrence });
    let child = null;
    const views = occurrence && occurrence.slots ? occurrence.slots.views : null;
    if (typeof views === 'function') {
      child = views({
        renderSlot(slot, args) {
          calls.push({ type: 'chat-view', slot, args });
          return { type: 'div', props: { 'data-chat-view': slot }, children: null };
        },
      });
    }
    return { type: 'div', props: { 'data-factory': name }, children: child };
  }
  return { SessionProvider, renderFactorySlot, calls };
}

function managedScenes() {
  return [1, 2, 3].map((index) => ({ sceneId: 'scene-' + index, order: index - 1, start: (index - 1) * 5, duration: 5, title: 'Scene ' + index, elements: [] }));
}

function managedInspected() {
  return {
    projectId: 'proj-smoke',
    revision: 'c'.repeat(64),
    width: 1280,
    height: 720,
    duration: 15,
    scenes: managedScenes(),
    elements: [
      {
        stableId: 'scene-1-title',
        sceneId: 'scene-1',
        text: 'Scene 1',
        timing: { start: 0, duration: 5 },
        capabilities: ['text', 'layout', 'style'],
        layout: { left: 88, top: 196, width: 1104, height: 120 },
        style: { color: '#ffffff', fontSize: 64, fontWeight: 600, textAlign: 'left' },
      },
    ],
    files: ['assets/gsap.min.js', 'index.html'].map((path) => ({ path: path, bytes: 100, sha256: 'd'.repeat(64) })),
  };
}

function sessionFetch(options) {
  const config = options || {};
  const fetchFunction = makeHostFetch(async (request) => {
    const method = request.body.method;
    if (typeof config.handler === 'function') {
      const custom = await config.handler(request, config);
      if (custom !== undefined) return custom;
    }
    if (method === 'session.list') {
      return Promise.resolve({
        ok: true,
        result: {
          enabled: true,
          contract: 1,
          projectId: request.body.params.projectId,
          activeSessionId: config.activeSessionId === undefined ? null : config.activeSessionId,
          sessions: (config.sessions || []).map((id) => ({ sessionId: id, status: 'available' })),
        },
      });
    }
    if (method === 'session.create') {
      config.createCalls = (config.createCalls || 0) + 1;
      const id = config.newSessionId || 'session-new';
      config.activeSessionId = id;
      config.sessions = (config.sessions || []).concat([id]);
      return Promise.resolve({ ok: true, result: { enabled: true, contract: 1, projectId: request.body.params.projectId, sessionId: id, activeSessionId: id } });
    }
    if (method === 'session.select') {
      config.selectCalls = (config.selectCalls || []).concat([request.body.params.sessionId]);
      const id = request.body.params.sessionId;
      const delay = (config.selectDelays && config.selectDelays[id]) || 0;
      return new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, result: { enabled: true, contract: 1, projectId: request.body.params.projectId, sessionId: id, activeSessionId: id } }), delay);
      });
    }
    if (method === 'session.diagnose') {
      return Promise.resolve({ ok: true, result: { enabled: true, contract: 1 } });
    }
    if (method === 'project.list') {
      // P3-012 bridge shape: recency for auto-open. `demo` is the legacy fixture
      // entry the client must filter out; `proj-smoke` is the managed project.
      return Promise.resolve({
        ok: true,
        result: {
          projects: [
            { projectId: 'proj-smoke', updatedAt: 2000 },
            { projectId: 'demo', updatedAt: 1000 },
          ],
          defaultProjectId: 'proj-smoke',
        },
      });
    }
    if (method === 'project.create') {
      config.projectCreated = true;
      return Promise.resolve({ ok: true, result: { projectId: 'proj-smoke', revision: 'c'.repeat(64), scenes: managedScenes().slice(0, 1) } });
    }
    if (method === 'open') {
      const id = request.body.params.projectId;
      config.openedProject = id;
      return Promise.resolve({ ok: true, result: { projectId: id, revision: 'c'.repeat(64) } });
    }
    if (method === 'inspect') {
      return Promise.resolve({ ok: true, result: managedInspected() });
    }
    if (method === 'preview.snapshot') {
      config.snapshotRequests = (config.snapshotRequests || []).concat([request.body.params]);
      config.snapshotSeq = (config.snapshotSeq || 0) + 1;
      const snapshotId = ('a'.repeat(16) + String(config.snapshotSeq).padStart(16, '0')).slice(0, 32);
      config.snapshotResults = (config.snapshotResults || []).concat([{ revision: request.body.params.revision, snapshotId: snapshotId }]);
      return Promise.resolve({
        ok: true,
        result: {
          snapshotId: snapshotId,
          projectId: request.body.params.projectId,
          revision: request.body.params.revision,
          entry: 'index.html',
          entryUrl: '/api/dsh-video/preview/' + 'a'.repeat(32) + '/index.html',
          routeBase: '/api/dsh-video/preview',
          files: [],
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      });
    }
    if (method === 'preview.release') {
      config.releaseCalls = (config.releaseCalls || []).concat([request.body.params.snapshotId]);
      return Promise.resolve({ ok: true, result: { released: true } });
    }
    if (method === 'preview') {
      config.previewCalls = (config.previewCalls || []).concat([request.body.params]);
      const response = config.preview || {
        ok: true,
        result: {
          fileName: 'frame.png',
          mediaType: 'image/png',
          size: 4,
          sha256: 'a'.repeat(64),
          dataUrl: 'data:image/png;base64,AAAA',
        },
      };
      if ((config.previewDelay || 0) > 0) {
        return new Promise((resolve) => setTimeout(() => resolve(response), config.previewDelay));
      }
      return Promise.resolve(response);
    }
    return Promise.resolve({ ok: false, error: { code: 'E_METHOD', message: 'unexpected ' + method } });
  });
  fetchFunction.config = config;
  return fetchFunction;
}

function mountSessionEditor(hostFetch, options) {
  const config = options || {};
  const loaded = loadClient({ fetch: hostFetch, stageSize: config.stageSize, previewTimeoutMs: config.previewTimeoutMs });
  const env = createFakeEnvironment({ services: { sessions: config.sessions } });
  loaded.exports.apply(env.ctx);
  const main = registrationOf(env, 'main');
  assert(main !== undefined, 'main panel is not registered');
  const props = Object.assign({ t: translateFor(env) }, main.options.inject(), config.kit || {});
  const interactive = loaded.react.renderInteractive(main.component, props);
  let tree = interactive.render();
  return {
    loaded,
    env,
    interactive,
    tree: () => tree,
    rerender() {
      tree = interactive.rerender();
      return tree;
    },
  };
}

/**
 * P3-012 boot helper: the product workspace auto-loads project.list, opens (or
 * provisions) the managed project and its Session on mount. Async requests need
 * more than one settle round; each round re-renders so effects see the new state.
 */
async function settlePanel(editor, rounds) {
  const total = rounds || 12;
  for (let index = 0; index < total; index += 1) {
    await settle();
    editor.rerender();
  }
  return editor.tree();
}

/**
 * Re-mount the panel from the same loaded module/env (the plugin keeps its view
 * memory in module scope) with the same kit the first mount received.
 */
function remountInteractivePanel(editor, kit) {
  const main = registrationOf(editor.env, 'main');
  assert(main !== undefined, 'main panel is not registered');
  const props = Object.assign({ t: translateFor(editor.env) }, main.options.inject(), kit || {});
  return editor.loaded.react.renderInteractive(main.component, props);
}

async function mountBootedPanel(hostFetch, options) {
  const editor = mountSessionEditor(hostFetch, options);
  await settlePanel(editor);
  // The product preview preloads its first revision as a hidden candidate and
  // promotes it when the fixed runtime reports ready; the Node shim simulates
  // that contract event so product-level assertions run against a ready preview.
  if (findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-canvas-shell') !== null) {
    await ensureCanvasActive(editor);
  }
  return editor;
}
//#endregion

//#region tests: module + registration baseline
test('module registers one browser module with the dsh-video id and factory', () => {
  const loaded = loadClient();
  assert(loaded.registration.id === 'dsh-video-editor', `module id is "${loaded.registration.id}"`);
  assert(typeof loaded.registration.factory === 'function', 'factory missing');
  assert(typeof loaded.exports.apply === 'function', 'plugin body lacks apply()');
  assert(
    JSON.stringify(loaded.exports.inject) === JSON.stringify(['slots', 'layout', 'locale', 'sessions']),
    `unexpected inject list: ${JSON.stringify(loaded.exports.inject)}`
  );
});

test('apply registers the video main panel and one native sidebar entry', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment();
  loaded.exports.apply(env.ctx);
  const main = registrationOf(env, 'main');
  assert(main !== undefined, 'main panel was not registered');
  assert(main.options.key === PANEL_ID, `main key is "${main.options.key}"`);
  const entry = sidebarEntryOf(env);
  assert(entry !== undefined, 'sidebar entry was not registered');
  assert(entry.options.id === PANEL_ID, 'sidebar id must address the same main panel');
  assert(entry.options.order === 30, `sidebar order is ${entry.options.order}`);
  assert(typeof entry.options.label === 'function', 'sidebar label must be a locale-aware thunk');
  assert(entry.options.label() === 'dsh-video-editor', `sidebar label is "${entry.options.label()}"`);
  assert(env.events.locale.length === 1 && env.events.locale[0].ns === 'dshVideo', 'locale dictionaries not registered');
  assert(registrationOf(env, 'conversation.header.leading') === undefined, 'the old top capsule seat must not be used');
  assert(env.events.errors.length === 0, `unexpected activation errors: ${activationErrors(env).join('; ')}`);
});

test('sidebar label keeps the exact user spelling in both locales', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment();
  loaded.exports.apply(env.ctx);
  const entry = sidebarEntryOf(env);
  assert(entry.options.label() === 'dsh-video-editor', 'zh label must be exactly dsh-video-editor');
  env.setLocale('en');
  assert(entry.options.label() === 'dsh-video-editor', 'en label must keep the exact user spelling');
  assert(dictionaryOf(env, 'zh')['nav.label'] === 'dsh-video-editor', 'zh dictionary label missing');
  assert(dictionaryOf(env, 'en')['nav.label'] === 'dsh-video-editor', 'en dictionary label missing');
});

test('sidebar icon honours the host owner props and native line style', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment();
  loaded.exports.apply(env.ctx);
  const tree = mountSidebarIcon(loaded, env, { size: 18, active: true });
  const svg = findNode(tree, (node) => node.type === 'svg');
  assert(svg !== null, 'sidebar icon did not render an svg');
  assert(svg.props.width === 18 && svg.props.height === 18, 'icon must use the host-provided square edge');
  assert(svg.props.viewBox === '0 0 16 16', 'icon must use the host 16-unit grid');
  assert(svg.props.stroke === 'currentColor', 'icon must follow the row colour with currentColor');
  assert(svg.props['aria-hidden'] === 'true', 'icon is decorative; the host row owns the accessible name');
  const defaultIcon = mountSidebarIcon(loaded, env);
  const defaultSvg = findNode(defaultIcon, (node) => node.type === 'svg');
  assert(defaultSvg.props.width === 16, 'icon must fall back to the expanded 16px edge');
});
//#endregion

//#region tests: panel content + display options
test('panel renders the preparing status, one return action and one resizable AI pane before boot', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment();
  loaded.exports.apply(env.ctx);
  const tree = mountPanel(loaded, env);
  const root = findNode(tree, (node) => node.props && node.props.className === 'dv-root');
  assert(root !== null, 'video panel root missing');
  assert(root.props['data-simplified'] === undefined, 'the removed simplified-effects marker is still on the root');
  const empty = findNode(tree, (node) => node.props && node.props.className === 'dv-empty');
  assert(empty !== null, 'empty state missing');
  assert(textOf(empty) === '正在准备工程…', `boot status is "${textOf(empty)}"`);
  const back = panelButton(tree, 'dv-back');
  assert(back !== null, 'return action missing');
  assert(back.props['aria-label'] === '返回对话', 'return action needs an accessible name');
  assert(textOf(back) === '返回对话', 'return action label missing');
  // The plugin display-settings trigger is gone; the pane width lives on the
  // splitter (the project picker only exists once a project is available).
  assert(findNode(tree, (node) => node.props && node.props['aria-label'] === '显示选项') === null, 'the removed display-settings trigger is still rendered');
  assert(aiWidthCss(tree) !== undefined, 'the resizable AI pane width variable is missing');
  assert(projectMenu(tree) === null, 'project menu must start closed');
  assert(projectToggle(tree) === null, 'the project picker must not appear before a project exists');
  const separator = splitterOf(tree);
  assert(separator !== null && separator.props.role === 'separator', 'resize separator missing');
  const text = textOf(tree);
  for (const forbidden of ['空工作区', '从一个想法', '创建工程', '导出', '时间线', 'dsh-video-editor', '简化界面效果']) {
    assert(text.includes(forbidden) === false, `panel still renders removed content "${forbidden}"`);
  }
});

test('return action leaves the video panel through the host layout service', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment({ activePanelId: PANEL_ID });
  loaded.exports.apply(env.ctx);
  const interactive = mountInteractivePanel(loaded, env);
  let tree = interactive.render();
  const back = panelButton(tree, 'dv-back');
  back.props.onClick();
  assert(env.events.panelCalls[env.events.panelCalls.length - 1] === null, 'return action did not ask for the conversation');
  tree = interactive.rerender();
  assert(findNode(tree, (node) => node.props && node.props.role === 'alert') === null, 'successful return must not show an error');
});

test('failed return is surfaced in place and reported once', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment({ activePanelId: PANEL_ID, selectPanelThrows: true });
  loaded.exports.apply(env.ctx);
  const interactive = mountInteractivePanel(loaded, env);
  let tree = interactive.render();
  panelButton(tree, 'dv-back').props.onClick();
  tree = interactive.rerender();
  const alert = findNode(tree, (node) => node.props && node.props.role === 'alert');
  assert(alert !== null, 'failed return must render an in-place error');
  assert(textOf(alert) === '返回对话失败，请重试。', `error text is "${textOf(alert)}"`);
  assert(
    activationErrors(env).filter((message) => message.includes('navigation-failed')).length === 1,
    'navigation failure must be reported exactly once'
  );
});

test('P3-016: the AI pane splitter resizes, persists, resets and steps from the keyboard', () => {
  const storage = createMemoryStorage();
  const loaded = loadClientWithStorage(storage);
  const env = createFakeEnvironment();
  loaded.exports.apply(env.ctx);
  const interactive = mountInteractivePanel(loaded, env);
  let tree = interactive.render();
  assert(String(aiWidthCss(tree)).includes('42%'), `default AI pane ratio is not 42%: ${aiWidthCss(tree)}`);
  let separator = splitterOf(tree);
  assert(separator !== null, 'splitter separator missing');
  assert(separator.props.tabIndex === 0, 'splitter must be keyboard focusable');
  assert(separator.props['aria-orientation'] === 'vertical', 'splitter orientation missing');
  assert(separator.props['aria-valuenow'] === '42', `splitter value is ${separator.props['aria-valuenow']}`);
  assert(String(separator.props['aria-label']).length > 0, 'splitter needs an accessible name');

  // Simulate a 1000px workspace: leaving the divider at x=500 is a 50% pane.
  mainSplit(tree).getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 700 });
  let prevented = false;
  separator.props.onPointerDown({ preventDefault() { prevented = true; }, currentTarget: {}, pointerId: 1 });
  assert(prevented === true, 'pointer down must be handled');
  separator.props.onPointerMove({ clientX: 500 });
  tree = interactive.rerender();
  assert(String(aiWidthCss(tree)).includes('50%'), `dragged ratio is ${aiWidthCss(tree)}`);
  separator = splitterOf(tree);
  separator.props.onPointerUp({ currentTarget: {}, pointerId: 1 });
  const stored = JSON.parse(storage.map.get(LAYOUT_PREFS_KEY));
  assert(stored.version === 1 && stored.aiPaneRatio === 0.5, `stored layout preference is wrong: ${storage.map.get(LAYOUT_PREFS_KEY)}`);

  // Double-click restores the default ratio and persists it.
  separator.props.onDoubleClick();
  tree = interactive.rerender();
  assert(String(aiWidthCss(tree)).includes('42%'), 'double-click did not restore the default ratio');
  assert(JSON.parse(storage.map.get(LAYOUT_PREFS_KEY)).aiPaneRatio === 0.42, 'double-click did not persist the default');

  // Keyboard: ArrowLeft widens the AI pane, ArrowRight narrows it, Home resets.
  separator = splitterOf(tree);
  let keyPrevented = false;
  separator.props.onKeyDown({ key: 'ArrowLeft', preventDefault() { keyPrevented = true; } });
  assert(keyPrevented === true, 'ArrowLeft must be handled');
  tree = interactive.rerender();
  assert(String(aiWidthCss(tree)).includes('44%'), `ArrowLeft ratio is ${aiWidthCss(tree)}`);
  separator = splitterOf(tree);
  separator.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} });
  tree = interactive.rerender();
  assert(String(aiWidthCss(tree)).includes('42%'), `ArrowRight ratio is ${aiWidthCss(tree)}`);
  separator = splitterOf(tree);
  separator.props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} });
  tree = interactive.rerender();
  separator = splitterOf(tree);
  separator.props.onKeyDown({ key: 'Home', preventDefault() {} });
  tree = interactive.rerender();
  assert(String(aiWidthCss(tree)).includes('42%'), 'Home did not restore the default ratio');
  assert(splitterOf(tree).props['aria-valuenow'] === '42', 'splitter value did not follow the ratio');
});

const LAYOUT = (function loadLayoutHelpers() {
  const source = extractClientRegion('layout splitter helpers');
  assert(source.includes('function aiPaneWidthCss('), 'shipped splitter width helper is missing');
  assert(source.includes('function clampAiPaneWidth('), 'shipped splitter pixel clamp is missing');
  const names = [
    'AI_PANE_DEFAULT_RATIO',
    'AI_PANE_MIN_WIDTH',
    'AI_PANE_MAX_WIDTH',
    'LEFT_PANE_MIN_WIDTH',
    'normalizeAiPaneRatio',
    'aiPaneWidthCss',
    'stepAiPaneRatio',
    'clampAiPaneWidth',
  ];
  const exportExpression = ';({' + names.map((name) => name + ': ' + name).join(', ') + '})';
  return vm.runInContext(source + exportExpression, vm.createContext({}), { filename: 'client.js#layout-splitter-helpers' });
})();

function assertEqual(actual, expected, message) {
  assert(Object.is(actual, expected), `${message || 'values differ'}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

test('P3-016 pure: splitter ratio bounds, CSS width, keyboard steps and pixel clamps', () => {
  assertEqual(LAYOUT.AI_PANE_DEFAULT_RATIO, 0.42);
  assertEqual(LAYOUT.AI_PANE_MIN_WIDTH, 320);
  assertEqual(LAYOUT.AI_PANE_MAX_WIDTH, 720);
  assertEqual(LAYOUT.LEFT_PANE_MIN_WIDTH, 360);
  assertEqual(LAYOUT.normalizeAiPaneRatio(0.5), 0.5);
  assertEqual(LAYOUT.normalizeAiPaneRatio('0.6'), 0.6);
  assertEqual(LAYOUT.normalizeAiPaneRatio(9), 0.7, 'ratio above the maximum was not clamped');
  assertEqual(LAYOUT.normalizeAiPaneRatio(-1), 0.2, 'ratio below the minimum was not clamped');
  assertEqual(LAYOUT.normalizeAiPaneRatio('nope'), 0.42);
  assertEqual(LAYOUT.normalizeAiPaneRatio(Number.NaN), 0.42);
  assertEqual(LAYOUT.normalizeAiPaneRatio(undefined), 0.42);
  assertEqual(LAYOUT.aiPaneWidthCss(0.5), 'clamp(320px, 50%, min(720px, calc(100% - 360px)))');
  assertEqual(LAYOUT.aiPaneWidthCss(0.425), 'clamp(320px, 42.5%, min(720px, calc(100% - 360px)))');
  assertEqual(LAYOUT.stepAiPaneRatio(0.42, 0.02), 0.44);
  assertEqual(LAYOUT.stepAiPaneRatio(0.42, -0.02), 0.4);
  assertEqual(LAYOUT.stepAiPaneRatio(0.69, 0.02), 0.7);
  assertEqual(LAYOUT.stepAiPaneRatio(0.21, -0.02), 0.2);
  assertEqual(LAYOUT.clampAiPaneWidth(500, 1000), 500);
  assertEqual(LAYOUT.clampAiPaneWidth(900, 1000), 640, 'the left stage floor was not protected');
  assertEqual(LAYOUT.clampAiPaneWidth(100, 1000), 320, 'the readable AI minimum was not enforced');
  assertEqual(LAYOUT.clampAiPaneWidth(500, 800), 440, 'a narrow container did not protect the left stage');
  assertEqual(LAYOUT.clampAiPaneWidth(500, 1500), 500);
  assertEqual(LAYOUT.clampAiPaneWidth(Number.NaN, 1000), 320);
});

test('P3-016: the pane-width preference is restored on a fresh module load', () => {
  const storage = createMemoryStorage({ [LAYOUT_PREFS_KEY]: JSON.stringify({ version: 1, aiPaneRatio: 0.5 }) });
  const loaded = loadClientWithStorage(storage);
  const env = createFakeEnvironment();
  loaded.exports.apply(env.ctx);
  const tree = mountPanel(loaded, env);
  assert(String(aiWidthCss(tree)).includes('50%'), 'stored pane ratio was not restored');
  assert(splitterOf(tree).props['aria-valuenow'] === '50', 'splitter value did not reflect the stored ratio');
});

test('P3-016: corrupt, unknown-version and wrong-shape layout preferences fall back safely', () => {
  const cases = [
    ['invalid JSON', '{"version":1,'],
    ['old version', JSON.stringify({ version: 0, aiPaneRatio: 0.5 })],
    ['unknown version', JSON.stringify({ version: 99, aiPaneRatio: 0.5 })],
    ['null payload', 'null'],
    ['array payload', '[]'],
    ['missing field', JSON.stringify({ version: 1 })],
    ['legacy simplified payload', JSON.stringify({ version: 1, simplifiedEffects: true })],
    ['non-numeric ratio', JSON.stringify({ version: 1, aiPaneRatio: 'wide' })],
  ];
  for (const [label, raw] of cases) {
    const storage = createMemoryStorage({ [LAYOUT_PREFS_KEY]: raw });
    const loaded = loadClientWithStorage(storage);
    const env = createFakeEnvironment();
    loaded.exports.apply(env.ctx);
    const tree = mountPanel(loaded, env);
    assert(String(aiWidthCss(tree)).includes('42%'), `${label}: corrupt preference was not rejected`);
  }
  // A valid but out-of-range ratio is accepted and clamped, not dropped.
  const storage = createMemoryStorage({ [LAYOUT_PREFS_KEY]: JSON.stringify({ version: 1, aiPaneRatio: 9 }) });
  const loaded = loadClientWithStorage(storage);
  const env = createFakeEnvironment();
  loaded.exports.apply(env.ctx);
  assert(String(aiWidthCss(mountPanel(loaded, env))).includes('70%'), 'an out-of-range ratio was not clamped');
});

test('P3-016: storage read/write exceptions keep the pane usable and are reported', () => {
  const storage = createMemoryStorage({}, { getThrows: true, setThrows: true });
  const loaded = loadClientWithStorage(storage);
  const env = createFakeEnvironment();
  let threw = false;
  try {
    loaded.exports.apply(env.ctx);
  } catch (_error) {
    threw = true;
  }
  assert(threw === false, 'apply threw when storage was unavailable');
  const interactive = mountInteractivePanel(loaded, env);
  let tree = interactive.render();
  assert(String(aiWidthCss(tree)).includes('42%'), 'an unreadable preference changed the default ratio');
  mainSplit(tree).getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 700 });
  let separator = splitterOf(tree);
  try {
    separator.props.onPointerDown({ preventDefault() {}, currentTarget: {}, pointerId: 1 });
    separator.props.onPointerMove({ clientX: 480 });
    tree = interactive.rerender();
    separator = splitterOf(tree);
    separator.props.onPointerUp({ currentTarget: {}, pointerId: 1 });
    tree = interactive.rerender();
    separator = splitterOf(tree);
    separator.props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} });
    tree = interactive.rerender();
  } catch (_error) {
    threw = true;
  }
  assert(threw === false, 'the pane threw when the storage write failed');
  assert(String(aiWidthCss(tree)).includes('%'), 'the in-memory ratio was lost after a failed write');
  assert(activationErrors(env).some((message) => message.includes('prefs-')), 'storage failures were not reported');
});

test('P3-016: the project picker menu manages focus and closes with Escape/Tab', async () => {
  const sessions = makeSessionsService({ list: ['session-menu'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-menu', sessions: ['session-menu'] });
  const editor = await mountBootedPanel(hostFetch, { sessions: sessions, kit: makeSessionKit() });
  try {
    let tree = editor.tree();
    let toggle = projectToggle(tree);
    assert(toggle !== null, 'project picker arrow missing');
    assert(toggle.props['aria-expanded'] === 'false', 'menu must start collapsed');
    toggle.props.onClick();
    tree = editor.rerender();
    assert(projectToggle(tree).props['aria-expanded'] === 'true', 'the arrow did not expose the open state');
    const menu = projectMenu(tree);
    assert(menu !== null, 'the project menu did not open');
    const activeItem = findNode(menu, (node) => node.type === 'button' && node.props.role === 'menuitemradio' && node.props['aria-checked'] === 'true');
    assert(activeItem !== null, 'the current project item is missing');
    const focused = editor.interactive.activeElement();
    assert(focused !== null && focused.props && focused.props.role === 'menuitemradio', 'opening the menu did not focus the current project');
    menu.props.onKeyDown({ key: 'Escape', preventDefault() {} });
    tree = editor.rerender();
    assert(projectMenu(tree) === null, 'Escape did not close the project menu');
    const afterEscape = editor.interactive.activeElement();
    assert(afterEscape !== null && String(afterEscape.props.className).split(/\s+/).includes('dv-project-toggle'), 'Escape did not return focus to the arrow');
    let prevented = false;
    projectToggle(tree).props.onKeyDown({ key: 'ArrowDown', preventDefault() { prevented = true; } });
    assert(prevented === true, 'ArrowDown must be handled');
    tree = editor.rerender();
    assert(projectMenu(tree) !== null, 'ArrowDown did not open the project menu');
    const focusedByArrow = editor.interactive.activeElement();
    assert(focusedByArrow !== null && focusedByArrow.props.role === 'menuitemradio', 'ArrowDown did not focus the current project');
    projectMenu(tree).props.onKeyDown({ key: 'Tab', preventDefault() {} });
    tree = editor.rerender();
    assert(projectMenu(tree) === null, 'Tab did not close the project menu');
    const afterTab = editor.interactive.activeElement();
    assert(afterTab !== null && String(afterTab.props.className).split(/\s+/).includes('dv-project-toggle'), 'Tab did not return focus to the arrow');
    projectToggle(tree).props.onClick();
    tree = editor.rerender();
    assert(projectMenu(tree) !== null, 'menu did not reopen');
    projectToggle(tree).props.onClick();
    tree = editor.rerender();
    assert(projectMenu(tree) === null, 'second arrow press did not close the menu');
  } finally {
    editor.interactive.unmount();
  }
});

test('M1-04: the project menu shows the folder actions and copies the Host-authoritative path', async () => {
  const sessions = makeSessionsService({ list: ['session-folder'] });
  const baseFetch = sessionFetch({ activeSessionId: 'session-folder', sessions: ['session-folder'] });
  const seen = [];
  const hostFetch = makeHostFetch(async (request) => {
    const method = request.body && request.body.method;
    seen.push(method);
    if (method === 'project.path') {
      return { ok: true, result: { projectId: 'demo', path: '/Users/test/Movies/DSH Video/projects/demo' } };
    }
    if (method === 'project.reveal') {
      return { ok: true, result: { projectId: 'demo', opened: true } };
    }
    const response = await baseFetch(request.url, { method: 'POST', body: JSON.stringify(request.body) });
    return response.json();
  });

  async function mountFolderPanel(navigatorMock) {
    const loaded = loadClient({ fetch: hostFetch });
    loaded.sandbox.navigator = navigatorMock;
    const env = createFakeEnvironment({ services: { sessions } });
    loaded.exports.apply(env.ctx);
    const main = registrationOf(env, 'main');
    assert(main !== undefined, 'main panel is not registered');
    const props = Object.assign({ t: translateFor(env) }, main.options.inject(), makeSessionKit());
    const interactive = loaded.react.renderInteractive(main.component, props);
    let tree = interactive.render();
    for (let round = 0; round < 14; round += 1) {
      await settle();
      tree = interactive.rerender();
    }
    return { loaded, env, interactive, tree: () => tree, rerender() { tree = interactive.rerender(); return tree; } };
  }

  let clipboardValue = null;
  const editor = await mountFolderPanel({ platform: 'MacIntel', clipboard: { writeText: async (value) => { clipboardValue = value; } } });
  try {
    let tree = editor.tree();
    const toggle = projectToggle(tree);
    assert(toggle !== null, 'project picker arrow missing for the folder actions');
    toggle.props.onClick();
    tree = editor.rerender();
    const revealItem = findNode(tree, (node) => node.type === 'button' && node.props && node.props['data-action'] === 'reveal');
    const copyItem = findNode(tree, (node) => node.type === 'button' && node.props && node.props['data-action'] === 'copy-path');
    assert(revealItem !== null && copyItem !== null, 'the folder actions are missing from the project menu');
    assert(textOf(revealItem) === '在 Finder 中显示', `macOS reveal label is wrong: ${textOf(revealItem)}`);
    assert(textOf(copyItem) === '复制路径', 'copy-path label is wrong');
    assert(revealItem.props.role === 'menuitem' && revealItem.props.disabled === false, 'the reveal item must be an enabled menuitem');

    // A visible folder button in the project bar is the primary affordance; it
    // reveals directly without opening the picker menu.
    const folderButton = findNode(tree, (node) => node.type === 'button' && node.props && node.props['data-action'] === 'reveal-folder');
    assert(folderButton !== null, 'the visible folder button is missing from the project bar');
    assert(folderButton.props['aria-label'] === '在 Finder 中显示', `folder button aria-label is wrong: ${folderButton.props['aria-label']}`);
    const revealsBefore = seen.filter((method) => method === 'project.reveal').length;
    folderButton.props.onClick();
    await settle(10);
    tree = editor.rerender();
    assert(seen.filter((method) => method === 'project.reveal').length === revealsBefore + 1, 'the folder button did not issue exactly one reveal request');
    assert(projectMenu(tree) === null, 'the folder button opened the project menu');

    projectToggle(tree).props.onClick();
    tree = editor.rerender();
    projectMenu(tree).props.onKeyDown({ key: 'Escape', preventDefault() {} });
    tree = editor.rerender();
    projectToggle(tree).props.onClick();
    tree = editor.rerender();
    const menuReveal = findNode(tree, (node) => node.type === 'button' && node.props && node.props['data-action'] === 'reveal');
    menuReveal.props.onClick();
    await settle(10);
    tree = editor.rerender();
    assert(seen.includes('project.reveal'), 'the reveal action did not reach the Host');
    assert(projectMenu(tree) === null, 'the menu stayed open after reveal');
    assert(findNode(tree, (node) => node.props && node.props.className === 'dv-project-folder-notice') === null, 'a successful reveal showed an error notice');

    projectToggle(tree).props.onClick();
    tree = editor.rerender();
    findNode(tree, (node) => node.type === 'button' && node.props && node.props['data-action'] === 'copy-path').props.onClick();
    await settle(10);
    tree = editor.rerender();
    assert(seen.includes('project.path'), 'the copy action did not ask the Host for the authoritative path');
    assert(clipboardValue === '/Users/test/Movies/DSH Video/projects/demo', `clipboard received ${String(clipboardValue)}`);
    const notice = findNode(tree, (node) => node.props && node.props.className === 'dv-project-folder-notice');
    assert(notice !== null && textOf(notice) === '路径已复制', 'the copy success notice is missing');
  } finally {
    editor.interactive.unmount();
  }

  // No open project: the folder button is not rendered.
  const emptyLoaded = loadClient({ fetch: hostFetch });
  const emptyEnv = createFakeEnvironment({ services: { sessions } });
  emptyLoaded.exports.apply(emptyEnv.ctx);
  const emptyMain = registrationOf(emptyEnv, 'main');
  const emptyProps = Object.assign({ t: translateFor(emptyEnv) }, emptyMain.options.inject(), makeSessionKit());
  const emptyInteractive = emptyLoaded.react.renderInteractive(emptyMain.component, emptyProps);
  const emptyTree = emptyInteractive.render();
  assert(findNode(emptyTree, (node) => node.props && node.props['data-action'] === 'reveal-folder') === null, 'the folder button is rendered without an open project');
  emptyInteractive.unmount();

  // Non-macOS label and clipboard fallback: the toast shows the path for manual copy.
  const failing = makeHostFetch(async (request) => {
    const method = request.body && request.body.method;
    if (method === 'project.path') return { ok: true, result: { projectId: 'demo', path: '/tmp/工程 目录/demo' } };
    const response = await baseFetch(request.url, { method: 'POST', body: JSON.stringify(request.body) });
    return response.json();
  });
  const failingEditor = await (async () => {
    const loaded = loadClient({ fetch: failing });
    loaded.sandbox.navigator = { platform: 'Win32' };
    const env = createFakeEnvironment({ services: { sessions } });
    loaded.exports.apply(env.ctx);
    const main = registrationOf(env, 'main');
    const props = Object.assign({ t: translateFor(env) }, main.options.inject(), makeSessionKit());
    const interactive = loaded.react.renderInteractive(main.component, props);
    let tree = interactive.render();
    for (let round = 0; round < 14; round += 1) {
      await settle();
      tree = interactive.rerender();
    }
    return { tree: () => tree, rerender() { tree = interactive.rerender(); return tree; }, interactive };
  })();
  try {
    let tree = failingEditor.tree();
    projectToggle(tree).props.onClick();
    tree = failingEditor.rerender();
    const revealItem = findNode(tree, (node) => node.type === 'button' && node.props && node.props['data-action'] === 'reveal');
    assert(textOf(revealItem) === '在文件管理器中显示', 'the non-macOS reveal label is wrong');
    findNode(tree, (node) => node.type === 'button' && node.props && node.props['data-action'] === 'copy-path').props.onClick();
    await settle(10);
    tree = failingEditor.rerender();
    const notice = findNode(tree, (node) => node.props && node.props.className === 'dv-project-folder-notice');
    assert(notice !== null && notice.props.role === 'alert', 'a failed copy did not surface an alert notice');
    assert(textOf(notice).includes('/tmp/工程 目录/demo'), 'the fallback notice does not expose the path for manual copy');
  } finally {
    failingEditor.interactive.unmount();
  }
});

test('M1-05: the Host ui-state restores the last project and exposes the save status', async () => {
  const sessions = makeSessionsService({ list: ['session-state'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-state', sessions: ['session-state'] });
  const uiSets = [];
  hostFetch.config.handler = (request) => {
    const method = request.body.method;
    if (method === 'ui.state.get') {
      return { ok: true, result: { version: 1, lastProjectId: 'proj-restored', layout: { aiPaneRatio: 0.55 }, timelineOpen: null, updatedAt: null } };
    }
    if (method === 'ui.state.set') {
      uiSets.push(request.body.params.patch);
      return { ok: true, result: { version: 1, lastProjectId: request.body.params.patch.lastProjectId === undefined ? 'proj-restored' : request.body.params.patch.lastProjectId, layout: { aiPaneRatio: 0.55 }, timelineOpen: null, updatedAt: null } };
    }
    if (method === 'project.list') {
      return {
        ok: true,
        result: {
          projects: [
            { projectId: 'proj-smoke', updatedAt: 2000 },
            { projectId: 'proj-restored', updatedAt: 1000 },
          ],
          defaultProjectId: 'proj-smoke',
        },
      };
    }
    return undefined;
  };
  const editor = await mountBootedPanel(hostFetch, { sessions: sessions, kit: makeSessionKit() });
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await settlePanel(editor);
    let tree = editor.tree();
    const root = findNode(tree, (node) => node.props && node.props.className === 'dv-root');
    assert(root !== null && root.props['data-project-id'] === 'proj-restored', `the Host lastProjectId was not restored: ${root && root.props['data-project-id']}`);
    assert(String(aiWidthCss(tree)).includes('55%'), `the Host pane ratio was not restored: ${aiWidthCss(tree)}`);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await settlePanel(editor);
    assert(uiSets.some((patch) => patch.lastProjectId === 'proj-restored'), 'the restored project was not written back to the Host ui-state');
    const chip = findNode(tree, (node) => node.type === 'button' && node.props && node.props.className === 'dv-save-status');
    assert(chip !== null && chip.props['data-status'] === 'saved', `the saved indicator is missing: ${chip && chip.props['data-status']}`);
    assert(textOf(chip) === '已保存', `the saved indicator text is wrong: ${textOf(chip)}`);
    // Changing the splitter persists the new ratio to the Host ui-state.
    const splitter = splitterOf(tree);
    assert(splitter !== null, 'splitter missing for ratio persistence');
    splitter.props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await settlePanel(editor);
    assert(uiSets.some((patch) => patch.layout && Math.abs(patch.layout.aiPaneRatio - 0.55) > 0.01), 'the pane ratio change was not persisted to the Host ui-state');
  } finally {
    editor.interactive.unmount();
  }
});

test('M1-05: a failed panel-state save is visible and retryable', async () => {
  const sessions = makeSessionsService({ list: ['session-state'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-state', sessions: ['session-state'] });
  let setAttempts = 0;
  hostFetch.config.handler = (request) => {
    const method = request.body.method;
    if (method === 'ui.state.get') {
      return { ok: true, result: { version: 1, lastProjectId: null, layout: null, timelineOpen: null, updatedAt: null } };
    }
    if (method === 'ui.state.set') {
      setAttempts += 1;
      return { ok: false, error: { code: 'E_INTERNAL', message: 'disk unavailable', stage: 'ui-state' } };
    }
    return undefined;
  };
  const editor = await mountBootedPanel(hostFetch, { sessions: sessions, kit: makeSessionKit() });
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await settlePanel(editor);
    let tree = editor.tree();
    let chip = findNode(tree, (node) => node.type === 'button' && node.props && node.props.className === 'dv-save-status');
    assert(chip !== null && chip.props['data-status'] === 'failed', `a failed save was not surfaced: ${chip && chip.props['data-status']}`);
    assert(textOf(chip) === '保存失败 · 重试', `unexpected failed-save copy: ${textOf(chip)}`);
    const attemptsBefore = setAttempts;
    chip.props.onClick();
    tree = editor.rerender();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await settlePanel(editor);
    tree = editor.tree();
    chip = findNode(tree, (node) => node.type === 'button' && node.props && node.props.className === 'dv-save-status');
    assert(setAttempts > attemptsBefore, 'retrying the failed save did not issue another Host write');
    assert(chip !== null && chip.props['data-status'] === 'failed', 'the retried save did not settle back to failed');
  } finally {
    editor.interactive.unmount();
  }
});

test('P3-016: the work name starts inline rename; Enter saves and Esc cancels without publishing', async () => {
  const sessions = makeSessionsService({ list: ['session-rename'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-rename', sessions: ['session-rename'] });
  hostFetch.config.handler = (request) => {
    if (request.body.method === 'project.rename') {
      return {
        ok: true,
        result: {
          projectId: request.body.params.projectId,
          revision: 'c'.repeat(64),
          title: request.body.params.title,
          changed: true,
        },
      };
    }
    return undefined;
  };
  const editor = await mountBootedPanel(hostFetch, { sessions: sessions, kit: makeSessionKit() });
  try {
    let tree = editor.rerender();
    const nameButton = projectNameButton(tree);
    assert(nameButton !== null && textOf(nameButton) === 'Scene 1', 'the current work name is missing');
    nameButton.props.onClick();
    tree = editor.rerender();
    let input = projectNameInput(tree);
    assert(input !== null, 'clicking the name did not start inline rename');
    assert(input.props.value === 'Scene 1', `rename draft is ${input.props.value}`);
    assert(editor.interactive.activeElement() === input, 'the rename input was not focused');
    assert(input.props['aria-label'] === '重命名工程', 'the rename input needs an accessible name');
    input.props.onKeyDown({ key: 'Escape', preventDefault() {} });
    tree = editor.rerender();
    assert(projectNameInput(tree) === null && textOf(projectNameButton(tree)) === 'Scene 1', 'Escape did not cancel the rename');
    assert(hostFetch.calls.every((call) => call.body.method !== 'project.rename'), 'Escape issued a rename request');
    projectNameButton(tree).props.onClick();
    tree = editor.rerender();
    projectNameInput(tree).props.onChange({ target: { value: '  足球短片  ' } });
    tree = editor.rerender();
    assert(projectNameInput(tree).props.value === '  足球短片  ', 'the draft did not update');
    projectNameInput(tree).props.onKeyDown({ key: 'Enter', preventDefault() {} });
    await settlePanel(editor);
    tree = editor.tree();
    const calls = hostFetch.calls.filter((call) => call.body.method === 'project.rename');
    assert(calls.length === 1, `expected one rename request, got ${calls.length}`);
    assert(calls[0].body.params.title === '足球短片', `rename sent "${calls[0].body.params.title}"`);
    assert(projectNameInput(tree) === null, 'the rename input stayed after a successful save');
    assert(textOf(projectNameButton(tree)) === '足球短片', 'the saved title is not shown');
    assert(hostFetch.calls.every((call) => call.body.method !== 'project.compose' && call.body.method !== 'edit'), 'rename triggered a content write');
    // The new title also wins over the content-derived fallback in the picker.
    projectToggle(tree).props.onClick();
    tree = editor.rerender();
    assert(textOf(projectMenu(tree)).includes('足球短片'), 'the picker did not adopt the renamed title');
  } finally {
    editor.interactive.unmount();
  }
});

test('P3-016: rename failures stay local, keep the draft and never publish', async () => {
  const sessions = makeSessionsService({ list: ['session-rename-fail'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-rename-fail', sessions: ['session-rename-fail'] });
  hostFetch.config.handler = (request) => {
    if (request.body.method === 'project.rename') {
      return { ok: false, error: { code: 'E_PARAMS', message: 'Invalid project title' } };
    }
    return undefined;
  };
  const editor = await mountBootedPanel(hostFetch, { sessions: sessions, kit: makeSessionKit() });
  try {
    let tree = editor.rerender();
    projectNameButton(tree).props.onClick();
    tree = editor.rerender();
    projectNameInput(tree).props.onChange({ target: { value: '失败标题' } });
    tree = editor.rerender();
    projectNameInput(tree).props.onKeyDown({ key: 'Enter', preventDefault() {} });
    await settlePanel(editor);
    tree = editor.tree();
    const alert = findNode(tree, (node) => node.props && node.props.className === 'dv-project-rename-error');
    assert(alert !== null, 'a failed rename did not show an error');
    assert(textOf(alert) === '重命名失败，请重试。', `rename error text is "${textOf(alert)}"`);
    assert(projectNameInput(tree) !== null && projectNameInput(tree).props.value === '失败标题', 'the failed rename did not keep the draft');
    assert(projectNameButton(tree) === null, 'a failed rename replaced the draft with the old name');
    assert(hostFetch.calls.every((call) => call.body.method !== 'project.compose' && call.body.method !== 'edit'), 'a failed rename triggered a content write');
    // An empty/blank title is refused locally without a worker round trip.
    projectNameInput(tree).props.onChange({ target: { value: '   ' } });
    tree = editor.rerender();
    projectNameInput(tree).props.onKeyDown({ key: 'Enter', preventDefault() {} });
    tree = editor.rerender();
    const emptyAlert = findNode(tree, (node) => node.props && node.props.className === 'dv-project-rename-error');
    assert(emptyAlert !== null && textOf(emptyAlert) === '工程名称不能为空。', 'a blank title was not refused locally');
    assert(hostFetch.calls.filter((call) => call.body.method === 'project.rename').length === 1, 'a blank title was sent to the worker');
    // Escape clears the failure and restores the name control.
    projectNameInput(tree).props.onKeyDown({ key: 'Escape', preventDefault() {} });
    tree = editor.rerender();
    assert(projectNameInput(tree) === null, 'Escape did not close the failed rename');
    assert(textOf(projectNameButton(tree)) === 'Scene 1', 'a failed rename changed the visible title');
    assert(findNode(tree, (node) => node.props && node.props.className === 'dv-project-rename-error') === null, 'Escape left the rename error visible');
  } finally {
    editor.interactive.unmount();
  }
});
//#endregion

//#region tests: sidebar/main atomic lifecycle
test('sidebar declared late: the pair mounts only together', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment({
    declaredSlots: { [SIDEBAR_SLOT]: false } });
  loaded.exports.apply(env.ctx);
  assert(liveRegistrations(env).length === 0, 'nothing may register before the sidebar entry exists');
  assert(registrationOf(env, 'main') === undefined, 'main panel must not exist before its sidebar entry');
  env.declareSlot(SIDEBAR_SLOT, 'list');
  assert(liveMain(env).length === 1, 'main panel missing after sidebar declaration');
  assert(liveSidebar(env).length === 1, 'sidebar entry missing after declaration');
  const nav = navigationOf(env);
  nav.onBack();
  assert(env.events.panelCalls[env.events.panelCalls.length - 1] === null, 'navigation unavailable after late mount');
});

test('main declared late: the pair mounts only together', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment({ declaredSlots: { main: false } });
  loaded.exports.apply(env.ctx);
  assert(liveRegistrations(env).length === 0, 'nothing may register before the main declaration exists');
  assert(registrationOf(env, SIDEBAR_SLOT) === undefined, 'sidebar entry must not exist before its panel');
  env.declareSlot('main', 'keyed');
  assert(liveMain(env).length === 1, 'main panel missing after declaration');
  assert(liveSidebar(env).length === 1, 'sidebar entry missing after declaration');
});

test('the new sidebar row coexists with the shipped panel rows', () => {
  const loaded = loadClient();
  const shipped = [
    { options: { id: 'plugins', order: 0, label: 'plugins' } },
    { options: { id: 'schedules', order: 10, label: 'schedules' } },
    { options: { id: 'dsh-context', order: 20, label: 'context' } },
  ];
  const env = createFakeEnvironment({ sidebarOccupants: shipped });
  loaded.exports.apply(env.ctx);
  const entries = env.entriesBySlot[SIDEBAR_SLOT];
  assert(entries.length === 4, `expected 3 shipped rows + ours, got ${entries.length}`);
  assert(entries.indexOf(shipped[0]) >= 0 && entries.indexOf(shipped[2]) >= 0, 'shipped rows were replaced');
  const ours = entries.find((entry) => entry.options && entry.options.id === PANEL_ID);
  assert(ours !== undefined, 'our sidebar row is missing');
  assert(ours.options.order === 30, 'our row must sort after the shipped rows');
  assert(env.events.errors.length === 0, `unexpected activation errors: ${activationErrors(env).join('; ')}`);
});

test('an occupied sidebar id refuses the whole pair', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment({ sidebarOccupants: [{ options: { id: PANEL_ID, order: 30 } }] });
  loaded.exports.apply(env.ctx);
  assert(liveRegistrations(env).length === 0, 'a conflicting sidebar id left registrations behind');
  assert(registrationOf(env, 'main') === undefined, 'video panel was registered without a usable entry');
  assert(
    activationErrors(env).some((message) => message.includes('sidebar-entry-conflict')),
    'sidebar id conflict was not reported'
  );
  assert(
    activationErrors(env).some((message) => message.includes('sidebar-entry-unavailable')),
    'missing reachable entry was not diagnosed'
  );
});

test('an occupied main key refuses the whole pair', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment({ mainOccupants: [{ options: { key: PANEL_ID } }] });
  loaded.exports.apply(env.ctx);
  assert(liveRegistrations(env).length === 0, 'expected no registrations');
  assert(activationErrors(env).some((message) => message.includes('main-key-conflict')), 'main key conflict was not reported');
});

test('a sidebar registration failure rolls the video panel back', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment({ registerThrows: { [SIDEBAR_SLOT]: true } });
  loaded.exports.apply(env.ctx);
  assert(liveRegistrations(env).length === 0, 'a failed sidebar entry left the video panel registered');
  assert(env.entriesBySlot.main.length === 0, 'main panel registration survived the rollback');
  const errors = activationErrors(env);
  assert(errors.some((message) => message.includes('sidebar-register-failed')), 'sidebar registration failure was not reported');
  assert(errors.some((message) => message.includes('sidebar-entry-unavailable')), 'missing entry was not diagnosed');
});

test('a main registration failure leaves no sidebar entry', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment({ registerThrows: { main: true } });
  loaded.exports.apply(env.ctx);
  assert(liveRegistrations(env).length === 0, 'a failed main panel left registrations behind');
  assert(registrationOf(env, SIDEBAR_SLOT) === undefined, 'a sidebar entry was registered without its panel');
  assert(activationErrors(env).some((message) => message.includes('main-register-failed')), 'main registration failure was not reported');
});

test('slot enumeration failure refuses to mount without throwing', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment({ entriesUnavailable: true });
  let threw = false;
  try {
    loaded.exports.apply(env.ctx);
  } catch (_error) {
    threw = true;
  }
  assert(threw === false, 'apply threw when slot enumeration was unavailable');
  assert(liveRegistrations(env).length === 0, `expected no registrations, got ${liveRegistrations(env).length}`);
  assert(
    activationErrors(env).some((message) => message.includes('main-entries-unavailable')),
    'enumeration failure was not reported'
  );
});
//#endregion

//#region tests: collapse, retry and unload
test('sidebar collapse while video is selected releases the pair and returns to the conversation', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment();
  loaded.exports.apply(env.ctx);
  env.setActivePanel(PANEL_ID);
  assert(liveRegistrations(env).length === 2, 'baseline pair missing');
  env.collapseSlot(SIDEBAR_SLOT);
  assert(liveRegistrations(env).length === 0, `a lost sidebar entry left ${liveRegistrations(env).length} registration(s)`);
  assert(env.events.panelCalls[env.events.panelCalls.length - 1] === null, 'losing the entry did not return the UI to the conversation');
  env.declareSlot(SIDEBAR_SLOT, 'list');
  assert(liveMain(env).length === 1 && liveSidebar(env).length === 1, 'redeclaration did not restore the pair');
  const cleanupErrors = activationErrors(env).filter((message) => message.includes('cleanup-failed'));
  assert(cleanupErrors.length === 0, `cleanup errors after collapse: ${cleanupErrors.join('; ')}`);
});

test('main collapse releases the sidebar entry; redeclaration restores the pair', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment();
  loaded.exports.apply(env.ctx);
  env.setActivePanel(PANEL_ID);
  env.collapseSlot('main');
  assert(liveRegistrations(env).length === 0, `main collapse left ${liveRegistrations(env).length} live registration(s)`);
  assert(env.events.panelCalls[env.events.panelCalls.length - 1] === null, 'main collapse while video was selected did not return to the conversation');
  env.declareSlot('main', 'keyed');
  assert(liveMain(env).length === 1 && liveSidebar(env).length === 1, 'main redeclaration did not restore the pair');
});

test('losing the entry does not steal another panel', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment();
  loaded.exports.apply(env.ctx);
  env.setActivePanel('plugins');
  env.collapseSlot(SIDEBAR_SLOT);
  assert(liveRegistrations(env).length === 0, 'pair was not released');
  assert(env.events.panelCalls.length === 0, 'another panel selection was disturbed');
  env.declareSlot(SIDEBAR_SLOT, 'list');
  assert(liveMain(env).length === 1 && liveSidebar(env).length === 1, 'pair did not recover');
});

test('repeated declaration cycles keep exactly one pair and no duplicate registration', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment();
  loaded.exports.apply(env.ctx);
  for (let round = 0; round < 3; round += 1) {
    env.collapseSlot(SIDEBAR_SLOT);
    assert(liveRegistrations(env).length === 0, `round ${round}: lost entry left live registrations`);
    env.declareSlot(SIDEBAR_SLOT, 'list');
    assert(liveMain(env).length === 1, `round ${round}: expected exactly one main registration`);
    assert(liveSidebar(env).length === 1, `round ${round}: expected exactly one sidebar entry`);
  }
  const cleanupErrors = activationErrors(env).filter((message) => message.includes('cleanup-failed'));
  assert(cleanupErrors.length === 0, `repeated lifecycle produced cleanup errors: ${cleanupErrors.join('; ')}`);
});

test('unloading while video is selected removes everything and returns to the conversation', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment();
  loaded.exports.apply(env.ctx);
  env.setActivePanel(PANEL_ID);
  env.disposeAllInjections();
  env.disposeAllEffects();
  assert(liveRegistrations(env).length === 0, `registrations left live after unload: ${liveRegistrations(env).length}`);
  assert(env.events.panelCalls[env.events.panelCalls.length - 1] === null, 'unload while video was selected did not return to the conversation');
});

test('unloading while another panel is selected does not steal it', () => {
  const loaded = loadClient();
  const env = createFakeEnvironment();
  loaded.exports.apply(env.ctx);
  env.setActivePanel('plugins');
  env.disposeAllInjections();
  env.disposeAllEffects();
  assert(liveRegistrations(env).length === 0, 'registrations left live after unload');
  assert(env.events.panelCalls.length === 0, 'unload disturbed another selected panel');
});

//#region P3-012: conversation-first auto preview
function panelRoot(tree) {
  return findNode(tree, (node) => node.props && node.props['data-boot'] !== undefined);
}

function productCanvas(tree) {
  return findNode(tree, (node) => node.props && node.props.className === 'dv-canvas-shell');
}

function previewFrame(tree) {
  return findNode(tree, (node) => node.type === 'iframe' && node.props && node.props.className === 'dv-stage-frame');
}

function inspectWithRevision(revision) {
  return Object.assign(managedInspected(), { revision: revision });
}

function panelClasses(tree) {
  return findAll(tree, (node) => node.props && typeof node.props.className === 'string').map((node) => node.props.className);
}

function panelIds(tree) {
  return findAll(tree, (node) => node.props && typeof node.props.id === 'string').map((node) => node.props.id);
}

test('P3-012: no project auto-provisions one project and one bound Session exactly once', async () => {
  const sessions = makeSessionsService({ list: [] });
  const hostFetch = sessionFetch({ activeSessionId: null, sessions: [], newSessionId: 'session-first' });
  hostFetch.config.handler = async (request) => {
    if (request.body.method === 'project.list') {
      return { ok: true, result: { projects: [{ projectId: 'demo', updatedAt: 9 }], defaultProjectId: 'demo' } };
    }
    return undefined;
  };
  const kit = makeSessionKit();
  const editor = await mountBootedPanel(hostFetch, { sessions: sessions, kit: kit });
  const tree = editor.tree();
  const projectCreates = hostFetch.calls.filter((call) => call.body.method === 'project.create');
  const sessionCreates = hostFetch.calls.filter((call) => call.body.method === 'session.create');
  assert(projectCreates.length === 1, `first open issued ${projectCreates.length} project.create requests`);
  assert(hostFetch.config.projectCreated === true, 'project.create was not called for a first-time user');
  assert(sessionCreates.length === 1 && hostFetch.config.createCalls === 1, `first open issued ${sessionCreates.length} session.create requests`);
  assert(typeof sessionCreates[0].body.params.requestId === 'string' && sessionCreates[0].body.params.requestId.length > 0, 'session.create lost its dedupe requestId');
  const root = panelRoot(tree);
  assert(root !== null && root.props['data-boot'] === 'ready', `boot state is ${root && root.props['data-boot']}`);
  assert(root.props['data-project-id'] === 'proj-smoke', `the provisioned project is not adopted: ${root.props['data-project-id']}`);
  assert(root.props['data-session-active'] === 'session-first', `the created Session is not active: ${root.props['data-session-active']}`);
  assert(productCanvas(tree) !== null, 'the read-only canvas did not mount for the provisioned project');
  assert(findNode(tree, (node) => node.props && node.props['data-canvas-revision'] === 'c'.repeat(64)) !== null, 'the first preview revision is not rendered');
  assert(hostFetch.config.snapshotRequests && hostFetch.config.snapshotRequests.length >= 1, 'no preview snapshot was requested');
  // Re-renders (a double effect) must not provision a second project/Session pair.
  editor.rerender();
  await settle();
  editor.rerender();
  assert(hostFetch.calls.filter((call) => call.body.method === 'project.create').length === 1, 'a re-render provisioned a second project');
  assert(hostFetch.calls.filter((call) => call.body.method === 'session.create').length === 1, 'a re-render created a second Session');
});

test('P3-012: project.list auto-opens the most recent managed project and ignores demo', async () => {
  const sessions = makeSessionsService({ list: ['session-ready'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-ready', sessions: ['session-ready'] });
  hostFetch.config.handler = async (request) => {
    if (request.body.method === 'project.list') {
      return {
        ok: true,
        result: {
          projects: [
            { projectId: 'demo', updatedAt: 90 },
            { projectId: 'proj-older', updatedAt: 10 },
            { projectId: 'proj-recent', updatedAt: 20 },
          ],
          defaultProjectId: 'proj-recent',
        },
      };
    }
    return undefined;
  };
  const kit = makeSessionKit();
  const editor = await mountBootedPanel(hostFetch, { sessions: sessions, kit: kit });
  const tree = editor.tree();
  assert(hostFetch.config.openedProject === 'proj-recent', `auto-opened "${hostFetch.config.openedProject}" instead of the most recent managed project`);
  const root = panelRoot(tree);
  assert(root.props['data-project-id'] === 'proj-recent', 'the product panel did not adopt the auto-opened project');
  assert(productCanvas(tree) !== null, 'the left read-only canvas did not mount');
  const frame = previewFrame(tree);
  assert(frame !== null, 'the snapshot iframe is missing');
  assert(typeof frame.props.src === 'string' && frame.props.src.startsWith('/api/dsh-video/preview/') && frame.props.src.includes('instance='), 'the iframe is not bound to the preview route');
  assert(frame.props.sandbox === 'allow-scripts', 'the snapshot iframe is not sandboxed to scripts only');
  assert(hostFetch.config.snapshotRequests[0].projectId === 'proj-recent', `snapshot requested for ${hostFetch.config.snapshotRequests[0].projectId}`);
  assert(hostFetch.config.snapshotRequests[0].revision === 'c'.repeat(64), 'the snapshot was not requested for the inspected revision');
  const sessionLists = hostFetch.calls.filter((call) => call.body.method === 'session.list');
  assert(sessionLists.length >= 1, 'the bound Session list was not loaded');
  assert(sessionLists.every((call) => call.body.params.projectId === 'proj-recent'), 'the Session list was loaded for a different project');
  // The demo entry never reaches the switcher.
  const optionValues = findAll(tree, (node) => node.type === 'option').map((node) => node.props.value);
  assert(optionValues.includes('demo') === false, 'the demo project is still offered in the product switcher');
});

function previewNoticeNode(tree) {
  return findNode(tree, (node) => node.props && node.props.className === 'dv-preview-notice');
}

// P3-017 B1 diagnostics: "revision:attempt:snapshotMs:readyMs:errorCode" ring.
function previewDiagnosticEntries(editor) {
  const shell = productCanvas(editor.tree());
  if (shell === null) return [];
  const text = shell.props['data-preview-diagnostics'];
  if (typeof text !== 'string' || text.length === 0) return [];
  return text.split('|').map((line) => line.split(':'));
}

function previewAttemptOf(editor) {
  const shell = productCanvas(editor.tree());
  return shell === null ? '' : shell.props['data-preview-attempt'];
}

async function waitForPreviewPhase(editor, phase, rounds) {
  const total = rounds || 40;
  for (let round = 0; round < total; round += 1) {
    const shell = productCanvas(editor.tree());
    if (shell !== null && shell.props['data-canvas-phase'] === phase) return true;
    await new Promise((resolve) => setTimeout(resolve, 80));
    await settle();
    editor.rerender();
  }
  const shell = productCanvas(editor.tree());
  return shell !== null && shell.props['data-canvas-phase'] === phase;
}

function snapshotIdFor(config, revision) {
  const results = (config.snapshotResults || []).filter((entry) => entry.revision === revision);
  assert(results.length > 0, 'the fake host never produced a snapshot for revision ' + revision.slice(0, 4));
  return results[results.length - 1].snapshotId;
}

async function waitForCandidate(editor, rounds) {
  const total = rounds || 24;
  for (let round = 0; round < total; round += 1) {
    await settle();
    editor.rerender();
    if (candidateIframe(editor) !== null) return true;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

test('P3-012/R2: a published revision preloads hidden and switches only after its runtime is ready', async () => {
  const revisionA = 'c'.repeat(64);
  const revisionB = 'e'.repeat(64);
  let currentRevision = revisionA;
  const sessions = makeSessionsService({ list: ['session-live'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-live', sessions: ['session-live'] });
  hostFetch.config.handler = async (request) => {
    if (request.body.method === 'inspect') return { ok: true, result: inspectWithRevision(currentRevision) };
    return undefined;
  };
  const kit = makeSessionKit();
  const editor = await mountBootedPanel(hostFetch, { sessions: sessions, kit: kit });
  let shell = productCanvas(editor.tree());
  assert(shell.props['data-canvas-revision'] === revisionA, `initial active revision is ${shell.props['data-canvas-revision']}`);
  assert(shell.props['data-canvas-target-revision'] === revisionA, 'initial target revision marker is missing');
  assert(shell.props['data-canvas-phase'] === 'ready', `initial phase is ${shell.props['data-canvas-phase']}`);
  const activeBefore = activeIframe(editor);
  assert(activeBefore !== null, 'the initial active iframe is missing');
  const snapshotsBefore = hostFetch.config.snapshotRequests.length;
  // The Agent published through project.compose: the worker revision changed.
  currentRevision = revisionB;
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert(await waitForCandidate(editor), 'the published revision was not preloaded as a hidden candidate');
  shell = productCanvas(editor.tree());
  // Retention: the old composition is still the visible/playable one and the
  // markers stay truthful while the new candidate preloads.
  assert(activeIframe(editor) !== null, 'the last valid composition was unmounted while the new revision preloaded');
  assert(activeIframe(editor).props.src === activeBefore.props.src, 'the visible composition changed before the candidate was ready');
  assert(shell.props['data-canvas-revision'] === revisionA, 'the active revision marker lied during preload');
  assert(shell.props['data-canvas-target-revision'] === revisionB, 'the target revision marker does not name the preloading revision');
  assert(shell.props['data-canvas-phase'] === 'ready', 'the phase left ready while the last valid composition is visible');
  assert(candidateIframe(editor) !== null, 'the hidden candidate iframe is missing');
  assert(candidateIframe(editor).props['aria-hidden'] === 'true', 'the candidate iframe is not hidden from assistive content');
  assert(candidateIframe(editor).props.style.visibility === 'hidden', 'the candidate iframe is not visually hidden');
  assert(candidateIframe(editor).props.style.pointerEvents === 'none', 'the candidate iframe can receive pointer input');
  assert(previewNoticeNode(editor.tree()) === null, 'a preview notice appeared before any failure');
  assert(hostFetch.config.snapshotRequests.length > snapshotsBefore, 'no snapshot was requested for the published revision');
  assert(hostFetch.config.snapshotRequests.some((request) => request.revision === revisionB), 'the published revision was never requested');
  // Promote only on the candidate runtime ready event.
  const oldSnapshotId = snapshotIdFor(hostFetch.config, revisionA);
  promoteCanvasCandidate(editor);
  shell = productCanvas(editor.tree());
  assert(shell.props['data-canvas-revision'] === revisionB, 'the active revision marker did not switch after promotion');
  assert(shell.props['data-canvas-target-revision'] === revisionB, 'the target revision marker did not settle on the new active revision');
  assert(shell.props['data-canvas-phase'] === 'ready', 'the switched preview is not ready');
  assert(activeIframe(editor) !== null && activeIframe(editor).props.src !== activeBefore.props.src, 'the visible iframe did not switch to the published revision');
  assert(candidateIframe(editor) === null, 'the candidate iframe is still mounted after promotion');
  assert(previewNoticeNode(editor.tree()) === null, 'a preview notice is visible after a successful switch');
  await settle();
  const releases = hostFetch.config.releaseCalls || [];
  assert(releases.filter((snapshotId) => snapshotId === oldSnapshotId).length === 1, `expected one preview.release for the old snapshot, got ${JSON.stringify(releases)}`);
});

test('P3-012/R2: a failed candidate snapshot keeps the last valid composition and retries', async () => {
  const revisionA = 'c'.repeat(64);
  const revisionB = 'e'.repeat(64);
  let currentRevision = revisionA;
  let failRevisionB = true;
  const sessions = makeSessionsService({ list: ['session-retain'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-retain', sessions: ['session-retain'] });
  hostFetch.config.handler = async (request) => {
    if (request.body.method === 'inspect') return { ok: true, result: inspectWithRevision(currentRevision) };
    if (request.body.method === 'preview.snapshot' && request.body.params.revision === revisionB && failRevisionB) {
      return { ok: false, error: { code: 'E_PERSIST', message: 'snapshot copy failed' } };
    }
    return undefined;
  };
  const kit = makeSessionKit();
  const editor = await mountBootedPanel(hostFetch, { sessions: sessions, kit: kit });
  let shell = productCanvas(editor.tree());
  assert(shell.props['data-canvas-revision'] === revisionA, 'the initial active revision is missing');
  const activeBefore = activeIframe(editor);
  assert(activeBefore !== null, 'the initial active iframe is missing');
  currentRevision = revisionB;
  await new Promise((resolve) => setTimeout(resolve, 1700));
  let notice = null;
  for (let round = 0; round < 24; round += 1) {
    await settle();
    editor.rerender();
    notice = previewNoticeNode(editor.tree());
    if (notice !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  assert(notice !== null, 'the compact preview failure notice is missing');
  assert(notice.props.role === 'alert', 'the preview notice is not an alert');
  assert(textOf(notice).includes(translateFor(editor.env)('video.canvas.persistFailed')), `notice copy is not localized: ${textOf(notice)}`);
  shell = productCanvas(editor.tree());
  assert(activeIframe(editor) !== null && activeIframe(editor).props.src === activeBefore.props.src, 'the last valid composition was unmounted by a failed candidate snapshot');
  assert(shell.props['data-canvas-revision'] === revisionA, 'the active revision marker changed on a failed switch');
  assert(shell.props['data-canvas-target-revision'] === revisionB, 'the target revision marker does not name the failed revision');
  assert(shell.props['data-canvas-phase'] === 'ready', `phase is ${shell.props['data-canvas-phase']} while the old composition is visible`);
  assert(candidateIframe(editor) === null, 'the failed candidate iframe was not discarded');
  assert(textOf(editor.tree()).includes(translateFor(editor.env)('video.frame.empty')) === false, 'the removed legacy no-frame copy is still rendered');
  const noticeRetry = findNode(notice, (node) => node.type === 'button' && textOf(node) === translateFor(editor.env)('video.canvas.retry'));
  assert(noticeRetry !== null, 'the preview notice retry button is missing');
  // Explicit retry with the host serving the revision again: the preview switches.
  failRevisionB = false;
  noticeRetry.props.onClick();
  assert(await waitForCandidate(editor), 'the retry did not preload the requested revision');
  promoteCanvasCandidate(editor);
  shell = productCanvas(editor.tree());
  assert(shell.props['data-canvas-revision'] === revisionB, 'the retry did not switch the active revision');
  assert(previewNoticeNode(editor.tree()) === null, 'the notice is still visible after a successful retry');
  assert(activeIframe(editor) !== null && activeIframe(editor).props.src !== activeBefore.props.src, 'the visible iframe did not switch after a successful retry');
});

test('P3-012/R2: a candidate runtime error keeps the last valid composition playable', async () => {
  const revisionA = 'c'.repeat(64);
  const revisionB = 'e'.repeat(64);
  let currentRevision = revisionA;
  const sessions = makeSessionsService({ list: ['session-runtime-error'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-runtime-error', sessions: ['session-runtime-error'] });
  hostFetch.config.handler = async (request) => {
    if (request.body.method === 'inspect') return { ok: true, result: inspectWithRevision(currentRevision) };
    return undefined;
  };
  const kit = makeSessionKit();
  const editor = await mountBootedPanel(hostFetch, { sessions: sessions, kit: kit });
  const activeBefore = activeIframe(editor);
  assert(activeBefore !== null, 'the initial active iframe is missing');
  currentRevision = revisionB;
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert(await waitForCandidate(editor), 'the next revision was not preloaded as a candidate');
  const candidateNode = candidateIframe(editor);
  assert(candidateNode !== null, 'the hidden candidate iframe is missing');
  const releasesBefore = (hostFetch.config.releaseCalls || []).length;
  const snapshotsBefore = (hostFetch.config.snapshotRequests || []).filter((request) => request.revision === revisionB).length;
  // The fixed runtime reports an error before ready: nothing may be promoted and
  // the last valid composition stays visible/playable.
  dispatchFrameEvent(editor, {
    frame: runtimeFrameOf(editor, candidateNode),
    type: 'error',
    payload: { code: 'E_RUNTIME', message: 'runtime failed before ready' },
  });
  editor.rerender();
  let tree = editor.tree();
  let shell = productCanvas(tree);
  assert(previewNoticeNode(tree) === null, 'the first runtime failure must be retried automatically before a notice');
  assert(activeIframe(editor) !== null && activeIframe(editor).props.src === activeBefore.props.src, 'the last valid composition was unmounted by a candidate runtime error');
  assert(shell.props['data-canvas-revision'] === revisionA, 'the active revision marker changed on a candidate runtime error');
  assert(shell.props['data-canvas-target-revision'] === revisionB, 'the target revision marker is missing on a candidate runtime error');
  assert(shell.props['data-canvas-phase'] === 'ready', 'the phase left ready on a candidate runtime error');
  assert(findNode(tree, (node) => node.props && node.props.className === 'dv-canvas-status' && node.props.role === 'alert') === null, 'a candidate runtime error replaced the stage with the full first-load error');
  await settle();
  assert((hostFetch.config.releaseCalls || []).length > releasesBefore, 'the failed candidate snapshot was not released');
  const diagnostic = previewDiagnosticEntries(editor);
  assert(diagnostic.length === 1 && diagnostic[0][4] === 'E_RUNTIME', `the runtime failure is not diagnosed: ${JSON.stringify(diagnostic)}`);
  // The failed attempt is retried automatically with a fresh snapshot.
  assert(await waitForCandidate(editor), 'the failed runtime was not retried with a new snapshot');
  const retriedSnapshots = (hostFetch.config.snapshotRequests || []).filter((request) => request.revision === revisionB).length;
  assert(retriedSnapshots > snapshotsBefore, 'the automatic retry did not request a new snapshot');
  assert(shell.props['data-preview-retrying'] === 'true' || productCanvas(editor.tree()).props['data-preview-retrying'] === 'false', 'the retry marker is missing');
  const secondCandidate = candidateIframe(editor);
  assert(secondCandidate !== null, 'the retried candidate iframe is missing');
  // A second failure consumes the single retry: the compact notice appears and
  // the retained composition is still not replaced.
  dispatchFrameEvent(editor, {
    frame: runtimeFrameOf(editor, secondCandidate),
    type: 'error',
    payload: { code: 'E_RUNTIME', message: 'runtime failed again' },
  });
  editor.rerender();
  tree = editor.tree();
  shell = productCanvas(tree);
  const notice = previewNoticeNode(tree);
  assert(notice !== null && notice.props.role === 'alert', 'the candidate runtime error did not show the compact notice after the retry');
  assert(activeIframe(editor) !== null && activeIframe(editor).props.src === activeBefore.props.src, 'the last valid composition was unmounted by a candidate runtime error');
  assert(shell.props['data-canvas-revision'] === revisionA, 'the active revision marker changed on a candidate runtime error');
  assert(shell.props['data-canvas-target-revision'] === revisionB, 'the target revision marker is missing on a candidate runtime error');
  assert(shell.props['data-canvas-phase'] === 'ready', 'the phase left ready on a candidate runtime error');
  const diagnosticAfter = previewDiagnosticEntries(editor);
  assert(diagnosticAfter.length === 2, `the retry diagnostics ring is not bounded/complete: ${JSON.stringify(diagnosticAfter)}`);
  assert(diagnosticAfter.every((entry) => entry[4] === 'E_RUNTIME'), 'a failed attempt is missing its error code');
  // The retained composition still receives the playback commands.
  const commandCountBefore = editor.loaded.runtime.commands.length;
  const play = findNode(tree, (node) => node.type === 'button' && textOf(node) === translateFor(editor.env)('video.canvas.play'));
  assert(play !== null, 'the play control is missing while the retained composition is shown');
  play.props.onClick();
  editor.rerender();
  const playCommand = editor.loaded.runtime.commands.slice(commandCountBefore).find((message) => message.type === 'play');
  assert(playCommand !== undefined, 'the retained composition is not playable');
  assert(playCommand.instanceId === contractRefFromFrame(activeIframe(editor)).instanceId, 'the play command was not sent to the displayed composition');
});

test('P3-012/R2: an initial preview failure stays a full recoverable error', async () => {
  let failFirst = true;
  const sessions = makeSessionsService({ list: ['session-initial'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-initial', sessions: ['session-initial'] });
  hostFetch.config.handler = async (request) => {
    if (request.body.method === 'preview.snapshot' && failFirst) {
      return { ok: false, error: { code: 'E_NETWORK', message: 'snapshot transport failed' } };
    }
    return undefined;
  };
  const kit = makeSessionKit();
  const editor = mountSessionEditor(hostFetch, { sessions: sessions, kit: kit });
  await settlePanel(editor);
  // P3-017 B1: the first snapshot failure is retried once automatically, so the
  // honest first-load error only appears after the retry also fails.
  let shell = productCanvas(editor.tree());
  assert(shell !== null, 'the preview shell is missing');
  assert(shell.props['data-canvas-revision'] === '', 'no active revision marker may exist before the first ready composition');
  assert(shell.props['data-canvas-target-revision'] === 'c'.repeat(64), 'the target revision marker is missing on the initial failure');
  assert(shell.props['data-canvas-phase'] === 'loading', `the first failure must stay loading during the automatic retry, got ${shell.props['data-canvas-phase']}`);
  assert(await waitForPreviewPhase(editor, 'error'), 'the failed automatic retry did not surface the initial error');
  let tree = editor.tree();
  shell = productCanvas(tree);
  const status = findNode(tree, (node) => node.props && node.props.className === 'dv-canvas-status' && node.props.role === 'alert');
  assert(status !== null, 'the initial failure did not show the full recoverable status');
  assert(textOf(status).includes(translateFor(editor.env)('video.error.network')), `initial failure copy is not localized: ${textOf(status)}`);
  assert(previewNoticeNode(tree) === null, 'the first-load failure must not use the compact candidate notice');
  const diagnostics = previewDiagnosticEntries(editor);
  assert(diagnostics.length === 2, `the initial failure must record both attempts: ${JSON.stringify(diagnostics)}`);
  assert(diagnostics[0][4] === 'E_NETWORK' && diagnostics[1][4] === 'E_NETWORK', 'the initial failure diagnostics lost the error code');
  const retry = findNode(status, (node) => node.type === 'button' && textOf(node) === translateFor(editor.env)('video.canvas.retry'));
  assert(retry !== null, 'the initial failure retry button is missing');
  failFirst = false;
  retry.props.onClick();
  assert(await waitForCandidate(editor), 'the retry did not preload the first composition');
  promoteCanvasCandidate(editor);
  shell = productCanvas(editor.tree());
  assert(shell.props['data-canvas-revision'] === 'c'.repeat(64), 'the retried first composition did not become active');
  assert(shell.props['data-canvas-phase'] === 'ready', 'the retried first composition did not reach the ready phase');
});
function inspectGeometry(revisionId, geometry) {
  return Object.assign(managedInspected(), {
    revision: revisionId,
    width: geometry.width,
    height: geometry.height,
    duration: geometry.duration,
  });
}

function previewGeometry(editor) {
  const tree = editor.tree();
  const shell = findNode(tree, (node) => node.props && node.props.className === 'dv-canvas-shell');
  const stage = findNode(
    tree,
    (node) => node.props && typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes('dv-canvas-stage')
  );
  const seek = findNode(tree, (node) => node.type === 'input' && node.props && node.props.className === 'dv-seek');
  const timeLabel = findNode(tree, (node) => node.props && node.props.className === 'dv-time');
  const activeFrame = activeIframe(editor);
  return {
    revision: shell !== null ? shell.props['data-canvas-revision'] : null,
    targetRevision: shell !== null ? shell.props['data-canvas-target-revision'] : null,
    phase: shell !== null ? shell.props['data-canvas-phase'] : null,
    activeWidth: activeFrame !== null ? activeFrame.props.style.width : null,
    activeHeight: activeFrame !== null ? activeFrame.props.style.height : null,
    activeSrc: activeFrame !== null ? activeFrame.props.src : null,
    stageWidth: stage !== null ? stage.props.style.width : null,
    stageHeight: stage !== null ? stage.props.style.height : null,
    seekMax: seek !== null ? seek.props.max : null,
    seekValue: seek !== null ? seek.props.value : null,
    timeText: timeLabel !== null ? textOf(timeLabel) : null,
  };
}

function durationLabelSeconds(text) {
  const match = /\/\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(String(text || ''));
  return match === null ? null : Number(match[1]);
}

const GEOMETRY_B = { width: 720, height: 1280, duration: 5 };
const GEOMETRY_A = { width: 1280, height: 720, duration: 6 };
const GEOMETRY_B_STAGE = { width: '405px', height: '720px' };
const GEOMETRY_A_STAGE = { width: '1280px', height: '720px' };

async function waitForSnapshotRequest(hostFetch, revisionId, rounds) {
  const total = rounds || 40;
  for (let round = 0; round < total; round += 1) {
    if ((hostFetch.config.snapshotRequests || []).some((request) => request.revision === revisionId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settle();
  }
  return (hostFetch.config.snapshotRequests || []).some((request) => request.revision === revisionId);
}

test('P3-012/R2F: a failed candidate with different geometry keeps the active viewport and duration', async () => {
  const revisionB = 'c'.repeat(64);
  const revisionA = 'e'.repeat(64);
  let currentRevision = revisionB;
  let failRevisionA = true;
  const sessions = makeSessionsService({ list: ['session-geometry'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-geometry', sessions: ['session-geometry'] });
  hostFetch.config.handler = async (request) => {
    if (request.body.method === 'inspect') {
      return { ok: true, result: inspectGeometry(currentRevision, currentRevision === revisionA ? GEOMETRY_A : GEOMETRY_B) };
    }
    if (request.body.method === 'preview.snapshot' && request.body.params.revision === revisionA && failRevisionA) {
      return { ok: false, error: { code: 'E_PERSIST', message: 'geometry-change snapshot failed' } };
    }
    return undefined;
  };
  const kit = makeSessionKit();
  const editor = await mountBootedPanel(hostFetch, { sessions: sessions, kit: kit });
  let geometry = previewGeometry(editor);
  assert(geometry.revision === revisionB && geometry.phase === 'ready', `initial preview is ${geometry.revision}/${geometry.phase}`);
  assert(geometry.activeWidth === '720px' && geometry.activeHeight === '1280px', `initial iframe is ${geometry.activeWidth}x${geometry.activeHeight}`);
  assert(geometry.seekMax === '5', `initial seek.max is ${geometry.seekMax}`);
  assert(durationLabelSeconds(geometry.timeText) === 5, `initial duration label is ${geometry.timeText}`);
  assert(geometry.stageWidth === GEOMETRY_B_STAGE.width && geometry.stageHeight === GEOMETRY_B_STAGE.height, `initial letterbox is ${geometry.stageWidth}x${geometry.stageHeight}`);
  const activeBefore = activeIframe(editor);
  assert(activeBefore !== null, 'the initial active iframe is missing');
  // The Agent publishes a different aspect ratio / duration; its snapshot fails.
  currentRevision = revisionA;
  await new Promise((resolve) => setTimeout(resolve, 1700));
  let notice = null;
  for (let round = 0; round < 24; round += 1) {
    await settle();
    editor.rerender();
    notice = previewNoticeNode(editor.tree());
    if (notice !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  assert(notice !== null, 'the compact geometry-change failure notice is missing');
  geometry = previewGeometry(editor);
  assert(geometry.revision === revisionB, `active revision marker changed to ${geometry.revision}`);
  assert(geometry.targetRevision === revisionA, 'the target revision marker does not name the failed candidate');
  assert(geometry.phase === 'ready', `phase is ${geometry.phase} while the old composition is visible`);
  assert(geometry.activeWidth === '720px' && geometry.activeHeight === '1280px', `the retained iframe was resized to ${geometry.activeWidth}x${geometry.activeHeight}`);
  assert(geometry.activeSrc === activeBefore.props.src, 'the retained iframe source changed');
  assert(geometry.seekMax === '5', `seek.max changed to ${geometry.seekMax} by the failed candidate`);
  assert(Number(geometry.seekValue) <= 5, `seek value left the retained duration: ${geometry.seekValue}`);
  assert(durationLabelSeconds(geometry.timeText) === 5, `duration label changed to ${geometry.timeText}`);
  assert(geometry.stageWidth === GEOMETRY_B_STAGE.width && geometry.stageHeight === GEOMETRY_B_STAGE.height, `the letterbox changed to ${geometry.stageWidth}x${geometry.stageHeight}`);
  // The retained composition is still the one receiving playback commands.
  const commandsBefore = editor.loaded.runtime.commands.length;
  const play = buttonByText(editor.tree(), translateFor(editor.env)('video.canvas.play'));
  assert(play !== null, 'the play control is missing on the retained preview');
  play.props.onClick();
  editor.rerender();
  const playCommand = editor.loaded.runtime.commands.slice(commandsBefore).find((message) => message.type === 'play');
  assert(playCommand !== undefined && playCommand.instanceId === contractRefFromFrame(activeBefore).instanceId, 'the retained composition is not playable');
  // A later successful candidate switches every display value atomically.
  failRevisionA = false;
  const retry = findNode(notice, (node) => node.type === 'button' && textOf(node) === translateFor(editor.env)('video.canvas.retry'));
  assert(retry !== null, 'the preview notice retry button is missing');
  retry.props.onClick();
  assert(await waitForCandidate(editor), 'the retry did not preload the geometry-change revision');
  const candidateFrame = candidateIframe(editor);
  assert(candidateFrame !== null, 'the hidden candidate iframe is missing');
  assert(candidateFrame.props.style.width === '1280px' && candidateFrame.props.style.height === '720px', `the candidate iframe is sized ${candidateFrame.props.style.width}x${candidateFrame.props.style.height}`);
  geometry = previewGeometry(editor);
  assert(geometry.activeWidth === '720px' && geometry.seekMax === '5', 'candidate preload changed the active display before ready');
  promoteCanvasCandidate(editor);
  geometry = previewGeometry(editor);
  assert(geometry.revision === revisionA, `the switched active revision is ${geometry.revision}`);
  assert(geometry.activeWidth === '1280px' && geometry.activeHeight === '720px', `the switched iframe is ${geometry.activeWidth}x${geometry.activeHeight}`);
  assert(geometry.seekMax === '6', `the switched seek.max is ${geometry.seekMax}`);
  assert(durationLabelSeconds(geometry.timeText) === 6, `the switched duration label is ${geometry.timeText}`);
  assert(geometry.stageWidth === GEOMETRY_A_STAGE.width && geometry.stageHeight === GEOMETRY_A_STAGE.height, `the switched letterbox is ${geometry.stageWidth}x${geometry.stageHeight}`);
  assert(candidateIframe(editor) === null, 'the candidate iframe survived the switch');
});

test('P3-012/R2F: a delayed candidate with different geometry keeps the old display until it is ready', async () => {
  const revisionB = 'c'.repeat(64);
  const revisionA = 'e'.repeat(64);
  const delayMs = 400;
  let currentRevision = revisionB;
  const sessions = makeSessionsService({ list: ['session-delay'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-delay', sessions: ['session-delay'] });
  hostFetch.config.handler = async (request) => {
    if (request.body.method === 'inspect') {
      return { ok: true, result: inspectGeometry(currentRevision, currentRevision === revisionA ? GEOMETRY_A : GEOMETRY_B) };
    }
    if (request.body.method === 'preview.snapshot' && request.body.params.revision === revisionA) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return undefined;
  };
  const kit = makeSessionKit();
  const editor = await mountBootedPanel(hostFetch, { sessions: sessions, kit: kit });
  const activeBefore = activeIframe(editor);
  assert(activeBefore !== null && activeBefore.props.style.width === '720px', 'the initial active iframe is not the genre-B geometry');
  // Publish the different-geometry revision; the poll requests its snapshot.
  currentRevision = revisionA;
  await new Promise((resolve) => setTimeout(resolve, 1700));
  // One render propagates the new target inspected props and starts the delayed
  // preload; while it is in flight the visible display must stay the old one.
  editor.rerender();
  let geometry = previewGeometry(editor);
  assert(geometry.revision === revisionB, `active revision marker changed during the wait: ${geometry.revision}`);
  assert(geometry.phase === 'ready', `phase is ${geometry.phase} while the last ready composition is visible`);
  assert(geometry.activeWidth === '720px' && geometry.activeHeight === '1280px', `the active iframe was resized to ${geometry.activeWidth}x${geometry.activeHeight} while waiting`);
  assert(geometry.seekMax === '5', `seek.max changed to ${geometry.seekMax} while waiting`);
  assert(durationLabelSeconds(geometry.timeText) === 5, `duration label changed to ${geometry.timeText} while waiting`);
  assert(geometry.stageWidth === GEOMETRY_B_STAGE.width && geometry.stageHeight === GEOMETRY_B_STAGE.height, `the letterbox changed to ${geometry.stageWidth}x${geometry.stageHeight} while waiting`);
  assert(await waitForSnapshotRequest(hostFetch, revisionA), 'the delayed candidate snapshot was never requested');
  // Let the delayed snapshot resolve, then mount the hidden candidate.
  await new Promise((resolve) => setTimeout(resolve, delayMs + 250));
  await settle();
  editor.rerender();
  await settle();
  editor.rerender();
  const candidateFrame = candidateIframe(editor);
  assert(candidateFrame !== null, 'the delayed candidate iframe did not mount');
  assert(candidateFrame.props.style.width === '1280px' && candidateFrame.props.style.height === '720px', `the candidate iframe is sized ${candidateFrame.props.style.width}x${candidateFrame.props.style.height}`);
  geometry = previewGeometry(editor);
  assert(geometry.revision === revisionB, `active revision marker changed while the candidate preloads: ${geometry.revision}`);
  assert(geometry.targetRevision === revisionA, `target revision marker is ${geometry.targetRevision}`);
  assert(geometry.activeWidth === '720px' && geometry.seekMax === '5', 'preloading the candidate changed the active display');
  // Candidate runtime ready → the atomic switch to the candidate's geometry/duration.
  promoteCanvasCandidate(editor);
  geometry = previewGeometry(editor);
  assert(geometry.revision === revisionA, `the switched active revision is ${geometry.revision}`);
  assert(geometry.activeWidth === '1280px' && geometry.activeHeight === '720px', `the switched iframe is ${geometry.activeWidth}x${geometry.activeHeight}`);
  assert(geometry.seekMax === '6', `the switched seek.max is ${geometry.seekMax}`);
  assert(durationLabelSeconds(geometry.timeText) === 6, `the switched duration label is ${geometry.timeText}`);
  assert(geometry.stageWidth === GEOMETRY_A_STAGE.width && geometry.stageHeight === GEOMETRY_A_STAGE.height, `the switched letterbox is ${geometry.stageWidth}x${geometry.stageHeight}`);
  assert(candidateIframe(editor) === null, 'the candidate iframe survived the switch');
  await settle();
  const oldSnapshotId = snapshotIdFor(hostFetch.config, revisionB);
  assert((hostFetch.config.releaseCalls || []).filter((snapshotId) => snapshotId === oldSnapshotId).length === 1, `expected one release of the old geometry snapshot, got ${JSON.stringify(hostFetch.config.releaseCalls)}`);
});

test('P3-012: the rendered product workspace has no manual editing controls', async () => {
  const sessions = makeSessionsService({ list: ['session-clean'], titles: { 'session-clean': '工程 · 干净' } });
  const hostFetch = sessionFetch({ activeSessionId: 'session-clean', sessions: ['session-clean'] });
  const kit = makeSessionKit();
  const editor = await mountBootedPanel(hostFetch, { sessions: sessions, kit: kit });
  const tree = editor.tree();
  const shell = productCanvas(tree);
  assert(shell !== null, 'the read-only preview is missing');
  assert(shell.props['data-preview-only'] === 'true', 'the product canvas is not in preview-only mode');
  assert(shell.props['data-canvas-revision'] === 'c'.repeat(64), 'the canvas is not bound to the inspected revision');
  assert(findNode(tree, (node) => node.props && node.props['data-canvas-phase'] !== undefined) !== null, 'the canvas phase marker is missing');
  assert(buttonByText(tree, translateFor(editor.env)('video.canvas.play')) !== null, 'the play control is missing');
  assert(findNode(tree, (node) => node.type === 'input' && node.props && node.props.className === 'dv-seek') !== null, 'the seek control is missing');
  const classes = panelClasses(tree);
  for (const forbidden of ['dv-editor', 'dv-stagebar', 'dv-overlay', 'dv-selection', 'dv-inline-editor', 'dv-drawer', 'dv-canvas-tools', 'dv-editor-actions', 'dv-export-link']) {
    assert(classes.some((value) => value.split(/\s+/).includes(forbidden)) === false, `removed manual surface "${forbidden}" is still rendered`);
  }
  const ids = panelIds(tree);
  for (const removedId of ['dsh-video-target', 'dsh-video-title', 'dsh-video-frame-time']) {
    assert(ids.includes(removedId) === false, `removed manual control #${removedId} is still rendered`);
  }
  const renderedText = textOf(tree);
  for (const key of ['video.canvas.undo', 'video.canvas.redo', 'video.canvas.addScene', 'video.canvas.sceneColor', 'video.canvas.textStyle', 'video.open', 'video.update', 'video.save', 'video.frame.empty', 'video.frameTime', 'video.details', 'video.target']) {
    const label = translateFor(editor.env)(key);
    assert(label !== key, `removed dictionary key ${key} was dropped (keep old keys for compatibility)`);
    assert(renderedText.includes(label) === false, `removed manual-editing copy "${label}" is still rendered`);
  }
  // 'video.export' is the legacy manual label: its dictionary entry stays for
  // compatibility but the product UI uses the canvas keys above.
  assert(dictionaryOf(editor.env)['video.export'] === '导出 MP4', 'the legacy export copy key was dropped from the dictionary');
  // P3-017 B3: the product topbar owns the export action (the old manual export
  // button stays hidden behind previewOnly=false), bound to the inspected
  // revision and observable for the export state machine.
  assert(findNode(tree, (node) => node.props && node.props.className === 'dv-export') !== null, 'the product export control is missing');
  assert(panelRoot(tree).props['data-export'] === 'idle', 'the product export state marker is missing');
  assert(panelRoot(tree).props['data-export-revision'] === '', 'an idle export must not name a revision');
  assert(buttonByText(tree, translateFor(editor.env)('video.canvas.export')) !== null, 'the product export button is missing');
  assert(buttonByText(tree, translateFor(editor.env)('video.canvas.exporting')) === null, 'the product shows an exporting label before any export');
  // The native conversation panel and its history action stay.
  assert(findNode(tree, (node) => node.props && node.props.className === 'dv-ai') !== null, 'the native conversation panel is missing');
  assert(findNode(tree, (node) => node.props && node.props['data-factory'] === 'conversation.content') !== null, 'the native conversation Factory is missing');
  assert(findNode(tree, (node) => node.props && typeof node.props.className === 'string' && node.props.className.includes('dv-history-toggle')) !== null, 'the conversation history action is missing');
});

test('P3-012: returning to the panel reopens the remembered managed project', async () => {
  const sessions = makeSessionsService({ list: ['session-a'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-a', sessions: ['session-a'] });
  hostFetch.config.handler = async (request) => {
    if (request.body.method === 'project.list') {
      return {
        ok: true,
        result: {
          projects: [
            { projectId: 'proj-a', updatedAt: 10 },
            { projectId: 'proj-b', updatedAt: 20 },
          ],
          defaultProjectId: 'proj-b',
        },
      };
    }
    if (request.body.method === 'open') {
      hostFetch.config.openedProjects = (hostFetch.config.openedProjects || []).concat([request.body.params.projectId]);
      return undefined;
    }
    if (request.body.method === 'inspect') return { ok: true, result: managedInspected() };
    return undefined;
  };
  const kit = makeSessionKit();
  const first = await mountBootedPanel(hostFetch, { sessions: sessions, kit: kit });
  assert(panelRoot(first.tree()).props['data-project-id'] === 'proj-b', 'the first boot did not open the most recent project');
  const toggle = projectToggle(first.tree());
  assert(toggle !== null, 'the project picker arrow is missing');
  toggle.props.onClick();
  const menu = projectMenu(first.rerender());
  assert(menu !== null, 'the project picker did not open');
  const target = projectMenuItems(first.tree()).find((item) => textOf(item) !== '' && item.props['aria-checked'] === 'false');
  assert(target !== undefined, 'the other project is not listed in the picker');
  target.props.onClick();
  await settlePanel(first);
  assert(panelRoot(first.tree()).props['data-project-id'] === 'proj-a', 'the switcher did not open the chosen project');
  const remounted = remountInteractivePanel(first, kit);
  let tree = remounted.render();
  for (let round = 0; round < 12; round += 1) {
    await settle();
    tree = remounted.rerender();
  }
  const opened = (hostFetch.config.openedProjects || []).slice();
  assert(opened.length >= 3, `expected three open requests (first, switch, remount), got ${opened.length}`);
  assert(opened[opened.length - 1] === 'proj-a', `the remount reopened "${opened[opened.length - 1]}" instead of the remembered project`);
  assert(panelRoot(tree).props['data-project-id'] === 'proj-a', 'the remounted panel lost the remembered project');
  assert(findNode(tree, (node) => node.props && node.props['data-session-active'] === 'session-a') !== null, 'the remembered Session was not restored');
  remounted.unmount();
});
//#endregion

test('P3-006-A: embedded native conversation uses videoView, hero:false and the Chat view', async () => {
  const sessions = makeSessionsService({
    list: ['session-aaa'],
    titles: { 'session-aaa': '演示工程 · 创作 1' },
    mainViewRetained: true,
  });
  const hostFetch = sessionFetch({ activeSessionId: 'session-aaa', sessions: ['session-aaa'] });
  const kit = makeSessionKit();
  const editor = mountSessionEditor(hostFetch, { sessions, kit });
  await settle();
  editor.rerender();
  await settle();
  editor.rerender();
  const retained = sessions.retained[sessions.retained.length - 1];
  assert(retained !== undefined && retained.id === 'session-aaa', 'the bound Session was not retained');
  assert(retained.options.source === 'videoView', `retain source was ${retained.options.source}`);
  const provider = kit.calls.filter((call) => call.type === 'session-provider').pop();
  assert(provider !== undefined && provider.session.sessionId === 'session-aaa', 'SessionProvider did not receive the owned reference');
  const factory = kit.calls.filter((call) => call.type === 'factory').pop();
  assert(factory !== undefined && factory.name === 'conversation.content', 'native conversation Factory was not rendered');
  assert(factory.input.variant === 'embedded', 'occurrence was not embedded');
  assert(factory.input.hero === false, 'hero must stay false to avoid host navigation');
  assert(typeof factory.occurrence.slots.views === 'function', 'Chat view local slot missing');
  assert(factory.occurrence.slots.widthControls === undefined, 'embedded occurrence must omit width controls');
  const chatView = kit.calls.filter((call) => call.type === 'chat-view').pop();
  assert(chatView !== undefined && chatView.slot === 'conversation.session' && chatView.args.view === 'chat', 'the embedded view did not lock Chat');
  assert(retained.ref.released === false, 'mainView retention must not prevent the hidden-host embedding from retaining');
  const tree = editor.tree();
  assert(findNode(tree, (node) => node.props && node.props['data-factory'] === 'conversation.content') !== null, 'factory output missing from the tree');
  assert(findNode(tree, (node) => node.props && node.props.className === 'dv-model') === null, 'the plugin rendered a custom model control');
  assert(findNode(tree, (node) => node.props && node.props.className === 'dv-ai-head').props['aria-label'] === '演示工程 · 创作 1', 'history title projection was not retained in the accessible heading');
  assert(hostFetch.calls.some((call) => call.body.method === 'session.list'), 'session history was not loaded from the Host');
});

test('P3-006-A: ready with an open error shows the failure instead of the editing root', async () => {
  const sessions = makeSessionsService({
    list: ['session-err'],
    faces: { 'session-err': { openState: 'error', openError: { message: 'boom' } } },
  });
  const hostFetch = sessionFetch({ activeSessionId: 'session-err', sessions: ['session-err'] });
  const kit = makeSessionKit();
  const editor = mountSessionEditor(hostFetch, { sessions, kit });
  await settle();
  editor.rerender();
  await settle();
  const tree = editor.rerender();
  assert(kit.calls.filter((call) => call.type === 'factory').length === 0, 'the factory was rendered despite an open error');
  const alert = findNode(tree, (node) => node.props && node.props.role === 'alert');
  assert(alert !== null, 'open error was not surfaced');
  assert(textOf(alert).includes(translateFor(editor.env)('video.ai.error')), `open error text was ${textOf(alert)}`);
});

test('P3-006-A: a visible host conversation disables the embedded editing root with a notice', async () => {
  const sessions = makeSessionsService({ list: ['session-host'], titles: { 'session-host': '宿主标题' } });
  const hostFetch = sessionFetch({ activeSessionId: 'session-host', sessions: ['session-host'] });
  const kit = makeSessionKit();
  const editor = mountSessionEditor(hostFetch, { sessions, kit });
  await settle();
  editor.rerender();
  await settle();
  const factoryBefore = kit.calls.filter((call) => call.type === 'factory').length;
  editor.env.setActivePanel('conversation');
  editor.rerender();
  await settle();
  const tree = editor.rerender();
  const notice = findNode(tree, (node) => node.props && node.props.className === 'dv-ai-notice');
  assert(notice !== null, 'visible host conversation notice missing');
  assert(textOf(notice) === translateFor(editor.env)('video.ai.hostOpen'), `notice text was ${textOf(notice)}`);
  assert(findNode(tree, (node) => node.props && node.props['data-factory'] === 'conversation.content') === null, 'a second editing root was mounted while the host conversation was visible');
  assert(kit.calls.filter((call) => call.type === 'factory').length >= factoryBefore, 'factory calls were lost');
});

test('P3-006-A: unmounting the panel releases the owned reference (reverse navigation)', async () => {
  const sessions = makeSessionsService({ list: ['session-leave'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-leave', sessions: ['session-leave'] });
  const kit = makeSessionKit();
  const editor = mountSessionEditor(hostFetch, { sessions, kit });
  await settle();
  editor.rerender();
  await settle();
  const retained = sessions.retained[sessions.retained.length - 1];
  assert(retained !== undefined && retained.ref.released === false, 'reference was not held while mounted');
  editor.interactive.unmount();
  assert(retained.ref.released === true, 'reference was not released on unmount');
  assert(sessions.released.includes('session-leave'), 'release was not owned by the panel lifecycle');
});

test('P3-012: an opened project without a Session auto-creates exactly one and adopts it', async () => {
  const sessions = makeSessionsService({ list: [] });
  const hostFetch = sessionFetch({ activeSessionId: null, sessions: [], newSessionId: 'session-created' });
  const kit = makeSessionKit();
  const editor = await mountBootedPanel(hostFetch, { sessions: sessions, kit: kit });
  const tree = editor.tree();
  const creates = hostFetch.calls.filter((call) => call.body.method === 'session.create');
  assert(creates.length === 1, `the opened project issued ${creates.length} session.create requests`);
  assert(hostFetch.config.createCalls === 1, `session.create ran ${hostFetch.config.createCalls} times`);
  assert(typeof creates[0].body.params.requestId === 'string' && creates[0].body.params.requestId.length > 0, 'session.create lost its dedupe requestId');
  assert(findNode(tree, (node) => node.props && node.props['data-session-active'] === 'session-created') !== null, 'the auto-created Session is not active');
  const provider = kit.calls.filter((call) => call.type === 'session-provider').pop();
  assert(provider !== undefined && provider.session.sessionId === 'session-created', 'the native conversation provider did not receive the created Session');
  assert(findNode(tree, (node) => node.props && node.props.className === 'dv-ai-head').props['aria-label'] === 'session-created', 'the created Session is not visible in the conversation header');
  // A re-render cannot create a second Session for the same project.
  editor.rerender();
  await settle();
  editor.rerender();
  assert(hostFetch.calls.filter((call) => call.body.method === 'session.create').length === 1, 'a re-render created a second Session');
});

test('P3-006-A: history lists mapped Sessions and a superseded switch cannot win', async () => {
  const sessions = makeSessionsService({
    list: ['session-aaa', 'session-bbb', 'session-ccc'],
    titles: { 'session-aaa': '工程 · 一', 'session-bbb': '工程 · 二', 'session-ccc': '工程 · 三' },
  });
  const hostFetch = sessionFetch({
    activeSessionId: 'session-aaa',
    sessions: ['session-aaa', 'session-bbb', 'session-ccc'],
    selectDelays: { 'session-bbb': 50 },
  });
  const kit = makeSessionKit();
  const editor = mountSessionEditor(hostFetch, { sessions, kit });
  await settle();
  editor.rerender();
  await settle();
  const toggle = findNode(editor.tree(), (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes('dv-history-toggle'));
  assert(toggle !== null, 'history toggle missing');
  toggle.props.onClick();
  const tree = editor.rerender();
  const items = findNodes(tree, (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className === 'dv-history-item');
  assert(items.length === 3, `history listed ${items.length} Sessions instead of the mapped three`);
  items[1].props.onClick();
  items[2].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 140));
  editor.rerender();
  await settle();
  const finalTree = editor.rerender();
  const root = findNode(finalTree, (node) => node.props && node.props['data-session-active'] !== undefined);
  assert(root !== null && root.props['data-session-active'] === 'session-ccc', `superseded switch won: ${root && root.props['data-session-active']}`);
  const provider = kit.calls.filter((call) => call.type === 'session-provider').pop();
  assert(provider !== undefined && provider.session.sessionId === 'session-ccc', `superseded switch won: ${provider && provider.session.sessionId}`);
  assert(findNode(finalTree, (node) => node.props && node.props.className === 'dv-ai-head').props['aria-label'] === '工程 · 三', 'the latest Session title is not visible');
  assert(hostFetch.config.selectCalls.includes('session-bbb') && hostFetch.config.selectCalls.includes('session-ccc'), 'both switches were not attempted');
  const projectWrites = hostFetch.calls.filter((call) => ['open', 'project.create', 'edit', 'scene.update', 'scene.create', 'scene.remove', 'frame', 'render'].includes(call.body.method));
  assert(projectWrites.length === 1, `the only project request must be the initial auto-open, got ${projectWrites.map((call) => call.body.method).join(',')}`);
  assert(projectWrites[0].body.method === 'open', 'switching Sessions issued a project business request');
});


//#region tests: P3-006-C local preview

function interactiveTarget(options) {
  const settings = options || {};
  const attributes = settings.attributes || {};
  return {
    closest(selector) {
      if (settings.selector === selector) {
        return {
          getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
          },
        };
      }
      return null;
    },
  };
}

/**
 * A DOM target whose closest() can expose several independent selector matches
 * (e.g. an <img> inside a host ToolRow fileLink button). The returned ancestor
 * carries the element `textContent` (used by the P3-022 summary parser) and its
 * attributes feed getAttribute().
 */
function richTarget(options) {
  const settings = options || {};
  const attributes = settings.attributes || {};
  const selectors = Array.isArray(settings.selectors) ? settings.selectors : settings.selector === undefined ? [] : [settings.selector];
  const element = {
    textContent: typeof settings.text === 'string' ? settings.text : '',
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
  };
  return {
    closest(selector) {
      return selectors.indexOf(selector) === -1 ? null : element;
    },
  };
}

function clickCaptureNode(tree) {
  const aside = findNode(tree, (node) => node.props && typeof node.props.className === 'string' && node.props.className.split(' ').includes('dv-ai'));
  assert(aside !== null, 'the embedded AI surface is missing');
  return aside;
}

test('P3-006-C: a presented image card opens the local preview without the host sidebar', async () => {
  const sessions = makeSessionsService({ list: ['session-preview'], titles: { 'session-preview': '工程 · 预览' } });
  const hostFetch = sessionFetch({ activeSessionId: 'session-preview', sessions: ['session-preview'] });
  const kit = makeSessionKit();
  const editor = mountSessionEditor(hostFetch, { sessions, kit });
  await settle();
  editor.rerender();
  await settle();
  const aside = clickCaptureNode(editor.tree());
  const target = interactiveTarget({ selector: 'button[title]', attributes: { title: '/tmp/output/frame.png' } });
  let prevented = 0;
  let stopped = 0;
  aside.props.onClickCapture({
    target,
    preventDefault() { prevented += 1; },
    stopPropagation() { stopped += 1; },
  });
  await settle();
  const tree = editor.rerender();
  const dialog = findNode(tree, (node) => node.props && node.props.className === 'dv-preview');
  assert(dialog !== null, 'the local preview dialog was not rendered');
  const image = findNode(tree, (node) => node.props && node.props.className === 'dv-preview-image');
  assert(image !== null && image.props.src === 'data:image/png;base64,AAAA', 'the preview image did not use the bounded Host data URL');
  assert(prevented === 1 && stopped === 1, 'the native file opener was not intercepted');
  assert(hostFetch.config.previewCalls.length === 1, 'the preview request was not issued exactly once');
  const call = hostFetch.config.previewCalls[0];
  assert(call.projectId === 'proj-smoke' && call.sessionId === 'session-preview' && call.path === '/tmp/output/frame.png', `unexpected preview params: ${JSON.stringify(call)}`);
  assert(findNode(tree, (node) => node.props && node.props.className === 'dv-left') !== null, 'opening a preview replaced the left project surface');
  const close = findNode(tree, (node) => node.props && node.props.className === 'dv-preview-close');
  assert(close !== null, 'preview close control missing');
  close.props.onClick();
  const closedTree = editor.rerender();
  assert(findNode(closedTree, (node) => node.props && node.props.className === 'dv-preview') === null, 'closing the preview did not return to the AI surface');
  const root = findNode(closedTree, (node) => node.props && node.props['data-session-active'] !== undefined);
  assert(root !== null && root.props['data-session-active'] === 'session-preview', 'closing the preview changed the active Session');
});

test('P3-006-C: non-file clicks and unsupported files keep their native or explicit states', async () => {
  const sessions = makeSessionsService({ list: ['session-preview'] });
  const hostFetch = sessionFetch({
    activeSessionId: 'session-preview',
    sessions: ['session-preview'],
    preview: { ok: false, error: { code: 'E_PREVIEW_UNSUPPORTED', message: 'unsupported' } },
  });
  const editor = mountSessionEditor(hostFetch, { sessions, kit: makeSessionKit() });
  await settle();
  editor.rerender();
  await settle();
  const aside = clickCaptureNode(editor.tree());
  let prevented = 0;
  aside.props.onClickCapture({
    target: interactiveTarget({ selector: null }),
    preventDefault() { prevented += 1; },
    stopPropagation() {},
  });
  assert(prevented === 0 && (hostFetch.config.previewCalls || []).length === 0, 'a normal chat click was intercepted');

  aside.props.onClickCapture({
    target: interactiveTarget({ selector: 'button[title]', attributes: { title: '/tmp/output/notes.txt' } }),
    preventDefault() {},
    stopPropagation() {},
  });
  await settle();
  const tree = editor.rerender();
  const status = findNode(tree, (node) => node.props && node.props.className === 'dv-preview-status');
  assert(status !== null && textOf(status) === translateFor(editor.env)('video.preview.unsupported'), 'unsupported preview did not show the accurate local message');
  closePreviewTree(tree);
});

test('P3-006-C: Markdown file links use the same bounded preview and a late Session result cannot win', async () => {
  const sessions = makeSessionsService({ list: ['session-one', 'session-two'] });
  const hostFetch = sessionFetch({
    activeSessionId: 'session-one',
    sessions: ['session-one', 'session-two'],
    previewDelay: 40,
  });
  const kit = makeSessionKit();
  const editor = mountSessionEditor(hostFetch, { sessions, kit });
  await settle();
  editor.rerender();
  await settle();
  const aside = clickCaptureNode(editor.tree());
  aside.props.onClickCapture({
    target: interactiveTarget({ selector: 'a[href]', attributes: { href: 'file:///tmp/output/photo.png' } }),
    preventDefault() {},
    stopPropagation() {},
  });
  assert(hostFetch.config.previewCalls[0].path === 'file:///tmp/output/photo.png', 'the Markdown link address was not forwarded unchanged');
  const toggle = findNode(editor.tree(), (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes('dv-history-toggle'));
  toggle.props.onClick();
  const menuTree = editor.rerender();
  const items = findNodes(menuTree, (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className === 'dv-history-item');
  const targetSession = items.find((item) => textOf(item).includes('session-two')) || items[1];
  targetSession.props.onClick();
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 70));
  const tree = editor.rerender();
  await settle();
  const finalTree = editor.rerender();
  const root = findNode(finalTree, (node) => node.props && node.props['data-session-active'] !== undefined);
  assert(root !== null && root.props['data-session-active'] === 'session-two', 'the Session switch did not complete');
  assert(findNode(finalTree, (node) => node.props && node.props.className === 'dv-preview') === null, 'a late preview from the previous Session appeared after the switch');
});

function closePreviewTree(tree) {
  const close = findNode(tree, (node) => node.props && node.props.className === 'dv-preview-close');
  assert(close !== null, 'preview close control missing');
  close.props.onClick();
}



test('P3-008 -> P3-012: the product mounts the snapshot canvas read-only; manual controls are hidden', async () => {
  const sessions = makeSessionsService({ list: ['session-canvas'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-canvas', sessions: ['session-canvas'] });
  const kit = makeSessionKit();
  const editor = await mountBootedPanel(hostFetch, { sessions, kit });
  const after = editor.tree();
  const shell = productCanvas(after);
  assert(shell !== null, 'snapshot canvas shell was not rendered');
  assert(shell.props['data-preview-only'] === 'true', 'the product canvas is not read-only');
  const frame = previewFrame(after);
  assert(frame !== null && frame.props.sandbox === 'allow-scripts', 'sandboxed snapshot iframe missing');
  assert(typeof frame.props.src === 'string' && frame.props.src.startsWith('/api/dsh-video/preview/') && frame.props.src.includes('instance='), 'snapshot iframe src is not the bound preview route');
  assert(findNode(after, (node) => node.props && node.props['data-canvas-revision'] === 'c'.repeat(64)) !== null, 'canvas revision marker missing');
  assert(buttonByText(after, translateFor(editor.env)('video.canvas.play')) !== null, 'playback control missing');
  assert(buttonByText(after, translateFor(editor.env)('video.canvas.materials')) !== null, 'M2 material library entry is missing');
  assert(buttonByText(after, translateFor(editor.env)('video.canvas.addScene')) === null, 'the manual add-Scene action is still offered');
  // P3-017 B3 intentionally surfaces a product export action; it is not the
  // hidden manual render path (that one still lives behind previewOnly=false).
  assert(buttonByText(after, translateFor(editor.env)('video.canvas.export')) !== null, 'the product export action is missing');
  assert(hostFetch.config.snapshotRequests && hostFetch.config.snapshotRequests.length >= 1, 'worker snapshot was not requested for the canvas');
  assert(hostFetch.config.createCalls === undefined || hostFetch.config.createCalls === 1, 'the auto-provisioned Session count is wrong');
  editor.interactive.unmount();
});

//#region tests: R1/R2/R5/R6 canvas contracts
// Pure-helper extraction: execute the exact shipped source of the reviewed
// helper block from <root>/client.js inside a Node VM. The block lives in the
// shipped `host bridge helpers` region and has no React/DOM dependency, so the
// tests below assert the shipped bytes instead of a reimplementation.
function extractClientRegion(name) {
  const start = CLIENT_SOURCE.indexOf('//#region ' + name);
  assert(start >= 0, `client region "${name}" not found`);
  const end = CLIENT_SOURCE.indexOf('//#endregion', start);
  assert(end > start, `client region "${name}" has no closing marker`);
  return CLIENT_SOURCE.slice(start, end);
}

const CANVAS_HELPER_NAMES = [
  'canvasValidateEvent',
  'canvasValidateCommand',
  'canvasValidateHit',
  'canvasIsOversizedMessage',
  'canvasMessageLedger',
  'canvasStaticBase',
  'canvasLayoutPatch',
  'canvasSceneTemplate',
  'canvasCopySceneTemplate',
  'canvasNormalizedColor',
  'canvasNormalizedAssetPath',
  'canvasIsRevisionConflict',
  'canvasValidRect',
];

const CANVAS = (function loadCanvasHelpers() {
  const source = extractClientRegion('host bridge helpers');
  assert(source.includes('function canvasLayoutPatch('), 'inverse-mapped layout helper is missing from the shipped client');
  assert(source.includes('function canvasValidateEvent('), 'strict runtime event validator is missing from the shipped client');
  assert(source.includes('function canvasMessageLedger('), 'per-snapshot message ledger is missing from the shipped client');
  const exportExpression = ';({' + CANVAS_HELPER_NAMES.map((name) => name + ': ' + name).join(', ') + '})';
  return vm.runInContext(source + exportExpression, vm.createContext({}), { filename: 'client.js#host-bridge-helpers' });
})();

/**
 * P3-012: the product workspace only mounts CanvasWorkspace read-only
 * (`previewOnly: true`). The reviewed P3-008 manual path stays reachable through
 * the default previewOnly=false, so the component tests mount the exact shipped
 * component source extracted from the two reviewed client regions — the same
 * region-extraction contract the P3-008 browser harness uses.
 */
function extractCanvasModule(loaded) {
  const helpers = extractClientRegion('host bridge helpers');
  const canvas = extractClientRegion('P3-008 canvas workspace');
  assert(canvas.includes('function CanvasWorkspace('), 'P3-008 canvas region has no CanvasWorkspace');
  assert(helpers.includes('async function hostRequest('), 'host bridge helpers region has no hostRequest');
  assert(canvas.includes('const previewOnly = props.previewOnly === true'), 'the canvas region lost its previewOnly flag');
  const body =
    '"use strict";\n' +
    helpers +
    '\n' +
    canvas +
    '\nreturn { MediaLibraryPanel: MediaLibraryPanel, CanvasWorkspace: CanvasWorkspace, hostRequest: hostRequest, formatSeconds: formatSeconds, errorText: errorText, hostError: hostError, operationId: operationId };\n';
  const factory = vm.runInContext('(function (React, h) {\n' + body + '\n})', loaded.context, { filename: 'client.js#canvas-component' });
  return factory(loaded.react, loaded.react.createElement);
}

const CANVAS_TEST_INSTANCE = 'dvcanvas-smoketest';
const CANVAS_TEST_NONCE = '0123456789abcdef0123456789abcdef';
const CANVAS_REVISION = 'c'.repeat(64);
const CANVAS_NEXT_REVISION = 'd'.repeat(64);
const CANVAS_FRESH_REVISION = 'e'.repeat(64);

function canvasContractEvent(overrides) {
  const base = {
    v: 1,
    kind: 'evt',
    instanceId: CANVAS_TEST_INSTANCE,
    nonce: CANVAS_TEST_NONCE,
    seq: 1,
    type: 'state',
    replyTo: null,
    payload: { time: 0, duration: 5, playing: false },
  };
  return Object.assign(base, overrides || {});
}

test('R6 pure: strict runtime event validation covers envelope, seq, types and payload shapes', () => {
  assert(CANVAS.canvasValidateEvent(canvasContractEvent()).ok === true, 'a valid state event was rejected');
  const valid = [
    canvasContractEvent({ type: 'ready', payload: { runtimeVersion: 'p3-008-runtime.1', width: 1280, height: 720, duration: 15 } }),
    canvasContractEvent({ type: 'pong', replyTo: 1, payload: {} }),
    canvasContractEvent({ type: 'seeked', replyTo: 1, payload: { time: 2 } }),
    canvasContractEvent({ type: 'playing', replyTo: 1, payload: { time: 2 } }),
    canvasContractEvent({ type: 'paused', replyTo: 1, payload: { time: 2 } }),
    canvasContractEvent({ type: 'hit', replyTo: 1, payload: { hit: null } }),
    canvasContractEvent({ type: 'elements', replyTo: 1, payload: { elements: [] } }),
    canvasContractEvent({ type: 'destroyed', replyTo: 1, payload: {} }),
    canvasContractEvent({ type: 'error', payload: { code: 'E_RUNTIME', message: 'boom' } }),
  ];
  for (const event of valid) {
    const result = CANVAS.canvasValidateEvent(event);
    assert(result.ok === true, `valid ${event.type} event was rejected: ${JSON.stringify(result)}`);
  }
  const invalid = [
    ['version', canvasContractEvent({ v: 2 }), 'E_VERSION'],
    ['kind', canvasContractEvent({ kind: 'cmd' }), 'E_MALFORMED'],
    ['unknown envelope key', canvasContractEvent({ extra: true }), 'E_MALFORMED'],
    ['missing replyTo', canvasContractEvent({ replyTo: undefined }), 'E_MALFORMED'],
    ['instance id', canvasContractEvent({ instanceId: 'SHORT' }), 'E_INSTANCE'],
    ['nonce', canvasContractEvent({ nonce: 'xyz' }), 'E_NONCE'],
    ['seq zero', canvasContractEvent({ seq: 0 }), 'E_SEQ'],
    ['seq fraction', canvasContractEvent({ seq: 1.5 }), 'E_SEQ'],
    ['unknown type', canvasContractEvent({ type: 'unknown' }), 'E_TYPE'],
    ['payload array', canvasContractEvent({ payload: [] }), 'E_PAYLOAD'],
    ['replyTo string', canvasContractEvent({ replyTo: 'one' }), 'E_REPLY'],
    ['ready width', canvasContractEvent({ type: 'ready', payload: { runtimeVersion: 'x', width: 0, height: 720, duration: 15 } }), 'E_PAYLOAD'],
    ['state playing', canvasContractEvent({ payload: { time: 0, duration: 5 } }), 'E_PAYLOAD'],
    ['state duration', canvasContractEvent({ payload: { time: 0, duration: '5', playing: false } }), 'E_PAYLOAD'],
    ['seeked time', canvasContractEvent({ type: 'seeked', replyTo: 1, payload: { time: '2' } }), 'E_PAYLOAD'],
    ['hit shape', canvasContractEvent({ type: 'hit', replyTo: 1, payload: { hit: { stableId: '' } } }), 'E_PAYLOAD'],
    ['elements size', canvasContractEvent({ type: 'elements', replyTo: 1, payload: { elements: new Array(513).fill({}) } }), 'E_PAYLOAD'],
    ['error code', canvasContractEvent({ type: 'error', payload: { code: '', message: 'x' } }), 'E_PAYLOAD'],
    ['error message type', canvasContractEvent({ type: 'error', payload: { code: 'E', message: 2 } }), 'E_PAYLOAD'],
  ];
  for (const [label, event, code] of invalid) {
    const result = CANVAS.canvasValidateEvent(event);
    assert(result.ok === false && result.code === code, `${label}: expected ${code}, got ${JSON.stringify(result)}`);
  }
  assert(CANVAS.canvasValidateCommand({ v: 1, kind: 'cmd', instanceId: CANVAS_TEST_INSTANCE, nonce: CANVAS_TEST_NONCE, seq: 1, type: 'hitTest', payload: { x: 1, y: 2 } }).ok === true, 'valid command rejected');
  assert(CANVAS.canvasValidateCommand({ v: 1, kind: 'cmd', instanceId: CANVAS_TEST_INSTANCE, nonce: CANVAS_TEST_NONCE, seq: 1, type: 'seek', payload: { time: Number.NaN } }).ok === false, 'invalid seek command accepted');
  assert(CANVAS.canvasIsOversizedMessage({ payload: { text: 'x'.repeat(20000) } }) === true, 'oversized event was not detected');
  assert(CANVAS.canvasIsOversizedMessage(canvasContractEvent()) === false, 'normal event was flagged oversized');
});

test('R6 pure: the message ledger enforces monotonic seq, exact correlation and explicit revocation', () => {
  const ledger = CANVAS.canvasMessageLedger({ instanceId: CANVAS_TEST_INSTANCE, nonce: CANVAS_TEST_NONCE, timeoutMs: 50 });
  const first = ledger.command('hitTest', { x: 10, y: 20 });
  assert(first.seq === 1 && first.v === 1 && first.kind === 'cmd' && first.instanceId === CANVAS_TEST_INSTANCE, 'command envelope shape is wrong');
  const second = ledger.command('state');
  assert(second.seq === 2 && ledger.pendingCount() === 2, 'commands are not tracked with increasing seq');
  let threw = false;
  try {
    ledger.command('hitTest', { x: Number.NaN, y: 0 });
  } catch (_error) {
    threw = true;
  }
  assert(threw === true, 'an invalid command payload was accepted');
  const hit = canvasContractEvent({ seq: 1, type: 'hit', replyTo: 1, payload: { hit: null } });
  assert(ledger.accept(hit, { sourceOk: false }).code === 'E_SOURCE_MISMATCH', 'wrong event source was not dropped');
  assert(ledger.accept(canvasContractEvent({ instanceId: 'dvcanvas-other1', seq: 1, type: 'hit', replyTo: 1, payload: { hit: null } }), { sourceOk: true }).code === 'E_WRONG_INSTANCE', 'wrong instance was not dropped');
  assert(ledger.accept(canvasContractEvent({ nonce: 'f'.repeat(32), seq: 1, type: 'hit', replyTo: 1, payload: { hit: null } }), { sourceOk: true }).code === 'E_NONCE', 'wrong nonce was not dropped');
  assert(ledger.accept(canvasContractEvent({ payload: { text: 'x'.repeat(20000) } }), { sourceOk: true }).code === 'E_OVERSIZED', 'oversized event was not dropped');
  assert(ledger.accept(canvasContractEvent({ extra: true }), { sourceOk: true }).code === 'E_MALFORMED', 'malformed event was not dropped');
  assert(ledger.accept(canvasContractEvent({ seq: 1, type: 'state', replyTo: null }), { sourceOk: true }).code === 'E_UNCORRELATED', 'a floating direct response was accepted');
  assert(ledger.accept(canvasContractEvent({ seq: 2, type: 'hit', replyTo: 99, payload: { hit: null } }), { sourceOk: true }).code === 'E_LATE_RESPONSE', 'a reply to an unknown command was accepted');
  const accepted = ledger.accept(canvasContractEvent({ seq: 3, type: 'hit', replyTo: 1, payload: { hit: null } }), { sourceOk: true });
  assert(accepted.accepted === true && accepted.commandType === 'hitTest' && accepted.replyTo === 1, 'a correlated reply was not accepted');
  assert(ledger.pendingCount() === 1, 'the answered command was not removed');
  assert(ledger.accept(canvasContractEvent({ seq: 3, type: 'hit', replyTo: 1, payload: { hit: null } }), { sourceOk: true }).code === 'E_STALE_SEQ', 'a duplicate event seq was accepted');
  const stateReply = ledger.accept(canvasContractEvent({ seq: 4, type: 'state', replyTo: 2, payload: { time: 1, duration: 5, playing: false } }), { sourceOk: true });
  assert(stateReply.accepted === true && ledger.pendingCount() === 0, 'the second correlated reply was not settled');
  assert(ledger.accept(canvasContractEvent({ seq: 5, type: 'state', replyTo: 2, payload: { time: 1, duration: 5, playing: false } }), { sourceOk: true }).code === 'E_LATE_RESPONSE', 'a second reply to the same command was accepted');

  const revoked = CANVAS.canvasMessageLedger({ instanceId: CANVAS_TEST_INSTANCE, nonce: CANVAS_TEST_NONCE, timeoutMs: 50 });
  revoked.command('ping');
  revoked.command('state');
  const expired = revoked.expire(Date.now() + 1000);
  assert(expired.length === 2 && revoked.pendingCount() === 0, `expire did not release both pending commands: ${JSON.stringify(expired)}`);
  revoked.command('ping');
  const pendingSeqs = revoked.revoke();
  assert(pendingSeqs.length === 1 && pendingSeqs[0] === 3, `revoke did not return every pending seq: ${JSON.stringify(pendingSeqs)}`);
  assert(revoked.pendingCount() === 0, 'revoke left pending commands');
  assert(revoked.accept(canvasContractEvent({ seq: 6, type: 'error', payload: { code: 'E_RUNTIME', message: 'x' } }), { sourceOk: true }).code === 'E_INSTANCE_REVOKED', 'a revoked ledger accepted an event');
});

test('R2 pure: a move patches only left/top from the static base, never the animated offset or auto size', () => {
  const animated = { x: 88, y: 210, width: 980, height: 72 };
  const base = { left: 88, top: 196, width: 980, height: null };
  const moved = CANVAS.canvasLayoutPatch({
    mode: 'move',
    base: base,
    animated: animated,
    preview: { x: 98, y: 210, width: 980, height: 72 },
    composition: { width: 1280, height: 720 },
  });
  assert(moved.ok === true, `move patch failed: ${JSON.stringify(moved)}`);
  assert(JSON.stringify(moved.patch) === JSON.stringify({ left: 98, top: 196 }), `move patch was ${JSON.stringify(moved.patch)}; the animation offset or auto height leaked into the layout`);
  const clamped = CANVAS.canvasLayoutPatch({
    mode: 'move',
    base: base,
    animated: animated,
    preview: { x: 1500, y: -100, width: 980, height: 72 },
    composition: { width: 1280, height: 720 },
  });
  assert(JSON.stringify(clamped.patch) === JSON.stringify({ left: 300, top: 0 }), `move clamp was ${JSON.stringify(clamped.patch)}`);
  const unknownOrigin = CANVAS.canvasLayoutPatch({
    mode: 'move',
    base: { left: null, top: 196, width: 980, height: null },
    animated: animated,
    preview: { x: 98, y: 210, width: 980, height: 72 },
    composition: { width: 1280, height: 720 },
  });
  assert(unknownOrigin.ok === false && unknownOrigin.code === 'E_LAYOUT_BASE', 'a move without a static origin was not refused');
  assert(CANVAS.canvasLayoutPatch({ mode: 'move', base: base }).ok === false, 'incomplete drag input was accepted');
});

test('R2 pure: resize inverse-maps the animation scale per axis with sy falling back to sx', () => {
  const scaleX = CANVAS.canvasLayoutPatch({
    mode: 'se',
    base: { left: 0, top: 0, width: 400, height: 100 },
    animated: { x: 100, y: 50, width: 200, height: 100 },
    preview: { x: 100, y: 50, width: 240, height: 130 },
    composition: { width: 1280, height: 720 },
  });
  assert(JSON.stringify(scaleX.patch) === JSON.stringify({ width: 480, height: 130 }), `scaleX resize patch was ${JSON.stringify(scaleX.patch)}`);
  const autoHeight = CANVAS.canvasLayoutPatch({
    mode: 'se',
    base: { left: 88, top: 196, width: 980, height: null },
    animated: { x: 88, y: 210, width: 980, height: 72 },
    preview: { x: 88, y: 210, width: 1030, height: 92 },
    composition: { width: 1280, height: 720 },
  });
  assert(JSON.stringify(autoHeight.patch) === JSON.stringify({ width: 1030, height: 92 }), `auto-height resize patch was ${JSON.stringify(autoHeight.patch)}`);
  const northWest = CANVAS.canvasLayoutPatch({
    mode: 'nw',
    base: { left: 100, top: 100, width: 400, height: 200 },
    animated: { x: 50, y: 40, width: 200, height: 100 },
    preview: { x: 30, y: 30, width: 220, height: 110 },
    composition: { width: 1280, height: 720 },
  });
  assert(JSON.stringify(northWest.patch) === JSON.stringify({ width: 440, height: 220, left: 60, top: 80 }), `nw resize patch was ${JSON.stringify(northWest.patch)}`);
  const bounds = CANVAS.canvasLayoutPatch({
    mode: 'se',
    base: { left: 0, top: 0, width: 200, height: 100 },
    animated: { x: 0, y: 0, width: 200, height: 100 },
    preview: { x: 0, y: 0, width: 5000, height: 5000 },
    composition: { width: 1280, height: 720 },
  });
  assert(bounds.patch.width === 1280 && bounds.patch.height === 720, `resize bounds clamp was ${JSON.stringify(bounds.patch)}`);
  const rightBound = CANVAS.canvasLayoutPatch({
    mode: 'se',
    base: { left: 1000, top: 0, width: 200, height: 100 },
    animated: { x: 1000, y: 0, width: 200, height: 100 },
    preview: { x: 1000, y: 0, width: 500, height: 100 },
    composition: { width: 1280, height: 720 },
  });
  assert(
    JSON.stringify(rightBound.patch) === JSON.stringify({ width: 280, height: 100 }),
    `east resize did not stay inside the composition: ${JSON.stringify(rightBound.patch)}`
  );
  const unknownScale = CANVAS.canvasLayoutPatch({
    mode: 'se',
    base: { left: 10, top: 10, width: null, height: null },
    animated: { x: 10, y: 10, width: 100, height: 50 },
    preview: { x: 10, y: 10, width: 120, height: 60 },
    composition: { width: 1280, height: 720 },
  });
  assert(unknownScale.ok === false && unknownScale.code === 'E_LAYOUT_SCALE', 'a resize without any known static extent was not refused');
  const autoWidthScale = CANVAS.canvasLayoutPatch({
    mode: 'se',
    base: { left: 10, top: 10, width: null, height: 100 },
    animated: { x: 10, y: 10, width: 200, height: 100 },
    preview: { x: 10, y: 10, width: 240, height: 120 },
    composition: { width: 1280, height: 720 },
  });
  assert(
    autoWidthScale.ok === false && autoWidthScale.code === 'E_LAYOUT_SCALE',
    'a resize with an auto width guessed an x scale instead of refusing (animated width could be baked)'
  );
});

test('R1 pure: the authoritative Scene template is copied complete with only sceneId stripped', () => {
  const fullTemplate = {
    title: 'Scene 1',
    duration: 5,
    subtitle: '保留副标题',
    badge: '保留标签',
    color: '#123456',
    accent: '#abcdef',
    logo: 'assets/logo.png',
    shot: 'assets/old-shot.png',
    sceneId: 'scene-1',
  };
  const inspected = {
    revision: CANVAS_FRESH_REVISION,
    scenes: [
      { sceneId: 'scene-1', template: fullTemplate },
      { sceneId: 'scene-2', template: { title: 'Scene 2', duration: 5 } },
    ],
  };
  const prepared = CANVAS.canvasSceneTemplate(inspected, 'scene-1');
  assert(prepared.ok === true, `template copy failed: ${JSON.stringify(prepared)}`);
  assert(prepared.revision === CANVAS_FRESH_REVISION, 'the fresh authoritative revision was not returned');
  const expected = {
    title: 'Scene 1',
    duration: 5,
    subtitle: '保留副标题',
    badge: '保留标签',
    color: '#123456',
    accent: '#abcdef',
    logo: 'assets/logo.png',
    shot: 'assets/old-shot.png',
  };
  assert(JSON.stringify(prepared.template) === JSON.stringify(expected), `template copy was ${JSON.stringify(prepared.template)}`);
  assert(prepared.template !== fullTemplate, 'the template must be a copy, not the inspect object');
  prepared.template.color = '#ffffff';
  assert(fullTemplate.color === '#123456', 'mutating the copy changed the inspect result');
  const absent = CANVAS.canvasSceneTemplate({ revision: CANVAS_FRESH_REVISION, scenes: [{ sceneId: 'scene-1' }] }, 'scene-1');
  assert(absent.ok === false && absent.code === 'E_SCENE_TEMPLATE', 'an absent template was not refused');
  const missingRequired = CANVAS.canvasSceneTemplate({ revision: CANVAS_FRESH_REVISION, scenes: [{ sceneId: 'scene-1', template: { title: '', duration: 5 } }] }, 'scene-1');
  assert(missingRequired.ok === false && missingRequired.code === 'E_SCENE_TEMPLATE', 'an invalid title was not refused');
  const unknownField = CANVAS.canvasSceneTemplate({ revision: CANVAS_FRESH_REVISION, scenes: [{ sceneId: 'scene-1', template: { title: 'a', duration: 5, extra: true } }] }, 'scene-1');
  assert(unknownField.ok === false && unknownField.code === 'E_SCENE_TEMPLATE', 'an unknown template field was silently kept');
  const missingScene = CANVAS.canvasSceneTemplate(inspected, 'scene-9');
  assert(missingScene.ok === false && missingScene.code === 'E_SCENE_NOT_FOUND', 'an absent scene was not reported');
  const badRevision = CANVAS.canvasSceneTemplate({ revision: 'not-a-revision', scenes: inspected.scenes }, 'scene-1');
  assert(badRevision.ok === false && badRevision.code === 'E_SCENE_TEMPLATE', 'an untrusted revision was accepted');
  assert(CANVAS.canvasValidateHit({ stableId: 'a', sceneId: null, tag: 'div', text: '', rect: { x: 0, y: 0, width: 1, height: 1 }, style: {}, stack: [] }) === null, 'a valid hit was rejected');
});
//#region canvas component fixture + gesture helpers
function canvasHitPayload(overrides) {
  return Object.assign(
    {
      stableId: 'scene-1-title',
      sceneId: 'scene-1',
      tag: 'div',
      text: 'Scene 1',
      rect: { x: 88, y: 210, width: 980, height: 72 },
      style: {
        color: '#ffffff',
        fontSize: '64px',
        fontFamily: 'ui-sans-serif',
        fontWeight: '600',
        lineHeight: '1.1',
        textAlign: 'left',
        letterSpacing: '0px',
        whiteSpace: 'normal',
      },
      stack: ['scene-1-title'],
    },
    overrides || {}
  );
}

function canvasManagedInspect(options) {
  const settings = options || {};
  const sceneTemplate =
    settings.template === undefined
      ? {
          title: 'Scene 1',
          duration: 5,
          subtitle: '保留副标题',
          badge: '保留标签',
          color: '#123456',
          accent: '#654321',
          logo: 'assets/logo.png',
          shot: 'assets/old-shot.png',
          sceneId: 'scene-1',
        }
      : settings.template;
  const scene = { sceneId: 'scene-1', order: 0, start: 0, duration: 5, title: 'Scene 1', elements: [] };
  const scenes = settings.scenes || [sceneTemplate === null ? scene : Object.assign({}, scene, { template: sceneTemplate })];
  return {
    projectId: 'proj-smoke',
    revision: settings.revision || CANVAS_REVISION,
    width: 1280,
    height: 720,
    duration: 15,
    scenes: scenes,
    elements: settings.elements || [
      {
        stableId: 'scene-1-title',
        sceneId: 'scene-1',
        text: 'Scene 1',
        timing: { start: 0, duration: 5 },
        capabilities: ['text', 'layout', 'style'],
        layout: settings.layout === undefined ? { left: 88, top: 196, width: 980, height: 120 } : settings.layout,
        style: { color: '#ffffff', fontSize: 64, fontWeight: 600, textAlign: 'left' },
      },
    ],
    files: settings.files || [{ path: 'assets/photo.png', bytes: 120, sha256: 'd'.repeat(64) }],
  };
}

function canvasFetch(options) {
  const config = options || {};
  const state = { revision: config.revision || CANVAS_REVISION, edits: [], updates: [], inspects: [] };
  const fetchFunction = sessionFetch({
    activeSessionId: null,
    sessions: [],
    newSessionId: 'session-canvas-smoke',
    handler: async (request) => {
      const method = request.body.method;
      if (method === 'project.create') {
        return {
          ok: true,
          result: {
            projectId: 'proj-smoke',
            revision: state.revision,
            scenes: [{ sceneId: 'scene-1', order: 0, start: 0, duration: 5, title: 'Scene 1' }],
          },
        };
      }
      if (method === 'inspect') {
        state.inspects.push(request.body.params);
        const result = typeof config.inspect === 'function' ? config.inspect(state) : canvasManagedInspect({ revision: state.revision });
        return { ok: true, result: result };
      }
      if (method === 'edit') {
        state.edits.push(request.body.params);
        if (typeof config.edit === 'function') {
          const custom = await config.edit(request, state);
          if (custom !== undefined) return custom;
        }
        if (state.revision === CANVAS_REVISION) state.revision = CANVAS_NEXT_REVISION;
        return { ok: true, result: { projectId: 'proj-smoke', revision: state.revision, operationId: request.body.params.operationId } };
      }
      if (method === 'scene.update') {
        state.updates.push(request.body.params);
        if (typeof config.sceneUpdate === 'function') {
          const custom = await config.sceneUpdate(request, state);
          if (custom !== undefined) return custom;
        }
        state.revision = CANVAS_FRESH_REVISION;
        return { ok: true, result: { projectId: 'proj-smoke', revision: state.revision, scenes: [] } };
      }
      return undefined;
    },
  });
  fetchFunction.state = state;
  return fetchFunction;
}

function canvasMethodCalls(hostFetch, method) {
  return hostFetch.calls.filter((call) => call.body && call.body.method === method);
}

/**
 * Mount the shipped CanvasWorkspace directly with `previewOnly: false` (the
 * reviewed default) so the hidden manual-edit path keeps its component-level
 * regression coverage even though the product workspace only renders it
 * read-only. This mirrors the P3-008 browser harness, which also mounts this
 * component from the extracted reviewed regions.
 */
async function mountCanvasReady(options) {
  const settings = options || {};
  const loaded = loadClient({ fetch: settings.fetch, stageSize: settings.stageSize });
  const env = createFakeEnvironment();
  loaded.exports.apply(env.ctx);
  const canvasModule = extractCanvasModule(loaded);
  const firstInspected = await canvasModule.hostRequest('inspect', { projectId: 'proj-smoke' });
  assert(firstInspected !== null && typeof firstInspected === 'object', 'the component harness inspect failed');
  const props = {
    t: translateFor(env),
    projectId: 'proj-smoke',
    inspected: firstInspected,
    previewOnly: false,
    onReload: async function reloadCanvas() {
      const next = await canvasModule.hostRequest('inspect', { projectId: 'proj-smoke' });
      props.inspected = next;
      return next;
    },
    onError: function canvasError() {},
  };
  const interactive = loaded.react.renderInteractive(canvasModule.CanvasWorkspace, props);
  let tree = interactive.render();
  const editor = {
    loaded,
    env,
    interactive,
    props,
    canvasModule,
    tree: () => tree,
    rerender() {
      tree = interactive.rerender();
      return tree;
    },
  };
  for (let round = 0; round < 5; round += 1) {
    await settle();
    tree = interactive.rerender();
  }
  assert(findNode(tree, (node) => node.props && node.props.className === 'dv-canvas-shell') !== null, 'managed canvas did not mount');
  // R2: the first snapshot is a hidden candidate until its fixed runtime reports
  // ready (the real browser runtime does that itself; the Node shim simulates the
  // contract event so the manual path can be exercised after promotion).
  await ensureCanvasActive(editor);
  tree = editor.tree();
  assert(activeIframe(editor) !== null, 'the ready candidate was not promoted to the active composition');
  return editor;
}

/** Parse the runtime instance reference out of a snapshot iframe src. */
function contractRefFromFrame(frame) {
  const src = frame && frame.props && typeof frame.props.src === 'string' ? frame.props.src : '';
  const instanceMatch = /[?&]instance=([^&]+)/.exec(src);
  const nonceMatch = /[?&]nonce=([^&]+)/.exec(src);
  assert(instanceMatch !== null && nonceMatch !== null, 'snapshot iframe src carries no instance/nonce contract markers');
  return { instanceId: decodeURIComponent(instanceMatch[1]), nonce: nonceMatch[1] };
}

/** Dispatch one contract event from a specific snapshot iframe WindowProxy. */
function dispatchFrameEvent(editor, options) {
  const settings = options || {};
  const runtime = editor.loaded.runtime;
  const frame = settings.frame || canvasLatestFrame(editor);
  assert(frame !== undefined && frame !== null, 'no iframe to dispatch a runtime event to');
  const reference = contractRefFromFrame(frame);
  if (runtime.eventSeqs === undefined) runtime.eventSeqs = new Map();
  const last = runtime.eventSeqs.get(reference.instanceId) || 0;
  const seq = settings.seq !== undefined ? settings.seq : last + 1;
  runtime.eventSeqs.set(reference.instanceId, Math.max(last, seq));
  const event = {
    v: 1,
    kind: 'evt',
    instanceId: reference.instanceId,
    nonce: reference.nonce,
    seq: seq,
    type: settings.type,
    replyTo: settings.replyTo !== undefined ? settings.replyTo : null,
    payload: settings.payload || {},
  };
  for (const listener of runtime.listeners.slice()) listener({ source: frame.contentWindow, data: event });
  return event;
}

function iframesByClass(editor, className) {
  return findAll(
    editor.tree(),
    (node) => node.type === 'iframe' && node.props && typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes(className)
  );
}

function candidateIframe(editor) {
  const candidates = iframesByClass(editor, 'dv-stage-frame-candidate');
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

function activeIframe(editor) {
  const actives = iframesByClass(editor, 'dv-stage-frame');
  return actives.length > 0 ? actives[actives.length - 1] : null;
}

function runtimeFrameOf(editor, vnode) {
  const frames = editor.loaded.runtime.iframes;
  const found = frames.filter((entry) => entry.props.src === vnode.props.src);
  assert(found.length > 0, 'runtime iframe node not tracked by the React shim');
  return found[found.length - 1];
}

/** Simulate the fixed runtime of the hidden candidate reporting ready. */
function promoteCanvasCandidate(editor) {
  const candidate = candidateIframe(editor);
  assert(candidate !== null, 'no hidden candidate iframe to promote');
  dispatchFrameEvent(editor, {
    frame: runtimeFrameOf(editor, candidate),
    type: 'ready',
    payload: { runtimeVersion: 'p3-012-runtime.1', width: 1280, height: 720, duration: 15 },
  });
  editor.rerender();
  return editor.tree();
}

/**
 * Drive the preview to its ready composition: promote the hidden candidate once
 * its runtime reports ready (the real browser runtime does that by itself) and
 * return once the active composition is mounted. An active composition is only
 * returned after any pending candidate has been promoted, so revision-switch
 * assertions run against the new active revision.
 */
async function ensureCanvasActive(editor) {
  for (let round = 0; round < 10; round += 1) {
    await settle();
    editor.rerender();
    if (candidateIframe(editor) !== null) {
      promoteCanvasCandidate(editor);
      await settle();
      editor.rerender();
      if (activeIframe(editor) !== null) return editor.tree();
      continue;
    }
    if (activeIframe(editor) !== null) return editor.tree();
  }
  return editor.tree();
}

function canvasOverlay(tree) {
  const overlay = findNode(tree, (node) => node.props && node.props.className === 'dv-overlay');
  assert(overlay !== null, 'canvas overlay is missing');
  return overlay;
}

function takeCanvasCommand(editor, type) {
  const commands = editor.loaded.runtime.commands;
  const index = commands.findIndex((message) => message.type === type);
  if (index < 0) return null;
  return commands.splice(index, 1)[0];
}

function canvasLatestFrame(editor) {
  const frames = editor.loaded.runtime.iframes;
  assert(frames.length > 0, 'canvas iframe was never rendered');
  return frames[frames.length - 1];
}

function canvasDispatch(editor, options) {
  const settings = options || {};
  const runtime = editor.loaded.runtime;
  const reference = settings.reference || null;
  const instanceId = settings.instanceId !== undefined ? settings.instanceId : reference !== null ? reference.instanceId : null;
  const nonce = settings.nonce !== undefined ? settings.nonce : reference !== null ? reference.nonce : null;
  assert(typeof instanceId === 'string' && typeof nonce === 'string', 'canvas dispatch needs an instance reference');
  if (runtime.eventSeqs === undefined) runtime.eventSeqs = new Map();
  const last = runtime.eventSeqs.get(instanceId) || 0;
  const seq = settings.seq !== undefined ? settings.seq : last + 1;
  runtime.eventSeqs.set(instanceId, Math.max(last, seq));
  const event = {
    v: 1,
    kind: 'evt',
    instanceId: instanceId,
    nonce: nonce,
    seq: seq,
    type: settings.type,
    replyTo: settings.replyTo !== undefined ? settings.replyTo : reference !== null ? reference.seq : null,
    payload: settings.payload || {},
  };
  const frame = settings.frame || canvasLatestFrame(editor);
  const source = settings.source !== undefined ? settings.source : frame.contentWindow;
  for (const listener of runtime.listeners.slice()) listener({ source: source, data: event });
  return event;
}

function canvasSelectText(editor) {
  canvasOverlay(editor.tree()).props.onClick({ clientX: 640, clientY: 360 });
  const command = takeCanvasCommand(editor, 'hitTest');
  assert(command !== null, 'the canvas did not request a hit test');
  canvasDispatch(editor, { reference: command, type: 'hit', payload: { hit: canvasHitPayload() } });
  editor.rerender();
  const selection = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-selection');
  assert(selection !== null, 'selection was not applied from the correlated runtime hit');
  return selection;
}

function canvasOpenTextEditor(editor) {
  const selection = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-selection');
  assert(selection !== null, 'selection missing before opening the text editor');
  selection.props.onDoubleClick();
  const pause = takeCanvasCommand(editor, 'pause');
  if (pause !== null) canvasDispatch(editor, { reference: pause, type: 'paused', payload: { time: 0 } });
  editor.rerender();
  const textarea = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor');
  assert(textarea !== null, 'inline text editor did not open');
  return textarea;
}

function canvasTypeDraft(editor, value) {
  const textarea = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor');
  assert(textarea !== null, 'inline text editor is missing');
  textarea.props.onChange({ target: { value: value } });
  editor.rerender();
  return findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor');
}

function canvasPressEnter(editor) {
  const textarea = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor');
  assert(textarea !== null, 'inline text editor is missing');
  textarea.props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} });
}

function canvasRetryButton(editor) {
  const overlay = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-overlay');
  if (overlay === null) return null;
  // The reviewed requirement is that the retry affordance sits in the editor
  // overlay next to the still-open draft, not in a detached toolbar.
  return findNode(overlay, (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes('dv-editor-retry'));
}

function canvasDrag(editor, options) {
  const settings = options || {};
  const tree = editor.tree();
  let handleTarget;
  if (settings.handle === undefined || settings.handle === null) {
    handleTarget = findNode(tree, (node) => node.props && node.props.className === 'dv-selection');
    assert(handleTarget !== null, 'selection missing before the move gesture');
  } else {
    handleTarget = findNode(
      tree,
      (node) => node.props && typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes('dv-handle-' + settings.handle)
    );
    assert(handleTarget !== null, `resize handle ${settings.handle} missing`);
  }
  const pointer = { pointerId: 11, preventDefault() {}, stopPropagation() {} };
  handleTarget.props.onPointerDown(Object.assign({}, pointer, { clientX: settings.startX, clientY: settings.startY }));
  editor.rerender();
  canvasOverlay(editor.tree()).props.onPointerMove(Object.assign({}, pointer, { clientX: settings.moveX, clientY: settings.moveY }));
  editor.rerender();
  canvasOverlay(editor.tree()).props.onPointerUp(Object.assign({}, pointer, { clientX: settings.moveX, clientY: settings.moveY }));
}

const CANVAS_REVISION_CHAIN = [
  CANVAS_REVISION,
  CANVAS_NEXT_REVISION,
  CANVAS_FRESH_REVISION,
  'a'.repeat(64),
  'b'.repeat(64),
  'f'.repeat(64),
];

/**
 * Fake Host worker for the inline-text write-attempt regressions. It mirrors the
 * real worker semantics: the result is cached by operationId + canonical request
 * signature and the cache is checked BEFORE the revision; the same operationId
 * with another signature is E_OPERATION_REUSED; a stale expectedRevision without
 * a cache entry is E_REVISION_CONFLICT. `loseResponses` makes an applied/cached
 * call throw before answering (the acknowledgement is lost).
 */
function canvasTextEngine(options) {
  const config = options || {};
  const state = {
    revisionIndex: 0,
    revision: CANVAS_REVISION,
    text: config.initialText || 'Scene 1',
    applied: 0,
    appliedTexts: [],
    operations: new Map(),
    loseResponses: config.loseResponses || 0,
    reuseNextOperation: config.reuseNextOperation || 0,
  };
  state.handle = async function handleEdit(request) {
    const params = request.body.params;
    const signature = JSON.stringify({
      expectedRevision: params.expectedRevision,
      operationId: params.operationId,
      ops: params.ops,
    });
    const cached = state.operations.get(params.operationId);
    let result;
    if (cached !== undefined) {
      if (cached.signature !== signature) {
        return { ok: false, error: { code: 'E_OPERATION_REUSED', message: 'operationId already has a different request' } };
      }
      result = cached.result;
    } else {
      if (state.reuseNextOperation > 0) {
        state.reuseNextOperation -= 1;
        return { ok: false, error: { code: 'E_OPERATION_REUSED', message: 'operationId already has a different request' } };
      }
      if (params.expectedRevision !== state.revision) {
        return { ok: false, error: { code: 'E_REVISION_CONFLICT', message: 'Project changed before edit' } };
      }
      const textOp = params.ops.find((op) => op.type === 'text');
      if (textOp !== undefined) {
        state.text = textOp.text;
        state.appliedTexts.push(textOp.text);
      }
      state.applied += 1;
      state.revisionIndex = Math.min(state.revisionIndex + 1, CANVAS_REVISION_CHAIN.length - 1);
      state.revision = CANVAS_REVISION_CHAIN[state.revisionIndex];
      result = { projectId: 'proj-smoke', revision: state.revision, operationId: params.operationId };
      state.operations.set(params.operationId, { signature: signature, result: result });
    }
    if (state.loseResponses > 0) {
      state.loseResponses -= 1;
      throw new Error('the write was applied but the response was lost');
    }
    return { ok: true, result: result };
  };
  return state;
}

function canvasTextFetch(engine) {
  return canvasFetch({
    inspect: () =>
      canvasManagedInspect({
        revision: engine.revision,
        elements: [
          {
            stableId: 'scene-1-title',
            sceneId: 'scene-1',
            text: engine.text,
            timing: { start: 0, duration: 5 },
            capabilities: ['text', 'layout', 'style'],
            layout: { left: 88, top: 196, width: 980, height: 120 },
            style: { color: '#ffffff', fontSize: 64, fontWeight: 600, textAlign: 'left' },
          },
        ],
      }),
    edit: (request) => engine.handle(request),
  });
}
//#endregion

test('R1 pure: frozen 0.3.2 template text limits accept long text without truncation', () => {
  function prepare(templateOverrides) {
    const template = Object.assign({ title: 'Scene 1', duration: 5 }, templateOverrides || {});
    return CANVAS.canvasSceneTemplate(
      { revision: CANVAS_FRESH_REVISION, scenes: [{ sceneId: 'scene-1', template: template }] },
      'scene-1'
    );
  }
  // Lengths that the previous 200/300/48 limits wrongly rejected are legal now.
  for (const title of ['x'.repeat(201), 'x'.repeat(300), '标题'.repeat(400)]) {
    const prepared = prepare({ title: title });
    assert(prepared.ok === true, `title of ${title.length} was rejected`);
    assert(prepared.template.title === title, 'the title was truncated or changed');
  }
  assert(prepare({ subtitle: 'x'.repeat(301) }).ok === true, 'subtitle of 301 was rejected');
  assert(prepare({ subtitle: 'x'.repeat(1500) }).ok === true, 'long subtitle was rejected');
  assert(prepare({ badge: 'x'.repeat(49) }).ok === true, 'badge of 49 was rejected');
  assert(prepare({ badge: 'x'.repeat(1500) }).ok === true, 'long badge was rejected');
  // 2048 boundary accepted and preserved exactly for every text field.
  const boundary = 'x'.repeat(2048);
  for (const field of ['title', 'subtitle', 'badge']) {
    const override = {};
    override[field] = boundary;
    const prepared = prepare(override);
    assert(prepared.ok === true, `${field} at the 2048 boundary was rejected`);
    assert(prepared.template[field] === boundary, `${field} was truncated at the 2048 boundary`);
  }
  // 2049 rejected for every text field.
  const overflow = 'x'.repeat(2049);
  for (const field of ['title', 'subtitle', 'badge']) {
    const override = {};
    override[field] = overflow;
    const prepared = prepare(override);
    assert(prepared.ok === false && prepared.code === 'E_SCENE_TEMPLATE', `${field} over 2048 was accepted`);
  }
  // Empty title stays illegal; empty optional text fields are legal.
  assert(prepare({ title: '' }).ok === false, 'an empty title was accepted');
  const emptyOptional = prepare({ subtitle: '', badge: '' });
  assert(emptyOptional.ok === true && emptyOptional.template.subtitle === '' && emptyOptional.template.badge === '', 'empty optional text was rejected or guessed');
  // The frozen Host bridge and engine enforce UTF-16 string length
  // (`value.length`), so astral characters count as two units here as well:
  // this keeps the client aligned with the Host instead of accepting text the
  // worker would reject. 1024 astral chars = 2048 units is legal; 1025 is not.
  const astralAtLimit = '\u{1F600}'.repeat(1024);
  const astralPrepared = prepare({ title: astralAtLimit });
  assert(astralPrepared.ok === true, 'a 2048-UTF-16-unit astral title was rejected');
  assert(astralPrepared.template.title === astralAtLimit, 'an astral title was truncated');
  assert(astralPrepared.template.title.length === 2048, 'the astral title length is not UTF-16 units');
  assert(prepare({ title: '\u{1F600}'.repeat(1025) }).ok === false, 'a 2050-UTF-16-unit astral title was accepted');
});

test('R1 wiring: scene colour is copied from a fresh authoritative template and only the colour changes', async () => {
  const template = {
    title: 'Scene 1',
    duration: 5,
    subtitle: '保留副标题',
    badge: '保留标签',
    color: '#123456',
    accent: '#654321',
    logo: 'assets/logo.png',
    shot: 'assets/old-shot.png',
    sceneId: 'scene-1',
  };
  const hostFetch = canvasFetch({ inspect: (state) => canvasManagedInspect({ revision: state.revision, template: template }) });
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    // The authoritative project moved on out of band: this UI still renders the
    // old revision, so the write must come from the fresh inspect under test.
    hostFetch.state.revision = CANVAS_FRESH_REVISION;
    let tree = editor.rerender();
    const colorInput = findNode(tree, (node) => node.props && node.props.type === 'color');
    assert(colorInput !== null, 'scene colour input is missing');
    colorInput.props.onChange({ target: { value: '#FFD400' } });
    tree = editor.rerender();
    const apply = buttonByText(tree, translateFor(editor.env)('video.canvas.apply'));
    assert(apply !== null, 'scene colour apply action is missing');
    apply.props.onClick();
    await settle();
    editor.rerender();
    const updates = canvasMethodCalls(hostFetch, 'scene.update');
    assert(updates.length === 1, `expected one scene.update, got ${updates.length}`);
    const params = updates[0].body.params;
    assert(params.sceneId === 'scene-1', `scene.update targeted ${params.sceneId}`);
    assert(params.expectedRevision === CANVAS_FRESH_REVISION, `scene.update used ${params.expectedRevision} instead of the fresh inspect revision`);
    const expected = {
      title: 'Scene 1',
      duration: 5,
      subtitle: '保留副标题',
      badge: '保留标签',
      color: '#ffd400',
      accent: '#654321',
      logo: 'assets/logo.png',
      shot: 'assets/old-shot.png',
    };
    assert(JSON.stringify(params.template) === JSON.stringify(expected), `scene.update template was ${JSON.stringify(params.template)}`);
    assert(params.template.sceneId === undefined, 'the scene.update template leaked sceneId');
    assert(typeof params.operationId === 'string' && params.operationId.length > 0, 'scene.update lost its operationId');
    assert(canvasMethodCalls(hostFetch, 'inspect').length >= 2, 'no fresh inspect was issued before the scene write');
    await ensureCanvasActive(editor);
    assert(
      findNode(editor.tree(), (node) => node.props && node.props['data-canvas-revision'] === CANVAS_FRESH_REVISION) !== null,
      'the canvas did not reload the fresh revision after the write'
    );
  } finally {
    editor.interactive.unmount();
  }
});

test('R1 wiring: an absent Scene template refuses the destructive write with localized copy', async () => {
  const hostFetch = canvasFetch({ inspect: (state) => canvasManagedInspect({ revision: state.revision, template: null }) });
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    const tree = editor.rerender();
    buttonByText(tree, translateFor(editor.env)('video.canvas.apply')).props.onClick();
    await settle();
    editor.rerender();
    assert(canvasMethodCalls(hostFetch, 'scene.update').length === 0, 'scene.update was sent without an authoritative template');
    const alert = findNode(editor.tree(), (node) => node.props && node.props.role === 'alert');
    assert(
      alert !== null && textOf(alert).includes(translateFor(editor.env)('video.canvas.templateUnavailable')),
      `refusal copy missing: ${alert && textOf(alert)}`
    );
  } finally {
    editor.interactive.unmount();
  }
});

test('R1 wiring: using a picture keeps the complete template and never injects the UI colour', async () => {
  const template = {
    title: 'Scene 1',
    duration: 5,
    subtitle: '保留副标题',
    badge: '保留标签',
    color: '#123456',
    accent: '#654321',
    logo: 'assets/logo.png',
    shot: 'assets/old-shot.png',
  };
  const hostFetch = canvasFetch({ inspect: (state) => canvasManagedInspect({ revision: state.revision, template: template }) });
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    let tree = editor.rerender();
    buttonByText(tree, translateFor(editor.env)('video.canvas.materials')).props.onClick();
    tree = editor.rerender();
    const use = buttonByText(tree, translateFor(editor.env)('video.canvas.useAsset'));
    assert(use !== null, 'asset use action is missing from the drawer');
    use.props.onClick();
    await settle();
    editor.rerender();
    const updates = canvasMethodCalls(hostFetch, 'scene.update');
    assert(updates.length === 1, `expected one scene.update, got ${updates.length}`);
    const params = updates[0].body.params;
    const expected = {
      title: 'Scene 1',
      duration: 5,
      subtitle: '保留副标题',
      badge: '保留标签',
      color: '#123456',
      accent: '#654321',
      logo: 'assets/logo.png',
      shot: 'assets/photo.png',
    };
    assert(JSON.stringify(params.template) === JSON.stringify(expected), `asset template was ${JSON.stringify(params.template)}`);
    assert(params.template.color !== '#1d4ed8', 'the UI default colour leaked into the asset write');
    assert(params.expectedRevision === CANVAS_REVISION, `asset write used ${params.expectedRevision}`);
  } finally {
    editor.interactive.unmount();
  }
});

test('R2 wiring: a component move writes the static-base patch and reloads the new revision', async () => {
  const hostFetch = canvasFetch({
    inspect: (state) => canvasManagedInspect({ revision: state.revision, layout: { left: 88, top: 196, width: 980, height: null } }),
  });
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    canvasSelectText(editor);
    canvasDrag(editor, { startX: 500, startY: 246, moveX: 510, moveY: 246 });
    await settle();
    editor.rerender();
    const edits = canvasMethodCalls(hostFetch, 'edit');
    assert(edits.length === 1, `expected one layout edit, got ${edits.length}`);
    const params = edits[0].body.params;
    const op = params.ops[0];
    assert(op.type === 'layout' && op.unit === 'composition-px' && op.target === 'scene-1-title', `unexpected layout op ${JSON.stringify(op)}`);
    assert(JSON.stringify(op.box) === JSON.stringify({ left: 98, top: 196 }), `layout box was ${JSON.stringify(op.box)}; the animated Y offset or the auto height leaked into the write`);
    assert(params.expectedRevision === CANVAS_REVISION, 'layout edit lost expectedRevision');
    await ensureCanvasActive(editor);
    assert(
      findNode(editor.tree(), (node) => node.props && node.props['data-canvas-revision'] === CANVAS_NEXT_REVISION) !== null,
      'the new revision did not replace the canvas snapshot after the layout write'
    );
  } finally {
    editor.interactive.unmount();
  }
});

test('R2 wiring: a failed layout write restores the pre-drag selection and never retries automatically', async () => {
  const hostFetch = canvasFetch({
    inspect: (state) => canvasManagedInspect({ revision: state.revision, layout: { left: 88, top: 196, width: 980, height: null } }),
    edit: async () => ({ ok: false, error: { code: 'E_PERSIST', message: 'SDK persistence failed' } }),
  });
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    canvasSelectText(editor);
    canvasDrag(editor, { startX: 500, startY: 246, moveX: 510, moveY: 246 });
    await settle();
    await settle();
    assert(canvasMethodCalls(hostFetch, 'edit').length === 1, 'the failed layout write was not sent exactly once');
    const tree = editor.rerender();
    const selection = findNode(tree, (node) => node.props && node.props.className === 'dv-selection');
    assert(selection !== null, 'selection was lost after the failed layout write');
    assert(selection.props.style.left === '88px' && selection.props.style.top === '210px', `selection rect was not restored: ${JSON.stringify(selection.props.style)}`);
    const alert = findNode(tree, (node) => node.props && node.props.role === 'alert');
    assert(alert !== null && textOf(alert).includes(translateFor(editor.env)('video.canvas.persistFailed')), `failure copy missing: ${alert && textOf(alert)}`);
    assert(findNode(tree, (node) => node.props && node.props['data-canvas-revision'] === CANVAS_REVISION) !== null, 'a failed write changed the canvas revision');
    await settle();
    assert(canvasMethodCalls(hostFetch, 'edit').length === 1, 'the failed layout write was retried automatically');
  } finally {
    editor.interactive.unmount();
  }
});

test('R2 wiring: a missing static layout refuses the write with localized copy', async () => {
  const hostFetch = canvasFetch({ inspect: (state) => canvasManagedInspect({ revision: state.revision, layout: null }) });
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    canvasSelectText(editor);
    canvasDrag(editor, { startX: 500, startY: 246, moveX: 510, moveY: 246 });
    await settle();
    editor.rerender();
    assert(canvasMethodCalls(hostFetch, 'edit').length === 0, 'a layout write was sent without a static base');
    const alert = findNode(editor.tree(), (node) => node.props && node.props.role === 'alert');
    assert(alert !== null && textOf(alert).includes(translateFor(editor.env)('video.canvas.layoutRefused')), `refusal copy missing: ${alert && textOf(alert)}`);
  } finally {
    editor.interactive.unmount();
  }
});

test('R5: a failed text save keeps the draft and reuses the editor operationId on retry', async () => {
  let failFirst = true;
  const hostFetch = canvasFetch({
    edit: async () => {
      if (failFirst) {
        failFirst = false;
        return { ok: false, error: { code: 'E_PERSIST', message: 'SDK persistence failed' } };
      }
      return undefined;
    },
  });
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    canvasSelectText(editor);
    canvasOpenTextEditor(editor);
    canvasTypeDraft(editor, '人工改标题');
    canvasPressEnter(editor);
    await settle();
    editor.rerender();
    assert(canvasMethodCalls(hostFetch, 'edit').length === 1, 'the failed text save was not sent exactly once');
    const kept = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor');
    assert(kept !== null && kept.props.value === '人工改标题', `the draft was lost after the failure: ${kept && kept.props.value}`);
    assert(canvasRetryButton(editor) !== null, 'the retry affordance is missing from the editor overlay');
    const alert = findNode(editor.tree(), (node) => node.props && node.props.role === 'alert');
    assert(alert !== null && textOf(alert).includes(translateFor(editor.env)('video.canvas.persistFailed')), 'the failure copy is missing');
    await settle();
    assert(canvasMethodCalls(hostFetch, 'edit').length === 1, 'the failed text save was retried automatically');
    canvasRetryButton(editor).props.onClick();
    await settle();
    editor.rerender();
    const edits = canvasMethodCalls(hostFetch, 'edit');
    assert(edits.length === 2, `expected one explicit retry, got ${edits.length} edits`);
    assert(edits[0].body.params.operationId === edits[1].body.params.operationId, 'the retry lost the editor operationId');
    assert(
      edits[1].body.params.ops[0].text === '人工改标题' && edits[1].body.params.ops[0].target === 'scene-1-title',
      'the retry changed the draft or its target'
    );
    assert(findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor') === null, 'the editor did not close after the successful retry');
    const editIndex = hostFetch.calls.indexOf(edits[1]);
    assert(hostFetch.calls.slice(editIndex + 1).some((call) => call.body.method === 'inspect'), 'the successful save did not reload the authoritative project');
    await ensureCanvasActive(editor);
    assert(
      findNode(editor.tree(), (node) => node.props && node.props['data-canvas-revision'] === CANVAS_NEXT_REVISION) !== null,
      'the saved revision did not replace the canvas snapshot'
    );
  } finally {
    editor.interactive.unmount();
  }
});

test('R5: a revision conflict refreshes only on explicit retry and needs a later explicit submit', async () => {
  let conflicts = 1;
  const hostFetch = canvasFetch({
    edit: async (request, state) => {
      if (conflicts > 0) {
        conflicts = 0;
        state.revision = CANVAS_FRESH_REVISION;
        return { ok: false, error: { code: 'E_REVISION_CONFLICT', message: 'Project changed before edit' } };
      }
      return undefined;
    },
  });
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    canvasSelectText(editor);
    canvasOpenTextEditor(editor);
    canvasTypeDraft(editor, '冲突标题');
    const inspectBefore = canvasMethodCalls(hostFetch, 'inspect').length;
    canvasPressEnter(editor);
    await settle();
    editor.rerender();
    assert(canvasMethodCalls(hostFetch, 'edit').length === 1, 'the conflict submit did not send exactly one write');
    assert(canvasMethodCalls(hostFetch, 'inspect').length === inspectBefore, 'the conflict reloaded the project without an explicit retry');
    const kept = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor');
    assert(kept !== null && kept.props.value === '冲突标题', 'the conflict lost the draft');
    const alert = findNode(editor.tree(), (node) => node.props && node.props.role === 'alert');
    assert(alert !== null && textOf(alert).includes(translateFor(editor.env)('video.error.conflict')), `conflict copy missing: ${alert && textOf(alert)}`);
    // Explicit retry 1: refresh the authoritative revision, do not write.
    canvasRetryButton(editor).props.onClick();
    await settle();
    editor.rerender();
    assert(canvasMethodCalls(hostFetch, 'edit').length === 1, 'the refresh retry silently submitted the draft');
    assert(canvasMethodCalls(hostFetch, 'inspect').length === inspectBefore + 1, 'the explicit retry did not refresh the authoritative revision');
    const notice = findNode(
      editor.tree(),
      (node) => node.props && node.props.className === 'dv-tool-hint' && textOf(node).includes(translateFor(editor.env)('video.canvas.revisionRefreshed'))
    );
    assert(notice !== null, 'the refreshed-revision notice is missing');
    const keptAfterRefresh = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor');
    assert(keptAfterRefresh !== null && keptAfterRefresh.props.value === '冲突标题', 'the draft did not survive the conflict refresh');
    // Explicit retry 2: the actual write against the refreshed revision.
    canvasRetryButton(editor).props.onClick();
    await settle();
    editor.rerender();
    const edits = canvasMethodCalls(hostFetch, 'edit');
    assert(edits.length === 2, `expected the later explicit submit, got ${edits.length} edits`);
    assert(edits[1].body.params.expectedRevision === CANVAS_FRESH_REVISION, `the retried write used ${edits[1].body.params.expectedRevision}`);
    // The conflict refresh reset the frozen attempt: the later explicit submit
    // must use a NEW operationId at the refreshed revision (a reused id could
    // only be replayed with the stale signature).
    assert(edits[0].body.params.operationId !== edits[1].body.params.operationId, 'the post-refresh submit reused the conflict attempt operationId');
    assert(findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor') === null, 'the editor did not close after the successful retry');
  } finally {
    editor.interactive.unmount();
  }
});

test('R5: an uncertain network failure keeps the draft and reuses the operationId', async () => {
  let failFirst = true;
  const hostFetch = canvasFetch({
    edit: async () => {
      if (failFirst) {
        failFirst = false;
        return new Error('socket closed before the response');
      }
      return undefined;
    },
  });
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    canvasSelectText(editor);
    canvasOpenTextEditor(editor);
    canvasTypeDraft(editor, '网络标题');
    canvasPressEnter(editor);
    await settle();
    editor.rerender();
    assert(canvasMethodCalls(hostFetch, 'edit').length === 1, 'the network failure did not stop at one write');
    const kept = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor');
    assert(kept !== null && kept.props.value === '网络标题', 'the network failure lost the draft');
    const alert = findNode(editor.tree(), (node) => node.props && node.props.role === 'alert');
    assert(alert !== null && textOf(alert).includes(translateFor(editor.env)('video.error.network')), `network failure copy missing: ${alert && textOf(alert)}`);
    canvasRetryButton(editor).props.onClick();
    await settle();
    editor.rerender();
    const edits = canvasMethodCalls(hostFetch, 'edit');
    assert(edits.length === 2 && edits[0].body.params.operationId === edits[1].body.params.operationId, 'the uncertain retry did not reuse the operationId');
    assert(findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor') === null, 'the editor did not close after the retry');
  } finally {
    editor.interactive.unmount();
  }
});

test('R5: Escape closes the inline editor without sending any write', async () => {
  const hostFetch = canvasFetch({});
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    canvasSelectText(editor);
    canvasOpenTextEditor(editor);
    canvasTypeDraft(editor, '不应提交');
    const textarea = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor');
    let prevented = false;
    textarea.props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true; } });
    await settle();
    editor.rerender();
    assert(prevented === true, 'Escape was not handled by the inline editor');
    assert(findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor') === null, 'Escape did not close the inline editor');
    assert(canvasMethodCalls(hostFetch, 'edit').length === 0, 'Escape sent an edit request');
  } finally {
    editor.interactive.unmount();
  }
});

test('R5 wiring: a pointer-capture retargeted overlay double-click opens the inline editor', async () => {
  const hostFetch = canvasFetch({});
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    // Real gesture sequence: pointer capture on the overlay retargets
    // pointerup/click/dblclick to the overlay (nearest common ancestor), so the
    // selection node's own dblclick never fires in a real browser.
    canvasOverlay(editor.tree()).props.onClick({ clientX: 640, clientY: 246 });
    const selectCommand = takeCanvasCommand(editor, 'hitTest');
    assert(selectCommand !== null, 'the selection click did not request a hit test');
    canvasDispatch(editor, { reference: selectCommand, type: 'hit', payload: { hit: canvasHitPayload() } });
    await settle();
    editor.rerender();
    await settle();
    const selection = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-selection');
    assert(selection !== null, 'selection missing before the retargeted double click');
    const overlayNode = canvasOverlay(editor.tree());
    const retargeted = { clientX: 640, clientY: 246, target: overlayNode, currentTarget: overlayNode };
    overlayNode.props.onDoubleClick(retargeted);
    const pause = takeCanvasCommand(editor, 'pause');
    if (pause !== null) canvasDispatch(editor, { reference: pause, type: 'paused', payload: { time: 0 } });
    await settle();
    editor.rerender();
    await settle();
    let textarea = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor');
    assert(textarea !== null, 'the retargeted overlay double-click did not open the inline editor');
    assert(textarea.props.value === 'Scene 1', `the editor value came from the wrong source: ${textarea.props.value}`);
    assert(canvasMethodCalls(hostFetch, 'edit').length === 0, 'opening the inline editor sent an edit request');
    textarea.props.onKeyDown({ key: 'Escape', preventDefault() {} });
    await settle();
    editor.rerender();
    await settle();
    assert(findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor') === null, 'Escape did not close the editor');

    // A double-click on a not-yet-selected text element goes through the
    // hit-test fallback and still opens the editor on the real target.
    canvasOverlay(editor.tree()).props.onClick({ clientX: 320, clientY: 240 });
    const clearCommand = takeCanvasCommand(editor, 'hitTest');
    assert(clearCommand !== null, 'the clearing click did not request a hit test');
    canvasDispatch(editor, { reference: clearCommand, type: 'hit', payload: { hit: null } });
    await settle();
    editor.rerender();
    await settle();
    assert(findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-selection') === null, 'selection did not clear');
    canvasOverlay(editor.tree()).props.onDoubleClick({ clientX: 640, clientY: 246 });
    const fallbackCommand = takeCanvasCommand(editor, 'hitTest');
    assert(fallbackCommand !== null, 'the double-click fallback did not request a hit test');
    canvasDispatch(editor, { reference: fallbackCommand, type: 'hit', payload: { hit: canvasHitPayload() } });
    const fallbackPause = takeCanvasCommand(editor, 'pause');
    if (fallbackPause !== null) canvasDispatch(editor, { reference: fallbackPause, type: 'paused', payload: { time: 0 } });
    await settle();
    editor.rerender();
    await settle();
    textarea = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor');
    assert(textarea !== null && textarea.props.value === 'Scene 1', 'the double-click hit-test fallback did not open the editor');
  } finally {
    editor.interactive.unmount();
  }
});

test('R5: a successful save closes the editor first and then reloads the new revision', async () => {
  const hostFetch = canvasFetch({});
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    canvasSelectText(editor);
    canvasOpenTextEditor(editor);
    canvasTypeDraft(editor, '成功标题');
    const before = hostFetch.calls.length;
    canvasPressEnter(editor);
    await settle();
    editor.rerender();
    const edits = canvasMethodCalls(hostFetch, 'edit');
    assert(edits.length === 1, `expected one text edit, got ${edits.length}`);
    const op = edits[0].body.params.ops[0];
    assert(op.type === 'text' && op.text === '成功标题' && op.target === 'scene-1-title', `unexpected text op ${JSON.stringify(op)}`);
    const editIndex = hostFetch.calls.indexOf(edits[0]);
    assert(editIndex >= before, 'the edit was not sent after the explicit submit');
    assert(hostFetch.calls.slice(editIndex + 1).some((call) => call.body.method === 'inspect'), 'the successful save did not reload the authoritative project');
    assert(findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor') === null, 'the editor did not close on success');
    await ensureCanvasActive(editor);
    assert(
      findNode(editor.tree(), (node) => node.props && node.props['data-canvas-revision'] === CANVAS_NEXT_REVISION) !== null,
      'the canvas did not load the saved revision'
    );
  } finally {
    editor.interactive.unmount();
  }
});

test('R5(b): a write applied but response lost replays the identical frozen request and applies once', async () => {
  const engine = canvasTextEngine({ loseResponses: 1 });
  const hostFetch = canvasTextFetch(engine);
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    canvasSelectText(editor);
    canvasOpenTextEditor(editor);
    canvasTypeDraft(editor, '丢确认标题');
    canvasPressEnter(editor);
    await settle();
    editor.rerender();
    await settle();
    const firstAttempts = canvasMethodCalls(hostFetch, 'edit');
    assert(firstAttempts.length === 1, `expected one sent attempt, got ${firstAttempts.length}`);
    assert(engine.applied === 1 && engine.text === '丢确认标题', 'the fake worker did not apply the write whose acknowledgement was lost');
    const kept = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor');
    assert(kept !== null && kept.props.value === '丢确认标题', 'the lost acknowledgement closed the editor or cleared the draft');
    const alert = findNode(editor.tree(), (node) => node.props && node.props.role === 'alert');
    assert(
      alert !== null && textOf(alert).includes(translateFor(editor.env)('video.error.network')),
      'the lost acknowledgement was not surfaced as an uncertain failure'
    );
    await settle();
    assert(canvasMethodCalls(hostFetch, 'edit').length === 1, 'the uncertain attempt was retried automatically');
    canvasRetryButton(editor).props.onClick();
    await settle();
    editor.rerender();
    await settle();
    const edits = canvasMethodCalls(hostFetch, 'edit');
    assert(edits.length === 2, `expected one explicit retry, got ${edits.length} edits`);
    assert(JSON.stringify(edits[1].body.params) === JSON.stringify(edits[0].body.params), 'the unchanged-draft retry did not send the identical frozen request');
    assert(engine.applied === 1, `the text was applied ${engine.applied} times instead of once`);
    assert(findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor') === null, 'the editor did not close after the cached success');
    await ensureCanvasActive(editor);
    assert(
      findNode(editor.tree(), (node) => node.props && node.props['data-canvas-revision'] === engine.revision) !== null,
      'the canvas did not load the settled revision after the cached success'
    );
  } finally {
    editor.interactive.unmount();
  }
});

test('R5(c): a changed retained draft settles the old frozen attempt first and then writes with a new operationId', async () => {
  const engine = canvasTextEngine({ loseResponses: 1 });
  const hostFetch = canvasTextFetch(engine);
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    canvasSelectText(editor);
    canvasOpenTextEditor(editor);
    canvasTypeDraft(editor, '旧文案');
    canvasPressEnter(editor);
    await settle();
    editor.rerender();
    await settle();
    assert(engine.applied === 1 && engine.text === '旧文案', 'setup: the acknowledged-lost write was not applied');
    const first = canvasMethodCalls(hostFetch, 'edit')[0].body.params;
    canvasTypeDraft(editor, '新文案');
    canvasPressEnter(editor);
    await settle();
    editor.rerender();
    await settle();
    const edits = canvasMethodCalls(hostFetch, 'edit');
    assert(edits.length === 3, `expected old-attempt settle plus new attempt, got ${edits.length} edits`);
    assert(JSON.stringify(edits[1].body.params) === JSON.stringify(first), 'the old attempt was not settled with its exact frozen request');
    const next = edits[2].body.params;
    assert(next.operationId !== first.operationId, 'the new intent reused the old attempt operationId');
    assert(next.expectedRevision === CANVAS_NEXT_REVISION, `the new attempt did not use the settled revision: ${next.expectedRevision}`);
    assert(next.ops[0].text === '新文案', 'the new attempt did not carry the changed draft');
    assert(engine.applied === 2 && engine.text === '新文案', `final apply state is wrong: ${engine.text} applied ${engine.applied}`);
    assert(findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor') === null, 'the editor did not close after the new attempt succeeded');
    await ensureCanvasActive(editor);
    assert(
      findNode(editor.tree(), (node) => node.props && node.props['data-canvas-revision'] === engine.revision) !== null,
      'the canvas did not load the final revision'
    );
  } finally {
    editor.interactive.unmount();
  }
});

test('R5(d): an uncertain settle keeps the frozen attempt and recovers without reopening the editor', async () => {
  const engine = canvasTextEngine({ loseResponses: 2 });
  const hostFetch = canvasTextFetch(engine);
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    canvasSelectText(editor);
    canvasOpenTextEditor(editor);
    canvasTypeDraft(editor, '旧文案');
    canvasPressEnter(editor);
    await settle();
    editor.rerender();
    await settle();
    const first = canvasMethodCalls(hostFetch, 'edit')[0].body.params;
    canvasTypeDraft(editor, '新文案');
    canvasPressEnter(editor);
    await settle();
    editor.rerender();
    await settle();
    const afterSettleFailure = canvasMethodCalls(hostFetch, 'edit');
    assert(afterSettleFailure.length === 2, `expected only the old-attempt settle, got ${afterSettleFailure.length} edits`);
    assert(JSON.stringify(afterSettleFailure[0].body.params) === JSON.stringify(afterSettleFailure[1].body.params), 'the settle was not the exact frozen request');
    assert(afterSettleFailure[1].body.params.operationId === first.operationId, 'the operationId changed while the old outcome was still unknown');
    const kept = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor');
    assert(kept !== null && kept.props.value === '新文案', 'the changed draft was lost after the uncertain settle');
    const alert = findNode(editor.tree(), (node) => node.props && node.props.role === 'alert');
    assert(alert !== null && textOf(alert).includes(translateFor(editor.env)('video.error.network')), 'the uncertain settle was not surfaced');
    // The next explicit retry settles the same frozen attempt (cached success)
    // and only then starts the new intent: recoverable without Esc/reopen.
    canvasRetryButton(editor).props.onClick();
    await settle();
    editor.rerender();
    await settle();
    const edits = canvasMethodCalls(hostFetch, 'edit');
    assert(edits.length === 4, `expected settle retry plus new attempt, got ${edits.length} total edits`);
    assert(JSON.stringify(edits[2].body.params) === JSON.stringify(first), 'the recovering retry changed the frozen settle request');
    assert(edits[3].body.params.operationId !== first.operationId, 'the recovered new intent reused the old operationId');
    assert(edits[3].body.params.ops[0].text === '新文案', 'the recovered attempt did not carry the changed draft');
    assert(engine.applied === 2 && engine.text === '新文案', `final apply state is wrong: ${engine.text} applied ${engine.applied}`);
    assert(findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor') === null, 'the editor did not close after recovery');
  } finally {
    editor.interactive.unmount();
  }
});

test('R5(e): E_OPERATION_REUSED is recoverable through the explicit refresh path', async () => {
  const engine = canvasTextEngine({ reuseNextOperation: 1 });
  const hostFetch = canvasTextFetch(engine);
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    canvasSelectText(editor);
    canvasOpenTextEditor(editor);
    canvasTypeDraft(editor, '复用标题');
    canvasPressEnter(editor);
    await settle();
    editor.rerender();
    await settle();
    assert(canvasMethodCalls(hostFetch, 'edit').length === 1, 'the reused-id failure did not stop at one write');
    assert(engine.applied === 0, 'the reused-id failure applied the text');
    const kept = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor');
    assert(kept !== null && kept.props.value === '复用标题', 'the E_OPERATION_REUSED failure lost the draft');
    const alert = findNode(editor.tree(), (node) => node.props && node.props.role === 'alert');
    assert(
      alert !== null && textOf(alert).includes(translateFor(editor.env)('video.error.conflict')),
      `E_OPERATION_REUSED was not mapped to the recoverable conflict copy: ${alert && textOf(alert)}`
    );
    const inspectBefore = canvasMethodCalls(hostFetch, 'inspect').length;
    canvasRetryButton(editor).props.onClick();
    await settle();
    editor.rerender();
    await settle();
    assert(canvasMethodCalls(hostFetch, 'edit').length === 1, 'the refresh retry silently resubmitted after E_OPERATION_REUSED');
    assert(canvasMethodCalls(hostFetch, 'inspect').length === inspectBefore + 1, 'the refresh retry did not refresh the authoritative revision');
    const notice = findNode(
      editor.tree(),
      (node) => node.props && node.props.className === 'dv-tool-hint' && textOf(node).includes(translateFor(editor.env)('video.canvas.revisionRefreshed'))
    );
    assert(notice !== null, 'the refreshed-revision notice is missing after E_OPERATION_REUSED');
    canvasRetryButton(editor).props.onClick();
    await settle();
    editor.rerender();
    await settle();
    const edits = canvasMethodCalls(hostFetch, 'edit');
    assert(edits.length === 2, `expected the later explicit submit, got ${edits.length} edits`);
    assert(edits[1].body.params.operationId !== edits[0].body.params.operationId, 'the recovered submit reused the failed operationId');
    assert(engine.applied === 1 && engine.text === '复用标题', 'the recovered submit did not apply the text once');
    assert(findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-inline-editor') === null, 'the editor did not close after recovery');
  } finally {
    editor.interactive.unmount();
  }
});

test('R6 wiring: the canvas drops wrong-source, uncorrelated and malformed events and accepts only correlated replies', async () => {
  const hostFetch = canvasFetch({});
  const editor = await mountCanvasReady({ fetch: hostFetch });
  try {
    canvasOverlay(editor.tree()).props.onClick({ clientX: 640, clientY: 360 });
    const command = takeCanvasCommand(editor, 'hitTest');
    assert(command !== null, 'the canvas did not request a hit test');
    assert(
      command.v === 1 &&
        command.kind === 'cmd' &&
        /^[a-z0-9][a-z0-9-]{7,63}$/.test(command.instanceId) &&
        command.nonce.length === 32 &&
        Number.isInteger(command.seq) &&
        command.seq >= 1,
      `outgoing command is not the reviewed contract shape: ${JSON.stringify(command)}`
    );
    assert(findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-selection') === null, 'a selection existed before any runtime reply');
    const dispatchOptions = { reference: command, type: 'hit', payload: { hit: canvasHitPayload() } };
    // No rerender happens between these dispatches: the review contract must be
    // enforced inside one bound snapshot instance.
    canvasDispatch(editor, Object.assign({}, dispatchOptions, { source: {} }));
    canvasDispatch(editor, Object.assign({}, dispatchOptions, { instanceId: 'dvcanvas-other1' }));
    canvasDispatch(editor, Object.assign({}, dispatchOptions, { replyTo: null }));
    canvasDispatch(editor, Object.assign({}, dispatchOptions, { payload: { hit: { stableId: 42 } } }));
    assert(findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-selection') === null, 'a dropped event mutated the selection');
    const accepted = canvasDispatch(editor, dispatchOptions);
    canvasDispatch(editor, Object.assign({}, dispatchOptions, { seq: 1, payload: { hit: null } }));
    editor.rerender();
    assert(findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-selection') !== null, 'the valid correlated hit reply was not applied');
    assert(typeof accepted.seq === 'number' && accepted.seq > 1, 'event sequence is not strictly increasing');
    // Unbind must settle the pending command promise explicitly: the waiter is
    // resolved with null, its timer is cleared and the listener is removed.
    canvasOverlay(editor.tree()).props.onClick({ clientX: 320, clientY: 240 });
    assert(takeCanvasCommand(editor, 'hitTest') !== null, 'the final pending command was not posted');
    assert(editor.loaded.runtime.timers.size > 0, 'a pending command did not have a settlement timer');
    editor.interactive.unmount();
    await settle();
    assert(editor.loaded.runtime.listeners.length === 0, 'the canvas left a message listener bound after unmount');
    assert(editor.loaded.runtime.timers.size === 0, `unmount left ${editor.loaded.runtime.timers.size} pending command timer(s); pending promises were not settled`);
  } finally {
    editor.interactive.unmount();
  }
});

test('P3-012 component: previewOnly hides every manual control and gesture surface', async () => {
  const hostFetch = canvasFetch({});
  const loaded = loadClient({ fetch: hostFetch, stageSize: { width: 1280, height: 720 } });
  const env = createFakeEnvironment();
  loaded.exports.apply(env.ctx);
  const canvasModule = extractCanvasModule(loaded);
  const firstInspected = await canvasModule.hostRequest('inspect', { projectId: 'proj-smoke' });
  const props = {
    t: translateFor(env),
    projectId: 'proj-smoke',
    inspected: firstInspected,
    previewOnly: true,
    onReload: async function reloadCanvas() {
      return firstInspected;
    },
    onError: function canvasError() {},
  };
  const interactive = loaded.react.renderInteractive(canvasModule.CanvasWorkspace, props);
  let currentTree = interactive.render();
  const editor = {
    loaded,
    env,
    interactive,
    props,
    tree: () => currentTree,
    rerender() {
      currentTree = interactive.rerender();
      return currentTree;
    },
  };
  try {
    for (let round = 0; round < 5; round += 1) {
      await settle();
      currentTree = interactive.rerender();
    }
    // R2: the first composition preloads as a hidden candidate; the revision
    // marker stays empty and the target marker names the requested revision.
    const pendingShell = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-canvas-shell');
    assert(pendingShell !== null, 'the preview-only shell is missing');
    assert(pendingShell.props['data-preview-only'] === 'true', 'the preview-only shell marker is missing');
    assert(pendingShell.props['data-canvas-phase'] === 'loading', `first-load phase is ${pendingShell.props['data-canvas-phase']}`);
    assert(pendingShell.props['data-canvas-revision'] === '', 'the active revision marker must be empty before the first ready composition');
    assert(pendingShell.props['data-canvas-target-revision'] === CANVAS_REVISION, 'the target revision marker is missing during preload');
    const hiddenCandidate = candidateIframe(editor);
    assert(hiddenCandidate !== null, 'the preloading candidate iframe is missing');
    assert(hiddenCandidate.props['aria-hidden'] === 'true', 'the candidate iframe is not aria-hidden');
    assert(hiddenCandidate.props.style.visibility === 'hidden', 'the candidate iframe is not visually hidden');
    assert(hiddenCandidate.props.style.pointerEvents === 'none', 'the candidate iframe can receive pointer input');
    await ensureCanvasActive(editor);
    const tree = editor.tree();
    const shell = findNode(tree, (node) => node.props && node.props.className === 'dv-canvas-shell');
    assert(shell.props['data-canvas-revision'] === CANVAS_REVISION, 'the promoted active revision marker is missing');
    assert(shell.props['data-canvas-target-revision'] === CANVAS_REVISION, 'the target revision marker is missing after promotion');
    assert(shell.props['data-canvas-phase'] === 'ready', `phase is ${shell.props['data-canvas-phase']} after promotion`);
    assert(activeIframe(editor) !== null, 'the active composition iframe is missing');
    assert(candidateIframe(editor) === null, 'the candidate iframe is still mounted after promotion');
    assert(findNode(tree, (node) => node.type === 'input' && node.props && node.props.className === 'dv-seek') !== null, 'the seek control is missing');
    assert(buttonByText(tree, translateFor(env)('video.canvas.play')) !== null, 'the play control is missing');
    const classes = findAll(tree, (node) => node.props && typeof node.props.className === 'string').map((node) => node.props.className);
    for (const forbidden of ['dv-overlay', 'dv-selection', 'dv-inline-editor', 'dv-drawer', 'dv-canvas-tools', 'dv-editor-actions']) {
      assert(classes.some((value) => value.split(/\s+/).includes(forbidden)) === false, `manual surface "${forbidden}" rendered in previewOnly`);
    }
    for (const key of ['video.canvas.undo', 'video.canvas.redo', 'video.canvas.addScene', 'video.canvas.export', 'video.canvas.sceneColor', 'video.canvas.textStyle']) {
      assert(buttonByText(tree, translateFor(env)(key)) === null, `manual control "${key}" rendered in previewOnly`);
    }
    // No user gesture exists that could issue a write.
    const writes = hostFetch.calls.filter((call) => ['edit', 'scene.create', 'scene.update', 'scene.remove', 'scene.reorder', 'render', 'asset.import', 'undo', 'redo'].includes(call.body.method));
    assert(writes.length === 0, `previewOnly issued write requests: ${writes.map((call) => call.body.method).join(',')}`);
  } finally {
    interactive.unmount();
  }
});

test('P3-008 wiring: the snapshot iframe keeps the composition viewport and is CSS-scaled', async () => {
  const stageSize = { width: 900, height: 400 };
  const hostFetch = canvasFetch({});
  const editor = await mountCanvasReady({ fetch: hostFetch, stageSize: stageSize });
  try {
    const tree = editor.tree();
    const frame = findNode(tree, (node) => node.props && node.props.className === 'dv-stage-frame');
    assert(frame !== null, 'snapshot iframe is missing');
    const scale = Math.min(stageSize.width / 1280, stageSize.height / 720);
    const style = frame.props.style || {};
    // The reviewed P3-005-B contract: composition coordinates are CSS pixels in
    // the iframe document viewport, so the element must stay at composition
    // size and be scaled visually by the host, never resized to the letterbox.
    assert(style.width === '1280px' && style.height === '720px', `the iframe viewport is not composition-sized: ${style.width}x${style.height}`);
    assert(style.transformOrigin === 'top left', 'the iframe transform origin is not top left');
    assert(style.transform === 'scale(' + scale + ')', `the iframe transform is not the stage scale: ${style.transform}`);
    const stage = findNode(
      tree,
      (node) => node.props && typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes('dv-canvas-stage')
    );
    assert(stage !== null, 'the canvas stage node is missing');
    assert(stage.props.style.width === 1280 * scale + 'px' && stage.props.style.height === 720 * scale + 'px', `the stage letterbox is wrong: ${stage.props.style.width}x${stage.props.style.height}`);
  } finally {
    editor.interactive.unmount();
  }
});

//#endregion

//#endregion

test('UI polish: project navigation uses readable names, retains distinct choices and creates only explicitly', async () => {
  const sessions = makeSessionsService({ list: ['session-polish'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-polish', sessions: ['session-polish'] });
  hostFetch.config.handler = (request) => {
    if (request.body.method === 'project.list') return { ok: true, result: { projects: [{ projectId: 'proj-smoke' }, { projectId: 'proj-second' }], defaultProjectId: 'proj-smoke' } };
    return undefined;
  };
  const editor = await mountBootedPanel(hostFetch, { sessions, kit: makeSessionKit() });
  let tree = editor.tree();
  const topbar = findNode(tree, (node) => node.props && node.props.className === 'dv-topbar');
  assert(topbar !== null, 'the topbar is missing');
  const nameButton = projectNameButton(topbar);
  assert(nameButton !== null, 'the inline project name is missing');
  assert(textOf(nameButton) === 'Scene 1', 'current project title is not read from inspect');
  assert(!textOf(topbar).includes('proj-smoke') && !textOf(topbar).includes('proj-second'), 'technical project IDs leak into visible navigation');
  assert(projectMenu(tree) === null, 'the project menu must start closed');
  projectToggle(tree).props.onClick();
  tree = editor.rerender();
  assert(projectMenu(tree) !== null, 'the project picker did not open');
  const items = projectMenuItems(tree);
  assert(items.length === 5, `expected two projects + folder actions + new-project action, got ${items.length}`);
  assert(items.some((item) => item.props['data-action'] === 'reveal') && items.some((item) => item.props['data-action'] === 'copy-path'), 'the folder actions are missing from project navigation');
  assert(items.some((item) => item.props.role === 'menuitemradio' && item.props['aria-checked'] === 'true' && textOf(item).includes('Scene 1')), 'the current project is not marked in the picker');
  assert(items.some((item) => item.props.role === 'menuitem' && textOf(item).includes('新建工程')), 'new project is not available inside project navigation');
  assert(!textOf(projectMenu(tree)).includes('proj-'), 'technical project IDs leak into the picker');
  assert(hostFetch.calls.filter((call) => call.body.method === 'project.create').length === 0, 'opening navigation created a project');
  const newItem = items.find((item) => item.props.role === 'menuitem' && textOf(item).includes('新建工程'));
  newItem.props.onClick();
  await settlePanel(editor);
  assert(hostFetch.calls.filter((call) => call.body.method === 'project.create').length === 1, 'explicit new-project selection did not create exactly one project');
});

test('UI polish: preview controls follow the stage and remain accessible without visible button copy', async () => {
  const hostFetch = sessionFetch({ activeSessionId: 'session-polish', sessions: ['session-polish'] });
  const editor = await mountBootedPanel(hostFetch, { sessions: makeSessionsService({ list: ['session-polish'] }), kit: makeSessionKit() });
  const shell = productCanvas(editor.tree());
  const children = shell.children.flat(Infinity).filter(Boolean);
  const stageIndex = children.findIndex((node) => node.props && node.props.className === 'dv-canvas-wrap');
  const controlsIndex = children.findIndex((node) => node.props && node.props.className === 'dv-canvas-bar');
  assert(stageIndex >= 0 && controlsIndex > stageIndex, 'playback controls are above the artwork');
  const controls = children[controlsIndex];
  const play = findNode(controls, (node) => node.type === 'button');
  assert(play.props['aria-label'] === translateFor(editor.env)('video.canvas.play'), 'icon-only playback has no accessible name');
  assert(findNode(play, (node) => node.type === 'svg') !== null, 'playback still uses a text-only button');
  const ai = findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-ai-head');
  assert(!textOf(ai).includes('proj-'), 'AI header repeats the technical project identity');
  assert(findNode(editor.tree(), (node) => node.props && node.props.className === 'dv-conversation') !== null, 'native conversation has no full-height layout boundary');
});

test('UI polish: a preview that never reports runtime ready becomes retryable and a late instance cannot promote', async () => {
  const hostFetch = sessionFetch({ activeSessionId: 'session-polish', sessions: ['session-polish'] });
  const editor = mountSessionEditor(hostFetch, { sessions: makeSessionsService({ list: ['session-polish'] }), kit: makeSessionKit(), previewTimeoutMs: 60 });
  await settlePanel(editor);
  const frame = findNode(editor.tree(), (node) => node.type === 'iframe');
  assert(frame !== null, 'candidate did not begin loading');
  const expiredFrame = runtimeFrameOf(editor, frame);
  // P3-017 B1: the ready budget expires the attempt, the automatic retry gets a
  // fresh snapshot, and only a second expiry surfaces the recoverable error.
  assert(await waitForPreviewPhase(editor, 'error'), 'preview remains in infinite loading: ' + productCanvas(editor.tree()).props['data-canvas-phase']);
  const diagnostics = previewDiagnosticEntries(editor);
  assert(diagnostics.length === 2, `the ready timeouts are not diagnosed: ${JSON.stringify(diagnostics)}`);
  assert(diagnostics.every((entry) => entry[4] === 'E_PREVIEW_TIMEOUT'), 'a ready timeout lost its error code');
  assert(diagnostics.every((entry) => entry[2] !== '-' && entry[3] !== '-'), 'the ready timeout diagnostic lost its snapshotMs/readyMs durations');
  const snapshotsForRevision = (hostFetch.config.snapshotRequests || []).filter((request) => request.revision === 'c'.repeat(64));
  assert(snapshotsForRevision.length >= 2, 'the expired attempt was not retried with a fresh snapshot');
  assert((hostFetch.config.releaseCalls || []).length >= 2, 'the expired candidate snapshots were not released');
  assert(findNode(editor.tree(), (node) => node.props && node.props.role === 'alert') !== null, 'timeout has no recoverable feedback');
  // A ready event from the discarded instance may never promote after the error.
  dispatchFrameEvent(editor, { frame: expiredFrame, type: 'ready', payload: { runtimeVersion: 'p3-012-runtime.1', width: 1280, height: 720, duration: 15 } });
  editor.rerender();
  assert(productCanvas(editor.tree()).props['data-canvas-phase'] === 'error', 'a late instance promoted after the timeout error');
  const retry = buttonByText(editor.tree(), translateFor(editor.env)('video.canvas.retry'));
  assert(retry !== null, 'timeout has no retry');
  retry.props.onClick();
  await settlePanel(editor);
  await ensureCanvasActive(editor);
  assert(productCanvas(editor.tree()).props['data-canvas-phase'] === 'ready', 'retry did not recover');
});

//#region tests: P3-017 B1/B2/B3
async function waitForValue(read, expected, timeoutMs, editor) {
  const deadline = Date.now() + (timeoutMs || 3000);
  while (Date.now() < deadline) {
    if (read() === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle();
    if (editor !== undefined && editor !== null) editor.rerender();
  }
  return read() === expected;
}

async function pumpPreview(editor, rounds, delayMs) {
  for (let index = 0; index < (rounds || 1); index += 1) {
    await settle();
    editor.rerender();
    await new Promise((resolve) => setTimeout(resolve, delayMs === undefined ? 80 : delayMs));
  }
}

test('P3-017 B1: published revisions are debounced, superseded snapshots are released, diagnostics stay bounded', async () => {
  const revisionA = 'c'.repeat(64);
  const revisionB = 'e'.repeat(64);
  const revisionC = 'f'.repeat(64);
  let published = revisionA;
  let snapshotSeq = 0;
  const snapshotIds = new Map();
  const snapshotRequests = [];
  const hostFetch = sessionFetch({ activeSessionId: 'session-b1-race', sessions: ['session-b1-race'] });
  hostFetch.config.handler = async (request) => {
    const method = request.body.method;
    if (method === 'inspect') return { ok: true, result: Object.assign(managedInspected(), { revision: published }) };
    if (method === 'preview.snapshot') {
      const revisionId = request.body.params.revision;
      snapshotRequests.push(request.body.params);
      snapshotSeq += 1;
      const snapshotId = ('b'.repeat(16) + String(snapshotSeq).padStart(16, '0')).slice(0, 32);
      snapshotIds.set(revisionId, snapshotId);
      const result = {
        snapshotId: snapshotId,
        projectId: request.body.params.projectId,
        revision: revisionId,
        entry: 'index.html',
        entryUrl: '/api/dsh-video/preview/' + 'b'.repeat(32) + '/index.html',
        routeBase: '/api/dsh-video/preview',
        files: [],
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      if (revisionId === revisionB) {
        // Keep the superseded revision's snapshot in flight long enough for a
        // newer revision to arrive.
        return new Promise((resolve) => setTimeout(() => resolve({ ok: true, result }), 2500));
      }
      return { ok: true, result };
    }
    return undefined;
  };
  const sessions = makeSessionsService({ list: ['session-b1-race'] });
  const editor = await mountBootedPanel(hostFetch, { sessions: sessions, kit: makeSessionKit() });
  assert(productCanvas(editor.tree()).props['data-canvas-revision'] === revisionA, 'the first revision is not active');
  published = revisionB;
  // The target marker is truthful immediately, but the snapshot waits for the
  // debounce window instead of racing every intermediate revision.
  assert(await waitForValue(() => productCanvas(editor.tree()).props['data-canvas-target-revision'], revisionB, 6000, editor), 'the poll did not name the published revision');
  assert(snapshotRequests.some((request) => request.revision === revisionB) === false, 'the revision was snapshotted before the debounce window elapsed');
  assert(await waitForValue(() => snapshotRequests.some((request) => request.revision === revisionB), true, 4000), 'the debounced snapshot was never requested');
  // Publish the next revision while the previous snapshot is still in flight.
  published = revisionC;
  assert(await waitForValue(() => productCanvas(editor.tree()).props['data-canvas-target-revision'], revisionC, 6000, editor), 'the second published revision was not followed');
  let candidate = null;
  assert(
    await (async function waitForLatestCandidate() {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        candidate = candidateIframe(editor);
        if (candidate !== null) return true;
        await pumpPreview(editor, 1, 60);
      }
      candidate = candidateIframe(editor);
      return candidate !== null;
    })(),
    'the latest revision was not preloaded as a candidate'
  );
  promoteCanvasCandidate(editor);
  const shell = productCanvas(editor.tree());
  assert(shell.props['data-canvas-revision'] === revisionC, 'the latest revision did not become active');
  assert(shell.props['data-canvas-phase'] === 'ready', 'the switched preview is not ready');
  assert(shell.props['data-preview-pending'] === 'false', 'the pending marker did not settle');
  // The superseded snapshot resolves after the switch: it must be released, not
  // left retained, and it must never replace the newer active composition.
  const supersededId = snapshotIds.get(revisionB);
  assert(typeof supersededId === 'string', 'the superseded snapshot was never requested');
  assert(
    await waitForValue(() => (hostFetch.config.releaseCalls || []).includes(supersededId), true, 8000),
    'the superseded snapshot was never released'
  );
  assert(productCanvas(editor.tree()).props['data-canvas-revision'] === revisionC, 'a late snapshot replaced the newer composition');
  assert(previewDiagnosticEntries(editor).length === 0, 'a successful revision race recorded failure diagnostics');
});

test('P3-017 B2: image and file clicks open the plugin overlay and never the native sidebar', async () => {
  const sessions = makeSessionsService({ list: ['session-img'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-img', sessions: ['session-img'] });
  const editor = mountSessionEditor(hostFetch, { sessions: sessions, kit: makeSessionKit() });
  await settle();
  editor.rerender();
  await settle();
  const aside = clickCaptureNode(editor.tree());
  function clickImage(src) {
    let prevented = 0;
    let stopped = 0;
    aside.props.onClickCapture({
      target: interactiveTarget({ selector: 'img[src]', attributes: { src: src } }),
      preventDefault() { prevented += 1; },
      stopPropagation() { stopped += 1; },
    });
    assert(prevented === 1 && stopped === 1, `image click was not intercepted: ${src.slice(0, 24)}`);
  }
  function previewImageNode(tree) {
    return findNode(tree, (node) => node.props && node.props.className === 'dv-preview-image');
  }
  // 1. A browser-owned data: image renders directly, with no Host read.
  clickImage('data:image/png;base64,AAAA');
  await settle();
  let tree = editor.rerender();
  let image = previewImageNode(tree);
  assert(findNode(tree, (node) => node.props && node.props.className === 'dv-preview') !== null, 'the data: image preview did not open');
  assert(image !== null && image.props.src === 'data:image/png;base64,AAAA', 'the data: image did not render its own source');
  assert((hostFetch.config.previewCalls || []).length === 0, 'a data: image was sent through the Host file reader');
  closePreviewTree(tree);
  tree = editor.rerender();
  // 2. A blob: URL from the native chat (the file was already loaded) renders directly.
  clickImage('blob:http://dsh.internal/2f0e4d3c');
  await settle();
  tree = editor.rerender();
  image = previewImageNode(tree);
  assert(image !== null && image.props.src === 'blob:http://dsh.internal/2f0e4d3c', 'the blob image did not render its own source');
  assert((hostFetch.config.previewCalls || []).length === 0, 'a blob image was sent through the Host file reader');
  closePreviewTree(tree);
  tree = editor.rerender();
  // 3. A remote image already loaded by the chat stays browser-owned.
  clickImage('https://example.com/frame.png');
  await settle();
  tree = editor.rerender();
  image = previewImageNode(tree);
  assert(image !== null && image.props.src === 'https://example.com/frame.png', 'the remote image did not render its own source');
  assert((hostFetch.config.previewCalls || []).length === 0, 'a remote image was sent through the Host file reader');
  closePreviewTree(tree);
  tree = editor.rerender();
  // 4. A workspace-relative image path uses the existing bounded Host preview route.
  clickImage('.dsh-video-frames/latest.png');
  await settle();
  tree = editor.rerender();
  image = previewImageNode(tree);
  assert(image !== null && image.props.src === 'data:image/png;base64,AAAA', 'the relative image path did not render the Host preview');
  const calls = hostFetch.config.previewCalls || [];
  assert(calls.length === 1, `expected one Host preview call, got ${calls.length}`);
  assert(calls[0].projectId === 'proj-smoke' && calls[0].sessionId === 'session-img', 'the Host preview is not Session/project scoped');
  assert(calls[0].path === '.dsh-video-frames/latest.png', `the relative frame path was not forwarded unchanged: ${calls[0].path}`);
  closePreviewTree(tree);
  tree = editor.rerender();
  // 5. A normal chat click is still not intercepted.
  let prevented = 0;
  aside.props.onClickCapture({
    target: interactiveTarget({ selector: null }),
    preventDefault() { prevented += 1; },
    stopPropagation() {},
  });
  await settle();
  assert(prevented === 0 && (hostFetch.config.previewCalls || []).length === 1, 'a normal chat click was intercepted by the image path');
});

test('P3-022: DSH ToolRow fileLink summaries open the local preview instead of the native sidebar', async () => {
  const sessions = makeSessionsService({ list: ['session-toolrow'] });
  const hostFetch = sessionFetch({ activeSessionId: 'session-toolrow', sessions: ['session-toolrow'] });
  const editor = mountSessionEditor(hostFetch, { sessions: sessions, kit: makeSessionKit() });
  await settle();
  editor.rerender();
  await settle();
  const aside = clickCaptureNode(editor.tree());
  const previewCalls = () => hostFetch.config.previewCalls || [];
  function click(target) {
    let prevented = 0;
    let stopped = 0;
    aside.props.onClickCapture({
      target: target,
      preventDefault() { prevented += 1; },
      stopPropagation() { stopped += 1; },
    });
    return { prevented: prevented, stopped: stopped };
  }
  function previewImage(tree) {
    return findNode(tree, (node) => node.props && node.props.className === 'dv-preview-image');
  }
  function openPreviewTree() {
    const tree = editor.rerender();
    assert(findNode(tree, (node) => node.props && node.props.className === 'dv-preview') !== null, 'the click did not open the local preview overlay');
    return tree;
  }

  // 1. Real collapsed ToolRow shape (current DSH chat bundle): a button with a
  // CSS-module class such as Q2dzhW_fileLink, no title/data-* path attribute,
  // and a TextShimmer child whose text is "<title> · <path>". The click target
  // is the inner span (closest() resolves the fileLink button eventually).
  let outcome = click(richTarget({ selectors: ['[class*="fileLink"]'], text: '读取图片 · .dsh-video-frames/latest.png' }));
  assert(outcome.prevented === 1 && outcome.stopped === 1, 'the ToolRow fileLink click was not intercepted, so native openFile/sidebarRight would run');
  await settle();
  let tree = openPreviewTree();
  let image = previewImage(tree);
  assert(image !== null && image.props.src === 'data:image/png;base64,AAAA', 'the ToolRow fileLink did not render the bounded Host preview');
  assert(previewCalls().length === 1, `expected one Host preview call, got ${previewCalls().length}`);
  assert(previewCalls()[0].path === '.dsh-video-frames/latest.png', `the ToolRow summary path was not forwarded unchanged: ${previewCalls()[0].path}`);
  assert(previewCalls()[0].projectId === 'proj-smoke' && previewCalls()[0].sessionId === 'session-toolrow', 'the ToolRow preview is not Session/project scoped');
  closePreviewTree(tree);
  tree = editor.rerender();

  // 2. The same summary shape with an absolute path.
  outcome = click(richTarget({ selectors: ['[class*="fileLink"]'], text: '读取图片 · /tmp/p3-022-toolrow.png' }));
  assert(outcome.prevented === 1 && outcome.stopped === 1, 'the absolute-path ToolRow fileLink click was not intercepted');
  await settle();
  tree = openPreviewTree();
  image = previewImage(tree);
  assert(image !== null, 'the absolute-path ToolRow fileLink did not open the local preview');
  assert(previewCalls().length === 2 && previewCalls()[1].path === '/tmp/p3-022-toolrow.png', `the absolute ToolRow path was not forwarded: ${JSON.stringify(previewCalls()[1])}`);
  closePreviewTree(tree);
  tree = editor.rerender();

  // 3. A normal button with the same middle-dot text but no fileLink class is
  // still a normal chat click: it must not be intercepted.
  outcome = click(richTarget({ selectors: ['button[data-no-path]'], text: '读取图片 · .dsh-video-frames/latest.png' }));
  assert(outcome.prevented === 0 && outcome.stopped === 0, 'a normal chat button with middle-dot text was intercepted');
  await settle();
  assert(previewCalls().length === 2, 'a normal chat button opened a file preview');
  assert(previewImage(editor.rerender()) === null, 'a normal chat button opened the preview overlay');

  // 4. A fileLink anchor exposes its real href; the anchor path wins unchanged.
  outcome = click(richTarget({ selectors: ['a[href]', '[class*="fileLink"]'], attributes: { href: 'file:///tmp/output/photo.png' }, text: '读取图片 · photo.png' }));
  assert(outcome.prevented === 1 && outcome.stopped === 1, 'the fileLink anchor click was not intercepted');
  await settle();
  tree = openPreviewTree();
  assert(previewCalls().length === 3 && previewCalls()[2].path === 'file:///tmp/output/photo.png', `the fileLink anchor address was not forwarded unchanged: ${JSON.stringify(previewCalls()[2])}`);
  closePreviewTree(tree);
  tree = editor.rerender();

  // 5. An image inside a fileLink container takes the browser-owned image branch
  // first: no Host read and no native opener.
  const callsBeforeImage = previewCalls().length;
  outcome = click(richTarget({ selectors: ['img[src]', '[class*="fileLink"]'], attributes: { src: 'blob:http://dsh.internal/toolrow-image' }, text: '读取图片 · .dsh-video-frames/latest.png' }));
  assert(outcome.prevented === 1 && outcome.stopped === 1, 'the image inside a fileLink container was not intercepted');
  await settle();
  tree = openPreviewTree();
  image = previewImage(tree);
  assert(image !== null && image.props.src === 'blob:http://dsh.internal/toolrow-image', 'the image branch did not win inside a fileLink container');
  assert(previewCalls().length === callsBeforeImage, 'an image inside a fileLink container was sent through the Host file reader');
});

test('P3-017 B3: product export binds the clicked revision and reports stage/progress, cancel and download', async () => {
  const revisionA = 'c'.repeat(64);
  const revisionB = 'e'.repeat(64);
  let published = revisionA;
  const renderCalls = [];
  const statusCalls = [];
  const cancelCalls = [];
  let slowCancelled = false;
  const hostFetch = sessionFetch({ activeSessionId: 'session-export', sessions: ['session-export'] });
  hostFetch.config.handler = async (request) => {
    const method = request.body.method;
    if (method === 'inspect') return { ok: true, result: Object.assign(managedInspected(), { revision: published }) };
    if (method === 'render') {
      const params = request.body.params;
      renderCalls.push(params);
      const index = renderCalls.length;
      if (index === 3) return { ok: false, error: { code: 'E_RENDER', message: 'render start failed' } };
      const jobId = index === 1 ? 'job-fast' : 'job-slow';
      return { ok: true, result: { jobId: jobId, projectId: params.projectId, revision: params.revision, kind: 'render', state: 'queued', stage: 'snapshot', progress: 0 } };
    }
    if (method === 'status') {
      const jobId = request.body.params.jobId;
      statusCalls.push(jobId);
      if (jobId === 'job-fast') {
        const count = statusCalls.filter((id) => id === 'job-fast').length;
        const result = {
          jobId: jobId,
          projectId: 'proj-smoke',
          revision: revisionA,
          kind: 'render',
          state: 'running',
          stage: count >= 2 ? 'capture' : 'snapshot',
          progress: count >= 2 ? 0.5 : 0,
        };
        if (count >= 3) {
          result.state = 'succeeded';
          result.stage = 'finished';
          result.progress = 1;
          result.artifact = {
            projectId: 'proj-smoke',
            revision: revisionA,
            jobId: jobId,
            name: jobId + '.mp4',
            hash: 'a'.repeat(64),
            bytes: 2048,
            metadata: { duration: 15, width: 1280, height: 720, fps: 30, codec_name: 'h264' },
          };
        }
        return { ok: true, result: result };
      }
      return {
        ok: true,
        result: {
          jobId: jobId,
          projectId: 'proj-smoke',
          revision: revisionB,
          kind: 'render',
          state: slowCancelled ? 'cancelled' : 'running',
          stage: slowCancelled ? 'finished' : 'capture',
          progress: slowCancelled ? 0 : 0.3,
        },
      };
    }
    if (method === 'cancel') {
      cancelCalls.push(request.body.params.jobId);
      if (request.body.params.jobId === 'job-slow') slowCancelled = true;
      return {
        ok: true,
        result: { jobId: request.body.params.jobId, projectId: 'proj-smoke', revision: revisionB, kind: 'render', state: 'cancelling', stage: 'capture', progress: 0.3 },
      };
    }
    return undefined;
  };
  const sessions = makeSessionsService({ list: ['session-export'] });
  const editor = await mountBootedPanel(hostFetch, { sessions: sessions, kit: makeSessionKit() });
  const t = translateFor(editor.env);
  function exportButton(tree) {
    return buttonByText(tree, t('video.canvas.export'));
  }
  assert(exportButton(editor.tree()) !== null, 'the topbar export button is missing');
  // Two clicks in the same tick must start exactly one render.
  exportButton(editor.tree()).props.onClick();
  exportButton(editor.tree()).props.onClick();
  await settle();
  editor.rerender();
  assert(renderCalls.length === 1, `a double click started ${renderCalls.length} renders`);
  assert(renderCalls[0].revision === revisionA, 'the export is not bound to the inspected revision');
  assert(renderCalls[0].timeoutMs === 300000, `the render timeout is not the shared client budget: ${renderCalls[0].timeoutMs}`);
  // Drive the fake job while observing the real rendered stage/progress state.
  const observedStages = new Set();
  const observedProgress = new Set();
  let sawElapsed = false;
  const ready = await (async function pumpUntilReady() {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      await settle();
      const tree = editor.rerender();
      const status = findNode(tree, (node) => node.props && typeof node.props.className === 'string' && node.props.className.includes('dv-export-status'));
      if (status !== null) {
        observedStages.add(status.props['data-export-stage']);
        if (status.props['data-export-progress'] !== '') observedProgress.add(status.props['data-export-progress']);
        if (textOf(status).includes('已用')) sawElapsed = true;
      }
      if (panelRoot(tree).props['data-export'] === 'ready') return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return false;
  })();
  assert(ready, 'the export never reached the ready state');
  assert(observedStages.has('capture'), `the capture stage was never rendered: ${JSON.stringify([...observedStages])}`);
  assert(observedProgress.has('50'), `the worker progress was never rendered: ${JSON.stringify([...observedProgress])}`);
  assert(sawElapsed, 'the elapsed time was never rendered');
  let tree = editor.tree();
  const link = findNode(tree, (node) => node.props && typeof node.props.className === 'string' && node.props.className.includes('dv-export-link'));
  assert(link !== null, 'the download link is missing after a successful export');
  assert(link.props.href === 'api/dsh-video/artifact?jobId=job-fast', `unexpected download href: ${link.props.href}`);
  assert(link.props.download === 'Scene 1.mp4', `the download filename is not the project title: ${link.props.download}`);
  assert(panelRoot(tree).props['data-export'] === 'ready', 'the ready export marker is missing');
  assert(panelRoot(tree).props['data-export-revision'] === revisionA, 'the ready export lost its binding revision');
  // A later published revision never rewrites the finished/running export binding.
  published = revisionB;
  assert(
    await waitForValue(() => productCanvas(editor.tree()).props['data-canvas-target-revision'], revisionB, 6000, editor),
    'the next published revision was not followed'
  );
  assert(panelRoot(editor.tree()).props['data-export-revision'] === revisionA, 'the finished export followed a later published revision');
  assert(panelRoot(editor.tree()).props['data-export'] === 'ready', 'a later revision disturbed the finished export state');
  // A repeat export binds the CURRENT revision (B was never exported yet).
  exportButton(editor.tree()).props.onClick();
  await settle();
  tree = editor.rerender();
  assert(renderCalls.length === 2, 'the repeat export did not start a second render');
  assert(renderCalls[1].revision === revisionB, `the repeat export is not bound to the current revision: ${renderCalls[1].revision.slice(0, 4)}`);
  // Cancel while running: the control is responsive and the terminal state is honest.
  const cancelButton = findNode(tree, (node) => node.props && typeof node.props.className === 'string' && node.props.className.includes('dv-export-cancel'));
  assert(cancelButton !== null, 'the running export has no cancel control');
  cancelButton.props.onClick();
  let cancelled = false;
  for (let round = 0; round < 80; round += 1) {
    await settle();
    tree = editor.rerender();
    if (panelRoot(tree).props['data-export'] === 'cancelled') {
      cancelled = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert(cancelled, 'the cancelled export did not settle into the cancelled state');
  assert(cancelCalls.includes('job-slow'), 'the running render job was not cancelled on the Host');
  assert(textOf(tree).includes(t('video.export.cancelled')), 'the cancelled export has no honest copy');
  // A rejected render start surfaces the explicit error plus a retry affordance.
  assert(exportButton(editor.tree()) !== null, 'the export cannot be retried after a cancel');
  exportButton(editor.tree()).props.onClick();
  let failed = false;
  for (let round = 0; round < 60; round += 1) {
    await settle();
    tree = editor.rerender();
    if (panelRoot(tree).props['data-export'] === 'error') {
      failed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert(failed, 'a rejected render did not surface the error state');
  assert(textOf(tree).includes(t('video.canvas.exportFailed')), 'the export error has no honest copy');
  assert(exportButton(editor.tree()) !== null, 'the export error has no retry affordance');
});
//#endregion

test('V1 M2: product material library loads scoped metadata and exposes import/filter/search', async()=>{
  const hostFetch=canvasFetch({});
  hostFetch.config.handler=request=> request.body.method==='asset.list' ? {ok:true,result:{assets:[{assetId:'as_12345678',name:'Example movie',kind:'video',bytes:100,media:{durationSec:1,width:64,height:64}}],nextCursor:null,total:1}} : undefined;
  const loaded=loadClient({fetch:hostFetch}); const env=createFakeEnvironment();loaded.exports.apply(env.ctx);
  const component=extractCanvasModule(loaded).MediaLibraryPanel;
  assert(typeof component==='function','Media library component missing');
  const mounted=loaded.react.renderInteractive(component,{t:translateFor(env),projectId:'proj-smoke',onClose:()=>{}});
  mounted.render();await new Promise(resolve=>setTimeout(resolve,200));const tree=mounted.render();
  assert(textOf(tree).includes('Example movie'),'Imported media metadata is missing');
  assert(findNode(tree,n=>n.type==='input'&&n.props.type==='file')!==null,'File picker missing');
  assert(findNode(tree,n=>n.type==='input'&&n.props.type==='search')!==null,'Search missing');
});

test('V1 M2: a thumbnail finishing during a filter change remains visible',async()=>{
  const hostFetch=canvasFetch({});let completeDerive;
  hostFetch.config.handler=request=>{
    if(request.body.method==='asset.list')return {ok:true,result:{assets:[{assetId:'as_12345678',name:'Example movie',kind:'video',bytes:100,media:{durationSec:1}}],nextCursor:null,total:1}};
    if(request.body.method==='asset.derive')return new Promise(resolve=>{completeDerive=()=>resolve({ok:true,result:{ready:true}});});
  };
  const loaded=loadClient({fetch:hostFetch});const env=createFakeEnvironment();loaded.exports.apply(env.ctx);
  const component=extractCanvasModule(loaded).MediaLibraryPanel;
  const mounted=loaded.react.renderInteractive(component,{t:translateFor(env),projectId:'proj-smoke',onClose:()=>{}});
  mounted.render();await new Promise(resolve=>setTimeout(resolve,200));let tree=mounted.render();await new Promise(resolve=>setTimeout(resolve,10));
  assert(typeof completeDerive==='function','Background thumbnail request missing');
  buttonByText(tree,translateFor(env)('video.media.video')).props.onClick();mounted.render();
  await new Promise(resolve=>setTimeout(resolve,200));mounted.render();completeDerive();await new Promise(resolve=>setTimeout(resolve,20));tree=mounted.render();
  assert(findNode(tree,n=>n.type==='img'&&String(n.props.src).includes('derived'))!==null,'Completed thumbnail disappeared after filter change');
});

async function runTests() {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passes.push(name);
      console.log(`PASS  ${name}`);
    } catch (error) {
      failures.push([name, error instanceof Error ? error.message : String(error)]);
      console.error(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // The product panel polls the revision every 1.5s; a test that leaves a panel
  // mounted must not keep Node alive or fire after the run finished.
  for (const runtime of RUNTIMES) {
    for (const handle of runtime.timers) clearTimeout(handle);
    for (const handle of runtime.intervals) clearInterval(handle);
    runtime.timers.clear();
    runtime.intervals.clear();
    runtime.listeners.length = 0;
  }
  console.log(`\n${passes.length} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
