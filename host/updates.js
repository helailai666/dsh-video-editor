/** UI-only updates. Package sources and targets are Host-owned, never supplied by the model. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
const REPO='https://github.com/helailai666/dsh-video-editor';
const API='https://api.github.com/repos/helailai666/dsh-video-editor/releases/latest';
const stable=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const newer=(a,b)=>{if(!stable.test(a))return false;const base=b.split('-')[0];if(!stable.test(base))return false;const x=a.split('.').map(BigInt),y=base.split('.').map(BigInt);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return b.includes('-');};
export class PluginUpdates{
  constructor({manager,version=manifest.version,fetchImpl=fetch,now=Date.now,beforeInstall=async()=>{}}={}){this.manager=manager;this.beforeInstall=beforeInstall;this.version=version;this.fetchImpl=fetchImpl;this.now=now;this.view={phase:'idle',currentVersion:version};this.checkedAt=0;this.candidate=null;this.pending=null;this.checking=null;this.disposed=false;this.abort=null;}
  status(){return {...this.view};}
  set(phase,extra={}){this.view={phase,currentVersion:this.version,...extra};return this.status();}
  async check(force=false){
    if(this.disposed)throw new Error('Updates disposed');
    if(this.pending||['installed','restart-required'].includes(this.view.phase))return this.status();
    if(this.checking)return this.checking;
    if(!force&&this.checkedAt&&['available','current'].includes(this.view.phase)&&this.now()-this.checkedAt<600000)return this.status();
    this.checking=this.lookup().finally(()=>{this.checking=null;});return this.checking;
  }
  async lookup(){
    this.set('checking');this.candidate=null;
    try{
      const m=this.manager;if(!m||typeof m.listBundles!=='function'||typeof m.installBundle!=='function')return this.set('unsupported');
      const own=(await m.listBundles()).find(x=>x.name===manifest.name);
      if(!own)return this.set('unsupported');
      const source=own.source;
      if(typeof source!=='string')return this.set('unsupported');
      if(/^(link:|file:|\/|\.|~|[a-z]:[\\/])/i.test(source))return this.set('local');
      let candidate;
      if(source.startsWith(manifest.name+'@')&&own.updatable&&typeof m.listVersions==='function'&&typeof m.updateBundle==='function'){
        const listed=await m.listVersions(manifest.name);
        if(listed.status!=='accepted')throw new Error('Version lookup unavailable');
        const v=listed.versions.find(x=>x.bundle&&!x.incompatible&&!x.deprecated&&!x.prerelease&&newer(x.version,this.version));
        if(v)candidate={version:v.version,kind:'registry',registry:listed.registry};
      }else if(source.startsWith(REPO+'/releases/download/')||/^(?:git\+)?https:\/\/github\.com\/helailai666\/dsh-video-editor(?:\.git)?(?:#.*)?$/.test(source)||/^github:helailai666\/dsh-video-editor(?:#.*)?$/.test(source)){
        this.abort=new AbortController();const timer=setTimeout(()=>this.abort?.abort(),8000);
        try{
          const response=await this.fetchImpl(API,{headers:{accept:'application/vnd.github+json'},signal:this.abort.signal});
          if(response.status===404)return this.set('unpublished');
          if(!response.ok)throw new Error('Release lookup unavailable');
          if(Number(response.headers.get('content-length'))>1048576)throw new Error('Release response too large');
          const reader=response.body.getReader();let bytes=0,parts=[];while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1048576){await reader.cancel();throw new Error('Release response too large');}parts.push(value);}
          const release=JSON.parse(Buffer.concat(parts).toString('utf8'));
          const version=String(release.tag_name??'').replace(/^v/,'');
          const spec=REPO+'/releases/download/v'+version+'/dsh-video-'+version+'-'+process.platform+'-'+process.arch+'.tgz';
          if(!release.draft&&!release.prerelease&&newer(version,this.version)){
            if(!release.assets?.some(a=>a.name==='dsh-video-'+version+'-'+process.platform+'-'+process.arch+'.tgz'&&a.browser_download_url===spec))return this.set('release-unavailable');
            candidate={version,kind:'github',spec};
          }
        }finally{clearTimeout(timer);this.abort=null;}
      }else return this.set('unsupported');
      if(this.disposed)return this.status();
      this.checkedAt=this.now();this.candidate=candidate?{...candidate,source,enabled:own.enabled!==false}:null;
      return this.set(candidate?'available':'current',candidate?{latestVersion:candidate.version,releaseUrl:REPO+'/releases/tag/v'+candidate.version}:{});
    }catch{return this.set('check-failed');}
  }
  async install(version){
    if(this.disposed)throw new Error('Updates disposed');
    if(this.pending)return this.status();
    const target=this.candidate;
    if(!target||target.version!==version||!['available','failed'].includes(this.view.phase)||this.now()-this.checkedAt>600000)throw new Error('Check updates before installing');
    await this.beforeInstall();
    if(this.pending)return this.status();
    this.set('installing',{latestVersion:target.version});
    const requestId='dsh-video-update-'+randomUUID();
    // Manager owns the operation if replacing this plugin disposes its Host fiber.
    this.pending=Promise.resolve().then(async()=>{
      try{
        const own=(await this.manager.listBundles()).find(x=>x.name===manifest.name);
        if(own?.source!==target.source)throw new Error('Installation source changed');
        let result;
        if(target.kind==='registry')result=await this.manager.updateBundle(manifest.name,target.version,{registry:target.registry,requestId});
        else{
          if(typeof this.manager.removeBundle!=='function')throw new Error('Update unsupported');
          const removed=await this.manager.removeBundle(manifest.name);
          if(!['applied','restart-required'].includes(removed.application))throw new Error('Removal refused');
          try{result=await this.manager.installBundle(target.spec,{enabled:target.enabled,requestId});}catch{result={application:'failed'};}
          if(!['applied','restart-required'].includes(result.application)){
            let restored=false;try{const restore=await this.manager.installBundle(target.source,{enabled:target.enabled});restored=['applied','restart-required'].includes(restore.application);}catch{}
            return this.set('failed',{latestVersion:target.version,restored});
          }
        }
        const final=result.result??result;
        if(!['applied','restart-required'].includes(final.application))return this.set('failed',{latestVersion:target.version,restored:result.restore?.application==='applied'});
        return this.set(final.application==='restart-required'?'restart-required':'installed',{latestVersion:target.version});
      }catch{return this.set('failed',{latestVersion:target.version});}
      finally{this.pending=null;}
    });
    return this.status();
  }
  dispose(){this.disposed=true;this.abort?.abort();}
}
export function createUpdateRoute(service){return {path:'/api/dsh-video/updates',methods:['POST'],requestBody:'buffered',fetch:async request=>{
  const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  try{
    if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return reply({error:'Invalid content type'},415);
    const text=await request.text();if(Buffer.byteLength(text)>1024)return reply({error:'Request too large'},413);
    const b=JSON.parse(text);if(!b||Array.isArray(b)||typeof b!=='object')throw new Error();
    const keys=b.action==='install'?['action','version','confirm']:['action'];
    if(Object.keys(b).length!==keys.length||Object.keys(b).some(k=>!keys.includes(k)))throw new Error();
    if(b.action==='check')return reply(await service.check());
    if(b.action==='status')return reply(service.status());
    if(b.action==='install'&&b.confirm===true&&typeof b.version==='string')return reply(await service.install(b.version));
    throw new Error();
  }catch{return reply({error:'Invalid update request'},400);}
}};}
