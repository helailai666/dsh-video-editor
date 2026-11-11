/** Real Chrome + actual component + actual media Host/worker, temporary data only. */
import { closeTestBrowser } from './lib/browser-cleanup.mjs';
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { VideoBridge } from "../host/bridge.js";
import { createMediaRoute } from "../host/media-routes.js";
import { createRequestRoute } from "../host/routes.js";
import { loadStagedHost } from "./lib/staged-host.mjs";
import { pathToFileURL } from "node:url";
import { WorkerClient } from "../packages/video-engine-client/src/index.mjs";
const require = createRequire(
  resolve("packages/video-engine-worker/package.json"),
);
const puppeteer = require("puppeteer-core");
const stagingArg = process.argv.indexOf("--staging"),
  staging = stagingArg >= 0 ? resolve(process.argv[stagingArg + 1]) : null,
  staged = staging ? await loadStagedHost(staging) : null;
const Bridge = staged ? staged.VideoBridge : VideoBridge;
const requestRoute = staged
  ? (await import(pathToFileURL(join(staging, "bundle/host/routes.js")).href))
      .createRequestRoute
  : createRequestRoute;
const mediaRoute = staged
  ? (
      await import(
        pathToFileURL(join(staging, "bundle/host/media-routes.js")).href
      )
    ).createMediaRoute
  : createMediaRoute;

const root = await mkdtemp(join(tmpdir(), "m2-browser-"));
const out = resolve(process.argv[2] || "/tmp/m2-browser-evidence");
await mkdir(out, { recursive: true });
let bridge, browser, server;
const publicRoutes = new Map(),
  fetchRoutes = new Map();
