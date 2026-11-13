import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rename,realpath,lstat,readdir,rm,utimes,mkdtemp} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {fail} from './errors.mjs';
import {timelineRevision} from './timeline.mjs';
import {sourceSeconds} from './visuals.mjs';
import {inside} from './registry.mjs';
import {chooseWindow, compileBeatLayer, estimateGrid, mergeOnsetHits, onsetsFromEnvelope, pictureHits} from './beat.mjs';
import {defaultBrowserPath} from './browser.mjs';
const digest=x=>createHash('sha256').update(x).digest('hex');
export function validateVisualRequest(p){
 if(!/^cl_[a-z0-9]+$/.test(p.clipId)||!Number.isSafeInteger(p.startFrame)||!Number.isSafeInteger(p.endFrame)||p.startFrame<0||p.endFrame<=p.startFrame||!Number.isSafeInteger(p.count)||p.count<1||p.count>4)fail('E_PARAMS','Invalid visual sampling window');
 return p;
}
// A separate serial background queue never holds the project edit queue.
export class TimelineVisuals {
 constructor(timelines,priority=()=>false){this.priority=priority;this.roots=new Set();this.timelines=timelines;this.tasks=new Map();this.tail=Promise.resolve();this.closed=false;}
 async request(p){
  validateVisualRequest(p);
  const journal=await this.timelines.load(p.projectId),t=journal?.timeline;
  if(!t||timelineRevision(t)!==p.expectedRevision)fail('E_REVISION_CONFLICT','Timeline changed');
  const c=t.tracks.flatMap(x=>x.clips).find(x=>x.clipId===p.clipId);
  if(!c||p.startFrame<c.startFrame||p.endFrame>c.startFrame+c.durationFrames)fail('E_PARAMS','Clip window unavailable');
  if([...this.tasks.values()].filter(x=>!['complete','failed','cancelled'].includes(x.status)).length>=32)fail('E_LIMIT','Visual queue full');
  for(const [id,task]of this.tasks)if(Date.now()-task.updated>120000&&['complete','failed','cancelled'].includes(task.status))this.tasks.delete(id);
  if(this.tasks.size>=128){for(const [id,task]of this.tasks){if(['complete','failed','cancelled'].includes(task.status))this.tasks.delete(id);if(this.tasks.size<128)break;}}
  const task={taskId:randomBytes(12).toString('hex'),projectId:p.projectId,revision:p.expectedRevision,status:'queued',updated:Date.now(),abort:new AbortController()};
  this.tasks.set(task.taskId,task);
  const run=async()=>{
   if(task.abort.signal.aborted||this.closed){task.status='cancelled';return;}
   while(this.priority()&&!task.abort.signal.aborted&&!this.closed)await new Promise(yes=>setTimeout(yes,100));
   if(task.abort.signal.aborted||this.closed){task.status='cancelled';return;}
   task.status='running';const deadline=setTimeout(()=>task.abort.abort(),90000);
   try{task.result=await this.sample(t,c,p,task.abort.signal);task.status=task.abort.signal.aborted?'cancelled':'complete';}
   catch(error){task.status=task.abort.signal.aborted?'cancelled':'failed';task.error={code:error.code??'E_VISUALS',message:'预览图或波形暂不可用，稍后重试'};}
   finally{clearTimeout(deadline);task.updated=Date.now();}
  };
  this.tail=this.tail.then(run,run);return {taskId:task.taskId,revision:task.revision,status:task.status};
 }
 status(p){if(!/^[a-f0-9]{24}$/.test(p.taskId))fail('E_PARAMS','Invalid visual task');const task=this.tasks.get(p.taskId);if(!task||task.projectId!==p.projectId)fail('E_NOT_FOUND','Visual task unavailable');return {taskId:task.taskId,revision:task.revision,status:task.status,...(task.status==='complete'?{result:task.result}:{}),...(task.error?{error:task.error}:{})};}
 cancel(p){if(!/^[a-f0-9]{24}$/.test(p.taskId))fail('E_PARAMS','Invalid visual task');const task=this.tasks.get(p.taskId);if(!task||task.projectId!==p.projectId)fail('E_NOT_FOUND','Visual task unavailable');task.abort.abort();task.result=undefined;task.status='cancelled';return {cancelled:true};}
 async drain(projectId){for(const task of this.tasks.values())if(!projectId||task.projectId===projectId)task.abort.abort();await this.tail;}
 async command(args,signal,onData){
  if(signal.aborted)throw new Error('Cancelled');
  await new Promise((yes,no)=>{const child=spawn('ffmpeg',['-v','error','-nostdin','-y',...args],{stdio:['ignore','pipe','ignore']});
   const kill=()=>child.kill('SIGKILL'),timer=setTimeout(kill,45000);signal.addEventListener('abort',kill,{once:true});
   child.stdout.on('data',b=>{try{onData?.(b);}catch(e){kill();no(e);}});
   child.once('error',no);child.once('close',code=>{clearTimeout(timer);signal.removeEventListener('abort',kill);code===0&&!signal.aborted?yes():no(new Error('Media sampling failed'));});
  });
 }
 async cacheRoot(projectId){
  const dir=await realpath(this.timelines.dir(projectId)),root=resolve(dir,'.dsh-video','timeline-visuals-v1');
  for(const path of [resolve(dir,'.dsh-video'),root]){await mkdir(path,{recursive:false}).catch(e=>{if(e.code!=='EEXIST')throw e;});const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||!inside(dir,await realpath(path)))fail('E_PATH','Unsafe visual cache');}
  const marker=resolve(root,'.owner');
  try{if((await readFile(marker,'utf8'))!=='dsh-video/timeline-visuals-v1')fail('E_PATH','Unowned visual cache');}
  catch(e){if(e.code!=='ENOENT')throw e;if((await readdir(root)).length)fail('E_PATH','Unowned visual cache');await writeFile(marker,'dsh-video/timeline-visuals-v1',{flag:'wx'});}
  this.roots.add(root);
  if(!this.discovered){this.discovered=true;for(const registered of Object.values(this.timelines.store?.config?.projects??{})){try{const dir=await realpath(registered),candidate=resolve(dir,'.dsh-video','timeline-visuals-v1'),info=await lstat(candidate);if(info.isDirectory()&&!info.isSymbolicLink()&&inside(dir,await realpath(candidate))&&(await readFile(resolve(candidate,'.owner'),'utf8'))==='dsh-video/timeline-visuals-v1')this.roots.add(candidate);}catch{}}}
  return root;
 }
 async cached(root,key,extension,build){
  const path=resolve(root,key+'.'+extension);
  try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>8*1024*1024)fail('E_PATH','Unsafe cache file');const bytes=await readFile(path);await utimes(path,new Date(),new Date());return bytes;}catch(e){if(e.code!=='ENOENT')throw e;}
  const temporary=path+'.'+randomBytes(6).toString('hex')+'.'+extension;
  try{await build(temporary);const bytes=await readFile(temporary);if(bytes.length>8*1024*1024)fail('E_LIMIT','Visual output too large');await rename(temporary,path);return bytes;}finally{await rm(temporary,{force:true});}
 }
 // Whole-asset loudness envelope at ~1s buckets, for picking an insert window
 // before any timeline clip exists (range scoring of full-length cloud songs).
 async envelopeOf(p){
  const file=await this.timelines.media.resolveFile({projectId:p.projectId,assetId:p.assetId});
  if(!file||file.asset.kind==='image')fail('E_PARAMS','Asset has no audio envelope');
  if(file.asset.kind!=='audio'&&file.asset.hasAudio!==true)fail('E_PARAMS','Asset has no audio');
  const root=await this.cacheRoot(p.projectId);
  const abort=new AbortController();
  const timer=setTimeout(()=>abort.abort(),60000);
  let data;
  try{data=await this.envelope(file,root,abort.signal);}finally{clearTimeout(timer);}
  const level=data.levels.find(x=>x.seconds>=1)??data.levels.at(-1);
  const round=v=>Math.round(v*100000)/100000;
  return {assetId:p.assetId,sha256:file.asset.sha256,bucketSeconds:Number(level.seconds.toFixed(4)),peaks:level.peaks.map(round),rms:level.rms.map(round),materialPeak:round(data.peak)};
 }
 async envelope(file,root,signal){
  const key=digest('peaks-v1:'+file.asset.sha256);
  const bytes=await this.cached(root,key,'json',async output=>{
   const peaks=[],rms=[];let carry=Buffer.alloc(0),peak=0,energy=0,n=0,total=0;
   await this.command(['-i',file.path,'-vn','-ac','2','-ar','8000','-f','f32le','pipe:1'],signal,b=>{
    const data=Buffer.concat([carry,b]),end=data.length-data.length%8;
    for(let i=0;i<end;i+=8){const left=data.readFloatLE(i),right=data.readFloatLE(i+4),v=Math.max(Math.abs(left),Math.abs(right));peak=Math.max(peak,Number.isFinite(v)?v:0);energy+=Number.isFinite(v)?v*v:0;n++;total++;if(total>8000*3601)throw new Error('Audio limit');if(n===128){peaks.push(Number(peak.toFixed(6)));rms.push(Number(Math.sqrt(energy/n).toFixed(6)));peak=0;energy=0;n=0;}}
    carry=data.subarray(end);
   });
   if(n){peaks.push(Number(peak.toFixed(6)));rms.push(Number(Math.sqrt(energy/n).toFixed(6)));}
   const levels=[{seconds:128/8000,peaks,rms}];
   while(levels.at(-1).peaks.length>1){const prev=levels.at(-1),p=[],r=[];for(let i=0;i<prev.peaks.length;i+=2){p.push(Math.max(prev.peaks[i],prev.peaks[i+1]??0));r.push(Math.sqrt((prev.rms[i]**2+(prev.rms[i+1]??prev.rms[i])**2)/2));}levels.push({seconds:prev.seconds*2,peaks:p,rms:r});}
   await writeFile(output,JSON.stringify({peak:Math.max(0,...levels.at(-1).peaks),levels}));
  });return JSON.parse(bytes);
 }
 // Song onsets are measured on the finest cached level (16ms) and reported in
 // timeline-frame units (@30fps) so picture cuts and music hits stay comparable.
 async songEnvelope(p){
  const file=await this.timelines.media.resolveFile({projectId:p.projectId,assetId:p.assetId});
  if(!file||file.asset.kind==='image')fail('E_PARAMS','Asset has no audio envelope');
  if(file.asset.kind!=='audio'&&file.asset.hasAudio!==true)fail('E_PARAMS','Asset has no audio');
  const root=await this.cacheRoot(p.projectId);
  const abort=new AbortController();
  const timer=setTimeout(()=>abort.abort(),60000);
  let data;
  try{data=await this.envelope(file,root,abort.signal);}finally{clearTimeout(timer);}
  const level=data.levels[0];
  const onsets=onsetsFromEnvelope(level.peaks,{bucketSeconds:level.seconds,materialPeak:data.peak});
  return {asset:file.asset,song:{fps:file.asset.fps||30,durationSeconds:Number((level.peaks.length*level.seconds).toFixed(3)),onsetFrames:onsets.times.map(time=>Math.round(time*30)),truncated:onsets.truncated,grid:estimateGrid(onsets.times)}};
 }
 async beatmapOf(p){
  const journal=await this.timelines.load(p.projectId),t=journal?.timeline;
  if(!t||timelineRevision(t)!==p.revision)fail('E_REVISION_CONFLICT','Timeline changed');
  const hits=pictureHits({tracks:t.tracks,fromFrame:p.fromFrame,toFrame:p.toFrame,fps:30});
  const assets=new Map((t.assets??[]).map(a=>[a.assetId,a]));
  const windows=[];
  for(const track of t.tracks??[])for(const clip of track.clips??[]){
   const start=Math.max(clip.startFrame,p.fromFrame),end=Math.min(clip.startFrame+(clip.durationFrames??0),p.toFrame);
   if(end<=start)continue;
   const a=assets.get(clip.assetId);
   if(!a||(a.kind!=='audio'&&a.hasAudio!==true))continue;
   if(track.muted===true||clip.muted===true)continue;
   windows.push({clip,asset:a});
  }
  if(windows.length>16)fail('E_LIMIT','Too many audible clips in the range; shorten it and retry');
  const root=await this.cacheRoot(p.projectId);
  const abort=new AbortController();
  const timer=setTimeout(()=>abort.abort(),60000);
  const pairs=[];
  let sampled=0,unsampled=0;
  try{
   for(const {clip,asset} of windows){
    if(abort.signal.aborted){unsampled++;continue;}
    const file=await this.timelines.media.resolveFile({projectId:p.projectId,assetId:asset.assetId});
    if(!file||file.asset.kind==='image'){unsampled++;continue;}
    let data;
    try{data=await this.envelope(file,root,abort.signal);}catch{unsampled++;continue;}
    sampled++;
    const level=data.levels[0],fps=asset.fps||30;
    const fromSource=sourceSeconds(clip,p.fromFrame,fps),toSource=sourceSeconds(clip,p.toFrame,fps);
    const lo=Math.max(0,Math.floor(fromSource/level.seconds)),hi=Math.min(level.peaks.length,Math.ceil(toSource/level.seconds));
    if(hi<=lo)continue;
    const found=onsetsFromEnvelope(level.peaks.slice(lo,hi),{bucketSeconds:level.seconds,materialPeak:data.peak});
    for(let index=0;index<found.times.length;index+=1){
     const sourceTime=fromSource+found.times[index];
     const frame=clip.startFrame+((sourceTime-(clip.sourceInFrame??0)/fps)*30)/(clip.speed??1);
     const seconds=(frame-p.fromFrame)/30;
     if(!(seconds>=0)||seconds*30>p.toFrame-p.fromFrame)continue;
     pairs.push({seconds:Number(seconds.toFixed(3)),strength:found.strengths[index]});
    }
   }
  }finally{clearTimeout(timer);}
  pairs.sort((a,b)=>a.seconds-b.seconds);
  const merged=mergeOnsetHits(hits,{times:pairs.map(pair=>pair.seconds),strengths:pairs.map(pair=>pair.strength)},{fromFrame:p.fromFrame,toFrame:p.toFrame,fps:30});
  return {
   revision:p.revision,fps:30,fromFrame:p.fromFrame,toFrame:p.toFrame,rangeFrames:p.toFrame-p.fromFrame,
   hits:merged.hits,
   grid:estimateGrid(merged.hits.map(hit=>hit.seconds)),
   cutCount:merged.hits.filter(hit=>hit.source==='cut').length,
   onsetCount:merged.hits.filter(hit=>hit.source==='onset').length,
   sampledClips:sampled,
   unsampledClips:unsampled,
   truncated:merged.truncated===true,
  };
 }
 async alignOf(p){
  const journal=await this.timelines.load(p.projectId),t=journal?.timeline;
  if(!t||timelineRevision(t)!==p.revision)fail('E_REVISION_CONFLICT','Timeline changed');
  const rangeFrames=p.toFrame-p.fromFrame,locked=p.tempoLock!==false;
  let hits,grid;
  if(Array.isArray(p.hitFrames)&&p.hitFrames.length){
   hits=p.hitFrames.filter(frame=>Number.isInteger(frame)&&frame>p.fromFrame&&frame<=p.toFrame).slice(0,256)
    .map(frame=>({frame,seconds:Number(((frame-p.fromFrame)/30).toFixed(3)),source:'cut',strength:1}));
   grid=estimateGrid(hits.map(hit=>hit.seconds));
  }else{
   const beat=await this.beatmapOf(p);
   hits=beat.hits;grid=beat.grid;
  }
  const hitFrames=hits.map(hit=>hit.frame);
  if(!hitFrames.length)fail('E_PARAMS','No picture hits inside the range to align against');
  const {song}=await this.songEnvelope(p);
  if(!song.onsetFrames.length)fail('E_PARAMS','The asset has no measurable onsets; place it manually');
  const chosen=chooseWindow({hitFrames,onsetFrames:song.onsetFrames,baseFrame:p.fromFrame,rangeFrames,assetDurationFrames:Math.round(song.durationSeconds*30),grid,songGrid:song.grid,tempoLock:locked});
  const best=chosen.best;
  const warnings=[];
  if(song.truncated===true)warnings.push('song onsets truncated to the strongest 400');
  if(!song.grid.bpm)warnings.push('no trustworthy song pulse; the picture cut grid decided the window');
  if(best.speed!==1)warnings.push(`tempo locked at ${best.speed}x; apply it with clip.speed`);
  const drift=best.drift.map(item=>Object.assign({},item,{hitSeconds:Number(((item.hitFrame-p.fromFrame)/30).toFixed(3))}));
  const aligned=best.hitRate>=0.8;
  const score=aligned?null:compileBeatLayer({hits,grid,rangeSeconds:rangeFrames/30});
  const result={
   revision:p.revision,assetId:p.assetId,assetFps:song.fps,assetDurationSeconds:song.durationSeconds,
   fromFrame:p.fromFrame,toFrame:p.toFrame,rangeFrames,hitCount:hitFrames.length,
   song:{bpm:song.grid.bpm,intervalSeconds:song.grid.intervalSeconds,confidence:song.grid.confidence,onsetCount:song.onsetFrames.length},
   grid:{bpm:grid.bpm,intervalSeconds:grid.intervalSeconds,confidence:grid.confidence},
   tempoLock:locked,
   candidates:chosen.candidates.map(candidate=>Object.assign({},candidate,{sourceInFrame:Math.round(candidate.seconds*song.fps)})),
   best:Object.assign({},best,{sourceInFrame:Math.round(best.seconds*song.fps),drift}),
   beatLayer:score?{score}:null,
   beatLayerReason:aligned?'aligned':'drift',
   warnings,
  };
  if(JSON.stringify(result).length>48000)fail('E_LIMIT','Beat result too large; shorten the range');
  return result;
 }
 async sample(t,c,p,signal){
  const root=await this.cacheRoot(t.projectId),a=t.assets.find(x=>x.assetId===c.assetId),result={thumbnails:[],waveform:null};
  const file=a?await this.timelines.media.resolveFile({projectId:t.projectId,assetId:a.assetId}):null;
  const start=sourceSeconds(c,p.startFrame,a?.fps??30),end=sourceSeconds(c,p.endFrame,a?.fps??30);
  if(a&&(a.kind==='audio'||a.hasAudio)){
   const data=await this.envelope(file,root,signal),step=(end-start)/256,level=data.levels.find(x=>x.seconds>=step/2)??data.levels.at(-1),peaks=[];
   for(let i=0;i<256;i++){let max=0;const lo=Math.floor((start+i*step)/level.seconds),hi=Math.ceil((start+(i+1)*step)/level.seconds);for(let j=lo;j<Math.max(lo+1,hi);j++)max=Math.max(max,level.peaks[j]??0);peaks.push(Math.round(max*100000)/100000);}
   result.waveform={peaks,materialPeak:data.peak,startFrame:p.startFrame,endFrame:p.endFrame};
  }
  if(!c.audioOnly&&a?.kind!=='audio'){
   const sceneSnapshot=!a?await this.timelines.read(t.projectId):null;
   if(sceneSnapshot&&sceneSnapshot.revision!==timelineRevision(t))fail('E_REVISION_CONFLICT','Scene changed');
   const sceneContext={snapshot:sceneSnapshot},sceneKey=!a?digest(JSON.stringify({scene:c.scene.path,assets:t.assets.map(x=>x.sha256),legacy:t.legacyAssets,width:t.settings.width,height:t.settings.height,renderer:1})):null;
   try {
   const times=Array.from({length:p.count},(_,i)=>Math.max(0,Math.min((a?.durationFrames??c.scene?.durationFrames??1)/(a?.fps??30)-1/(a?.fps??30),start+(end-start)*(i+.5)/p.count)));
   for(let i=0;i<times.length;i++){
    if(signal.aborted)throw new Error('Cancelled');
    const time=Number(times[i].toFixed(3)),key=digest('thumb-v1:'+(a?.sha256??sceneKey)+':'+time);
    const image=await this.cached(root,key,'jpg',async output=>{
     if(file)await this.command([...(a.kind==='video'?['-ss',String(time)]:[]),'-i',file.path,'-frames:v','1','-vf','scale=128:72:force_original_aspect_ratio=decrease,pad=128:72:(ow-iw)/2:(oh-ih)/2','-q:v','6',output],signal);
     else await this.sceneFrame(t,c,time,output,signal,sceneContext);
    });
    if(image.length>10000)fail('E_LIMIT','Thumbnail limit');
    result.thumbnails.push({time,data:'data:image/jpeg;base64,'+image.toString('base64')});
   }
   }finally{if(sceneContext.abort)signal.removeEventListener('abort',sceneContext.abort);await sceneContext.browser?.close();await new Promise(yes=>sceneContext.server?sceneContext.server.close(yes):yes());}
  }
  await this.trim(root);return result;
 }
 async sceneFrame(t,c,time,output,signal,context){
  const temp=await mkdtemp(resolve(tmpdir(),'dsh-visual-'));
  try{
   if(!context.page){
    const snapshot=context.snapshot,files=snapshot.files;
    const {createServer}=await import('node:http');
    context.server=createServer(async(req,res)=>{try{
      const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname.slice(1));let bytes=files.get(name);
      if(!bytes){const entry=snapshot.mediaRefs?.find(x=>x.path===name);if(entry){const path=await realpath(entry.source);if(!inside(await realpath(this.timelines.dir(t.projectId)),path))throw new Error('Path');bytes=await readFile(path);}}
      if(!bytes){res.writeHead(404).end();return;}
      const type=name.endsWith('.html')?'text/html':name.endsWith('.js')?'text/javascript':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.png')?'image/png':name.endsWith('.jpg')?'image/jpeg':'application/octet-stream';
      res.setHeader('Content-Type',type);res.setHeader('Content-Security-Policy',"default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'");res.end(bytes);
    }catch{res.writeHead(404).end();}});
    await new Promise(yes=>context.server.listen(0,'127.0.0.1',yes));
    const {default:puppeteer}=await import('puppeteer-core');
    context.browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??process.env.PUPPETEER_EXECUTABLE_PATH??defaultBrowserPath(),headless:true,args:['--disable-gpu','--no-sandbox']});
    context.abort=()=>void context.browser.close();signal.addEventListener('abort',context.abort,{once:true});
    const page=context.page=await context.browser.newPage(),origin=`http://127.0.0.1:${context.server.address().port}`;
    await page.setRequestInterception(true);page.on('request',request=>{const url=request.url();if(url.startsWith(origin+'/')||url.startsWith('data:'))void request.continue();else void request.abort();});
    await page.setViewport({width:t.settings.width,height:t.settings.height});await page.goto(`${origin}/scene-${c.clipId}.html`,{waitUntil:'networkidle0',timeout:20000});
   }
   if(signal.aborted)throw new Error('Cancelled');
   const abort=()=>void context.browser.close();signal.addEventListener('abort',abort,{once:true});
   try{await context.page.evaluate(at=>{for(const tl of Object.values(window.__timelines??{})){tl.pause?.();tl.seek?.(at,false);}},time);const screenshot=resolve(temp,'scene.png');await context.page.screenshot({path:screenshot});await this.command(['-i',screenshot,'-vf','scale=128:72:force_original_aspect_ratio=decrease,pad=128:72:(ow-iw)/2:(oh-ih)/2','-frames:v','1','-q:v','6',output],signal);}finally{signal.removeEventListener('abort',abort);}
  }finally{await rm(temp,{recursive:true,force:true});}
 }
 async trim(root){const files=[];for(const name of await readdir(root)){if(!/^[a-f0-9]{64}\.(json|jpg)$/.test(name))continue;const path=resolve(root,name),s=await lstat(path);if(s.isFile()&&!s.isSymbolicLink())files.push({path,bytes:s.size,at:s.mtimeMs});}let total=files.reduce((n,x)=>n+x.bytes,0);for(const f of files.sort((a,b)=>a.at-b.at)){if(total<=128*1024*1024)break;await rm(f.path);total-=f.bytes;}const all=[];for(const dir of this.roots){for(const name of await readdir(dir).catch(()=>[])){if(!/^[a-f0-9]{64}\.(json|jpg)$/.test(name))continue;const path=resolve(dir,name),s=await lstat(path).catch(()=>null);if(s?.isFile()&&!s.isSymbolicLink())all.push({path,bytes:s.size,at:s.mtimeMs});}}let bytes=all.reduce((n,f)=>n+f.bytes,0);for(const f of all.sort((a,b)=>a.at-b.at)){if(bytes<=512*1024*1024)break;await rm(f.path,{force:true});bytes-=f.bytes;}}
}
