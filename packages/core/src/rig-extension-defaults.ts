import type { FaceDepthProfile, TorsoVolumeProfile } from "./types.js";

export function defaultFaceDepthProfile(): FaceDepthProfile {
  return {
    kind: "semantic-depth-v1",
    points: [
      { id: "forehead", position: 0.12, depth: 0.015 },
      { id: "noseRoot", position: 0.34, depth: 0.055 },
      { id: "noseTip", position: 0.52, depth: 0.16 },
      { id: "upperLip", position: 0.66, depth: 0.075 },
      { id: "lowerLip", position: 0.73, depth: 0.06 },
      { id: "chin", position: 0.92, depth: 0.025 }
    ]
  };
}

export function defaultTorsoVolumeProfile(strength = 0.8): TorsoVolumeProfile {
  return {
    kind: "torso-volume-v1",
    strength,
    points: [
      { id: "upperChest", position: 0.08, depth: 0.02 },
      { id: "chest", position: 0.3, depth: 0.08 },
      { id: "waist", position: 0.62, depth: -0.025 },
      { id: "hip", position: 0.92, depth: 0.045 }
    ]
  };
}
