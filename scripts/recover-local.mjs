// Restore local platform metadata for an existing, owned deployment. Does not create or replace Kubernetes workloads.
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../dist/server/app.js';
import {readConfig} from '../dist/server/config.js';
import {defaultRuntime} from '../dist/shared/engines.js';
const config=readConfig(), x=await buildApp(config,{background:false});
try {
 const {items}=JSON.parse(execFileSync('kubectl',['--context',config.KUBE_CONTEXT,'get','deployments','-n','launchpad-test','-l','launchpad.platform/instance=launchpad-local','-o','json'],{encoding:'utf8'}));
 for(const d of items){
  if(x.store.list().some(s=>s.uid===d.metadata.uid)){console.log('Already recovered',d.metadata.name);continue;}
  const spec=JSON.parse(d.metadata.annotations['launchpad.platform/spec']), modelId=spec.modelRef.name, name=d.metadata.name;
  const model=x.manager.catalog.find(m=>m.id===modelId)??x.runtimes.registerModel({id:modelId,name:'SmolLM2 135M · 本机推理',modelKey:modelId,servedModelName:'smollm2',description:'从现有 OrbStack 部署恢复，CPU 推理。',family:'SmolLM2'});
  let image=x.images.register({engineId:'custom',version:'recovered-20261026',imageRef:spec.runtime.image,architecture:'arm64',cuda:'CPU',notes:'从现有运行中的 Deployment 恢复。'});
  image=await x.images.validate(image.id);
  const weight=await x.assets.registerPvc({modelId,revision:spec.modelRef.version,targetId:'kubernetes:launchpad-test',requestId:randomUUID(),bindings:spec.kubernetes.pvcBindings.map(b=>({role:b.role,claimName:b.claimName,subPath:b.subPath,contentRevision:'sha256:2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d'}))},'admin');
  let profile=x.runtimes.create({...defaultRuntime(modelId,'custom'),name:'SmolLM2 CPU · 恢复配置',version:'v1',imageId:image.id,command:spec.runtime.command,args:spec.runtime.args,port:8000,healthPath:'/health',livenessPath:'/health',startupTimeoutSeconds:120,cpuCores:0.5,memoryGB:0.5,gpuCount:0,gpuMemoryGB:0,sharedMemoryGB:0,mounts:spec.kubernetes.mounts});
  await x.runtimes.publish(profile.id,profile.revision,'admin');await x.runtimes.drain();profile=x.runtimes.get(profile.id);
  const id=randomUUID(),now=new Date().toISOString();
  x.store.save({id,name,modelId,modelName:model.name,modelVersion:weight.revision,invocationModel:'smollm2',framework:'自定义引擎',variantId:profile.id,gpuLabel:'0.5 CPU / 0.5 GiB',gpuMemoryGB:0,clusterId:1,namespace:'launchpad-test',targetId:weight.target.id,status:'preparing',message:'从现存 Deployment 恢复登记',live:true,stale:false,routeReady:false,readyReplicas:null,desiredReplicas:d.spec.replicas,resumeReplicas:d.spec.replicas,busy:false,revision:'',createdAt:d.metadata.creationTimestamp,updatedAt:now,observability:[],spec,uid:d.metadata.uid,resourceVersion:d.metadata.resourceVersion,creationConfirmed:true,weightSource:{revision:weight.revision,sources:weight.sources,versionId:weight.id},deployment:{profileId:profile.id,profileName:profile.name+' / '+profile.version,engineId:'custom',imageRef:image.imageRef,command:[...profile.command,...profile.args].join(' '),healthPath:'/health',livenessPath:'/health',startupTimeoutSeconds:120,registryPackageId:profile.packageId}});
  await x.manager.refresh(id,'admin');const s=x.store.get(id);console.log(JSON.stringify({id,name,status:s.status,ready:s.readyReplicas,desired:s.desiredReplicas,endpoint:s.endpoint}));
 }
} finally {await x.app.close();}
