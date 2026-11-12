import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {SessionService} from '../host/sessions.js';
import {BridgeError} from '../host/errors.js';
import {VideoBridge, validateParams} from '../host/bridge.js';
import {createVideoTool} from '../host/tool.js';
const revision='a'.repeat(64);
const fake={mappingSync:()=> 'demo',bridge:{projectFacts:()=>({mode:'timeline',revision,width:1280,height:720,duration:20})}};
const text=SessionService.prototype.contextText.call(fake,{agent:{session:{id:'trusted'}}});
assert(text.includes('clip.trim'));assert(text.includes('"expectedRevision"'));assert(text.includes('"operationId"'));assert(text.includes('data-hf-root'));assert(text.includes('durationFrames'));assert(text.includes('Last known project revision'));assert(text.length<6500);
// ── Appended page-owned prompt contract ──
assert(!text.includes('do not configure or call cloud providers'),'the legacy cloud ban must be gone');
assert(!text.includes('no provider setup, cloud calls'),'the legacy provider-setup ban must be gone');
assert(text.includes('configured ONLY on the plugin settings page'));
assert(text.includes('Range scoring'));
assert(text.includes('durationFrames=toFrame-fromFrame'));
assert(text.includes('WITHOUT provider or score'),'range scoring must demand the page-configured cloud model');
assert(text.includes('never substitute a procedural local score'));
assert(text.includes('IS such an explicit request'),'the audio line must count range messages as explicit cloud asks');
const clientSource=await readFile('client.js','utf8');
assert(clientSource.includes("t('video.timeline.rangeRequest')"),'the sent range message must carry the explicit cloud music ask');
// ── Range scoring stage gate: profile + table + confirmation before billing ──
assert(text.includes('timeline.audioProfile'),'stage 1 must read the loudness curve');
assert(text.includes('时间段（秒）'),'the user-facing table columns are fixed');
assert(text.includes('END THE TURN'),'the prompt must wait for explicit approval before audio.generate');
assert(text.includes('timeline.beatmap(projectId,fromFrame,toFrame)'),'stage 1 must measure the real picture hit frames, not imagine them');
assert(text.includes('asset.align(projectId,assetId'),'a whole cloud song must be measured against those hits before it is placed');
assert(text.includes('hitRate')&&text.includes('beatLayer'),'the fixed line must report the measured hit rate and the free beat layer');
const bridgeSourceForProfile=await readFile('host/bridge.js','utf8');
assert(bridgeSourceForProfile.includes("'timeline.audioProfile': ['projectId','fromFrame','toFrame','assetId']"),'audioProfile needs an exact parameter whitelist');
const toolSourceForProfile=await readFile('host/tool.js','utf8');
assert(toolSourceForProfile.includes("'timeline.audioProfile':['projectId','fromFrame','toFrame','assetId']"),'the Tool must expose audioProfile with the same fields');
// The engine gained measured rhythm: same field lists on both sides, plus case/schema/README parity.
for(const whitelist of ["'timeline.beatmap': ['projectId','fromFrame','toFrame']","'asset.align': ['projectId','assetId','fromFrame','toFrame','hitFrames','tempoLock']"]){
  assert(bridgeSourceForProfile.includes(whitelist),`the Host needs the exact whitelist ${whitelist}`);
  assert(toolSourceForProfile.includes(whitelist),`the Tool must expose the same fields for ${whitelist.split(':')[0]}`);
}
const workerSource=await readFile('packages/video-engine-worker/src/worker.mjs','utf8');
assert(workerSource.includes('case "asset.envelope"'),'the worker must dispatch asset.envelope');
assert(workerSource.includes('case "timeline.beatmap"')&&workerSource.includes('case "asset.align"'),'the worker must dispatch the beat analysis methods');
const schemaText=await readFile('packages/video-engine-worker/protocol.schema.json','utf8');
assert(schemaText.includes('"asset.envelope"'),'the protocol schema must document asset.envelope');
for(const method of ['timeline.beatmap','asset.align']){
  const def=`params_${method.replace('.','_')}`;
  assert(schemaText.includes(`"${method}"`)&&schemaText.includes(`"${def}"`)&&schemaText.includes(`result_${method.replace('.','_')}`),`the protocol schema must pin ${method}`);
}
const workerReadme=await readFile('packages/video-engine-worker/README.md','utf8');
assert(workerReadme.includes('`asset.envelope`'),'the worker README must list asset.envelope');
assert(workerReadme.includes('`timeline.beatmap`')&&workerReadme.includes('`asset.align`'),'the worker README must list the beat analysis methods');
// ── Render deadline: one budget shared by the worker, the topbar and the canvas ──
const jobsSource=await readFile('packages/video-engine-worker/src/jobs.mjs','utf8');
assert(jobsSource.includes('RENDER_MS_PER_FRAME = 240')&&clientSource.includes('RENDER_MS_PER_FRAME = 240'),'the render capture deadline must stay identical in the worker and the client');
assert(jobsSource.includes('VALIDATE_MS_PER_FRAME = 25'),'the count_frames validation probe needs a budget that scales with the frame count');
assert(jobsSource.includes('timeoutMs: 15000')===false||jobsSource.includes('validateProbeTimeoutMs(frames)'),'the full-frame probe must not keep the fixed 15s window');
assert(clientSource.includes('EXPORT_POST_CAPTURE_SLACK_MS'),'the UI poll must outlast the worker deadline plus the post-capture slack');
assert(clientSource.includes('attempt < 240')===false,'the canvas export must not keep a fixed 120s poll window');
const configSource=await readFile('host/config.js','utf8');
assert(configSource.includes('192 * 1024 * 1024'),'a long 1080x1920 export must not hit the artifact ceiling');
assert(bridgeSourceForProfile.includes('music-scoring-library/SKILL.md'),'audio.guide must bundle the companion genre library');
assert(bridgeSourceForProfile.includes('drama-beat-shifts/SKILL.md'),'audio.guide must bundle the beat-shift designer');
assert(bridgeSourceForProfile.includes('beat-alignment/SKILL.md'),'audio.guide must bundle the beat-alignment manual');
const beatAlignmentSkill=await readFile('skills/beat-alignment/SKILL.md','utf8');
assert(beatAlignmentSkill.includes('卡点必须来自测量'),'hit points must be measured, never imagined');
assert(beatAlignmentSkill.includes('timeline.beatmap')&&beatAlignmentSkill.includes('asset.align'),'the manual must use both measured methods');
assert(beatAlignmentSkill.includes('不计费'),'the fallback beat layer must be honest about being free local synthesis');
assert(beatAlignmentSkill.includes('诚实边界'),'a weak pulse must be reported, not claimed as a locked beat');
const beatShiftSkill=await readFile('skills/drama-beat-shifts/SKILL.md','utf8');
assert(beatShiftSkill.includes('快节奏AI短剧情绪突变设计器')&&beatShiftSkill.includes('每个稳态/爆发段 = 一条独立 cue'),'the designer must map hard cuts onto real plugin edits');
const librarySkill=await readFile('skills/music-scoring-library/SKILL.md','utf8');
assert(librarySkill.includes('配乐库')&&librarySkill.includes('复仇、霸总、逆袭、打脸'),'the genre table ships with the plugin');
assert(librarySkill.includes('absolute clock seconds are forbidden'),'hit points use cue-relative positions, never fake second precision');
const creationSkill=await readFile('skills/audio-creation/SKILL.md','utf8');
assert(creationSkill.includes('END THE TURN'),'the bundled skill keeps the confirmation gate');
assert(librarySkill.includes('卡点结构线')&&creationSkill.includes('卡点结构线')&&beatShiftSkill.includes('卡点结构线')&&beatAlignmentSkill.includes('卡点结构线'),'every bundled skill must enforce the video-anchored beat-point line');
assert(creationSkill.includes('timeline.beatmap')&&creationSkill.includes('asset.align'),'the audio-creation loop must route through the measured methods');
assert(!creationSkill.includes('grade the chosen window against the 卡点·转场 column row by row'),'the skill must no longer grade alignment by eye');
const profileConfig={projectIds:new Set(['demo'])};
assert.deepEqual(validateParams(profileConfig,'timeline.audioProfile',{projectId:'demo',fromFrame:0,toFrame:120}),{projectId:'demo',fromFrame:0,toFrame:120});
assert.deepEqual(validateParams(profileConfig,'timeline.audioProfile',{projectId:'demo',assetId:'as_500f1291'}),{projectId:'demo',assetId:'as_500f1291'});
assert.throws(()=>validateParams(profileConfig,'timeline.audioProfile',{projectId:'demo',fromFrame:5,toFrame:5}),(e)=>e.code==='E_PARAMS');
assert.throws(()=>validateParams(profileConfig,'timeline.audioProfile',{projectId:'demo',fromFrame:0,toFrame:120,assetId:'as_500f1291'}),(e)=>e.code==='E_PARAMS','assetId and a range are mutually exclusive');
assert.throws(()=>validateParams(profileConfig,'timeline.audioProfile',{projectId:'demo',fromFrame:0,toFrame:120,clipId:'cl_x'}),(e)=>e.code==='E_PARAMS');
// Beat analysis parameter contract.
assert.deepEqual(validateParams(profileConfig,'timeline.beatmap',{projectId:'demo',fromFrame:0,toFrame:120}),{projectId:'demo',fromFrame:0,toFrame:120});
assert.throws(()=>validateParams(profileConfig,'timeline.beatmap',{projectId:'demo',fromFrame:0,toFrame:12000}),(e)=>e.code==='E_PARAMS','a six minute window is the maximum');
assert.throws(()=>validateParams(profileConfig,'timeline.beatmap',{projectId:'demo',fromFrame:0,toFrame:0}),(e)=>e.code==='E_PARAMS');
assert.deepEqual(validateParams(profileConfig,'asset.align',{projectId:'demo',assetId:'as_500f1291',fromFrame:0,toFrame:120,hitFrames:[30,60,90],tempoLock:false}),{projectId:'demo',assetId:'as_500f1291',fromFrame:0,toFrame:120,hitFrames:[30,60,90],tempoLock:false});
assert.throws(()=>validateParams(profileConfig,'asset.align',{projectId:'demo',fromFrame:0,toFrame:120}),(e)=>e.code==='E_PARAMS','asset.align needs the generated music asset');
assert.throws(()=>validateParams(profileConfig,'asset.align',{projectId:'demo',assetId:'as_500f1291',fromFrame:0,toFrame:120,hitFrames:[90,60]}),(e)=>e.code==='E_PARAMS','hit frames must be ascending');
assert.throws(()=>validateParams(profileConfig,'asset.align',{projectId:'demo',assetId:'as_500f1291',fromFrame:0,toFrame:120,hitFrames:[60,300]}),(e)=>e.code==='E_PARAMS','hit frames must stay inside the range');
assert.throws(()=>validateParams(profileConfig,'asset.align',{projectId:'demo',assetId:'as_500f1291',fromFrame:0,toFrame:120,tempoLock:'yes'}),(e)=>e.code==='E_PARAMS');
assert.throws(()=>validateParams(profileConfig,'asset.align',{projectId:'demo',assetId:'as_500f1291',revision:'b'.repeat(64),fromFrame:0,toFrame:120}),(e)=>e.code==='E_PARAMS','the model cannot pin a revision here; the Host re-inspects');
const profileBridge=Object.create(VideoBridge.prototype);
profileBridge.rememberFacts=()=>{};profileBridge.closing=false;profileBridge.disposed=false;
const visualWindows=[];
profileBridge.callClient=async(method,params)=>{
  if(method==='timeline.inspect')return {revision:'a'.repeat(64),
    tracks:[{trackId:'tr_v',kind:'video',muted:false,clips:[
      {clipId:'cl_a',startFrame:0,durationFrames:120,assetId:'as_1'},
      {clipId:'cl_m',startFrame:60,durationFrames:120,assetId:'as_2',muted:true},
      {clipId:'cl_s',startFrame:90,durationFrames:120,assetId:'as_3'}]},
      {trackId:'tr_m',kind:'video',muted:true,clips:[{clipId:'cl_t',startFrame:0,durationFrames:120,assetId:'as_1'}]}],
    assets:[{assetId:'as_1',kind:'video',hasAudio:true},{assetId:'as_2',kind:'video',hasAudio:true},{assetId:'as_3',kind:'image',hasAudio:false}]};
  if(method==='timeline.visuals.request'){visualWindows.push([params.clipId,params.startFrame,params.endFrame]);return {taskId:'t1',status:'queued',revision:'a'.repeat(64)};}
  if(method==='timeline.visuals.status')return {taskId:params.taskId,status:'complete',revision:'a'.repeat(64),result:{waveform:{peaks:Array.from({length:256},(_,i)=>i<128?0.2:0.9),materialPeak:1,startFrame:0,endFrame:120}}};
  throw new Error('unexpected engine method '+method);
};
const profile=await profileBridge.audioProfile({projectId:'demo',fromFrame:0,toFrame:120});
assert.deepEqual(visualWindows,[['cl_a',0,120]],'only unmuted audible clips overlapping the range are sampled');
assert.equal(profile.bucketSeconds,1);
assert.deepEqual(profile.curve,[0.2,0.2,0.9,0.9],'window peaks fold onto whole seconds by max');
assert.deepEqual(profile.sampledClips,['cl_a']);
assert.equal(profile.unsampledClips,0);
// assetId mode: whole-asset envelope for picking the insert window of a full song.
const assetBridge=Object.create(VideoBridge.prototype);
assetBridge.callClient=async(method,params)=>{
  assert.equal(method,'asset.envelope');
  return {assetId:params.assetId,sha256:'b'.repeat(64),bucketSeconds:1.024,
    peaks:Array.from({length:210},(_,i)=>i<20?0.05:0.8),
    rms:Array.from({length:210},()=>0.4),materialPeak:1};
};
const assetCurve=await assetBridge.audioProfile({projectId:'demo',assetId:'as_500f1291'});
assert.equal(assetCurve.curve.length,210);
assert.equal(assetCurve.curve[0],0.05);
assert.equal(assetCurve.curve[30],0.8);
assert(assetCurve.durationSeconds>210&&assetCurve.durationSeconds<220);
assert.equal(assetCurve.materialPeak,1);
// ── Beat facades: the Host resolves the authoritative revision itself and turns
//    the measurement into steps the model can apply verbatim ──
const beatBridge=Object.create(VideoBridge.prototype);
const beatCalls=[];
beatBridge.rememberFacts=()=>{};
beatBridge.callClient=async(method,params)=>{
  beatCalls.push([method,Object.keys(params).join(',')]);
  if(method==='timeline.inspect')return {revision:'c'.repeat(64),durationFrames:600,tracks:[],assets:[]};
  if(method==='timeline.beatmap')return {revision:params.revision,fps:30,fromFrame:params.fromFrame,toFrame:params.toFrame,rangeFrames:params.toFrame-params.fromFrame,hits:[{frame:150,seconds:5,pct:50,source:'cut',strength:1,aligned:true}],grid:{bpm:120,intervalSeconds:0.5,phaseSeconds:0,confidence:0.9},cutCount:1,onsetCount:0,sampledClips:1,unsampledClips:0,truncated:false};
  if(method==='asset.align')return {revision:params.revision,assetId:params.assetId,assetFps:30,assetDurationSeconds:210,fromFrame:params.fromFrame,toFrame:params.toFrame,rangeFrames:params.toFrame-params.fromFrame,hitCount:1,song:{bpm:112,intervalSeconds:0.536,confidence:0.7,onsetCount:80},grid:{bpm:120,intervalSeconds:0.5,confidence:0.9},tempoLock:params.tempoLock,candidates:[],best:{sourceInFrame:1500,seconds:50,speed:1.07,hitRate:0.5,meanErrorFrames:9,maxErrorFrames:20,toleranceFrames:5,onsetCount:60,drift:[]},beatLayer:{score:{duration:4,seed:7,masterDb:-6,events:[{sound:'kick',at:1,duration:0.16,note:36,gainDb:-6}]}},beatLayerReason:'drift',warnings:[]};
  throw new Error('unexpected engine method '+method);
};
const beatmap=await beatBridge.beatmap({projectId:'demo',fromFrame:0,toFrame:120});
assert.equal(beatmap.grid.bpm,120);
assert.deepEqual(beatCalls[0],['timeline.inspect','projectId'],'the beatmap facade inspects before it measures');
assert.deepEqual(beatCalls[1],['timeline.beatmap','projectId,revision,fromFrame,toFrame'],'the facade pins the authoritative revision it just read');
const alignment=await beatBridge.alignMusic({projectId:'demo',assetId:'as_500f1291',fromFrame:0,toFrame:120});
assert.deepEqual(beatCalls[3],['asset.align','projectId,revision,assetId,fromFrame,toFrame,tempoLock'],'tempoLock is passed explicitly, defaulting to true');
assert(alignment.note.includes('sourceInFrame:1500')&&alignment.note.includes('clip.speed')&&alignment.note.includes('procedural'),'the answer must be directly applicable');
assert(alignment.note.includes('hitRate 0.5'),'the facade keeps the measured hit rate in the report');
assert.equal(alignment.beatLayer.score.events[0].sound,'kick','the free beat layer survives the facade untouched');
assert(!text.includes('User additional instructions'),'no custom block without page settings');
// A bound session with a custom prompt gets the block verbatim (max 2000).
const longCustom='配乐保持器乐。'.repeat(300)+'OVERFLOW-SENTINEL'; // 1951 + sentinel > 2000
const withCustomFake={mappingSync:()=>'demo',bridge:{projectFacts:()=>({mode:'timeline',revision,width:1280,height:720,duration:20}),customSystemPromptText:()=>longCustom}};
const withCustom=SessionService.prototype.contextText.call(withCustomFake,{agent:{session:{id:'trusted'}}});
assert(withCustom.includes('User additional instructions'));
assert(withCustom.includes('lower priority'));
assert(withCustom.includes('配乐保持器乐。'.repeat(3)));
assert(!withCustom.includes('OVERFLOW-SENTINEL'),'custom text is capped at 2000 chars');
assert(withCustom.length<=8000,'assembled context respects the 8000-char bound');
assert(withCustom.includes('Last known project revision'),'essential facts survive alongside the full custom block');
// Empty custom prompt restores the default assembly (page clear == default).
const clearedFake={mappingSync:()=>'demo',bridge:{projectFacts:()=>({mode:'timeline',revision,width:1280,height:720,duration:20}),customSystemPromptText:()=>''}};
assert(!SessionService.prototype.contextText.call(clearedFake,{agent:{session:{id:'trusted'}}}).includes('User additional instructions'));
// An unbound session never receives the plugin context, custom block included.
const unboundFake={mappingSync:()=>null,bridge:{projectFacts:()=>null,customSystemPromptText:()=>'秘密追加指令'}};
assert.equal(SessionService.prototype.contextText.call(unboundFake,{agent:{session:{id:'other'}}}),'');
const tool=createVideoTool({invoke:async()=>{throw new BridgeError('E_PARAMS','Invalid operationId');}});
await assert.rejects(()=>tool.execute({action:'scene.compose',projectId:'demo',html:'x'},{agent:{id:'trusted'}}),e=>e.message.includes('expectedRevision')&&e.message.includes('operationId'));
// ── session.send: public admission, mapping authority and request-id replay ──
const bridgeSource=await readFile('host/bridge.js','utf8');
assert(/const SESSION_METHODS = Object.freeze\(\[[^\]]*'session\.send'/.test(bridgeSource),'session.send must sit inside the UI-only SESSION_METHODS gate');
assert(bridgeSource.includes("'session.send': ['projectId', 'requestId', 'text']"),'session.send needs an exact parameter whitelist');
assert(!(await readFile('host/tool.js','utf8')).includes("'session.send'"),'the model Tool must never expose session sending');
function sendHost(project,controller){
  return {
    requireEnabled:()=>'ok',
    requireActive:()=>true,
    store:{project:async()=>project},
    service:()=>controller,
    dedupeKey:(projectId,requestId)=>projectId+'\u0000'+requestId,
    sent:new Map(),
    report(){},
  };
}
const prompted=[];
const promptController={prompt:async(request,signal)=>{prompted.push({request,aborted:signal===undefined});return{accepted:true};}};
const sentOnce=await SessionService.prototype.send.call(sendHost({sessionIds:['s-old','s-active'],activeSessionId:'s-active'},promptController),'demo','send-1','`dshvideo:v1/demo/range/60-180/rev`\n对立、对抗节奏');
assert.equal(sentOnce.accepted,true);
assert.equal(prompted.length,1);
assert.equal(prompted[0].request.sessionId,'s-active','the bound Session comes from the trusted mapping, never the Client');
assert.equal(prompted[0].request.mode,'queue');
assert.equal(prompted[0].request.requestId,'send-1');
assert.equal(prompted[0].request.content[0].type,'text');
assert(prompted[0].request.content[0].text.includes('dshvideo:v1/demo/range/60-180/rev'));
// The same request id with the same content replays the acknowledgement only.
const replayHost=sendHost({sessionIds:['s-active'],activeSessionId:'s-active'},{prompt:async()=>{prompted.push({replay:true});return{accepted:true};}});
await SessionService.prototype.send.call(replayHost,'demo','send-2','第一条');
const beforeReplay=prompted.length;
const replay=await SessionService.prototype.send.call(replayHost,'demo','send-2','第一条');
assert.equal(replay.accepted,true);
assert.equal(prompted.length,beforeReplay,'a replayed request id must never admit the message twice');
await assert.rejects(()=>SessionService.prototype.send.call(replayHost,'demo','send-2','换了内容'),e=>e.code==='E_OPERATION_REUSED');
// No bound Session, no prompt capability, and malformed input are all refused.
await assert.rejects(()=>SessionService.prototype.send.call(sendHost({sessionIds:[],activeSessionId:null},promptController),'demo','send-3','x'),e=>e.code==='E_SESSION_NOT_BOUND');
await assert.rejects(()=>SessionService.prototype.send.call(sendHost({sessionIds:['s-active'],activeSessionId:'s-active'},{create:async()=>({})}),'demo','send-4','x'),e=>e.code==='E_SESSION_CONFIG');
await assert.rejects(()=>SessionService.prototype.send.call(sendHost({sessionIds:['s-active'],activeSessionId:'s-active'},promptController),'demo','bad id!!','x'),e=>e.code==='E_PARAMS');
await assert.rejects(()=>SessionService.prototype.send.call(sendHost({sessionIds:['s-active'],activeSessionId:'s-active'},promptController),'demo','send-5','   '),e=>e.code==='E_PARAMS');
await assert.rejects(()=>SessionService.prototype.send.call(sendHost({sessionIds:['s-active'],activeSessionId:'s-active'},promptController),'demo','send-6','x'.repeat(4001)),e=>e.code==='E_PARAMS');
// A transport failure is reported as unconfirmed, never as a silent success.
await assert.rejects(()=>SessionService.prototype.send.call(sendHost({sessionIds:['s-active'],activeSessionId:'s-active'},{prompt:async()=>{throw new Error('socket closed');}}),'demo','send-7','x'),e=>e.code==='E_SESSION_SEND');
// Derived so the reported number cannot drift from the assertions actually here.
const ownSource=await readFile(new URL(import.meta.url),'utf8');
console.log(JSON.stringify({ok:true,contextChars:text.length,customChars:withCustom.length,checks:(ownSource.match(/^\s*assert[.(]/gm)||[]).length}));

let plugin;vm.runInNewContext(await readFile('client.js','utf8'),{window:{__ModuleLoader__:{load(m){plugin=m.factory(()=>({createElement(){}}));}}},console,URL,TextEncoder,AbortController});assert(plugin.inject.includes('sessions'),'Client must await the Session service instead of caching an early null');
