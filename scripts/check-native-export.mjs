import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,join,dirname} from 'node:path';
import {loadProject} from '../packages/core/dist/project.js';
import {nativeLayerSampler} from '../packages/core/dist/cubism-native.js';
import {neutralMotionState} from '../packages/core/dist/deform.js';
import {renderProjectDirectoryPosePng} from '../packages/core/dist/offline-render.js';
import sharp from 'sharp';
const output=resolve(process.argv[2]);
// Optional fourth argument validates the Editor's re-export of the same CMO3.
const modelPath=resolve(process.argv[4]??join(output,'model.model3.json'));
const model3=JSON.parse(await readFile(modelPath,'utf8'));
const projectDirectory=resolve(process.argv[3]??'workspace/gothic-catgirl-live2d');
const project=await loadProject(projectDirectory);
const config=JSON.parse(await readFile('runtime/cubism-exporter/config.json','utf8'));
const editor=process.env.CUBISM_EDITOR_HOME??'D:/Software/Work/Live2D Cubism 5.3';
const poses=[];
const id=semantic=>project.model.parameters.find(p=>p.semantic===semantic)?.id;
for(const x of [-1,0,1])for(const y of [-1,0,1])for(const blink of [0,.25,.5,.75,1]) {
 const params=Object.fromEntries([[id('head-yaw'),x],[id('head-pitch'),y],[id('blink-left'),blink],[id('blink-right'),blink]].filter(x=>x[0]));
 poses.push({id:`head-${x}-${y}-blink-${blink}`,parameters:params});
}
for(const p of project.model.parameters)for(const value of [p.min,p.default,p.max])poses.push({id:`${p.id}-${value}`,parameters:{[p.id]:value}});
for(let i=1;i<=24;i++)poses.push({id:`mixed-${i}`,parameters:Object.fromEntries(project.model.parameters.map((p,j)=>[p.id,p.min+(p.max-p.min)*((i*(j*2+3)*.61803398875)%1)]))});
const exportInput=JSON.parse(await readFile(join(output,'puppetloom-source/model.json'),'utf8'));
const scale=exportInput.parameterScale??1;
const corePoses=poses.map(p=>({...p,parameters:Object.fromEntries(Object.entries(p.parameters).map(([k,v])=>[exportInput.parameterIds?.[k]??k,v*scale]))}));
const qa=join(output,process.argv[4]?'qa-editor':'qa');await mkdir(qa,{recursive:true});await writeFile(join(qa,'poses.json'),JSON.stringify(corePoses));
await new Promise((done,reject)=>{
 const child=spawn(config.java,['-Xmx4g','-Djava.library.path='+join(editor,'app/dll64'),'-cp',config.classpath+';'+join(editor,'app/lib/Live2DCubismCore.jar'),'puppetloom.exporter.CoreProbeKt',join(editor,'app/dll64/Live2DCubismCoreJNI.dll'),resolve(dirname(modelPath),model3.FileReferences.Moc),join(qa,'poses.json'),join(qa,'core-poses.json')],{stdio:'inherit',windowsHide:true});
 child.once('error',reject);child.once('exit',code=>code===0?done():reject(new Error(`Core probe failed ${code}`)));
});
const evaluated=JSON.parse(await readFile(join(qa,'core-poses.json'),'utf8'));let maxPixels=0,maxOpacity=0,maxUvError=0;const failures=[];
const samplers=new Map(project.layers.map(l=>[exportInput.drawableIds?.[l.id]??l.id,nativeLayerSampler(project,l)]));
for(const [i,pose]of evaluated.entries())for(const layer of pose.layers) {
 const sample=samplers.get(layer.id)(poses[i].parameters);let pixels=0;
 for(let j=0;j<sample.positions.length;j+=2)pixels=Math.max(pixels,Math.hypot(sample.positions[j]-layer.positions[j],sample.positions[j+1]-layer.positions[j+1]));
 const opacity=Math.abs(sample.opacity-layer.opacity);maxPixels=Math.max(maxPixels,pixels);maxOpacity=Math.max(maxOpacity,opacity);
 const sourceLayer=exportInput.layers.find(l=>l.id===layer.id);
 const uvError=Math.max(...layer.uvs.map((v,j)=>Math.abs(v-(j%2?1-sourceLayer.uvs[j]:sourceLayer.uvs[j]))));maxUvError=Math.max(maxUvError,uvError);
 // Canvas Y-down to Core Y-up reverses triangle winding; compare the same triangle vertices.
 const triangles=indices=>Array.from({length:indices.length/3},(_,i)=>indices.slice(i*3,i*3+3).sort((a,b)=>a-b).join(',')).sort();
 const topology=JSON.stringify(triangles(layer.indices))===JSON.stringify(triangles(sourceLayer.triangles));
 if(pixels>.55||opacity>.03||uvError>2e-6||!topology)failures.push({pose:pose.id,layer:layer.id,pixels,opacity,uvError,topology});
}
// Render the actual exported atlas and Core UVs; original layer textures would hide atlas defects.
const rendered=[];
for(const frame of evaluated.filter(p=>/^head-/.test(p.id) && (p.id.endsWith('blink-0')||p.id.startsWith('head-0-0-')))) {
 const clone=structuredClone(project);clone.model.bindings=[];clone.model.expressions=[];clone.model.behaviors=[];
 delete clone.runtime.poseField;delete clone.runtime.poseOcclusion;delete clone.runtime.collisionConstraints;
 for(const layer of clone.layers) {
  const exportedId=exportInput.drawableIds?.[layer.id]??layer.id;
  const core=frame.layers.find(d=>d.id===exportedId),input=exportInput.layers.find(d=>d.id===exportedId);
  if(!core||!input){layer.visible=false;continue;}
  layer.texture=model3.FileReferences.Textures[input.texture];
  layer.mesh.points=core.positions.reduce((a,v,j)=>{if(j%2===0)a.push({x:v/project.canvas.width,y:core.positions[j+1]/project.canvas.height});return a;},[]);
  layer.mesh.uvs=core.uvs.reduce((a,v,j)=>{if(j%2===0)a.push({x:v,y:1-core.uvs[j+1]});return a;},[]);
  layer.mesh.triangles=core.indices;layer.opacity=core.opacity;layer.order=core.order;
  layer.role='other';layer.weights={head:0,body:0,gaze:0,physics:0};layer.blinkMode='geometry';
 }
 const corePng=await renderProjectDirectoryPosePng(dirname(modelPath),clone,neutralMotionState,1280,1280);
 const values=poses.find(p=>p.id===frame.id).parameters;
 const defaults=Object.fromEntries(project.model.parameters.map(p=>[p.id,p.default]));
 const sourcePng=await renderProjectDirectoryPosePng(projectDirectory,project,{...neutralMotionState,parameters:{...defaults,...values}},1280,1280);
 await writeFile(join(qa,frame.id+'-core.png'),corePng);await writeFile(join(qa,frame.id+'-source.png'),sourcePng);
 const a=await sharp(corePng).ensureAlpha().raw().toBuffer(),b=await sharp(sourcePng).ensureAlpha().raw().toBuffer();
 let diff=0;for(let j=0;j<a.length;j+=4) {for(let c=0;c<3;c++)diff+=Math.abs(a[j+c]*a[j+3]/255-b[j+c]*b[j+3]/255);diff+=Math.abs(a[j+3]-b[j+3]);}
 const meanPremultipliedError=diff/a.length;rendered.push({pose:frame.id,meanPremultipliedError});
 if(meanPremultipliedError>1)failures.push({pose:frame.id,meanPremultipliedError});
}
const result={poses:poses.length,maxPixels,maxOpacity,maxUvError,rendered,failures,passed:failures.length===0};
await writeFile(join(qa,'core-comparison.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,failures:failures.slice(0,10)},null,2));if(!result.passed)process.exitCode=1;
