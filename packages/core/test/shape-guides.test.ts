import { describe, expect, it } from 'vitest';
import { compileShapeGuide } from '../src/shape-guides.js';
import { geometryEditOperationSchema } from '../src/schema.js';
import { transformKeyform } from '../src/geometry-edit.js';
import { makeGridMesh } from '../src/mesh.js';
import type { GeometryEditOperation, Point, PuppetLoomProject } from '../src/types.js';

describe('character-authored shape guides', () => {
  it('fits moving and fixed landmarks, uses circular pixel support on a rectangular canvas, and stays local', () => {
    const canvas = { width: 1000, height: 500 };
    const source = { x: .5, y: .5 }, fixed = { x: .55, y: .5 };
    const fn = compileShapeGuide({ kind: 'fit-landmarks', radiusPixels: 100, points: [
      { label: 'chin', source, target: { x: .502, y: .504 } }, { label: 'cheek fixed', source: fixed, target: fixed }
    ] }, canvas);
    expect(fn(source).x).toBeCloseTo(.502, 12); expect(fn(source).y).toBeCloseTo(.504, 12);
    expect(fn(fixed).x).toBeCloseTo(fixed.x, 12); expect(fn(fixed).y).toBeCloseTo(fixed.y, 12);
    expect(fn({ x: .1, y: .1 })).toEqual({ x: .1, y: .1 });
    const radial = compileShapeGuide({ kind: 'fit-landmarks', radiusPixels: 100, points: [{ label: 'tip', source, target: { x: .51, y: .5 } }] }, canvas);
    expect(radial({ x: .55, y: .5 }).x - .55).toBeCloseTo(radial({ x: .5, y: .6 }).x - .5, 12);
  });

  it.each([0, .3, -.5])('folds side walls while preserving a central stroke on an eye axis rotated by %s radians', angle => {
    const canvas = { width: 1200, height: 700 };
    const point = (x: number, y: number): Point => ({ x: (500 + x * Math.cos(angle) - y * Math.sin(angle)) / canvas.width, y: (280 + x * Math.sin(angle) + y * Math.cos(angle)) / canvas.height });
    const local = (p: Point) => ({ x: (p.x * canvas.width - 500) * Math.cos(angle) + (p.y * canvas.height - 280) * Math.sin(angle), y: -(p.x * canvas.width - 500) * Math.sin(angle) + (p.y * canvas.height - 280) * Math.cos(angle) });
    const fn = compileShapeGuide({ kind: 'curve-warp', source: [point(0, 0), point(25, -12), point(50, 0)], target: [point(0, 0), point(25, 12), point(50, 0)], profile: [
      { source: -20, target: -3 }, { source: -2, target: -1.5 }, { source: 2, target: 1.5 }, { source: 25, target: 1.6 }
    ] }, canvas);
    expect(local(fn(point(25, -6))).y).toBeCloseTo(6, 10);
    expect(local(fn(point(25, -4))).y - local(fn(point(25, -8))).y).toBeCloseTo(3, 10);
    expect(local(fn(point(25, 19))).y - local(fn(point(25, -4))).y).toBeCloseTo(.1, 10);
    expect(local(fn(point(0, 0))).x).toBeCloseTo(0, 10);
    expect(local(fn(point(50, 0))).x).toBeCloseTo(50, 10);
  });

  it('rejects ambiguous landmarks and reversed curve profiles', () => {
    expect(() => compileShapeGuide({ kind: 'fit-landmarks', radiusPixels: 30, points: [
      { label: 'a', source: { x: 0, y: 0 }, target: { x: 0, y: 0 } }, { label: 'b', source: { x: 0, y: 0 }, target: { x: 1, y: 0 } }
    ] }, { width: 100, height: 100 })).toThrow('重合');
    expect(() => compileShapeGuide({ kind: 'curve-warp', source: [{ x: 0, y: 0 }, { x: .5, y: 0 }, { x: 1, y: 0 }], target: [{ x: 0, y: 0 }, { x: .5, y: .1 }, { x: 1, y: 0 }], profile: [{ source: -2, target: 1 }, { source: 2, target: -1 }] }, { width: 100, height: 100 })).toThrow('严格递增');
  });

  function meshProject(): PuppetLoomProject {
    return { canvas: { width: 100, height: 100 }, layers: [{ id: 'face', mesh: makeGridMesh({ x: 0, y: 0, width: 1, height: 1 }, 5, 5) }], model: { deformers: [], bindings: [{ id: 'head', target: { kind: 'layer', id: 'face' }, parameterIds: ['yaw', 'pitch'], keyforms: [-1, 0, 1].flatMap(x => [-1, 0, 1].map(y => ({ values: [x, y] }))) }] } } as unknown as PuppetLoomProject;
  }
  it('edits one diagonal key, preserves the other eight, and blocks foldovers before touching the key', () => {
    const p = meshProject(), original = structuredClone(p.model.bindings[0]!.keyforms);
    const op: GeometryEditOperation = { op: 'transform-keyform', bindingId: 'head', values: [1, 1], coordinateSpace: 'rest-canvas', selection: { kind: 'all' }, transforms: [{ kind: 'fit-landmarks', radiusPixels: 45, points: [{ label: 'chin', source: { x: .5, y: .75 }, target: { x: .52, y: .75 } }] }] };
    transformKeyform(p, op);
    expect(p.model.bindings[0]!.keyforms.slice(0, 8)).toEqual(original.slice(0, 8));
    expect(p.model.bindings[0]!.keyforms[8]!.meshPointDeltas?.['17']?.x).toBeCloseTo(.02, 10);
    const snapshot = structuredClone(p);
    op.transforms = [{ kind: 'fit-landmarks', radiusPixels: 15, points: [{ label: 'bad', source: { x: .5, y: .5 }, target: { x: 2, y: .5 } }] }];
    expect(() => transformKeyform(p, op)).toThrow('翻折'); expect(p).toEqual(snapshot);
  });
  it('validates finite radii and strict field spelling through the public patch schema', () => {
    const base = { op: 'transform-keyform', bindingId: 'head', values: [1], coordinateSpace: 'rest-canvas', selection: { kind: 'all' } };
    expect(() => geometryEditOperationSchema.parse({ ...base, transforms: [{ kind: 'fit-landmarks', radiusPixels: Infinity, points: [] }] })).toThrow();
  });
});
