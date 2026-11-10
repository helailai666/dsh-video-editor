/** Turn an audited immutable stage into a relocatable, platform-specific DSH tarball. Never publish. */
import {cp,mkdir,readFile,writeFile,stat,realpath,readdir} from 'node:fs/promises';
import {resolve,join,isAbsolute,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {loadStagedHost} from './lib/staged-host.mjs';
const [stageArg,outArg]=process.argv.slice(2);
if(!stageArg||!outArg||!isAbsolute(outArg))throw new Error('Usage: node scripts/pack-release.mjs <immutable-stage> <new-absolute-output>');
const stage=await realpath(stageArg),out=resolve(outArg);
await loadStagedHost(stage);
try{await stat(out);throw new Error('Output must not already exist');}catch(e){if(e.code!=='ENOENT')throw e;}
const integrity=JSON.parse(await readFile(join(stage,'INTEGRITY.json'),'utf8'));
if(integrity.rootDirty)throw new Error('Release requires a clean pinned stage');
const manifest=JSON.parse(await readFile(join(stage,'bundle/package.json'),'utf8'));
if(manifest.name!=='dsh-video-editor'||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version))throw new Error('Unexpected release identity');
await mkdir(join(out,'package/runtime'),{recursive:true});const pkg=join(out,'package');
// Copy authored bundle only; development config and absolute dependency links are replaced below.
for(const item of await readdir(join(stage,'bundle'))){if(['node_modules','package.json','cordis.patch.yml'].includes(item))continue;await cp(join(stage,'bundle',item),join(pkg,item),{recursive:true,dereference:true});}
const rootCommit=integrity.root?.commit||integrity.rootCommit||integrity.source?.rootCommit;
if(!rootCommit)throw new Error('Stage has no pinned root commit');
const patch=execFileSync('git',['show',rootCommit+':cordis.patch.yml'],{encoding:'utf8'});
if(!/config:\s*\{\s*\}/.test(patch))throw new Error('Release requires portable default configuration');
await writeFile(join(pkg,'cordis.patch.yml'),patch);
for(const name of ['engine-client','engine-worker']){
 const target=join(pkg,'runtime',name);await mkdir(target);
 for(const item of ['src','package.json','README.md',...(name==='engine-worker'?['protocol.schema.json']:[])])await cp(join(stage,name,item),join(target,item),{recursive:true,dereference:true});
 if(name==='engine-worker')await cp(join(stage,name,'node_modules'),join(target,'node_modules'),{recursive:true,dereference:true});
}
manifest.private=false;manifest.engines={node:'>=22',dsh:'>=0.2.1-rc.2'};delete manifest.dependencies;delete manifest.devDependencies;delete manifest.scripts;
manifest.repository={type:'git',url:'https://github.com/helailai666/dsh-video-editor.git'};manifest.homepage='https://github.com/helailai666/dsh-video-editor';manifest.keywords=['dsh-plugin','video-editor'];
manifest.files=[...(manifest.files||[]),'runtime/','RELEASE.json'];
await writeFile(join(pkg,'package.json'),JSON.stringify(manifest,null,2)+'\n');
const release={format:1,version:manifest.version,rootCommit,platform:process.platform,arch:process.arch,stageIntegritySha256:createHash('sha256').update(await readFile(join(stage,'INTEGRITY.json'))).digest('hex')};
await writeFile(join(pkg,'RELEASE.json'),JSON.stringify(release,null,2)+'\n');
const filename=`dsh-video-${manifest.version}-${process.platform}-${process.arch}.tgz`;
execFileSync('tar',['-czf',join(out,filename),'-C',out,'package']);
const sha=createHash('sha256').update(await readFile(join(out,filename))).digest('hex');
await writeFile(join(out,'SHA256SUMS'),sha+'  '+filename+'\n');
console.log(JSON.stringify({ok:true,artifact:join(out,filename),sha256:sha,...release}));
