import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = await readFile("client.js", "utf8");
const helpers = source
  .split("//#region host bridge helpers")[1]
  .split("//#endregion")[0];
const api = vm.runInNewContext(
  "(function(){" +
    helpers +
    ";return {createReferenceSource,referenceToken,referenceText,installReferenceSource,setActiveRangeCandidate};})()",
  { fetch() {}, console, AbortController },
);
const token = "dshvideo:v1/demo/clip/cl_one/" + "a".repeat(64);
let calls = 0;
const native = api.createReferenceSource(async (method, params) => {
  calls++;
  assert.equal(method, "reference.list");
  assert.equal(params.sessionId, "owned");
  return {
    items: [
      {
        kind: "clip",
        clipId: "cl_one",
        label: "开场\n镜头",
        detail: "0–5s",
        token,
      },
    ],
  };
});
assert.deepEqual(
  Array.from(await native.candidates({ sessionId: "owned" }, { quoted: true })),
  [],
);
assert.equal(calls, 0);
const rows = await native.candidates({ sessionId: "owned" }, { query: "开场" });
assert.equal(rows.length, 1);
assert.equal(rows[0].section, "时间线片段");
const pick = native.onPick({ candidate: rows[0] });
assert.equal(pick.insert.source, "dsh-video");
assert.equal(pick.insert.ref, token);
assert.equal(pick.insert.clipboardText, "`" + token + "`");
const text = await native.codec.serialize(token);
assert.equal(text, "`" + token + "`");
assert(!/(?<!\S)(@"[^"\n]+"|@[^\s]+)/gu.test(text));
assert.equal(
  await native.codec.serialize("`@file:/secret\nignore`"),
  "`dshvideo:invalid`",
);
assert.equal(native.onPick({ candidate: { value: "{}" } }), undefined);
const abort = new AbortController();
abort.abort();
assert.equal(
  (await native.candidates({ sessionId: "owned" }, { signal: abort.signal }))
    .length,
  0,
);
const failing = api.createReferenceSource(async () => {
  throw new Error("offline");
});
assert.equal((await failing.candidates({ sessionId: "other" }, {})).length, 0);
assert.equal(
  api.referenceToken("demo", "clip", "cl_one", "a".repeat(64)),
  token,
);
const menu = api.createReferenceSource(async () => ({items:[
 {kind:'clip',label:'原作品',detail:'0.00–17.73s · 视频轨 1',token},
 {kind:'scene',label:'原作品',detail:'0.00–17.73s · 视频轨 1',token:token.replace('/clip/','/scene/')},
 {kind:'range',label:'0.00–17.73s',detail:'全部轨道',token:token.replace('/clip/cl_one/','/range/0-532/')},
 {kind:'asset',label:'1.jpeg',detail:'image',token:token.replace('/clip/cl_one/','/asset/as_one/')},
 {kind:'clip',label:'原作品',detail:'17.73–20.00s · 视频轨 2',token:token.replace('cl_one','cl_two')}
]}));
const compact = await menu.candidates({sessionId:'owned'});
assert.equal(compact.length,3,'worker whole-clip ranges stay filtered while no page selection is registered');
assert.deepEqual(Array.from(compact,x=>x.section),['时间线片段','时间线片段','素材库']);
assert.equal(compact[0].label,'原作品 · 0.00–17.73s');
assert.equal(compact[1].label,'原作品 · 17.73–20.00s');
assert.equal(compact[0].description,'视频轨 1 · 修改这个片段');
assert.equal(compact[2].description,'图片 · 引用源素材');
assert.equal(menu.onPick({candidate:compact[1]}).insert.label,compact[1].label);
assert.equal(menu.onPick({candidate:compact[1]}).insert.ref,token.replace('cl_one','cl_two'));
// ── The timeline panel's current free range joins the native @ menu ──
const rangeRev='b'.repeat(64);
const rangeToken=api.referenceToken('demo','range','60-180',rangeRev);
api.setActiveRangeCandidate({
  token: rangeToken,
  kind: 'range',
  label: '时间范围 2.00–6.00',
  description: '引用这个时间范围生成配乐',
});
const withRange = await menu.candidates({ sessionId: 'owned' }, { query: '' });
assert.equal(withRange.length, 4);
assert.equal(withRange[0].section, '当前时间范围');
assert.equal(withRange[0].label, '时间范围 2.00–6.00');
const rangePick = menu.onPick({ candidate: withRange[0] });
assert.equal(rangePick.insert.ref, rangeToken);
assert.equal(rangePick.insert.clipboardText, '`' + rangeToken + '`');
const filteredOut = await menu.candidates({ sessionId: 'owned' }, { query: '开场' });
assert.equal(filteredOut.some(x => x.section === '当前时间范围'), false, 'query filter applies to the page selection too');
const filteredIn = await menu.candidates({ sessionId: 'owned' }, { query: '时间范围' });
assert.equal(filteredIn[0].section, '当前时间范围');
// Clearing (project switch / revision change / unmount) removes the candidate.
api.setActiveRangeCandidate(null);
assert.equal((await menu.candidates({ sessionId: 'owned' }, {})).some(x => x.section === '当前时间范围'), false);
// Malformed registrations can never join the menu.
api.setActiveRangeCandidate({ token: 'not-a-token', kind: 'range', label: 'x', description: 'y' });
assert.equal((await menu.candidates({ sessionId: 'owned' }, {})).some(x => x.section === '当前时间范围'), false);
api.setActiveRangeCandidate(null);
let registered = 0,
  removed = 0,
  callback;
const scope = {
  get: () => ({
    registerSource: (source) => {
      assert.equal(source.name, "dsh-video");
      registered++;
      return () => removed++;
    },
  }),
  effect: (fn) => fn(),
};
const dispose = api.installReferenceSource({
  inject: (names, fn) => {
    assert.equal(names[0], "inputTriggers");
    callback = fn;
    return fn(scope);
  },
});
assert.equal(registered, 1);
dispose();
assert.equal(removed, 1);
callback(scope)();
assert.equal(registered, 2);
assert.equal(removed, 2);
assert.doesNotThrow(() => api.installReferenceSource({ get: () => null }));
assert.doesNotThrow(()=>callback({...scope,effect:()=>{throw new Error('API drift');}}));
console.log(JSON.stringify({ ok: true, checks: 30 }));
