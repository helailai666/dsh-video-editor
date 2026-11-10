import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {SessionService} from '../host/sessions.js';
import {BridgeError} from '../host/errors.js';
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
console.log(JSON.stringify({ok:true,contextChars:text.length,customChars:withCustom.length,checks:15}));

let plugin;vm.runInNewContext(await readFile('client.js','utf8'),{window:{__ModuleLoader__:{load(m){plugin=m.factory(()=>({createElement(){}}));}}},console,URL,TextEncoder,AbortController});assert(plugin.inject.includes('sessions'),'Client must await the Session service instead of caching an early null');
