import { describe, expect, it } from 'vitest';
import { frozenSecondaryState } from '../scripts/lib/motion-evidence.mjs';
import { createDefaultAuthoringModel, resolveMotionState } from '../packages/core/src/model.js';
import { neutralMotionState } from '../packages/core/src/deform.js';

describe('isolated secondary motion evidence', () => {
  it('keeps primary motion neutral after parameter resolution while preserving hair outputs', () => {
    const project = { model: createDefaultAuthoringModel() };
    project.model.parameters.push({ id: 'custom-hair-swing', name: 'Hair swing', group: 'Hair', min: -1, max: 1, default: 0 });
    const state = { ...neutralMotionState, headYaw: 0.8, blinkLeft: 1, blinkRight: 0.6,
      mouthOpen: 1, parameters: { 'param-head-yaw': 0.8, 'param-blink-left': 1,
        'param-blink-right': 0.6, 'param-mouth-open': 1, 'custom-hair-swing': 0.07 },
      secondary: { hairStrands: { lock: { x: [0, 0.03], y: [0, 0.01] } } } };
    const result = resolveMotionState(project, frozenSecondaryState(state, project));
    expect(result.headYaw).toBe(0);
    expect(result.blinkLeft).toBe(0);
    expect(result.blinkRight).toBe(0);
    expect(result.mouthOpen).toBe(0);
    expect(result.parameters['custom-hair-swing']).toBe(0.07);
    expect(result.secondary).toEqual(state.secondary);
    expect(state.parameters['param-mouth-open']).toBe(1);
  });
});
