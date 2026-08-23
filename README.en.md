<!-- readme-header:start -->

<p align="center">
  <img src="./assets/readme/logo.svg" width="112" alt="PuppetLoom">
</p>

<h1 align="center">PuppetLoom</h1>

<p align="center">
  <strong>Turn a layered character PSD into a verifiable 2D puppet that agents and artists can keep improving.</strong>
</p>

<p align="center">
  <a href="./README.md">中文</a> · <strong>English</strong> · <a href="./README.ja.md">日本語</a> | <a href="./docs/AGENT_USAGE.md">文档</a> | <a href="./CONTRIBUTING.md">贡献</a> | <a href="https://github.com/CheshireMew/PuppetLoom/issues">反馈</a>
</p>

<p align="center">
  <a href="https://x.com/0xCheshire" title="X"><img src="https://img.shields.io/badge/X-%400xCheshire-000000?logo=x&amp;logoColor=white" alt="X：@0xCheshire"></a>
  <a href="https://t.me/CheshireBTC" title="Telegram"><img src="https://img.shields.io/badge/Telegram-CheshireBTC-26A5E4?logo=telegram&amp;logoColor=white" alt="Telegram：CheshireBTC"></a>
  <a href="https://blog.blacknico.com/" title="Blog"><img src="https://img.shields.io/badge/Blog-blog.blacknico.com-2E7D32?logo=rss&amp;logoColor=white" alt="博客：blog.blacknico.com"></a>
  <a href="https://blacknico.com/" title="Homepage"><img src="https://img.shields.io/badge/Home-blacknico.com-1F6FEB?logo=googlechrome&amp;logoColor=white" alt="个人主页：blacknico.com"></a>
</p>

<p align="center">
  <a href="https://github.com/CheshireMew/PuppetLoom/stargazers"><img src="https://img.shields.io/github/stars/CheshireMew/PuppetLoom?style=flat" alt="GitHub Stars"></a>
  <a href="https://github.com/CheshireMew/PuppetLoom/forks"><img src="https://img.shields.io/github/forks/CheshireMew/PuppetLoom?style=flat" alt="GitHub Forks"></a>
  <a href="https://github.com/CheshireMew/PuppetLoom/blob/main/LICENSE"><img src="https://img.shields.io/github/license/CheshireMew/PuppetLoom?style=flat" alt="Repository License"></a>
</p>

<!-- readme-header:end -->

<p align="center">
  <img src="./assets/readme/puppetloom-cover-v2.png" width="100%" alt="PuppetLoom: bring layered characters to life">
</p>

PuppetLoom turns a layered character PSD into a safe, revisioned 2D puppet that can move on its own and keep improving through an external agent or manual calibration.

## From layered artwork to a puppet you can inspect

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Layered PSD artwork becomes a structured rig, revisioned evidence, and an autonomous 2D puppet">
</p>

PuppetLoom combines a Windows desktop application, deterministic CLI, project format, and Agent Skill around one workflow: import layered artwork, create a conservative rig, verify neutral plus 12 motion poses, inspect exact-revision evidence, and run the result in a transparent desktop window.

The desktop application handles creation, playback, inspection, and manual fallback. An external agent uses the public CLI and bundled Skill; PuppetLoom does not embed an agent chat or hide model changes behind opaque files.

The first result aims for a character that moves plausibly with the artwork it actually has. PuppetLoom itself never fakes missing closed-eye or mouth art with parameters; the complete Agent workflow can create genuinely missing expression assets in the source style and never redraw an existing closed mouth. Unsafe motion is reduced or blocked, and every accepted calibration remains recoverable.

## See-Through and the quality boundary

