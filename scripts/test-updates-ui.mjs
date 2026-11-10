import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {PluginUpdates,createUpdateRoute} from '../host/updates.js';
const require=createRequire(resolve('packages/video-engine-worker/package.json')),puppeteer=require('puppeteer-core');
const out=resolve(process.argv[2]||'/tmp/video-updates-ui');await mkdir(out,{recursive:true});
const source=await readFile(process.env.VIDEO_CLIENT||'client.js','utf8'),body=source.slice(source.indexOf('    //#region constants'),source.indexOf('    //#region plugin')),css=source.match(/const CSS = `([\s\S]*?)`;/)[1];
const lite=(await readFile('scripts/lib/react-dom-lite.mjs','utf8')).replace('export { React, createElement, createRoot, createPortal, flushSync, pendingWork };','window.ReactLite={React,createElement,createRoot};');
const asset='dsh-video-1.0.1-'+process.platform+'-'+process.arch+'.tgz';let installs=0,mode='local';
const service=new PluginUpdates({version:'1.0.0',manager:{listBundles:async()=>[{name:'dsh-video',source:mode==='local'?'link:/dev':'https://github.com/helailai666/dsh-video-editor/releases/download/v1.0.0/old.tgz'}],removeBundle:async()=>({application:'applied'}),installBundle:async()=>{installs++;return {application:'restart-required'};}},fetchImpl:async()=>new Response(JSON.stringify({tag_name:'v1.0.1',assets:[{name:asset,browser_download_url:'https://github.com/helailai666/dsh-video-editor/releases/download/v1.0.1/'+asset}]}))});
const route=createUpdateRoute(service);
const js=`const Module=(function(require){${body};return {UpdateControl,ZH};})(()=>ReactLite.React);ReactLite.createRoot(document.getElementById('mount')).render(ReactLite.createElement(Module.UpdateControl,{t:k=>Module.ZH[k]||k}));`;
const server=createServer(async(req,res)=>{if(req.url==='/api/dsh-video/updates'){let text='';for await(const chunk of req)text+=chunk;const r=await route.fetch(new Request('http://local'+req.url,{method:'POST',headers:{'content-type':'application/json'},body:text}));res.writeHead(r.status,{'content-type':'application/json'});res.end(await r.text());}else if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(js);}else if(req.url==='/lite.js'){res.setHeader('content-type','text/javascript');res.end(lite);}else {res.setHeader('content-type','text/html; charset=utf-8');res.end(`<meta charset=utf-8><style>${css}body{background:#202126;color:#eee}#mount{position:absolute;right:24px;top:24px}</style><div id=mount class=dv-root></div><button id=outside>Outside</button><script src=/lite.js></script><script src=/app.js></script>`);}});
await new Promise(yes=>server.listen(0,'127.0.0.1',yes));let browser;
try{
 browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:640,height:480});await page.goto('http://127.0.0.1:'+server.address().port);
 await page.click('[data-panel-trigger=updates]');await page.waitForFunction(()=>document.querySelector('.dv-update-panel')?.textContent.includes('本地开发安装'));
 await page.screenshot({path:join(out,'local-dark.png')});assert.equal(installs,0);
 await page.click('#outside');assert.equal(await page.$('.dv-update-panel'),null);
 mode='github';service.checkedAt=0;service.view.phase='idle';await page.reload();await page.click('[data-panel-trigger=updates]');await page.waitForFunction(()=>document.querySelector('.dv-update-panel')?.textContent.includes('1.0.1'));assert.equal(installs,0);
 await page.evaluate(()=>document.getElementById('mount').style.cssText+=';--dsw-alias-bg-layer-1:#fff;--dsw-alias-label-primary:#202126;--dsw-alias-label-secondary:#777;--dsw-alias-border-l1:#ddd;color:#202126');await page.screenshot({path:join(out,'available-light.png')});
 for(const b of await page.$$('.dv-update-panel button'))if(await b.evaluate(e=>e.textContent)==='安装更新')await b.click();
 await page.waitForFunction(()=>document.querySelector('.dv-update-panel')?.textContent.includes('重启 DSH'));assert.equal(installs,1);
 await page.keyboard.press('Escape');assert.equal(await page.$('.dv-update-panel'),null);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,checks:8,out}));
}finally{await browser?.close();await new Promise(yes=>server.close(yes));service.dispose();}
