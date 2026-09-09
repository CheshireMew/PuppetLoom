import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { describe,it,expect } from 'vitest';
import { createProject,loadProject } from '../src/project.js';
import { bakeNativeLayer,exportNativeCubism,nativeLayerSampler,nativeCubismParameterId,nativeArtPositions } from '../src/cubism-native.js';
import { applyAuthoringOperations } from '../src/authoring.js';
import { artifactPath } from '../../../test/support/artifacts.js';

describe('native Cubism sampling',()=>{
  it('maps source IDs to stable, distinct Editor-compatible identifiers',()=>{
    expect(nativeCubismParameterId('ParamAngleX')).toBe('ParamAngleX');
    const ids=['param-head-yaw','param_head_yaw','眼睛','眼睛'.repeat(100)].map(nativeCubismParameterId);
    expect(new Set(ids).size).toBe(4);
    for(const id of ids)expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
    expect(nativeCubismParameterId('眼睛')).toBe(ids[2]);
  });
  it('retains combined keyforms, measures intermediate error, and never mutates source geometry',async()=>{
    const directory=artifactPath('native-cubism-sampling');
    await createProject({input:resolve('test/fixtures/semantic.psd'),output:directory});
    const original=await loadProject(directory),face=original.layers.find(l=>l.role==='face')!;
    const p=applyAuthoringOperations(original,[{op:'upsert-binding',binding:{id:'native-test',parameterIds:['param-head-yaw','param-head-pitch'],target:{kind:'layer',id:face.id},keyforms:[-1,0,1].flatMap(x=>[-1,0,1].map(y=>({values:[x,y],meshPointDeltas:{'0':{x:x*y*.001,y:0}}})))}}]);
    const before=JSON.stringify(p);const baked=bakeNativeLayer(p,p.layers.find(l=>l.id===face.id)!,.5);
    expect(baked.axes.map(a=>a.id)).toEqual(expect.arrayContaining(['param-head-yaw','param-head-pitch']));
    expect(baked.maxError.pixels).toBeLessThanOrEqual(.5);expect(JSON.stringify(p)).toBe(before);
    const cell=baked.cells.at(-1)!;
    const values=Object.fromEntries(baked.axes.map(a=>[a.id,a.keys.at(-1)!]));
    expect(cell.positions).toEqual(nativeLayerSampler(p,p.layers.find(l=>l.id===face.id)!)(values).positions);
  },120000);
  it('keeps texture placement affine when the neutral mesh is sculpted',async()=>{
    const directory=artifactPath('native-cubism-art-placement');
    await createProject({input:resolve('test/fixtures/semantic.psd'),output:directory});
    const project=await loadProject(directory),face=project.layers.find(l=>l.role==='face')!;
    const art=nativeArtPositions(project,face);
    face.mesh.points[0]!.x+=.02;
    const sculpted=nativeLayerSampler(project,face)({});
    expect(Math.abs(sculpted.positions[0]!-art[0]!)).toBeGreaterThan(1);
    expect(nativeArtPositions(project,face)).toEqual(art);
    // Absolute keyforms must still contain the sculpture; only the source art stays flat.
    expect(bakeNativeLayer(project,face).base.positions).toEqual(sculpted.positions);
  },120000);
});

describe.skipIf(!existsSync('runtime/cubism-exporter/config.json'))('configured JVM native Cubism exporter',()=>{
  it.each(['4.2','5.3'] as const)('encodes runtime target %s independently of the editor profile',async(runtimeVersion)=>{
    const root=artifactPath(`native-cubism-${runtimeVersion}`),directory=join(root,'source');
    await createProject({input:resolve('test/fixtures/semantic.psd'),output:directory});
    const result=await exportNativeCubism(directory,join(root,'export'),{runtimeVersion,editorVersion:'5.4'});
    expect(result.editorVersion).toBe('5.4');expect(result.runtimeVersion).toBe(runtimeVersion);
    expect(result.verification.valid).toBe(true);
    // MOC format v4 = Cubism 4.2; v5 = Cubism 5.0; v6 = Cubism 5.3.
    expect((await readFile(result.moc3))[4]).toBe(runtimeVersion==='4.2'?4:6);
  },180000);
  it('writes real editable and runtime files, keeps the source revision, and refuses an occupied directory',async()=>{
    const root=artifactPath('native-cubism-export'),directory=join(root,'source'),output=join(root,'export');
    await createProject({input:resolve('test/fixtures/semantic.psd'),output:directory});
    const before=await readFile(join(directory,'calibration/current.json'));
    const result=await exportNativeCubism(directory,output);
    expect(result.verification.valid).toBe(true);expect(result.status).toBe('awaiting-visual-review');
    expect(result.editorVersion).toBe('5.3');expect(result.runtimeVersion).toBe('5.0');
    expect(Object.values(result.parameterIds).every(id=>/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(id))).toBe(true);
    expect(Object.values(result.drawableIds).every(id=>/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(id))).toBe(true);
    expect((await readFile(result.moc3)).subarray(0,4).toString()).toBe('MOC3');
    expect((await readFile(result.cmo3)).length).toBeGreaterThan(1000);
    expect(JSON.parse(await readFile(join(output,'codec-report.json'),'utf8')).readback).toBe(true);
    expect(await readFile(join(directory,'calibration/current.json'))).toEqual(before);
    await expect(exportNativeCubism(directory,output)).rejects.toThrow('已存在');
  },180000);
});