const errors = [];
let checks = 0;
try {
  const config = staged
    ? {
        ...staged.config,
        dataRoot: join(root, "data"),
        legacyDataRoots: [staging],
        requestTimeoutMs: 120000,
      }
    : {
        workerNode: process.execPath,
        workerEntry: resolve("packages/video-engine-worker/src/worker.mjs"),
        workerCwd: root,
        registryPath: join(root, "old-registry.json"),
        artifactRoot: join(root, "old-output"),
        allowedProjects: ["demo"],
        dataRoot: join(root, "data"),
        legacyDataRoots: [],
        requestTimeoutMs: 120000,
      };
  bridge = new Bridge({
    ctx: {
      connection: {
        fetch: {
          register: (r) => {
            fetchRoutes.set(r.path, r);
            return () => fetchRoutes.delete(r.path);
          },
        },
      },
      webServer: {
        register: (r) => {
          publicRoutes.set(r.path, r);
          return () => publicRoutes.delete(r.path);
        },
      },
      logger: { warn() {} },
      subprocess: { resolveExecutable: async (command) => command },
    },
    rawConfig: config,
    ...(staged
      ? {}
      : {
          engineLoader: async () => ({
            WorkerClient,
            workerEntry: config.workerEntry,
            clientVersion: "0.8.0",
            workerVersion: "0.8.0",
          }),
        }),
  });
  bridge.snapshots.webServer = {
    register: (r) => {
      publicRoutes.set(r.path, r);
      return () => publicRoutes.delete(r.path);
    },
  };
  const created = await bridge.invoke(
    "project.create",
    { templateId: "product-launch-v1", title: "Media library test" },
    { source: "http" },
  );
  const projectId = created.projectId;
  const source = await readFile(
    staging ? join(staging, "bundle/client.js") : "client.js",
    "utf8",
  );
  const body = source.slice(
    source.indexOf("    //#region constants"),
    source.indexOf("    //#region plugin"),
  );
  const css = source.match(/const CSS = `([\s\S]*?)`;/)[1];
  const lite = (
    await readFile("scripts/lib/react-dom-lite.mjs", "utf8")
  ).replace(
    "export { React, createElement, createRoot, createPortal, flushSync, pendingWork };",
    "window.ReactLite={React,createElement,createRoot};",
  );
  const initial = await bridge.invoke(
    "timeline.inspect",
    { projectId },
    { source: "http" },
  );
  const video = join(root, "timeline.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=20",
    ...(process.env.VISUALS_ACCEPTANCE==='1'?["-f","lavfi","-i","sine=frequency=440:duration=20"]:[]),
    "-c:v",
    "libx264",
    ...(process.env.VISUALS_ACCEPTANCE==='1'?["-c:a","aac","-shortest"]:[]),
    video,
  ]);
  const receipt = await bridge.uploadAsset(
    new Request(
      "http://local/api/dsh-video/asset-upload?projectId=" + projectId,
      {
        method: "POST",
        headers: {
          "content-type": "video/mp4",
          "x-dsh-project-id": projectId,
          "x-dsh-file-name": "timeline.mp4",
        },
        body: await readFile(video),
      },
    ),
  );
  const uploaded = await receipt.json();
  assert.equal(receipt.status, 200, JSON.stringify(uploaded));
  const imported = await bridge.invoke(
    "asset.importMedia",
    {
      projectId,
      operationId: "import",
      receiptId: uploaded.receiptId ?? uploaded.result?.receiptId,
    },
    { source: "http" },
  );
  await bridge.invoke(
    "timeline.apply",
    {
      projectId,
      expectedRevision: initial.revision,
      operationId: "insert",
      ops: [
        { op: "clip.delete", clipId: initial.tracks[0].clips[0].clipId },
        {
          op: "clip.insert",
          trackId: "tr_v1",
          assetId: imported.asset.assetId,
          startFrame: 0,
        },
      ],
    },
    { source: "http" },
  );
  const padded=await bridge.invoke('timeline.inspect',{projectId});
  await bridge.invoke('timeline.apply',{projectId,expectedRevision:padded.revision,operationId:'legacy-fixed-padding',ops:[{op:'timeline.settings',durationFrames:660,durationMode:'fixed'}]});
  const inspected = await bridge.invoke(
    "inspect",
    { projectId },
    { source: "http" },
  );
  const js = `const Module=(function(require){${body}\nreturn {CanvasWorkspace,ZH};})(()=>ReactLite.React);const h=ReactLite.createElement;function App(){const [project,setProject]=ReactLite.React.useState(${JSON.stringify(inspected)});window.seek=value=>{const input=document.querySelector('.dv-seek');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};return h(Module.CanvasWorkspace,{projectId:${JSON.stringify(projectId)},t:k=>Module.ZH[k]||k,inspected:project,previewOnly:true,onReload:window.reloadTimelineProject=async()=>{const response=await fetch('/api/dsh-video/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'inspect',params:{projectId:${JSON.stringify(projectId)}}})});const value=await response.json();setProject(value.result);},onError:()=>{}});}const root=ReactLite.createRoot(document.getElementById('mount'));root.render(h(App));`;
  const referenceJs=`const Module=(function(require){${body}\nreturn {ReferencePanel,ZH};})(()=>ReactLite.React);const h=ReactLite.createElement;function App(){const [open,setOpen]=ReactLite.React.useState(true);return h('div',{className:'dv-ai',style:{width:'100%',height:'100%'}},h('header',{className:'dv-ai-head'},h('strong',null,'AI 创作'),h('button',{'data-panel-trigger':'references',onClick:()=>setOpen(!open)},'引用')),h('button',{id:'reference-outside',style:{position:'absolute',bottom:'10px'}},'对话输入区'),open?h(Module.ReferencePanel,{projectId:${JSON.stringify(projectId)},t:k=>Module.ZH[k]||k,onClose:()=>setOpen(false)}):null);}ReactLite.createRoot(document.getElementById('mount')).render(h(App));`;


  const routes = [
    requestRoute(bridge),
    mediaRoute(bridge),
    mediaRoute(bridge, true),
  ];
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/" || url.pathname === "/references") {
        res.setHeader("content-type", "text/html");
        res.end(
          '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;background:#19191b;color:#eee;font:14px -apple-system,sans-serif}#mount{position:relative;width:800px;height:700px}' +
            css +
            '</style><div class="dv-root" id="mount"></div><script src="/lite.js"></script><script src="'+(url.pathname==='/references'?'/reference-page.js':'/page.js')+'"></script></html>',
        );
        return;
      }
      if (url.pathname === "/lite.js" || url.pathname === "/page.js" || url.pathname === "/reference-page.js") {
        res.setHeader("content-type", "text/javascript");
        res.end(url.pathname === "/lite.js" ? lite : url.pathname === "/reference-page.js" ? referenceJs : js);
        return;
      }
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (publicRoutes.has(url.pathname)) {
        await publicRoutes.get(url.pathname).handler(req, res);
        return;
      }
      const route =
        fetchRoutes.get(url.pathname) ||
        routes.find((r) => r.path === url.pathname);
      if (!route && url.pathname !== "/api/dsh-video/asset-upload") {
        res.writeHead(404);
        res.end();
        return;
      }
      const request = new Request("http://127.0.0.1" + req.url, {
        method: req.method,
        headers: req.headers,
        ...(["GET", "HEAD"].includes(req.method)
          ? {}
          : { body: Readable.toWeb(req), duplex: "half" }),
      });
      const response =
        url.pathname === "/api/dsh-video/asset-upload"
          ? await bridge.uploadAsset(request)
          : await route.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const stream = Readable.fromWeb(response.body);
        res.on("close", () => stream.destroy());
        stream.on("error", (error) => {
          if (!["ABORT_ERR", "ERR_STREAM_PREMATURE_CLOSE"].includes(error.code))
            errors.push(error.message);
          res.destroy();
        });
        stream.pipe(res);
      } else res.end();
    } catch (e) {
      res.writeHead(500);
      res.end("test server error");
      errors.push(e.message);
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  browser = await puppeteer.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  if(process.env.M4_AUDIO==='1')page.on('console',msg=>{if(/AudioContext|autoplay|Permissions/.test(msg.text()))console.log('[audio-console]',msg.text());});
  await page.setViewport({ width: 900, height: 760 });
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.waitForSelector(".dv-canvas-shell[data-canvas-phase=ready]");
  await page.waitForSelector(".dv-timeline-clip");
  await page.waitForFunction(()=>[...document.querySelectorAll('.dv-filmstrip img')].filter(x=>x.naturalWidth>0).length>=2);
  assert.ok(await page.$$eval('.dv-filmstrip img',xs=>new Set(xs.map(x=>x.src)).size>1));checks++;
  await page.waitForFunction(()=>document.querySelector('.dv-timeline')?.getAttribute('aria-busy')==='false'&&document.querySelector('.dv-timeline')?.dataset.durationMode==='auto');
  await page.evaluate(()=>{const m=document.getElementById('mount');m.style.transform='translateX(48px)';m.style.width='680px';});
  const contextTarget=await page.$('.dv-timeline-clip');const contextRect=await contextTarget.boundingBox();
  const contextPoint={x:contextRect.x+100,y:contextRect.y+25};
  await page.mouse.click(contextPoint.x,contextPoint.y,{button:'right'});
  await page.waitForSelector('.dv-timeline-more[open]');
  const contextBounds=await page.$eval('.dv-timeline-menu',e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
  assert.ok(Math.min(Math.abs(contextBounds.left-contextPoint.x),Math.abs(contextBounds.right-contextPoint.x))<=8,JSON.stringify({contextPoint,contextBounds}));
  assert.ok(Math.min(Math.abs(contextBounds.top-contextPoint.y),Math.abs(contextBounds.bottom-contextPoint.y))<=8,JSON.stringify({contextPoint,contextBounds}));
  assert.ok(contextBounds.left>=8&&contextBounds.right<=892&&contextBounds.top>=8&&contextBounds.bottom<=752);checks++;
  await page.keyboard.press('Escape');
  const trackRect=await (await page.$('.dv-track-name-text')).boundingBox();
  const trackPoint={x:trackRect.x+10,y:trackRect.y+8};
  await page.mouse.click(trackPoint.x,trackPoint.y,{button:'right'});
  await page.waitForSelector('.dv-track-menu-title');
  const trackBounds=await page.$eval('.dv-timeline-menu',e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
  assert.ok(Math.min(Math.abs(trackBounds.left-trackPoint.x),Math.abs(trackBounds.right-trackPoint.x))<=8,JSON.stringify({trackPoint,trackBounds}));
  assert.ok(Math.min(Math.abs(trackBounds.top-trackPoint.y),Math.abs(trackBounds.bottom-trackPoint.y))<=8,JSON.stringify({trackPoint,trackBounds}));checks++;
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{const m=document.getElementById('mount');m.style.transform='';m.style.width='800px';});
  if(process.env.VISUALS_ACCEPTANCE==='1'){
    const before=await bridge.invoke('timeline.inspect',{projectId});
    const original=before.tracks[0].clips[0];
    const time=await page.$eval('.dv-seek',e=>Number(e.value));
    await page.click('[data-clip-id="'+original.clipId+'"]',{button:'right'});
    for(const button of await page.$$('.dv-timeline-menu button'))if(await button.evaluate(e=>e.textContent)==='关闭视频原声')await button.click();
    await page.waitForFunction(id=>document.querySelector('[data-clip-id="'+id+'"]')?.classList.contains('is-muted'),{},original.clipId);
    assert.equal(await page.$eval('[data-clip-id="'+original.clipId+'"]',e=>!!e.querySelector('.dv-clip-envelope')),true,'Ordinary mute retains waveform');checks++;
    await page.click('button[aria-label="撤销"]');
    await page.waitForFunction(id=>!document.querySelector('[data-clip-id="'+id+'"]')?.classList.contains('is-muted'),{},original.clipId);
    await page.click('[data-clip-id="'+original.clipId+'"]',{button:'right'});
    await page.waitForSelector('.dv-timeline-more[open]');
    assert.equal(await page.$eval('.dv-seek',e=>Number(e.value)),time);checks++;
    await page.waitForFunction(()=>[...document.querySelectorAll('.dv-timeline-menu button')].some(b=>b.textContent==='分离音频'&&!b.disabled));
    assert.equal(await page.$$eval('.dv-timeline-menu button',xs=>xs.some(x=>x.textContent==='关闭视频原声')),true);
    const detach=await page.$('.dv-timeline-menu button');assert.equal(await detach.evaluate(e=>e.textContent),'分离音频');await detach.click();
    await page.waitForFunction(()=>document.querySelector('.dv-timeline-clip.is-audio.is-selected'));
    await page.waitForFunction(()=>!document.querySelector('.dv-timeline-more[open]'));
    const after=await bridge.invoke('timeline.inspect',{projectId});const audio=after.tracks.flatMap(t=>t.clips).find(c=>c.detachedFrom===original.clipId);
    assert.equal(after.tracks[0].clips[0].muted,true);assert.equal(audio.durationFrames,original.durationFrames);assert.equal(audio.assetId,original.assetId);checks++;
    await page.waitForFunction(()=>[...document.querySelectorAll('.dv-clip-envelope')].some(x=>x.width>0&&x.getContext('2d').getImageData(0,0,x.width,x.height).data.some((v,i)=>i%4===3&&v>0)));
    const videoSelector='[data-clip-id="'+original.clipId+'"]';
    assert.equal(await page.$eval(videoSelector,e=>!!e.querySelector('.dv-clip-envelope')),false,'Detached video must hide its waveform');
    assert.equal(await page.$eval(videoSelector,e=>e.querySelector('.dv-clip-visuals').classList.contains('has-original-audio')),false,'Detached video must reclaim waveform space');checks++;
    await page.click(videoSelector,{button:'right'});
    await page.waitForSelector('.dv-timeline-menu');
    const enableOriginal=await page.$$('.dv-timeline-menu button');
    for(const button of enableOriginal)if(await button.evaluate(e=>e.textContent)==='开启视频原声')await button.click();
    await page.waitForFunction(sel=>!!document.querySelector(sel+' .dv-clip-envelope'),{},videoSelector);checks++;
    await page.click('button[aria-label="撤销"]');
    await page.waitForFunction(sel=>!document.querySelector(sel+' .dv-clip-envelope'),{},videoSelector);
    await page.screenshot({path:join(out,'detached-audio.png')});checks++;
    await page.click('button[aria-label="撤销"]');await page.waitForFunction(()=>!document.querySelector('.dv-timeline-clip.is-audio'));
    const undone=await bridge.invoke('timeline.inspect',{projectId});assert.equal(undone.tracks[0].clips[0].muted,original.muted);await page.waitForSelector(videoSelector+' .dv-clip-envelope');checks++;
    await page.click('button[aria-label="重做"]');await page.waitForFunction(()=>document.querySelector('.dv-timeline-clip.is-audio'));
    const redone=await bridge.invoke('timeline.inspect',{projectId});assert.equal(redone.tracks.flatMap(t=>t.clips).find(c=>c.detachedFrom===original.clipId).clipId,audio.clipId);checks++;
    await page.click('button[aria-label="撤销"]');await page.waitForFunction(()=>!document.querySelector('.dv-timeline-clip.is-audio'));
    await page.waitForFunction(()=>document.querySelector('.dv-timeline').getAttribute('aria-busy')==='false');
  }
  await page.waitForSelector('.dv-timeline[data-duration-mode="auto"][data-duration-frames="600"]');
  await page.waitForFunction(()=>document.querySelector('.dv-time').textContent.includes('/ 20.00'));
  await page.waitForNetworkIdle({idleTime:500,timeout:15000});
  await page.evaluate(()=>document.getElementById('mount').style.width='799px');
  await page.waitForNetworkIdle({idleTime:500,timeout:15000});
  const coverage=await page.$eval('.dv-clip-visuals',el=>{const r=el.getBoundingClientRect(),bands=[...el.querySelectorAll('.dv-filmstrip')].filter(x=>x.children.length).map(x=>x.getBoundingClientRect());return {left:Math.min(...bands.map(x=>x.left))-r.left,right:r.right-Math.max(...bands.map(x=>x.right)),width:r.width};});
  assert.ok(coverage.left<=2&&coverage.right<=2,JSON.stringify(coverage));checks++;
  await page.evaluate(()=>document.getElementById('mount').style.width='800px');
  await page.waitForNetworkIdle({idleTime:500,timeout:15000});
  await page.evaluate(()=>{window.visualTilesBefore=document.querySelectorAll('.dv-filmstrip img').length;window.visualMinTiles=window.visualTilesBefore;window.visualObserver=new MutationObserver(()=>{window.visualMinTiles=Math.min(window.visualMinTiles,document.querySelectorAll('.dv-filmstrip img').length);});window.visualObserver.observe(document.querySelector('.dv-timeline'),{childList:true,subtree:true});});
  await page.click('.dv-play');await page.waitForFunction(()=>Number(document.querySelector('.dv-seek').value)>.2);await page.click('.dv-play');
  await page.waitForNetworkIdle({idleTime:500,timeout:15000});
  const preserved=await page.evaluate(()=>{window.visualObserver.disconnect();return {before:window.visualTilesBefore,min:window.visualMinTiles};});
  assert.ok(preserved.min>=preserved.before,JSON.stringify(preserved));checks++;
  await page.evaluate(()=>window.seek(0));

  await page.waitForFunction(()=>document.querySelector('.dv-timeline').getAttribute('aria-busy')==='false');
  assert.equal((await bridge.invoke('timeline.inspect',{projectId})).settings.durationFrames,600);checks++;
  checks++;
  assert.equal(await page.$$eval('.dv-canvas-bar button',xs=>xs.some(x=>x.textContent==='素材')),false,'playback bar must not contain the media entry');
  assert.equal(await page.$eval('.dv-resource-bar button[aria-label="素材"]',e=>e.getAttribute('aria-expanded')),'false');
  if(process.env.VISUALS_ACCEPTANCE!=='1')assert.equal(await page.$eval('.dv-timeline-notice',e=>getComputedStyle(e).display).catch(()=> 'none'),'none','idle timeline has no permanent instruction footer');checks++;
  assert.equal(await page.$$eval('.dv-track-mute',xs=>xs.every(x=>x.querySelector('svg')&&!x.textContent.trim())),true,'track sound actions use icons, not ambiguous letters');checks++;
  assert.equal(await page.$$('.dv-track-visibility').then(xs=>xs.length),1,'video tracks expose a picture toggle');checks++;
  await page.click('.dv-track-visibility');
  assert.equal((await bridge.invoke('timeline.inspect',{projectId})).tracks[0].hidden,true);checks++;
  await page.waitForFunction(()=>document.querySelector('.dv-track-visibility')?.getAttribute('aria-pressed')==='false');
  await page.waitForFunction(()=>document.querySelector('.dv-timeline').getAttribute('aria-busy')==='false');
  await page.click('.dv-track-visibility');
  await page.waitForFunction(()=>document.querySelector('.dv-track-visibility')?.getAttribute('aria-pressed')==='true');
  await page.click('.dv-timeline-more > summary');
  await page.click('.dv-time');
  assert.equal(await page.$eval('.dv-timeline-more',e=>e.open),false,'outside click dismisses edit menu');checks++;
  await page.click('.dv-timeline-more > summary');
  assert.deepEqual(await page.$$eval('.dv-timeline-menu button',xs=>xs.map(e=>e.textContent).filter(x=>!['分离音频','关闭视频原声'].includes(x))),['复制片段','与前一片段交换','与后一片段交换','添加视频轨','添加音轨','紧凑轨道','删除轨道']);checks++;
  assert.equal(await page.$$eval('.dv-timeline-menu button',xs=>xs.find(e=>e.textContent==='与前一片段交换').disabled),true);
  const editMenu=await page.$eval('.dv-timeline-menu',e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight};});
  assert(editMenu.top>=0&&editMenu.bottom<=editMenu.height,'all menu actions fit in viewport');checks++;
  await page.screenshot({path:join(out,'edit-menu.png')});
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.dv-timeline-more',e=>e.open),false);checks++;
  await page.click('.dv-track-name-text',{button:'right'});
  await page.waitForFunction(()=>document.querySelector('.dv-timeline-more').open);
  assert.equal(await page.$eval('.dv-track-menu-title',e=>e.textContent),'视频轨 1');checks++;
  await page.click('.dv-track-remove');
  await page.waitForSelector('.dv-track-delete-confirm');
  const removalBefore=(await bridge.invoke('timeline.inspect',{projectId})).revision;
  await clickMenuCancel();
  assert.equal((await bridge.invoke('timeline.inspect',{projectId})).revision,removalBefore);checks++;
  await page.click('.dv-timeline-more > summary');await page.click('.dv-track-remove');
  await page.waitForSelector('.dv-track-delete-confirm',{timeout:3000}).catch(async e=>{console.log('delete-debug',await page.$eval('.dv-timeline',n=>({text:n.textContent,html:n.innerHTML.slice(0,5000)})));throw e;});
  await page.click('.dv-track-delete-confirm button:last-child');
  await page.waitForFunction(()=>!document.querySelector('.dv-timeline-track'));
  assert.equal((await bridge.invoke('timeline.inspect',{projectId})).totalClips,0);checks++;
  await page.click('.dv-timeline-toolbar .dv-timeline-tool[aria-label="撤销"]');
  await page.waitForSelector('.dv-timeline-clip');
  await page.waitForFunction(()=>document.querySelector('.dv-timeline').getAttribute('aria-busy')==='false');checks++;
  await page.waitForFunction(()=>document.querySelector('.dv-canvas-shell').dataset.previewPending==='false'&&document.querySelector('.dv-time').textContent.includes('/ 20.00'));
  async function clickMenuCancel(){await page.click('.dv-track-delete-confirm button:first-of-type');await page.waitForFunction(()=>!document.querySelector('.dv-track-delete-confirm'));}
  await page.click('.dv-play');await page.waitForFunction(()=>document.querySelector('.dv-play').getAttribute('aria-label')==='暂停');
  const scrubRevision=(await bridge.invoke('timeline.inspect',{projectId})).revision;
  const ruler=await page.$eval('.dv-timeline-ruler',e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};});
  await page.mouse.move(ruler.x+ruler.width*.2,ruler.y+12);await page.mouse.down();
  await page.waitForFunction(()=>document.querySelector('.dv-play').getAttribute('aria-label')==='播放');checks++;
  await page.mouse.move(ruler.x+ruler.width*.4,ruler.y+12,{steps:8});
  await page.waitForFunction(x=>Math.abs(parseFloat(document.querySelector('.dv-timeline-playhead').style.left)-x)<2,{timeout:2000},156+ruler.width*.4).catch(async e=>{console.log('scrub-geometry',await page.$eval('.dv-timeline-playhead',n=>({left:n.style.left,time:document.querySelector('.dv-time').textContent,ruler:document.querySelector('.dv-timeline-ruler').getBoundingClientRect().width,scroll:document.querySelector('.dv-timeline-scroll').clientWidth,duration:document.querySelector('.dv-timeline').dataset.durationFrames,zoom:document.querySelector('.dv-timeline-zoom').value})),ruler);throw e;});checks++;
  await page.mouse.move(ruler.x+ruler.width*.65,ruler.y+22,{steps:8});
  await page.waitForFunction(x=>Math.abs(parseFloat(document.querySelector('.dv-timeline-playhead').style.left)-x)<2,{},156+ruler.width*.65);
  assert.equal(await page.evaluate(()=>getSelection().toString()),'');checks++;
  await (await page.$('.dv-timeline')).screenshot({path:join(out,'playhead-dragging.png')});
  await page.mouse.up();
  const head=await page.$eval('.dv-timeline-playhead',e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+7};});
  await page.mouse.move(head.x,head.y);await page.mouse.down();await page.mouse.move(ruler.x+ruler.width*.3,ruler.y+45,{steps:8});
  await page.waitForFunction(x=>Math.abs(parseFloat(document.querySelector('.dv-timeline-playhead').style.left)-x)<2,{},156+ruler.width*.3);checks++;
  await page.mouse.up();assert.equal((await bridge.invoke('timeline.inspect',{projectId})).revision,scrubRevision);checks++;
  const headPoint=()=>page.$eval('.dv-timeline-playhead',e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+7,left:parseFloat(e.style.left)};});
  let handle=await headPoint();await page.mouse.move(handle.x,handle.y);await page.mouse.down();await page.mouse.move(0,ruler.y+40,{steps:6});
  await page.waitForFunction(()=>parseFloat(document.querySelector('.dv-timeline-playhead').style.left)===156);
  await page.mouse.move(899,ruler.y+40,{steps:6});await page.mouse.up();
  assert.equal(Number(await page.$eval('.dv-timeline-playhead',e=>e.getAttribute('aria-valuenow'))),20);checks++;
  handle=await headPoint();await page.mouse.move(handle.x,handle.y);await page.mouse.down();await page.mouse.move(ruler.x+ruler.width*.4,ruler.y+12,{steps:6});
  await page.keyboard.press('Escape');await page.mouse.up();await page.waitForFunction(()=>document.querySelector('.dv-timeline').dataset.scrubbing==='false');
  assert(Math.abs((await headPoint()).left-handle.left)<2);checks++;
  await page.focus('.dv-timeline-playhead');await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>Number(document.querySelector('.dv-timeline-playhead').getAttribute('aria-valuenow'))===1/30);checks++;
  await page.$eval('.dv-timeline-zoom',e=>{e.value='80';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.$eval('.dv-timeline-scroll',e=>{e.scrollLeft=200;});
  let scrolled=await page.$eval('.dv-timeline-ruler',e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y};});
  await page.mouse.move(300,scrolled.y+12);await page.mouse.down();await page.$eval('.dv-timeline-scroll',e=>{e.scrollLeft+=120;});await page.mouse.move(340,scrolled.y+12);
  const expectedScrollTime=await page.$eval('.dv-timeline-ruler',e=>Math.round((340-e.getBoundingClientRect().left)/80*30)/30);
  await page.waitForFunction(t=>Math.abs(Number(document.querySelector('.dv-timeline-playhead').getAttribute('aria-valuenow'))-t)<1/30,{},expectedScrollTime);await page.mouse.up();checks++;
  const edge=await page.$eval('.dv-timeline-scroll',e=>({right:e.getBoundingClientRect().right,left:e.scrollLeft}));
  await page.mouse.move(edge.right-2,scrolled.y+12);await page.mouse.down();await page.waitForFunction(x=>document.querySelector('.dv-timeline-scroll').scrollLeft>x+8,{},edge.left);await page.mouse.up();checks++;
  await page.click('button[aria-label="适应时间线"]');await page.$eval('.dv-timeline-scroll',e=>{e.scrollLeft=0;});

  // ── Range scoring selection: ruler drag, range bar, keyboard, stale clear ──
  const rangeReadRevision=(await bridge.invoke('timeline.inspect',{projectId})).revision;
  await page.click('button[aria-label="框选配乐"]');
  assert.equal(await page.$eval('.dv-timeline',e=>e.dataset.rangeMode),'true');checks++;
  await page.mouse.move(ruler.x+ruler.width*.2,ruler.y+12);await page.mouse.down();
  await page.waitForFunction(()=>document.querySelector('.dv-timeline').dataset.rangeSelecting==='true');checks++;
  await page.mouse.move(ruler.x+ruler.width*.5,ruler.y+12,{steps:6});
  await page.mouse.up();
  await page.waitForFunction(()=>!!document.querySelector('.dv-range-bar'));
  const draftRange=await page.$eval('.dv-timeline-range',e=>({left:parseFloat(e.style.left),width:parseFloat(e.style.width)}));
  assert(draftRange.width>2&&draftRange.left>156,'range overlay must sit inside the ruler area');checks++;
  // Ruler scrub stays paused in range mode: the playhead never moved here.
  assert.equal((await bridge.invoke('timeline.inspect',{projectId})).revision,rangeReadRevision,'range selection writes nothing');checks++;
  // Numeric edit to an exact 2.00-6.00 second range (frames 60-180).
  await page.evaluate(()=>{const set=(el,v)=>{const proto=Object.getPrototypeOf(el);const desc=Object.getOwnPropertyDescriptor(proto,'value');desc.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};set(document.querySelector('.dv-range-bar input[aria-label="选区起点（秒）"]'),'2');set(document.querySelector('.dv-range-bar input[aria-label="选区终点（秒）"]'),'6');[...document.querySelectorAll('.dv-range-bar .dv-button')].find(b=>b.textContent==='区间').click();});
  await page.waitForFunction(()=>document.querySelector('.dv-range-bar .dv-range-label').textContent.includes('2.00–6.00'));checks++;
  const committedRange=await page.$eval('.dv-timeline-range',e=>({left:parseFloat(e.style.left),width:parseFloat(e.style.width)}));
  assert(committedRange.width>0);checks++;
  // Sending the range to the conversation needs a scene note first.
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.dv-range-bar .dv-button')].find(b=>b.textContent==='发送到聊天').disabled),true,'an empty scene note must not enable sending');checks++;
  await page.evaluate(()=>{const set=(el,v)=>{const proto=Object.getPrototypeOf(el);const desc=Object.getOwnPropertyDescriptor(proto,'value');desc.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};set(document.querySelector('.dv-range-bar .dv-range-note'),'对立、对抗节奏');});
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.dv-range-bar .dv-button')].find(b=>b.textContent==='发送到聊天').disabled),false,'a scene note enables the send action');checks++;
  // The click reports honestly through the Host session path (no silent success).
  await page.evaluate(()=>[...document.querySelectorAll('.dv-range-bar .dv-button')].find(b=>b.textContent==='发送到聊天').click());
  await page.waitForFunction(()=>document.querySelector('.dv-range-bar')&&[...document.querySelectorAll('.dv-timeline [role="status"]')].some(p=>p.textContent.length>0));checks++;
  // An invalid range keeps the committed selection and warns instead of writing.
  await page.evaluate(()=>{const set=(el,v)=>{const proto=Object.getPrototypeOf(el);const desc=Object.getOwnPropertyDescriptor(proto,'value');desc.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};set(document.querySelector('.dv-range-bar input[aria-label="选区终点（秒）"]'),'0');[...document.querySelectorAll('.dv-range-bar .dv-button')].find(b=>b.textContent==='区间').click();});
  await page.waitForFunction(()=>[...document.querySelectorAll('.dv-timeline [role="status"]')].some(p=>p.textContent.includes('有效范围')));
  assert.equal(await page.$eval('.dv-range-bar .dv-range-label',e=>e.textContent).includes('2.00–6.00'),true,'invalid input must not corrupt the committed range');checks++;
  // Clearing removes the bar and overlay; a new drag recreates them.
  await page.evaluate(()=>[...document.querySelectorAll('.dv-range-bar .dv-button')].find(b=>b.textContent==='清除选区').click());
  await page.waitForFunction(()=>!document.querySelector('.dv-range-bar')&&!document.querySelector('.dv-timeline-range'));checks++;
  await page.mouse.move(ruler.x+ruler.width*.3,ruler.y+12);await page.mouse.down();await page.mouse.move(ruler.x+ruler.width*.35,ruler.y+12,{steps:4});
  await page.keyboard.press('Escape');await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('.dv-timeline').dataset.rangeSelecting==='false');
  assert.equal(await page.$('.dv-range-bar'),null,'Escape cancels the in-flight range gesture without committing');checks++;
  // Turning range mode off restores ruler scrubbing.
  await page.click('button[aria-label="框选配乐"]');
  assert.equal(await page.$eval('.dv-timeline',e=>e.dataset.rangeMode),'false');
  await page.mouse.move(ruler.x+ruler.width*.2,ruler.y+12);await page.mouse.down();
  await page.waitForFunction(()=>document.querySelector('.dv-timeline').dataset.scrubbing==='true');await page.mouse.up();checks++;
  assert.equal((await bridge.invoke('timeline.inspect',{projectId})).revision,rangeReadRevision,'range gestures never write the project');checks++;

  const middle=await page.$eval('.dv-timeline-clip',e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width*.6,y:r.y+r.height/2};});
  await page.mouse.click(middle.x,middle.y);
  await page.waitForFunction(()=>Math.abs(Number(document.querySelector('.dv-seek').value)-12)<.1,{timeout:3000}).catch(async e=>{console.log('click-time-debug',middle,await page.$eval('.dv-timeline',n=>({seek:document.querySelector('.dv-seek').value,head:n.querySelector('.dv-timeline-playhead').style.left,clip:n.querySelector('.dv-timeline-clip').outerHTML.slice(0,450)})));throw e;});checks++;
  const contextTime=await page.$eval('.dv-seek',e=>Number(e.value));
  await page.mouse.click(middle.x,middle.y,{button:'right'});
  assert.equal(await page.$eval('.dv-seek',e=>Number(e.value)),contextTime);await page.keyboard.press('Escape');checks++;
  const blankTail=await page.$eval('.dv-timeline-lane',e=>{const lane=e.getBoundingClientRect(),clip=e.querySelector('.dv-timeline-clip').getBoundingClientRect();return {x:clip.right+8,y:lane.y+lane.height/2};});
  await page.mouse.click(blankTail.x,blankTail.y);
  await page.waitForFunction(()=>Number(document.querySelector('.dv-seek').value)===20);checks++;
  const snapRevision=(await bridge.invoke('timeline.inspect',{projectId})).revision;
  const snapAppearance=()=>page.$eval('.dv-snap-toggle',e=>({background:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color}));
  const enabledSnap=await snapAppearance();await page.click('.dv-snap-toggle');const disabledSnap=await snapAppearance();
  assert.notEqual(enabledSnap.background,disabledSnap.background,'snap must have a clearly different active surface');
  assert.notEqual(enabledSnap.color,disabledSnap.color);checks++;
  await page.focus('.dv-snap-toggle input');await page.keyboard.press('Space');
  assert.equal(await page.$eval('.dv-snap-toggle input',e=>e.checked),true);assert.equal((await bridge.invoke('timeline.inspect',{projectId})).revision,snapRevision);checks++;
  // Regression: a resource popup must close on outside click, not occupy the full stage.
  await page.click('.dv-resource-tab[aria-label="素材"]');
  await page.waitForSelector('.dv-media-library');
  await page.screenshot({path:join(out,'media-panel-dark.png')});
  await page.evaluate(()=>document.getElementById('mount').style.cssText+=';--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202126;--dsw-alias-label-secondary:#70747c;--dsw-alias-interactive-bg-hover:#f0f2f4;--dsw-alias-border-l1:#dfe1e5;color:#202126');
  await page.screenshot({path:join(out,'media-panel-light.png')});
  const mediaBounds=await page.$eval('.dv-media-library',e=>({height:e.getBoundingClientRect().height,bottom:getComputedStyle(e).bottom}));
  assert(mediaBounds.height<580,'sparse media content must not stretch to timeline');checks++;
  await page.click('.dv-time');
  assert.equal(await page.$('.dv-media-library'),null,'outside click dismisses the media panel');checks++;
  await page.click('.dv-resource-tab[aria-label="素材"]');
  await page.waitForSelector('.dv-media-library');
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('.dv-media-library'));checks++;
  await page.evaluate(()=>document.getElementById('mount').style.cssText='');
  await page.click('.dv-timeline-clip');
  assert.equal(await page.$eval('.dv-timeline-clip',e=>{const r=e.getBoundingClientRect();return !!document.elementFromPoint(r.left+3,r.top+r.height/2)?.closest('.dv-timeline-edge');}),true);checks++;
  assert.equal(await page.$eval('.dv-clip-settings',e=>e.open),false,'clip properties stay collapsed after selection');
  await page.click('.dv-clip-settings summary');
  assert.equal(await page.$eval('.dv-timeline-inspector',e=>e.getBoundingClientRect().height>0),true);
  await page.focus('.dv-clip-settings summary');await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.dv-clip-settings',e=>e.open),false);checks++;
  await page.setViewport({width:340,height:760});await page.evaluate(()=>document.getElementById('mount').style.width='100%');
  await page.waitForFunction(()=>{const el=document.querySelector('.dv-timeline-scroll');return el.scrollWidth<=el.clientWidth+1;});
  await page.click('.dv-clip-settings summary');
  assert.equal(await page.$eval('.dv-timeline-inspector',e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),true);checks++;
  await page.click('.dv-clip-settings summary');
  await page.setViewport({width:900,height:760});await page.evaluate(()=>document.getElementById('mount').style.width='800px');

  const clickText = async (text) => {
    await page.waitForFunction(
      (text) => {
        const b = [...document.querySelectorAll("button")].find(
          (x) => x.textContent === text,
        );
        return b && !b.disabled;
      },
      {},
      text,
    );
    await page.evaluate(
      (text) =>
        [...document.querySelectorAll("button")]
          .find((x) => x.textContent === text)
          .click(),
      text,
    );
  };
  const count = async (n) =>
    page.waitForFunction(
      (n) => document.querySelectorAll(".dv-timeline-clip").length === n,
      {},
      n,
    );
  // Reproduce the user's exact fixed-20s split (532 + 68 frames), in this disposable project.
  {
    const get=()=>bridge.invoke('timeline.inspect',{projectId}),wait=()=>page.waitForFunction(()=>document.querySelector('.dv-timeline').getAttribute('aria-busy')==='false');
    let t=await get();
    await bridge.invoke('timeline.apply',{projectId,expectedRevision:t.revision,operationId:'move-audit-setup',ops:[{op:'timeline.settings',durationFrames:600,durationMode:'fixed'},{op:'clip.split',clipId:t.tracks[0].clips[0].clipId,atFrame:532},{op:'track.add',kind:'video'}]});
    t=await get();const top=t.tracks[0].trackId,lower=t.tracks[1].trackId,long=t.tracks[0].clips[0].clipId,short=t.tracks[0].clips[1].clipId;
    await bridge.invoke('timeline.apply',{projectId,expectedRevision:t.revision,operationId:'move-audit-short-lower',ops:[{op:'clip.move',clipId:short,trackId:lower,startFrame:54}]});
    await page.evaluate(()=>window.reloadTimelineProject());
    await page.waitForFunction(id=>!!document.querySelector('[data-track-id="'+id+'"] [data-clip-id]'),{},lower);await wait();
    if(await page.$eval('.dv-snap-toggle input',e=>e.checked))await page.click('.dv-snap-toggle');
    const baseline=await get(),sourceShort=baseline.tracks[1].clips[0];
    async function hold(id,trackId,start){
      const state=await get(),clip=state.tracks.flatMap(x=>x.clips).find(x=>x.clipId===id),box=await(await page.$('[data-clip-id="'+id+'"]')).boundingBox(),lane=await(await page.$('[data-track-id="'+trackId+'"]')).boundingBox(),z=box.width/(clip.durationFrames/30),offset=Math.min(30,box.width/2);
      await page.mouse.move(box.x+offset,box.y+box.height/2);await page.mouse.down();await page.mouse.move(lane.x+start/30*z+offset,lane.y+lane.height/2,{steps:8});
      await page.waitForFunction(x=>Math.abs(Number(document.querySelector('.dv-drop-preview')?.dataset.startFrame)-Math.max(0,x))<=2,{},start);
    }
    async function undoMove(){await clickText('撤销');await wait();await page.waitForFunction(id=>Number(document.querySelector('[data-clip-id="'+id+'"]').getAttribute('aria-pressed'))!==-1,{},long);}
    for(const [id,target,start,end]of [[short,top,540,608],[long,lower,159,691]]){
      const before=await get();await hold(id,target,start);
      assert.equal(await page.$eval('.dv-drop-preview',e=>Number(e.dataset.nextDuration)),end);
      assert.equal((await get()).revision,before.revision);
      await page.screenshot({path:join(out,id===short?'move-short-end-held.png':'move-long-end-held.png')});
      await page.mouse.up();await wait();t=await get();
      assert.equal(t.settings.durationFrames,end);assert.equal(t.tracks.find(x=>x.trackId===target).clips.find(x=>x.clipId===id).startFrame,start);
      const moved=t.tracks.flatMap(x=>x.clips).find(x=>x.clipId===id),original=baseline.tracks.flatMap(x=>x.clips).find(x=>x.clipId===id);
      for(const k of ['sourceInFrame','durationFrames','speed','assetId'])assert.equal(moved[k],original[k]);
      await undoMove();assert.equal((await get()).settings.durationFrames,600);checks++;
    }
    await hold(short,lower,180);await page.mouse.up();await wait();t=await get();assert.equal(t.tracks[1].clips[0].startFrame,180);assert.equal(t.settings.durationFrames,532);assert.equal(t.tracks[0].clips[0].startFrame,0);await undoMove();checks++;
    await hold(short,lower,-10);await page.mouse.up();await wait();assert.equal((await get()).tracks[1].clips[0].startFrame,0);await undoMove();checks++;
    await page.click('.dv-snap-toggle');await hold(short,top,530);
    assert.equal(await page.$eval('.dv-drop-preview',e=>Number(e.dataset.startFrame)),532);
    await page.mouse.up();await wait();t=await get();assert.equal(t.settings.durationFrames,600);assert.equal(t.tracks[0].clips.find(x=>x.clipId===short).startFrame,532);await undoMove();checks++;
    // A held pointer at the right edge scrolls continuously; the committed frame includes that scroll.
    await page.click('.dv-snap-toggle');
    await page.$eval('.dv-timeline-zoom',e=>{e.value='100';e.dispatchEvent(new Event('input',{bubbles:true}));});
    const box=await(await page.$('[data-clip-id="'+long+'"]')).boundingBox(),view=await(await page.$('.dv-timeline-scroll')).boundingBox();
    await page.mouse.move(box.x+15,box.y+box.height/2);await page.mouse.down();await page.mouse.move(view.x+view.width-8,box.y+box.height/2,{steps:8});
    await page.waitForFunction(()=>document.querySelector('.dv-timeline-scroll').scrollLeft>40);
    const scrolled=await page.$eval('.dv-timeline-scroll',e=>e.scrollLeft);assert(scrolled>40);
    await page.mouse.up();await wait();t=await get();assert(t.tracks[0].clips.find(x=>x.clipId===long).startFrame>180);assert(t.settings.durationFrames>600);await undoMove();checks++;
    await clickText('适应时间线');
    // Vertical edge scrolling reaches tracks below the visible scroll area.
    t=await get();await bridge.invoke('timeline.apply',{projectId,expectedRevision:t.revision,operationId:'move-audit-scroll-tracks',ops:Array.from({length:4},()=>({op:'track.add',kind:'video'}))});
    await page.evaluate(()=>window.reloadTimelineProject());await page.waitForFunction(()=>document.querySelectorAll('.dv-timeline-lane').length===6);await wait();
    const firstBox=await(await page.$('[data-clip-id="'+long+'"]')).boundingBox(),v=await(await page.$('.dv-timeline-scroll')).boundingBox();
    await page.mouse.move(firstBox.x+15,firstBox.y+firstBox.height/2);await page.mouse.down();await page.mouse.move(firstBox.x+15,v.y+v.height-8,{steps:8});
    await page.waitForFunction(()=>document.querySelector('.dv-timeline-scroll').scrollTop>50);
    await page.keyboard.press('Escape');await page.mouse.up();assert.equal((await get()).totalClips,2);checks++;
    // Undo only test setup; production user projects are never involved.
    for(let i=0;i<3;i++){t=await get();await bridge.invoke('timeline.undo',{projectId,expectedRevision:t.revision,operationId:'move-audit-cleanup-'+i});}
    await page.evaluate(()=>window.reloadTimelineProject());await page.waitForFunction(()=>document.querySelectorAll('.dv-timeline-lane').length===1&&document.querySelectorAll('.dv-timeline-clip').length===1);await wait();
    if(!(await page.$eval('.dv-snap-toggle input',e=>e.checked)))await page.click('.dv-snap-toggle');
  }
  await page.click(".dv-timeline-clip");
  await page.evaluate(() => window.seek(5));
  await clickText("切分");
  await count(2);
  checks++;
  await page.waitForFunction(
    () =>
      document.querySelector(".dv-canvas-shell").dataset.previewPending ===
        "false" &&
      ![...document.querySelectorAll("button")].find(
        (x) => x.textContent === "切分",
      ).disabled,
  );
  await page.evaluate(() => window.seek(3));
  await clickText("切分");
  await count(3);
  checks++;
  const ids = await page.$$eval(".dv-timeline-clip", (els) =>
    els.map((x) => x.dataset.clipId),
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".dv-timeline").getAttribute("aria-busy") ===
      "false",
  );
  const second = await (
      await page.$('[data-clip-id="' + ids[1] + '"]')
    ).boundingBox(),
    first = await (
      await page.$('[data-clip-id="' + ids[0] + '"]')
    ).boundingBox();
  const sameTrackBefore=await bridge.invoke('timeline.inspect',{projectId});
  await page.mouse.move(second.x+15,second.y+second.height/2);await page.mouse.down();
  await page.mouse.move(first.x+15,first.y+first.height/2,{steps:8});
  assert.equal(await page.$('.dv-timeline-lane.is-drop-invalid').then(Boolean),true,'same-track overlap must not silently reorder other clips');
  await page.mouse.up();
  assert.equal((await bridge.invoke('timeline.inspect',{projectId})).revision,sameTrackBefore.revision);checks++;
  await page.click('[data-clip-id="' + ids[1] + '"]');
  await page.click(".dv-timeline-more > summary");
  await clickText("与前一片段交换");
  assert.equal(await page.$eval(".dv-timeline-more",e=>e.open),false);checks++;
  await page.waitForFunction(
    (id) => document.querySelector(".dv-timeline-clip").dataset.clipId === id,
    {},
    ids[1],
  );
  checks++;
  await clickText("撤销");
  await page.waitForFunction(
    (id) => document.querySelector(".dv-timeline-clip").dataset.clipId === id,
    {},
    ids[0],
  );
  checks++;
  await clickText("重做");
  await page.waitForFunction(
    (id) => document.querySelector(".dv-timeline-clip").dataset.clipId === id,
    {},
    ids[1],
  );
  checks++;
  await page.click(".dv-timeline-more > summary");
  await clickText("复制片段");
  await count(4);
  checks++;
  await clickText("删除");
  await count(3);
  checks++;
  await page.click(".dv-timeline-more > summary");
  await clickText("添加视频轨");
  await page.waitForFunction(
    () => document.querySelectorAll(".dv-timeline-track").length === 2,
  );
  checks++;
  await page.waitForFunction(
    () =>
      document.querySelector(".dv-timeline").getAttribute("aria-busy") ===
      "false",
  );
  await page.click(".dv-timeline-clip");
  const trim = await page.$(".dv-timeline-edge-out");
  const oldTrim = await trim.evaluate((el) =>
    Number(el.getAttribute("aria-valuenow")),
  );
  await trim.focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(
    (value) =>
      Number(
        document
          .querySelector(".dv-timeline-edge-out")
          .getAttribute("aria-valuenow"),
      ) === value,
    {},
    oldTrim - 1,
  );
  checks++;
  await page.waitForFunction(
    () =>
      document.querySelector(".dv-timeline").getAttribute("aria-busy") ===
      "false",
  );
  const movingId = await page.$eval(
    ".dv-timeline-clip",
    (el) => el.dataset.clipId,
  );
  const from = await (await page.$(".dv-timeline-clip")).boundingBox();
  const dest = await (await page.$$(".dv-timeline-lane"))[1].boundingBox();
  await page.mouse.move(from.x + 15, from.y + from.height / 2);
  await page.mouse.down();
  const beforeLift=await bridge.invoke('timeline.inspect',{projectId});
  await page.mouse.move(from.x + 15, dest.y + dest.height / 2, { steps: 8 });
  const lifted=await page.$eval('[data-clip-id="'+movingId+'"]',el=>({y:el.getBoundingClientRect().y,lifted:el.classList.contains('is-dragging')}));
  assert(lifted.y>from.y+20 && lifted.lifted,'clip must visibly follow vertical pointer movement before release');
  assert.equal(await page.$eval('.dv-timeline-lane.is-drop-target',e=>e.dataset.trackId),beforeLift.tracks[1].trackId);
  assert.equal(await page.$$('.dv-drag-origin').then(x=>x.length),1);
  assert.equal(await page.$$('.dv-drop-preview').then(x=>x.length),1);
  assert.equal((await bridge.invoke('timeline.inspect',{projectId})).revision,beforeLift.revision,'drag preview must not write project data');checks++;
  await page.screenshot({path:join(out,'cross-track-held.png')});
  await page.mouse.up();
  await page.waitForFunction(
    (id) =>
      document
        .querySelectorAll(".dv-timeline-lane")[1]
        .querySelector('[data-clip-id="' + id + '"]') !== null,
    {},
    movingId,
  );
  checks++;
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".dv-timeline-toolbar button")].find(
        (x) => x.textContent === "撤销",
      ).disabled === false,
  );
  const landed=await bridge.invoke('timeline.inspect',{projectId});
  const overlapSource=await (await page.$('.dv-timeline-lane [data-clip-id]:not([data-clip-id="'+movingId+'"])')).boundingBox();
  const occupied=await (await page.$('[data-clip-id="'+movingId+'"]')).boundingBox();
  await page.mouse.move(overlapSource.x+15,overlapSource.y+overlapSource.height/2);await page.mouse.down();
  await page.mouse.move(occupied.x+15,occupied.y+occupied.height/2,{steps:6});
  assert.equal(await page.$('.dv-timeline-lane.is-drop-invalid').then(Boolean),true,'overlapping cross-track destination is visibly rejected');
  await page.mouse.up();assert.equal((await bridge.invoke('timeline.inspect',{projectId})).revision,landed.revision);checks++;
  await clickText("撤销");
  await page.waitForFunction(
    (id) =>
      document
        .querySelectorAll(".dv-timeline-lane")[0]
        .querySelector('[data-clip-id="' + id + '"]') !== null,
    {},
    movingId,
  );
  checks++;
  const cancelledRevision=(await bridge.invoke('timeline.inspect',{projectId})).revision;
  const cancelFrom=await (await page.$('[data-clip-id="'+movingId+'"]')).boundingBox();
  await page.mouse.move(cancelFrom.x+15,cancelFrom.y+cancelFrom.height/2);await page.mouse.down();
  await page.mouse.move(cancelFrom.x+15,dest.y+dest.height/2,{steps:5});
  await page.keyboard.press('Escape');await page.mouse.up();
  assert.equal(await page.$('.is-dragging'),null);assert.equal(await page.$('.dv-drop-preview'),null);
  assert.equal((await bridge.invoke('timeline.inspect',{projectId})).revision,cancelledRevision,'Escape must cancel without a write');checks++;
  // Out-of-lane release must cancel rather than silently moving the source clip.
  const outsideFrom=await (await page.$('[data-clip-id="'+movingId+'"]')).boundingBox();
  await page.mouse.move(outsideFrom.x+15,outsideFrom.y+outsideFrom.height/2);await page.mouse.down();
  await page.mouse.move(outsideFrom.x+60,from.y-50,{steps:5});
  assert.equal(await page.$('.is-dragging.is-invalid').then(Boolean),true);
  await page.mouse.up();assert.equal((await bridge.invoke('timeline.inspect',{projectId})).revision,cancelledRevision);checks++;
  await page.screenshot({ path: join(out, "timeline.png") });
  await page.waitForSelector(".dv-canvas-shell[data-canvas-phase=ready]");
  checks++;
  await page.screenshot({ path: join(out, "full-workspace.png") });
  await page.setViewport({ width: 340, height: 760 });
  await page.evaluate(
    () => (document.getElementById("mount").style.width = "100%"),
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  checks++;
  await page.screenshot({ path: join(out, "full-narrow.png") });
  await page.waitForFunction(
    () =>
      document.querySelector(".dv-canvas-shell").dataset.previewPending ===
      "false",
  );
  const beforeAdd = await bridge.invoke("timeline.inspect", { projectId }),
    clipCount = beforeAdd.totalClips;
  await page.click('.dv-resource-bar button[aria-label="素材"]');
  await page.waitForSelector(".dv-media-tile");
  await page.click(".dv-media-tile");
  await clickText("加入时间线");
  await count(clipCount + 1);
  assert.equal(await page.$(".dv-media-library"), null);
  await page.waitForFunction(
    () =>
      document.querySelector(".dv-timeline").getAttribute("aria-busy") ===
      "false",
  );
  let afterAdd = await bridge.invoke("timeline.inspect", { projectId });
  assert.equal(afterAdd.tracks[0].clips.at(-1).durationFrames, 600);
  checks++;
  await clickText("撤销");
  await count(clipCount);
  await page.waitForFunction(
    () =>
      document.querySelector(".dv-timeline").getAttribute("aria-busy") ===
      "false",
  );
  await page.click('.dv-resource-bar button[aria-label="素材"]');
  await page.waitForSelector(".dv-media-tile");
  await page.evaluate(() => {
    const transfer = new DataTransfer(),
      tile = document.querySelector(".dv-media-tile"),
      lane = [...document.querySelectorAll(".dv-timeline-lane")].at(-1);
    tile.dispatchEvent(
      new DragEvent("dragstart", { dataTransfer: transfer, bubbles: true }),
    );
    const rect = lane.getBoundingClientRect();
    lane.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 2,
        clientY: rect.top + 10,
      }),
    );
  });
  await count(clipCount + 1);
  afterAdd = await bridge.invoke("timeline.inspect", { projectId });
  assert.equal(
    afterAdd.tracks.at(-1).clips[0].durationFrames,
    600,
    "Dropped video should use its complete source duration",
  );
  checks++;
  await page.click(".dv-media-library button[aria-label]");
  await clickText("撤销");
  await count(clipCount);
  await page.waitForFunction(
    () =>
      document.querySelector(".dv-canvas-shell").dataset.previewPending ===
        "false" &&
      document.querySelector(".dv-timeline").getAttribute("aria-busy") ===
        "false",
  );
  const timeBefore = await page.$eval(".dv-seek", (e) => Number(e.value));
  await page.click(".dv-play");
  await page.waitForFunction(
    (start) => Number(document.querySelector(".dv-seek").value) > start + 0.25,
    {},
    timeBefore,
  );
  const uiTime = await page.$eval(".dv-seek", (e) => Number(e.value)),
    activeFrame = await (
      await page.$('.dv-stage-frame[aria-hidden="false"]')
    ).contentFrame();
  const mediaError = await activeFrame.evaluate((time) => {
    const v = [...document.querySelectorAll("video")].find(
      (v) =>
        time >= Number(v.dataset.start) &&
        time < Number(v.dataset.start) + Number(v.dataset.duration),
    );
    return v
      ? Math.abs(
          v.currentTime -
            (Number(v.dataset.mediaStart) +
              (time - Number(v.dataset.start)) *
                Number(v.dataset.playbackRate)),
        )
      : Infinity;
  }, uiTime);
  assert.ok(mediaError <= 2 / 30, "Media drift " + mediaError);
  await page.click(".dv-play");
  checks++;
  await writeFile(
    join(out, "sync.json"),
    JSON.stringify(
      { uiTime, mediaErrorSeconds: mediaError, limitFrames: 2 },
      null,
      2,
    ),
  );
  if(process.env.M4_AUDIO==='1') {
    await page.setViewport({width:900,height:760});
    await page.evaluate(()=>document.getElementById('mount').style.width='100%');
    assert.equal(await page.$$('.dv-timeline').then(x=>x.length),1);
    assert.equal(await page.$('.dv-resource-tab[data-panel-trigger="audio"]'),null,'sound entry removed');
    assert.equal(await page.$('.dv-audio-panel'),null);checks++;
    const uploadBefore=await bridge.invoke('timeline.inspect',{projectId});
    const uploadedAudio=join(root,'user-upload.wav');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-y',uploadedAudio]);
    await page.click('.dv-resource-tab[aria-label="素材"]');
    await page.waitForSelector('.dv-media-library input[type=file]');
    await (await page.$('.dv-media-library input[type=file]')).uploadFile(uploadedAudio);
    await page.waitForFunction(()=>[...document.querySelectorAll('.dv-media-tile')].some(e=>e.textContent.includes('user-upload.wav')));
    const uploadAfter=await bridge.invoke('timeline.inspect',{projectId});
    assert.equal(uploadAfter.totalClips,uploadBefore.totalClips,'upload stays in materials');checks++;
    await page.keyboard.press('Escape');
    const beforeAudio=await bridge.invoke('timeline.inspect',{projectId});
    let generated=await bridge.invoke('audio.generate',{projectId,operationId:'ai-direct-audio',provider:'procedural',kind:'music',text:'AI直接配乐',score:{duration:4,events:[{sound:'bell',note:60,at:0,duration:4,gainDb:-12}]}});
    const deadline=Date.now()+60000;
    while(['queued','running','downloading'].includes(generated.state)){assert(Date.now()<deadline);await new Promise(r=>setTimeout(r,50));generated=await bridge.invoke('audio.status',{projectId,jobId:generated.jobId});}
    assert.equal(generated.state,'succeeded');
    // The AI follows its skill through generation and placement, without a panel click.
    let generatedTimeline=await bridge.invoke('timeline.inspect',{projectId});
    await bridge.invoke('timeline.apply',{projectId,expectedRevision:generatedTimeline.revision,operationId:'ai-audio-track',ops:[{op:'track.add',kind:'audio',name:'配乐'}]});
    generatedTimeline=await bridge.invoke('timeline.inspect',{projectId});
    const generatedTrack=generatedTimeline.tracks.find(t=>t.kind==='audio');
    const placement=await bridge.invoke('timeline.apply',{projectId,expectedRevision:generatedTimeline.revision,operationId:'ai-audio-place',ops:[{op:'clip.insert',assetId:generated.asset.assetId,trackId:generatedTrack.trackId,startFrame:0,mode:'reject'}]});
    assert.equal(placement.written,true);checks++;
    // This component harness supplies the parent revision update explicitly.
    await page.evaluate(()=>window.reloadTimelineProject());
    await count(beforeAudio.totalClips+1);
    await page.waitForFunction(()=>document.querySelector('.dv-timeline').getAttribute('aria-busy')==='false');
    let audioTimeline=await bridge.invoke('timeline.inspect',{projectId});
    const audioTrack=audioTimeline.tracks.find(x=>x.kind==='audio'),audioClip=audioTrack.clips[0];
    assert.ok(audioClip.durationFrames>30);checks++;
    assert.equal(await page.$$('[data-kind=audio] .dv-track-visibility').then(x=>x.length),0);checks++;
    await page.click('[data-kind=audio] .dv-track-name-text',{button:'right'});
    await page.waitForFunction(()=>document.querySelector('.dv-timeline-more').open);
    assert.equal(await page.$eval('.dv-timeline-menu',e=>e.textContent.includes('关闭画面')),false);checks++;
    await page.screenshot({path:join(out,'audio-track-context.png')});
    await page.keyboard.press('Escape');

    await page.click('[data-clip-id="'+audioClip.clipId+'"]');
    await page.click('.dv-clip-settings summary');
    for(const [label,value]of [['音量','-6'],['淡入','0.3'],['淡出','0.4'],['轨道增益','-3']]) {
      const input=await page.$('.dv-timeline-inspector input[aria-label="'+label+'"]');
      await input.click();await input.evaluate(e=>e.select());await input.press('Backspace');await input.type(value);await input.press('Tab');
      await page.waitForFunction(()=>document.querySelector('.dv-timeline').getAttribute('aria-busy')==='false');
    }
    audioTimeline=await bridge.invoke('timeline.inspect',{projectId});
    const edited=audioTimeline.tracks.find(x=>x.kind==='audio');
    assert.equal(edited.clips[0].volumeDb,-6);assert.equal(edited.clips[0].fadeInFrames,9);assert.equal(edited.clips[0].fadeOutFrames,12);assert.equal(edited.gainDb,-3);checks++;
    const soundIcon=await page.$eval('.dv-track-mute[aria-label$="'+audioTrack.name+'"] path',e=>e.getAttribute('d'));
    await page.click('.dv-track-mute[aria-label$="'+audioTrack.name+'"]');
    await page.waitForFunction(()=>document.querySelector('.dv-timeline').getAttribute('aria-busy')==='false');
    assert.equal((await bridge.invoke('timeline.inspect',{projectId})).tracks.find(x=>x.kind==='audio').muted,true);
    assert.equal(await page.$eval('.dv-timeline-clip.is-audio',e=>e.classList.contains('is-muted')),true);checks++;
    assert.equal(await page.$eval('.dv-track-mute[aria-pressed=true]',e=>e.getAttribute('aria-label').startsWith('取消静音')),true);assert.notEqual(await page.$eval('.dv-track-mute[aria-pressed=true] path',e=>e.getAttribute('d')),soundIcon);checks++;
    await clickText('撤销');await page.waitForFunction(()=>document.querySelector('.dv-timeline').getAttribute('aria-busy')==='false');checks++;
    await page.waitForFunction(()=>document.querySelector('.dv-canvas-shell').dataset.previewPending==='false');
    const audibleFrame=await (await page.$('.dv-stage-frame[aria-hidden="false"]')).contentFrame();
    await audibleFrame.waitForSelector('button[aria-label="开启预览声音"]');
    const soundRect=await audibleFrame.$eval('button[aria-label="开启预览声音"]',e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    const soundFrame=await page.$eval('.dv-stage-frame[aria-hidden="false"]',e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,scale:r.width/parseFloat(e.style.width)};});
    await page.mouse.click(soundFrame.x+soundRect.x*soundFrame.scale,soundFrame.y+soundRect.y*soundFrame.scale);
    await audibleFrame.waitForFunction(()=>document.querySelector('button[aria-label="开启预览声音"]')?.dataset.audioState==='enabled',{timeout:5000}).catch(async e=>{console.log('sound-button',await audibleFrame.$eval('button[aria-label="开启预览声音"]',e=>({text:e.textContent,state:e.dataset.audioState})));throw e;});
    await page.evaluate(()=>window.seek(.5));await page.click('.dv-play');
    await page.waitForFunction(()=>Number(document.querySelector('.dv-seek').value)>.8);
    const audioTime=await page.$eval('.dv-seek',e=>Number(e.value));
    const audioState=await audibleFrame.evaluate(time=>{const a=document.querySelector('audio');return {exists:!!a,muted:a?.muted,paused:a?.paused,delta:Math.abs(a.currentTime-time),volume:a?.dataset.volume,rate:a?.playbackRate};},audioTime);
    assert.equal(audioState.muted,false,JSON.stringify(audioState));assert.equal(audioState.paused,false);assert.ok(audioState.delta<=2/30,JSON.stringify(audioState));await page.click('.dv-play');checks++;
    await writeFile(join(out,'audio-preview.json'),JSON.stringify(audioState,null,2));
    const oldPreview=await page.$eval('.dv-canvas-shell',e=>e.dataset.canvasRevision);
    if(!await page.$eval('.dv-clip-settings',e=>e.open))await page.click('.dv-clip-settings > summary');
    const input=await page.$('.dv-timeline-inspector input[aria-label="音量"]');await input.click();await input.evaluate(e=>e.select());await input.press('Backspace');await input.type('-8');await input.press('Tab');
    await page.waitForFunction(old=>document.querySelector('.dv-canvas-shell').dataset.canvasRevision!==old&&document.querySelector('.dv-canvas-shell').dataset.previewPending==='false',{},oldPreview);
    const nextFrame=await (await page.$('.dv-stage-frame[aria-hidden="false"]')).contentFrame();
    await nextFrame.waitForFunction(()=>document.querySelector('audio')?.muted===false,{timeout:5000});checks++;
    await page.waitForFunction(()=>[...document.querySelectorAll('.dv-clip-envelope')].some(x=>x.width>0&&x.getContext('2d').getImageData(0,0,x.width,x.height).data.some((v,i)=>i%4===3&&v>0)));checks++;
    await page.screenshot({path:join(out,'audio-timeline.png')});
    await page.evaluate(()=>document.getElementById('mount').style.cssText+=';--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202126;--dsw-alias-label-secondary:#70747c;--dsw-alias-interactive-bg-hover:#f0f2f4;color:#202126');
    await page.screenshot({path:join(out,'audio-timeline-light.png')});
    await page.evaluate(()=>document.getElementById('mount').style.cssText='width:100%');

    await (await page.$('.dv-timeline')).screenshot({path:join(out,'timeline-detail.png')});
    await page.setViewport({width:340,height:760});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:join(out,'audio-narrow.png')});checks++;

  }
  if(process.env.M5_COLLAB==='1'){
    await page.setViewport({width:900,height:760});
    await page.waitForFunction(()=>document.querySelector('.dv-timeline').getAttribute('aria-busy')==='false');
    await page.click('.dv-timeline-clip');
    await page.waitForSelector('.dv-clip-reference');
    const text=await page.$eval('.dv-clip-reference',e=>e.value);assert(text.startsWith('`dshvideo:v1/'));checks++;
    const before=await bridge.invoke('timeline.inspect',{projectId});
    const cid=await page.$eval('.dv-timeline-clip',e=>e.dataset.clipId);
    bridge.sessions.projectForSession=async id=>id==='m5-fixture'?projectId:null;
    const targets=await bridge.invoke('timeline.references',{projectId},{source:'tool',agentSessionId:'m5-fixture'});
    const token=targets.items.find(x=>x.kind==='clip'&&x.clipId===cid).token;
    await bridge.invoke('timeline.resolve',{projectId,revision:before.revision,refs:[{kind:'token',token}]},{source:'tool',agentSessionId:'m5-fixture'});
    await bridge.invoke('timeline.apply',{projectId,expectedRevision:before.revision,operationId:'ai-concurrent',ops:[{op:'clip.set',clipId:cid,patch:{label:'AI 保留的片段'}}]},{source:'tool',agentSessionId:'m5-fixture'});
    await page.evaluate(()=>{const original=window.fetch;let drop=true;window.fetch=async(url,init)=>{const request=init?.body?JSON.parse(init.body):{};if(drop&&request.method==='timeline.inspect'){drop=false;return new Response(JSON.stringify({ok:false,error:{code:'E_NETWORK',message:'temporary inspect failure'}}),{headers:{'content-type':'application/json'}});}return original(url,init);};});
    const edge=await page.$('.dv-timeline-edge-out');await edge.focus();await page.keyboard.press('ArrowLeft');
    await page.waitForSelector('.dv-change-recovery[data-recovery=conflict]');
    assert.equal((await bridge.invoke('timeline.inspect',{projectId})).lastChange.operationId,'ai-concurrent');checks++;
    await clickText('预演此修改');await page.waitForSelector('.dv-change-recovery[data-recovery=preview]');
    assert.equal((await bridge.invoke('timeline.inspect',{projectId})).lastChange.operationId,'ai-concurrent');checks++;
    await clickText('确认应用');await page.waitForFunction(()=>!document.querySelector('.dv-change-recovery')&&document.querySelector('.dv-timeline').getAttribute('aria-busy')==='false');
    let current=await bridge.invoke('timeline.inspect',{projectId});assert.equal(current.tracks.flatMap(x=>x.clips).find(x=>x.clipId===cid).label,'AI 保留的片段');checks++;
    await clickText('撤销这次修改');await page.waitForFunction(()=>document.querySelector('.dv-timeline').getAttribute('aria-busy')==='false');
    current=await bridge.invoke('timeline.inspect',{projectId});assert.equal(current.tracks.flatMap(x=>x.clips).find(x=>x.clipId===cid).label,'AI 保留的片段');checks++;
    await page.evaluate(()=>{const original=window.fetch;let drop=true;window.__attempts=[];window.fetch=async function(url,init){const request=init?.body?JSON.parse(init.body):{};if(request.method==='timeline.apply'){window.__attempts.push(request);const response=await original(url,init);if(drop){drop=false;await response.text();throw new TypeError('simulated lost response');}return response;}return original(url,init);};});
    await page.click('.dv-timeline-clip');const uncertain=await page.$('.dv-timeline-edge-out');await uncertain.focus();await page.keyboard.press('ArrowLeft');
    await page.waitForSelector('.dv-change-recovery[data-recovery=retry]');
    const committed=await bridge.invoke('timeline.inspect',{projectId});
    await clickText('重试原请求');await page.waitForFunction(()=>!document.querySelector('.dv-change-recovery')&&document.querySelector('.dv-timeline').getAttribute('aria-busy')==='false');
    const retried=await bridge.invoke('timeline.inspect',{projectId});assert.equal(retried.revision,committed.revision);assert.equal(retried.historyCursor,committed.historyCursor);
    const attempts=await page.evaluate(()=>window.__attempts);assert.deepEqual(attempts[0],attempts[1]);checks++;
    // A new asset selected during conflict recovery must remain queued.
    const queuedBefore=await bridge.invoke('timeline.inspect',{projectId});
    await bridge.invoke('timeline.apply',{projectId,expectedRevision:queuedBefore.revision,operationId:'queue-conflict',ops:[{op:'clip.set',clipId:cid,patch:{label:'保留排队素材'}}]});
    await page.click('.dv-timeline-clip');await (await page.$('.dv-timeline-edge-out')).focus();await page.keyboard.press('ArrowLeft');
    await page.waitForSelector('.dv-change-recovery[data-recovery=conflict]');
    await page.click('.dv-resource-bar button[aria-label="素材"]');await page.waitForSelector('.dv-media-tile');await page.click('.dv-media-tile');await clickText('加入时间线');
    assert.equal((await bridge.invoke('timeline.inspect',{projectId})).totalClips,queuedBefore.totalClips);
    await page.click('.dv-change-recovery button:last-child');
    await count(queuedBefore.totalClips+1);checks++;
    const referencePage=await browser.newPage();referencePage.on('pageerror',e=>errors.push(e.message));await referencePage.setViewport({width:360,height:600});await referencePage.goto('http://127.0.0.1:'+server.address().port+'/references');await referencePage.evaluate(()=>document.getElementById('mount').style.width='100%');await referencePage.waitForSelector('.dv-reference-item');
    await (await referencePage.$('.dv-reference-item')).focus();await referencePage.keyboard.press('Enter');await referencePage.waitForSelector('.dv-reference-token input');
    assert((await referencePage.$eval('.dv-reference-token input',e=>e.value)).startsWith('`dshvideo:v1/'));checks++;
    await (await referencePage.$('.dv-reference-panel')).screenshot({path:join(out,'references.png')});
    await referencePage.setViewport({width:340,height:760});await referencePage.evaluate(()=>document.getElementById('mount').style.width='100%');assert.equal(await referencePage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);checks++;
    await referencePage.screenshot({path:join(out,'collaboration-narrow.png')});
    await referencePage.click('#reference-outside');await referencePage.waitForFunction(()=>!document.querySelector('.dv-reference-panel'));checks++;
    await referencePage.click('[data-panel-trigger="references"]');await referencePage.waitForSelector('.dv-reference-item');
    await referencePage.evaluate(()=>document.getElementById('mount').style.cssText+=';--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202126;--dsw-alias-label-secondary:#70747c;--dsw-alias-interactive-bg-hover:#f0f2f4;color:#202126');
    assert.equal(await referencePage.$eval('.dv-reference-range-wrap',e=>e.open),false);
    await referencePage.click('.dv-reference-range-wrap summary');await referencePage.waitForSelector('.dv-reference-range input');checks++;
    await referencePage.screenshot({path:join(out,'references-light.png')});
    await referencePage.keyboard.press('Escape');await referencePage.waitForFunction(()=>!document.querySelector('.dv-reference-panel'));assert.equal(await referencePage.evaluate(()=>document.activeElement?.getAttribute('data-panel-trigger')),'references');checks++;

  }
  if (process.env.M3_RENDER === "1") {
    const timeline = await bridge.invoke("timeline.inspect", { projectId });
    const job = await bridge.invoke("render", {
      projectId,
      revision: timeline.revision,
    });
    let result = job;
    while (
      !["succeeded", "failed", "cancelled", "timed_out"].includes(result.state)
    ) {
      await new Promise((r) => setTimeout(r, 500));
      result = await bridge.invoke("status", { jobId: job.jobId });
    }
    assert.equal(result.state, "succeeded", JSON.stringify(result));
    const artifact = await bridge.readArtifact(job.jobId);
    await writeFile(join(out, "render.mp4"), artifact.bytes);
    await writeFile(
      join(out, "render-result.json"),
      JSON.stringify(result, null, 2),
    );
    checks++;
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(out, "result.json"),
    JSON.stringify({ ok: true, checks, errors, staging }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, checks, out }));
} catch (error) {
  console.error(error.stack||error);
  if (browser) {
    const page = (await browser.pages()).at(-1);
    await page.screenshot({ path: join(out, "failure.png") });
    await writeFile(
      join(out, "failure.json"),
      JSON.stringify(
        await page.evaluate(() => ({
          text: document.body.innerText,
          focused: document.activeElement?.outerHTML,
          clips: [...document.querySelectorAll(".dv-timeline-clip")].map(
            (x) => x.outerHTML,
          ),
          phase: document
            .querySelector(".dv-canvas-shell")
            ?.outerHTML.slice(0, 700),
        })),
        null,
        2,
      ),
    );
  }
  throw error;
} finally {
  if (browser) await closeTestBrowser(browser);
  if (server) await new Promise((r) => server.close(r));
  if (bridge) await bridge.dispose();
  await rm(root, { recursive: true, force: true });
  if (staged) await loadStagedHost(staging);
}
