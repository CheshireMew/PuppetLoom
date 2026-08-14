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

## ag-psd

- Project: `Agamnentzar/ag-psd`
- Use: PSD decoding and deterministic test-fixture encoding
- License: MIT

The MIT license text is reproduced in `docs/licenses/ag-psd-MIT.txt`.

## Third demonstration project

The unpublished project shown in the Bilibili video “即刻出道！零基础半小时也能做出可直播的皮套！” informed the independently implemented coherent-pose design: one semantic head pose drives affected face layers, while grouped hair, body, and accessories follow through filtered response and separate inertia. It also informed conservative anti-separation limits. No source code, model weights, or assets from that project are available or included.

## Artwork

No user artwork or downloaded character sample is committed to PuppetLoom. Repository fixtures are programmatically generated geometric test art. Locally inspected third-party samples retain their original rights and are excluded from Git.
