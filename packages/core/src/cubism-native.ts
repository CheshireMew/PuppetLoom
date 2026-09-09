import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packCubismAtlas } from './cubism-atlas.js';
import { loadProject, loadCalibration, loadCalibrationDraft } from './project.js';
import { deformedPoints, neutralMotionState } from './deform.js';
import { featureGatedMotionState, authoredOpacityFor, layersInRenderOrder } from './render-contract.js';
import { evaluateLayerAuthoring } from './model.js';
import { poseDependentOrder } from './pose-occlusion.js';
import { characterLayerVisible } from './character-state.js';
import { createCubismParameterMappings, generateCubismSidecars } from './cubism-format.js';
import { verifyCubismModel } from './cubism-export.js';
import type { LayerBinding, PuppetLoomProject } from './types.js';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Cubism Editor rejects hyphens in parameter IDs even when Core accepts them. */
export function nativeCubismParameterId(sourceId:string) {
  if(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(sourceId))return sourceId;
  return `ParamPL_${sourceId.replace(/[^A-Za-z0-9_]/g,'_').slice(0,40)}_${createHash('sha256').update(sourceId).digest('hex').slice(0,12)}`;
}
export function nativeCubismDrawableId(sourceId:string) {
  if(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(sourceId))return sourceId;
  return `ArtMeshPL_${sourceId.replace(/[^A-Za-z0-9_]/g,'_').slice(0,38)}_${createHash('sha256').update(sourceId).digest('hex').slice(0,12)}`;
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
type Sample = { positions: number[]; opacity: number; order: number };
type Axis = { id: string; keys: number[] };

/** CMO3 reconstructs image UVs from the art's undeformed affine placement.
 * Keep neutral/authored deformation in keyforms, never in this image mapping. */
export function nativeArtPositions(project: PuppetLoomProject, layer: LayerBinding) {
  return layer.mesh.uvs.flatMap(uv=>[
    (layer.bounds.x+uv.x*layer.bounds.width)*project.canvas.width,
    (layer.bounds.y+uv.y*layer.bounds.height)*project.canvas.height,
  ]);
}

function errorBetween(a: Sample, b: Sample) {
  let pixels = 0;
  for (let i=0;i<a.positions.length;i+=2) pixels=Math.max(pixels,Math.hypot(a.positions[i]!-b.positions[i]!,a.positions[i+1]!-b.positions[i+1]!));
  return { pixels, opacity: Math.abs(a.opacity-b.opacity), order: Math.abs(a.order-b.order) };
}

/** Evaluate the same resolved parameter state used by the renderer, including authored keyforms. */
export function nativeLayerSampler(project: PuppetLoomProject, layer: LayerBinding) {
  const defaults=Object.fromEntries(project.model.parameters.map(p=>[p.id,p.default]));
  const sourceOrder=project.layers.filter(l=>l.visible!==false).sort((a,b)=>a.order-b.order).map(l=>l.order);
  const baseOrder=sourceOrder[layersInRenderOrder(project.layers).findIndex(l=>l.id===layer.id)]??layer.order;
  const face=project.layers.find(l=>l.role==='face');
  return (values: Record<string,number>): Sample => {
    const state=featureGatedMotionState(project,{...neutralMotionState,parameters:{...defaults,...values}});
    const offset=evaluateLayerAuthoring(project,layer,state).drawOrderOffset;
    const faceOrder=face?face.order+evaluateLayerAuthoring(project,face,state).drawOrderOffset:undefined;
    const order=poseDependentOrder(project,layer,state,baseOrder+offset,faceOrder);
    return { positions:deformedPoints(project,layer,state).flatMap(p=>[p.x*project.canvas.width,p.y*project.canvas.height]),
      opacity:characterLayerVisible(project,layer.id,state)?authoredOpacityFor(project,layer,state):0,order:order*20 };
  };
}

function coordinates(axes: Axis[]): number[][] {
  return axes.reduce<number[][]>((all,axis)=>axis.keys.flatMap((_,i)=>all.map(c=>[...c,i])),[[]]);
}

function interpolate(axes: Axis[], cells: Sample[], values: Record<string,number>): Sample {
  let corners=[{index:0,weight:1}],stride=1;
  for(const axis of axes) {
    const v=values[axis.id]!,keys=axis.keys;
    let hi=keys.findIndex(k=>k>=v);if(hi<0)hi=keys.length-1;
    let lo=Math.max(0,hi-1),t=hi===lo?0:(v-keys[lo]!)/(keys[hi]!-keys[lo]!);

    corners=corners.flatMap(c=>[{index:c.index+lo*stride,weight:c.weight*(1-t)},{index:c.index+hi*stride,weight:c.weight*t}]).filter(c=>c.weight>0);
    stride*=keys.length;
  }
  const result:Sample={positions:Array(cells[0]!.positions.length).fill(0),opacity:0,order:0};
  for(const c of corners) {const s=cells[c.index]!;s.positions.forEach((v,i)=>result.positions[i]!+=v*c.weight);result.opacity+=s.opacity*c.weight;result.order+=s.order*c.weight;}
  return result;
}

/** Bake only axes that affect this layer; retain authored knots and refine measured interpolation error. */
export function bakeNativeLayer(project: PuppetLoomProject, layer: LayerBinding, tolerancePixels=.5) {
  const sourceSample=nativeLayerSampler(project,layer);
  const mouth=layer.role==='mouth'?project.model.parameters.find(p=>p.semantic==='mouth-open'):undefined;
  const sample=(values:Record<string,number>)=>{
    const value=sourceSample(values),open=mouth?(values[mouth.id]??mouth.default):0;
    if(mouth&&open>.498&&open<.5){const t=(open-.498)/.002;value.opacity=sourceSample({...values,[mouth.id]:.498}).opacity*(1-t)+sourceSample({...values,[mouth.id]:.5}).opacity*t;}
    return value;
  };
  const base=sample({});
  const axes:Axis[]=[];
  // Non-neutral probes expose bindings that only move at a combined pose.
  const backgrounds=[{},Object.fromEntries(project.model.parameters.map(p=>[p.id,p.min])),Object.fromEntries(project.model.parameters.map(p=>[p.id,p.max]))];
  for(const param of project.model.parameters) {
    const knots=[param.min,param.default,param.max,...project.model.bindings.flatMap(b=>{const i=b.parameterIds.indexOf(param.id);return i<0?[]:b.keyforms.map(k=>k.values[i]!);})];
    // Two-art mouth switching is a deliberate step at .5; bracket it by a 0.002 transition (above the codec's 0.001 key tolerance).
    if(layer.role==='mouth'&&param.semantic==='mouth-open')knots.push(.498,.5,.42,.88);
    const keys=[...new Set(knots)].sort((a,b)=>a-b);
    const affects=backgrounds.some(bg=>{const baseline=sample({...bg,[param.id]:param.default});return keys.some(v=>{const e=errorBetween(baseline,sample({...bg,[param.id]:v}));return e.pixels>1e-4||e.opacity>1e-6||e.order>1e-6;});});
    if(affects&&keys.length>1)axes.push({id:param.id,keys});
  }
  let cells:Sample[]=[],maxError={pixels:0,opacity:0,order:0};
  const cache=new Map<string,Sample>();
  const get=(v:Record<string,number>)=>{const key=axes.map(a=>v[a.id]).join(',');let value=cache.get(key);if(!value){value=sample(v);cache.set(key,value);}return value;};
  for(let pass=0;pass<7;pass++) {
    const count=axes.reduce((n,a)=>n*a.keys.length,1);
    if(count>100000||count*layer.mesh.points.length>25_000_000)throw new Error(`${layer.id} 导出采样超过容量：${count} 个关键形。需分解变形层级，未静默丢弃参数。`);
    cells=coordinates(axes).map(c=>get(Object.fromEntries(axes.map((a,i)=>[a.id,a.keys[c[i]!]!]))));
    const probes:Record<string,number>[]=[];
    const defaults=Object.fromEntries(axes.map(a=>[a.id,project.model.parameters.find(p=>p.id===a.id)!.default]));
    for(const axis of axes)for(let i=1;i<axis.keys.length;i++) {
      probes.push({...defaults,[axis.id]:(axis.keys[i-1]!+axis.keys[i]!)/2});
    }
    // Deterministic mixed interior poses, in addition to each single-axis midpoint.
    for(let i=1;i<=96;i++)probes.push(Object.fromEntries(axes.map((a,j)=>[a.id,a.keys[0]!+(a.keys.at(-1)!-a.keys[0]!)*(((i*(j*2+3)*.61803398875)%1))])));
    for(let i=1;i<=48;i++)probes.push(Object.fromEntries(axes.map(a=>{const j=project.model.parameters.findIndex(p=>p.id===a.id);return [a.id,a.keys[0]!+(a.keys.at(-1)!-a.keys[0]!)*((i*(j*2+3)*.61803398875)%1)];})));
    const refine=new Map<string,Set<number>>();maxError={pixels:0,opacity:0,order:0};
    for(const v of probes) {
      const e=errorBetween(get(v),interpolate(axes,cells,v));
      maxError={pixels:Math.max(maxError.pixels,e.pixels),opacity:Math.max(maxError.opacity,e.opacity),order:Math.max(maxError.order,e.order)};
      if(e.pixels<=tolerancePixels&&e.opacity<=.025&&e.order<=.1)continue;
      for(const a of axes) {
        const hi=a.keys.findIndex(k=>k>v[a.id]!);if(hi<1)continue;
        const lo=a.keys[hi-1]!,high=a.keys[hi]!,t=(v[a.id]!-lo)/(high-lo);
        const left=get({...v,[a.id]:lo}),right=get({...v,[a.id]:high});
        const linear={positions:left.positions.map((x,i)=>x*(1-t)+right.positions[i]!*t),opacity:left.opacity*(1-t)+right.opacity*t,order:left.order*(1-t)+right.order*t};
        const local=errorBetween(get(v),linear);
        if(local.pixels<=tolerancePixels/Math.max(1,axes.length)&&local.opacity<=.025/Math.max(1,axes.length)&&local.order<=.1/Math.max(1,axes.length))continue;
        const set=refine.get(a.id)??new Set<number>();set.add((lo+high)/2);refine.set(a.id,set);
      }
    }
    if(!refine.size&&maxError.pixels<=tolerancePixels&&maxError.opacity<=.025&&maxError.order<=.1)return {base,axes,cells,maxError,samplesChecked:probes.length};
    if(!refine.size)break;
    if(pass===6)break;
    for(const a of axes)a.keys=[...new Set([...a.keys,...(refine.get(a.id)??[])])].sort((a,b)=>a-b);
  }
  throw new Error(`${layer.id} 导出插值未达到要求：${JSON.stringify(maxError)}。未生成可交付模型。`);
}

export type NativeCubismOptions = {editorVersion?:'5.3'|'5.4';runtimeVersion?:'4.2'|'5.0'|'5.3';tolerancePixels?:number;onProgress?:(message:string)=>void};

export async function exportNativeCubism(directory:string,outputDirectory:string,options:NativeCubismOptions={}) {
  const editorVersion=options.editorVersion??'5.3',runtimeVersion=options.runtimeVersion??'5.0';
  if(!['5.3','5.4'].includes(editorVersion)||!['4.2','5.0','5.3'].includes(runtimeVersion))throw new Error('不支持的 Cubism 工程或运行时版本。');
  const projectRoot=resolve(directory),output=resolve(outputDirectory);
  try {await access(output);throw new Error('导出目录已存在，请选择新目录。');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const configPath=process.env.PUPPETLOOM_NATIVE_EXPORT_CONFIG??join(root,'runtime/cubism-exporter/config.json');
  const config=JSON.parse(await readFile(configPath,'utf8').catch(()=>{throw new Error('请先运行 node scripts/setup-cubism-exporter.mjs 配置直接导出依赖。');})) as {java:string;classpath:string;sourceSha256:string};
  const sourceHash=createHash('sha256');
  for(const file of ['Main.kt','Physics.kt','CoreProbe.kt','EditorProfile.kt'])sourceHash.update(await readFile(join(root,'tools/cubism-exporter',file)));
  if(sourceHash.digest('hex')!==config.sourceSha256)throw new Error('格式转换器源码已更新，请重新运行 setup-cubism-exporter.mjs。');
  const project=await loadProject(projectRoot),calibration=await loadCalibration(projectRoot);
  if(await loadCalibrationDraft(projectRoot))throw new Error('存在未保存草稿，请先保存后导出。');
  const tolerance=options.tolerancePixels??.5;
  if(!Number.isFinite(tolerance)||tolerance<=0||tolerance>2)throw new Error('导出像素误差必须在 0..2 之间。');
  const beforeHash=fingerprint(project),work=join(output,'puppetloom-source');await mkdir(work,{recursive:true});
  await writeFile(join(output,'export-status.json'),JSON.stringify({status:'in-progress',revision:calibration.revision}));
  const layers=[];const textures=[];const reviews=[];
  const allLayers=project.layers.filter(l=>l.visible!==false);
  const drawableIds=Object.fromEntries(allLayers.map(layer=>[layer.id,nativeCubismDrawableId(layer.id)]));
  if(new Set(Object.values(drawableIds)).size!==allLayers.length)throw new Error('Cubism 图层 ID 冲突。');
  // Preserve a reversible ID mapping and signed ranges; scale units by 100 to avoid Core's absolute 0.001 key-snap tolerance.
  const parameterIds=Object.fromEntries(project.model.parameters.map(p=>[p.id,nativeCubismParameterId(p.id)]));
  if(new Set(Object.values(parameterIds)).size!==project.model.parameters.length)throw new Error('Cubism 参数 ID 冲突。');
  const mappings=createCubismParameterMappings(project.model.parameters).map(m=>({...m,targetIds:[parameterIds[m.sourceId]!],targetRange:{min:m.sourceRange.min*100,max:m.sourceRange.max*100,default:m.sourceRange.default*100},scale:100,offset:0,standard:false}));
  const individualBlinks=project.model.parameters.filter(p=>p.semantic==='blink-left'||p.semantic==='blink-right');
  if(individualBlinks.length===2){const global=mappings.find(m=>m.semantic==='blink');if(global)global.targetIds=individualBlinks.map(p=>parameterIds[p.id]!);}
  const sidecars=generateCubismSidecars(project,mappings);
  try {
    const atlas=await packCubismAtlas(await Promise.all(allLayers.map(async layer=>({id:layer.id,png:await readFile(join(projectRoot,layer.texture))}))));
    for(const [index,png] of atlas.pngs.entries()) {
      const file=`atlas-${index}.png`;await writeFile(join(work,file),png);
      textures.push({file,width:atlas.size,height:atlas.size});
    }
    for(const [index,layer]of allLayers.entries()) {
      options.onProgress?.(`转换 ${index+1}/${allLayers.length}：${layer.id}`);
      const baked=bakeNativeLayer(project,layer,tolerance);
      if(!['normal','multiply','add'].includes(layer.blendMode))throw new Error(`${layer.id} 的混合模式 ${layer.blendMode} 暂不支持直接导出，未替换成普通混合。`);
      const placement=atlas.placements.get(layer.id)!;
      const fileName=`layer-${index}.bin`,columns=layer.mesh.points.length*2+2;
      const buffer=Buffer.allocUnsafe(baked.cells.length*columns*4);
      let cursor=0;for(const cell of baked.cells)for(const v of [...cell.positions,cell.opacity,cell.order]){buffer.writeFloatLE(v,cursor);cursor+=4;}
      await writeFile(join(work,fileName),buffer);
      if(layer.clipLayerId&&!drawableIds[layer.clipLayerId])throw new Error(`${layer.id} 的裁剪图层未包含在导出模型中。`);
      layers.push({id:drawableIds[layer.id],sourceId:layer.id,name:layer.sourceName,positions:nativeArtPositions(project,layer),uvs:layer.mesh.uvs.flatMap(p=>[(placement.x+p.x*placement.width)/atlas.size,(placement.y+p.y*placement.height)/atlas.size]),triangles:layer.mesh.triangles,
        masks:layer.clipLayerId?[drawableIds[layer.clipLayerId]]:[],blend:layer.blendMode==='multiply'?'MultiplyPremultiplied':layer.blendMode==='add'?'AdditivePremultiplied':'Normal',
        texture:placement.page,axes:baked.axes.map(a=>({...a,sourceId:a.id,id:parameterIds[a.id],keys:a.keys.map(v=>v*100)})),data:fileName,count:baked.cells.length,opacity:baked.base.opacity,order:baked.base.order});
      reviews.push({layer:layer.id,axes:baked.axes.map(a=>({id:a.id,keys:a.keys.length})),keyforms:baked.cells.length,maxError:baked.maxError,samplesChecked:baked.samplesChecked});
    }
    const input={version:1,name:'model',editorVersion,runtimeVersion,width:project.canvas.width,height:project.canvas.height,parameterScale:100,parameterIds,drawableIds,parameters:project.model.parameters.map(p=>({...p,sourceId:p.id,id:parameterIds[p.id],min:p.min*100,max:p.max*100,default:p.default*100})),textures,layers,physics:sidecars.physics?.document};
    const inputPath=join(work,'model.json');await writeFile(inputPath,JSON.stringify(input));
    options.onProgress?.('写入 CMO3 / MOC3 并重新读入核对');
    await new Promise<void>((done,reject)=>{
      const child=spawn(config.java,['-Xmx8g','-Djava.awt.headless=true','-cp',config.classpath,'puppetloom.exporter.MainKt',inputPath,output],{windowsHide:true});
      let stderr='';child.stderr.on('data',c=>{stderr=(stderr+c).slice(-12000);});child.stdout.resume();child.once('error',reject);child.once('exit',code=>code===0?done():reject(new Error(`格式转换失败 (${code})：${stderr}`)));
    });
    const codec=JSON.parse(await readFile(join(output,'codec-report.json'),'utf8'));
    if(codec.notices.some((n:string)=>!n.startsWith('MissingSourceArt(')))throw new Error(`格式转换存在未保留内容：${JSON.stringify(codec.notices)}`);
    const modelPath=join(output,'model.model3.json');
    const model=JSON.parse(await readFile(modelPath,'utf8'));
    for(const sidecar of [...sidecars.expressions,...sidecars.motions,...(sidecars.physics?[sidecars.physics]:[]),sidecars.displayInfo]){const file=join(output,sidecar.file);await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify(sidecar.document,null,2));}
    model.FileReferences.Expressions=sidecars.expressions.map(x=>({Name:x.name,File:x.file}));
    model.FileReferences.Motions=Object.fromEntries(sidecars.motions.map(x=>[x.id,[{File:x.file}]]));
    const idle=sidecars.motions.filter(x=>project.model.behaviors.find(b=>b.id===x.id)?.autoplay);
    if(idle.length)model.FileReferences.Motions.Idle=idle.map(x=>({File:x.file}));
    if(sidecars.physics)model.FileReferences.Physics=sidecars.physics.file;
    model.FileReferences.DisplayInfo=sidecars.displayInfo.file;
    await writeFile(modelPath,JSON.stringify(model,null,2));
    if((await loadCalibration(projectRoot)).revision!==calibration.revision||fingerprint(await loadProject(projectRoot))!==beforeHash)throw new Error('导出期间项目发生变化，结果已过期，请重新导出。');
    const verification=await verifyCubismModel(modelPath);
    if(!verification.valid)throw new Error(`导出引用检查失败：${JSON.stringify(verification.issues)}`);
    const result={status:'awaiting-visual-review',editorVersion,runtimeVersion,outputDirectory:output,cmo3:join(output,'model.cmo3'),model3:modelPath,moc3:join(output,'model.moc3'),sourceRevision:calibration.revision,sourceFingerprint:beforeHash,parameterScale:100,parameterIds,drawableIds,tolerancePixels:tolerance,layers:reviews,verification,
      limitations:['几何为当前修订参数求值后的可编辑网格关键形，原程序化变形器层级不保留。','双素材嘴型在 mouth-open 的 .498 到 .5 之间完成透明度切换；原播放器在 .5 瞬时切换。','运行时行为与物理通过配套 JSON 转换；时间驱动的未参数化运动不等于原播放器。'],sidecarIssues:sidecars.issues};
    await writeFile(join(output,'export-status.json'),JSON.stringify(result,null,2));return result;
  }catch(error){await writeFile(join(output,'export-status.json'),JSON.stringify({status:'failed',message:error instanceof Error?error.message:String(error)}));throw error;}
}
