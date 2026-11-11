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
const bridgeSourceForProfile=await readFile('host/bridge.js','utf8');
assert(bridgeSourceForProfile.includes("'timeline.audioProfile': ['projectId','fromFrame','toFrame']"),'audioProfile needs an exact parameter whitelist');
const toolSourceForProfile=await readFile('host/tool.js','utf8');
assert(toolSourceForProfile.includes("'timeline.audioProfile':['projectId','fromFrame','toFrame']"),'the Tool must expose audioProfile with the same fields');
const profileConfig={projectIds:new Set(['demo'])};
assert.deepEqual(validateParams(profileConfig,'timeline.audioProfile',{projectId:'demo',fromFrame:0,toFrame:120}),{projectId:'demo',fromFrame:0,toFrame:120});
assert.throws(()=>validateParams(profileConfig,'timeline.audioProfile',{projectId:'demo',fromFrame:5,toFrame:5}),(e)=>e.code==='E_PARAMS');
assert.throws(()=>validateParams(profileConfig,'timeline.audioProfile',{projectId:'demo',fromFrame:0,toFrame:120,clipId:'cl_x'}),(e)=>e.code==='E_PARAMS');
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
console.log(JSON.stringify({ok:true,contextChars:text.length,customChars:withCustom.length,checks:27}));

let plugin;vm.runInNewContext(await readFile('client.js','utf8'),{window:{__ModuleLoader__:{load(m){plugin=m.factory(()=>({createElement(){}}));}}},console,URL,TextEncoder,AbortController});assert(plugin.inject.includes('sessions'),'Client must await the Session service instead of caching an early null');