PuppetLoom's workflow from a single illustration is built around the anime-character layer decomposition provided by [See-Through](https://github.com/shitagaki-lab/see-through). See-Through converts approved artwork into a layered PSD with original canvas coordinates and transparency, forming an important bridge into PuppetLoom's structural analysis, rigging, and verification. We thank the See-Through authors and their paper, [“See-through: Single-image Layer Decomposition for Anime Characters”](https://arxiv.org/abs/2602.03749). PuppetLoom does not embed or redistribute See-Through code or model weights. The official online demo is the default route; local deployment is a last option when the online service is unavailable and the user chooses it.

PuppetLoom is intended to produce a simple, good-looking, usable 2D puppet relatively quickly. It is not a replacement for a professionally commissioned Live2D model. Automated decomposition and rigging cannot fully replace artwork designed for hidden overlap, expression assets, and motion, or a modeler's work on large head turns, detailed meshes, complex physics, and performance timing. For higher-end results, work with a professional character artist and Live2D modeler.

## What you get

| Need | PuppetLoom delivers |
| --- | --- |
| Create from a PSD | Layer inspection, connected-component cleanup, semantic landmarks, irregular ArtMesh generation, conservative rigging, and a strongly validated ordinary project directory. |
| Make the character feel alive | Breathing, eye-leading head turns, neck and upper-body follow, weighted hair/clothing/tail lag, short autonomous sequences, expressions, and material-aware actions. |
| Improve with an external agent | A structured specification → read-only plan → per-part apply workflow with exact revisions, focused comparisons, motion sheets, blockers, and final verification. |
| Tune by hand | A desktop editor for layers, pivots, mesh and weight controls, draft recovery, revision saves, before/after comparison, acceptance, rejection, and restore. |
| Drive and record | Mouse, camera, microphone, hotkeys, and local runtime sources with priority, blend, and TTL; deterministic input JSON and recoverable WebM recording. |
| Hand off to Cubism | exp3, motion3, physics3, and cdi3 sidecars, Editor API inspection/sync where supported, then a runtime directory based on Editor-exported moc3/model3 files. |

The project preserves visible PSD layers, order, coordinates, opacity, and blend-mode records. It supports versioned parameters, 1D/2D keyforms, deformers, expressions, physics, and named behaviors. Head turns keep eyes and eyebrows opaque; peripheral parts may fade near the face edge, and near/far hair order may swap with direction.

## Quick start

PuppetLoom is currently verified on Windows. You need Node.js 24+, npm 11, and a WebGL2-capable GPU. There is no packaged installer yet; the public source repository is the supported installation path.

```powershell
git clone https://github.com/CheshireMew/PuppetLoom.git
cd PuppetLoom
npm ci
npm run build
npm run desktop
```

The root `启动PuppetLoom.cmd` launcher provides the same desktop entry and builds missing output automatically. Runtime data, caches, and logs use the configured PuppetLoom data root rather than the repository.

## Create and run a character

1. Drop a layered character PSD into the creation window. A reference image is optional and is used only to compare recomposition.
2. Review detected connected components, confident noise cleanup, preserved uncertain details, and any automatic layer split.
3. Choose a new or empty output directory and create the project. PuppetLoom builds in a side directory, validates the full result, and only then publishes it to the destination.
4. Open the calibration editor to inspect or adjust the rig, or launch the transparent puppet window immediately.

The puppet window can stay on top, pass mouse input through, follow the system pointer, use local face tracking and microphone-driven mouth motion, trigger the expressions/actions the project actually contains, and record a performance.

Video recording supports transparent or solid-color backgrounds, output resolution, 24/30/60 FPS, manual or timed stop, and optional microphone audio. A normal recording produces only a WebM. Replayable motion JSON is an explicit option for reproducing or debugging pointer, face, mouth, expression, behavior, and external-control input. Replay checks the saved project revision and temporarily isolates live sources. Interrupted recordings keep a partial file and report.

## Let an external Agent do the rigging

Load [`skills/live2d-puppet/SKILL.md`](skills/live2d-puppet/SKILL.md) in an Agent that can run the repository CLI, then give it the PSD or an existing PuppetLoom project and a result-oriented request:

> Use the repository's live2d-puppet Skill to create this layered PSD as a PuppetLoom project. Use only existing artwork. Show me the baseline evidence first, then work part by part and preserve every accepted revision.

For an existing character, say what should look different rather than naming vertices:

> Improve the head turn and front-hair follow. The face should keep its volume, the hair roots must stay attached, and the rebound should be smaller. Do not change accepted eye and mouth results.

The formal write path is `agent specification` → `agent plan --spec` → `agent apply --spec`. The external Agent interprets the request and visual evidence; the application executes a structured specification, validates it, and records each completed, absent, asset-blocked, or blocked part. See [Agent usage](docs/AGENT_USAGE.md) for the full loop.

For a recording-ready proof of external control, run `.\skills\live2d-puppet\scripts\demo_puppetloom.ps1 -Project D:\Puppets\my-character -KeepOpen`. It visits the five editor workspaces before driving the puppet through the public runtime CLI. The demo is read-only and preserves both revision and calibration draft.

## CLI: first successful project

All deterministic commands can return JSON. The following sequence inspects a PSD, creates a project under the ignored workspace directory, and verifies the result:

```powershell
$input = "D:\Characters\my-character.psd"
$project = Join-Path $PWD "workspace\my-character"

node .\apps\cli\dist\index.js inspect --input $input --json
node .\apps\cli\dist\index.js create --input $input --output $project --seed 42 --json
node .\apps\cli\dist\index.js verify --project $project --json
node .\apps\cli\dist\index.js play --project $project
```

Use `describe`, `render`, `record`, `compare`, and `history` to inspect a precise revision. Use `calibrate`, `author`, `actions`, `extensions`, or the structured `agent` workflow to create the next recoverable revision.

`migrate` is reserved for a genuinely updated source PSD and writes a new project. `export` bakes the current valid revision into a portable directory. The full CLI and exit-code contract live in [Agent usage](docs/AGENT_USAGE.md).

## Project, revisions, and evidence

A PuppetLoom project is an ordinary directory rather than a private archive. It contains the manifest, source PSD, textures, current calibration, revision sessions, reports, optional asset requests, and performance/input recordings.

Writes use a base revision and project lock. Validation and evidence finish before the current revision changes; restore creates another traceable revision and never erases history.

```text
my-character/
  puppetloom.json
  source/source.psd
  textures/
  calibration/current.json
  calibration/sessions/
  reports/
  requests/
  supplements/
```

Read [Project format](docs/PROJECT_FORMAT.md) for the schema and compatibility rules, [Calibration evidence](docs/CALIBRATION_EVIDENCE.md) for the review loop, and [Versioning](docs/VERSIONING.md) for lifecycle details.

## Cubism boundary

PuppetLoom can prepare and synchronize structures exposed by the Cubism Editor API, and can generate expression, motion, physics, and display-information sidecars. Cubism Editor remains the only source of a real `.moc3`.

When the official API cannot write ArtMesh vertices or Warp control points, the bridge reports that limit instead of claiming full compatibility. See [Cubism bridge](docs/CUBISM_BRIDGE.md) for the supported sequence and Editor versions.

## Documentation

- [Editor guide](docs/EDITOR_GUIDE.md) — manual inspection, draft handling, calibration, evidence, and runtime preview.
- [Agent usage](docs/AGENT_USAGE.md) — structured specifications, per-part repair, authoring, migration, and exit codes.
- [Architecture](docs/ARCHITECTURE.md) — responsibilities of core, renderer, CLI, desktop, and the external Agent boundary.
- [Validation record](docs/VALIDATION.md) and [Testing](docs/TESTING.md) — what has been verified, on which chain, and what still requires real artwork or human judgment.
- [Unified pose model](docs/COHERENT_POSE_MODEL.md) — head, body, gaze, perspective, occlusion, and secondary-motion relationships.
- [Cubism bridge](docs/CUBISM_BRIDGE.md) — official-format handoff and verification limits.

## Development and validation

```powershell
npm run build
npm run typecheck
npm test
npm run test:e2e
npm run test:launcher
npm run test:real-project
npm run test:motion-evidence
npm run test:visual
npm run test:performance
npm run artifacts:report
```

Build, typecheck, and test rebuild the active core/renderer sources so stale declarations cannot produce a false pass. Generated test PSDs contain no user characters. Runtime artifacts have storage preflight, inventory, and hashes; reporting identifies cleanup candidates but never deletes them automatically. Contribution expectations are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Star History

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/CheshireMew/PuppetLoom/star-history/star-history-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/CheshireMew/PuppetLoom/star-history/star-history.svg">
  <img alt="GitHub Star History for PuppetLoom" src="https://raw.githubusercontent.com/CheshireMew/PuppetLoom/star-history/star-history.svg">
</picture>

## License and third-party work

PuppetLoom is licensed under the [Apache License 2.0](LICENSE). Adopted projects, dependency roles, model-download boundaries, and complete attribution are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). User characters and downloaded third-party character samples are not committed to this repository.
