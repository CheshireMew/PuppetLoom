# Third-party notices

PuppetLoom contains selectively adapted ideas and independently reimplemented algorithms from the following projects. No upstream application is vendored; the relevant licenses and notices are retained below.

## Anime2.5DRig

- Project: `hakoniwa/Anime2.5DRig`, based on `852wa/Anime2.5DRig`
- Use: mesh-rigging, anchor detection, and spring-motion techniques
- License: MIT
- Copyright: Copyright (c) 2026 hakoniwa

The MIT license text is reproduced in `docs/licenses/Anime2.5DRig-MIT.txt`.

## AutoLive2d

- Project: `Fenglin-Maple/AutoLive2d`
- Use: PSD traversal, semantic layer classification, paired-feature handling, and safety-probe techniques
- License: Apache License 2.0

AutoLive2d is not vendored as an application. PuppetLoom does not include its Cubism, face-tracking, microphone, editor, or See-through integration code.

## See-Through

- Project: `shitagaki-lab/see-through` — <https://github.com/shitagaki-lab/see-through>
- Paper: Jian Lin et al., “See-through: Single-image Layer Decomposition for Anime Characters,” ACM SIGGRAPH 2026 Conference Proceedings — <https://arxiv.org/abs/2602.03749>
- Use: an external, important upstream stage that turns approved anime character artwork into a coordinate-preserving layered PSD for PuppetLoom inspection and rigging
- License: Apache License 2.0

PuppetLoom does not vendor, embed, or redistribute See-Through source code or model weights. The normal workflow sends the user to the official online demonstration, or uses a separately installed local See-Through project only when the online service is unavailable and the user explicitly chooses local execution. Generated PSDs and character artwork remain subject to their own applicable rights. We thank the See-Through authors for making single-image anime layer decomposition available to this workflow.

## MediaPipe Tasks Vision and Face Landmarker

- Project: Google MediaPipe Tasks Vision (`@mediapipe/tasks-vision`)
- Use: local camera face landmarks and blendshapes in the desktop character window
- License: Apache License 2.0

PuppetLoom uses the published JavaScript/Wasm package and downloads the official Face Landmarker task model to `D:\Tools\PuppetLoom\runtime-assets\mediapipe` with a pinned SHA-256 check. The model is not committed to this repository. Camera frames stay in the local renderer and are converted to short-lived motion values; PuppetLoom does not upload or save video frames. MediaPipe remains under Apache License 2.0; its published package also links its license and privacy notice at <https://goo.gle/mediapipe-privacy>.

## Mediabunny

- Project: `Vanilagy/mediabunny` — <https://github.com/Vanilagy/mediabunny>
- Version: `1.55.2`
- Use: WebCodecs-backed, incrementally streamed WebM video and Opus audio recording in the desktop character window
- License: Mozilla Public License 2.0 — <https://www.mozilla.org/MPL/2.0/>

PuppetLoom consumes the published npm package without modifying its source files. The desktop build includes the modules used by the recording path. The corresponding source code is available from the upstream repository and the versioned npm package at <https://www.npmjs.com/package/mediabunny/v/1.55.2>; those files remain licensed under MPL-2.0 and are not relicensed by PuppetLoom's AGPL-3.0-or-later license.

## electron-texture-bridge and Spout2

- Project: `naporin0624/electron-texture-bridge` (`@napolab/texture-bridge-core` 0.15.0) — <https://github.com/naporin0624/electron-texture-bridge>
- Upstream native component: `leadedge/Spout2`
- Use: Electron shared-texture to D3D11/Spout2 zero-copy output on Windows x64
- Licenses: MIT for electron-texture-bridge; BSD 2-Clause-style terms for bundled Spout2/SpoutDX portions

PuppetLoom consumes the published prebuilt Windows x64 N-API binary. The native package stays outside ASAR so Electron can load it. Applicable MIT and Spout2 notices are reproduced in `docs/licenses/electron-texture-bridge-MIT-Spout2-BSD.txt` and shipped with the application.

## ag-psd

- Project: `Agamnentzar/ag-psd`
- Use: PSD decoding and deterministic test-fixture encoding
- License: MIT

The MIT license text is reproduced in `docs/licenses/ag-psd-MIT.txt`.

## poly2tri.js

- Project: `r3mi/poly2tri.js`
- Use: constrained Delaunay triangulation of Alpha contours, holes, and interior ArtMesh sample points
- License: BSD 3-Clause
- Copyright: Copyright (c) 2009-2014, Poly2Tri Contributors

The BSD 3-Clause license text is reproduced in `docs/licenses/poly2tri-BSD-3-Clause.txt`.

## Lucide

- Project: `lucide-icons/lucide`
- Use: scalable interface icons in the desktop layer controls
- License: ISC; selected icons derived from Feather retain the MIT license
- Copyright: Copyright (c) 2026 Lucide Icons and Contributors; Feather portions Copyright (c) 2013-present Cole Bemis

The applicable ISC and MIT license texts are reproduced in `docs/licenses/Lucide-ISC-MIT.txt`.

## Live2D Cubism

- Project and documentation: Live2D Cubism Editor, Cubism SDK manuals, External Application Integration API, and `Live2D/CubismWebSamples`
- Use: public model3/exp3/motion3/physics3/cdi3 structure, Editor WebSocket protocol, and local compatibility validation

PuppetLoom does not distribute Cubism Editor, Cubism Core, the Cubism SDK, `.moc3` compilers, or Live2D sample assets. A sparse checkout of the official Mao sample is used only for local D-drive validation and is excluded from this repository. Live2D and Cubism remain trademarks and copyrighted products of Live2D Inc.; using their editor, SDK, Core, or exported data remains subject to Live2D's terms and licenses.

## Third demonstration project

The unpublished project shown in the Bilibili video “即刻出道！零基础半小时也能做出可直播的皮套！” informed the independently implemented coherent-pose design: one semantic head pose drives affected face layers, while grouped hair, body, and accessories follow through filtered response and separate inertia. It also informed conservative anti-separation limits. No source code, model weights, or assets from that project are available or included.

## Artwork

PuppetLoom deliberately versions one named character-art reference pack under `skills/live2d-puppet/assets/blue-whale-maid-reference/`. It supports the bundled Skill's documented layering, rigging, expression, and visual-review workflow; it is not a programmatic test fixture, runtime artifact, or private user project. The artwork and generated layered PSD remain subject to their applicable rights and are not relicensed by the AGPL-3.0-or-later code license.

All ordinary repository fixtures are programmatically generated geometric test art. Other private user artwork and downloaded character samples remain excluded from Git; locally inspected third-party samples retain their original rights.

