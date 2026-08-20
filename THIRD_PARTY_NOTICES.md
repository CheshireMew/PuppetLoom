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

## MediaPipe Tasks Vision and Face Landmarker

- Project: Google MediaPipe Tasks Vision (`@mediapipe/tasks-vision`)
- Use: local camera face landmarks and blendshapes in the desktop character window
- License: Apache License 2.0

PuppetLoom uses the published JavaScript/Wasm package and downloads the official Face Landmarker task model to `D:\Tools\PuppetLoom\runtime-assets\mediapipe` with a pinned SHA-256 check. The model is not committed to this repository. Camera frames stay in the local renderer and are converted to short-lived motion values; PuppetLoom does not upload or save video frames. The Apache License 2.0 text is available in the repository root `LICENSE`; MediaPipe's package also links its privacy notice at <https://goo.gle/mediapipe-privacy>.

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

No user artwork or downloaded character sample is committed to PuppetLoom. Repository fixtures are programmatically generated geometric test art. Locally inspected third-party samples retain their original rights and are excluded from Git.
