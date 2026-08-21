<!-- readme-header:start -->

<p align="center">
  <img src="./assets/readme/logo.svg" width="112" alt="PuppetLoom">
</p>

<h1 align="center">PuppetLoom</h1>

<p align="center">
  <strong>レイヤー分けされたキャラクターPSDから、検証・調整を続けられる2Dパペットを作ります。</strong>
</p>

<p align="center">
  <a href="./README.md">中文</a> · <a href="./README.en.md">English</a> · <strong>日本語</strong> | <a href="./docs/AGENT_USAGE.md">文档</a> | <a href="./CONTRIBUTING.md">贡献</a> | <a href="https://github.com/CheshireMew/PuppetLoom/issues">反馈</a>
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
  <img src="./assets/readme/puppetloom-cover-v2.png" width="100%" alt="PuppetLoom：レイヤーキャラクターを動かす">
</p>

PuppetLoom は、レイヤー分けされたキャラクター PSD から、安全に検証でき、revision を重ねながら改善できる 2D パペットを作る Windows 向けツールです。

## レイヤー素材から、確認しながら育てられるパペットへ

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="レイヤーPSDから構造化リグ、revision証拠、自律動作する2Dパペットへ進む流れ">
</p>

PuppetLoom は、デスクトップアプリ、決定論的 CLI、通常ディレクトリ形式のプロジェクト、外部 Agent 用 Skill を一つの流れにまとめます。PSD を読み込み、控えめな初期リグを作り、中立姿勢と 12 の動作姿勢を検証し、正確な revision の比較証拠を残したうえで、透明なデスクトップウィンドウとして実行できます。デスクトップアプリは作成、再生、確認、手動調整を担当し、外部 Agent は公開 CLI と同梱 Skill を使います。アプリ内に Agent チャットを埋め込む設計ではありません。

最初の目標は、素材が実際に持つ情報の範囲で自然に動くことです。閉じ目や三段階の口素材がなければ不足として報告し、危険な変形は縮小または停止し、採用済みの調整はすべて復元可能な revision として残します。

## できること

| 目的 | PuppetLoom が行うこと |
| --- | --- |
| PSD から作成 | レイヤー検査、連結成分によるノイズ判定、意味点、非矩形 ArtMesh、控えめなリグ、通常ディレクトリへの強検証付き生成。 |
| 自然な待機と動き | 呼吸、視線が先行する頭部回転、首と上半身の追従、髪・衣装・尻尾の重さに応じた遅れ、短い自律シーケンス、表情と素材依存アクション。 |
| 外部 Agent で改善 | 構造化仕様 → 読み取り専用 plan → 部位ごとの apply。revision、局所比較、連続運動表、blocker、最終 verification を返します。 |
| 手動で調整 | レイヤー、軸、メッシュ、ウェイト、草稿復元、revision 保存、前後比較、採用・却下・復元を備えたエディタ。 |
| 入力と録画 | マウス、カメラ、マイク、ショートカット、外部入力を優先度・blend・TTL で統合し、再生可能 JSON と復旧可能 WebM を保存。 |
| Cubism へ渡す | exp3 / motion3 / physics3 / cdi3、Editor API で扱える範囲の同期、Editor 出力 moc3/model3 を真源にした runtime ディレクトリ。 |

PSD の可視レイヤー、順序、座標、透明度、ブレンドモード記録を保持します。プロジェクトはパラメータ、1D/2D keyform、deformer、表情、物理、名前付き behavior を revision 管理します。頭部回転では目と眉を不透明のまま保ち、耳や横髪など顔の外側の部位だけを必要に応じて弱めます。

## クイックスタート

現在の検証対象は Windows です。Node.js 24 以上、npm 11、WebGL2 対応 GPU が必要です。インストーラーはまだ配布していないため、公開ソースからの起動が正式な入口です。

```powershell
git clone https://github.com/CheshireMew/PuppetLoom.git
cd PuppetLoom
npm install
npm run build
npm run desktop
```

ルートの `启动PuppetLoom.cmd` からも同じデスクトップ入口を開けます。ビルドがなければ自動で作成し、ユーザーデータ、キャッシュ、ログはリポジトリ外の設定済みデータルートに保存します。

## キャラクターを作成して実行する

1. レイヤー分けされたキャラクター PSD を作成画面へドロップします。元画像は任意で、再合成の差分確認だけに使います。
2. Alpha 連結成分、確信度の高いノイズ除去、保持された曖昧な細部、自動分割の結果を確認します。
3. 新規または空の出力ディレクトリを選びます。PuppetLoom は別ディレクトリで全体を作成・検証し、成功後にだけ目的地へ公開します。
4. エディタで確認・調整するか、そのまま透明なパペットウィンドウを開きます。

パペットウィンドウは最前面、マウス透過、システムマウス追従、ローカル顔トラッキング、マイク口パク、実在する表情・アクションの実行、録画に対応します。録画では透明・単色背景、解像度、24/30/60 FPS、手動または時間指定停止、マイク音声を選べます。通常の録画は WebM のみを生成し、再現やデバッグが必要な場合だけ、マウス追従・顔・口・表情・アクション・外部制御を再生できるモーション JSON を追加保存できます。再生時は project revision を確認し、ライブ入力を一時的に分離します。中断時は partial ファイルと報告を残します。

## 外部 Agent に制作を任せる

CLI を実行できる Agent に [`skills/live2d-puppet/SKILL.md`](skills/live2d-puppet/SKILL.md) を読み込ませ、PSD または既存プロジェクトと、結果を表す依頼を渡します。

> リポジトリの live2d-puppet Skill を使って、このレイヤーPSDから PuppetLoom プロジェクトを作成してください。既存素材だけを使い、最初に基準証拠を見せてから部位ごとに制作し、採用済み revision を保持してください。

既存キャラクターには、頂点番号ではなく見た目の目標を伝えます。

> 頭部回転と前髪の追従を改善してください。顔の立体感を保ち、髪の根元を外さず、反発を小さくしてください。採用済みの目と口は変更しないでください。

正式な書き込み経路は `agent specification` → `agent plan --spec` → `agent apply --spec` です。外部 Agent が依頼と視覚証拠を解釈し、PuppetLoom は構造化仕様を実行・検証して、各部位を completed / not-present / needs-assets / blocked として記録します。詳細は [Agent 利用ガイド](docs/AGENT_USAGE.md) を参照してください。

録画用の実演や外部制御の確認には、`.\skills\live2d-puppet\scripts\demo_puppetloom.ps1 -Project D:\Puppets\my-character -KeepOpen` を使います。5 つの editor workspace を順に見せた後、公開 runtime CLI でパペットを動かします。演示中は revision と calibration draft を変更しません。

## CLI で最初のプロジェクトを作る

すべての決定論的コマンドは JSON を返せます。次の例は PSD を検査し、Git 管理対象外の `workspace` にプロジェクトを作り、検証して実行します。

```powershell
$input = "D:\Characters\my-character.psd"
$project = Join-Path $PWD "workspace\my-character"

node .\apps\cli\dist\index.js inspect --input $input --json
node .\apps\cli\dist\index.js create --input $input --output $project --seed 42 --json
node .\apps\cli\dist\index.js verify --project $project --json
node .\apps\cli\dist\index.js play --project $project
```

`describe`、`render`、`record`、`compare`、`history` で正確な revision を確認します。`calibrate`、`author`、`actions`、`extensions`、構造化 `agent` フローは次の復元可能 revision を作ります。源 PSD が本当に更新された場合だけ `migrate` で新しいプロジェクトを作り、`export` は現在の有効 revision を別の可搬ディレクトリへ書き出します。

## プロジェクト、revision、証拠

PuppetLoom プロジェクトは独自圧縮形式ではなく通常のディレクトリです。manifest、源 PSD、texture、現在の calibration、revision session、report、任意の素材依頼、入力・録画記録を含みます。書き込みは base revision とプロジェクトロックを確認し、検証と証拠作成が完了してから current revision を一度だけ切り替えます。復元も履歴を消さず、新しい revision を作ります。

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

形式と互換性は [プロジェクト形式](docs/PROJECT_FORMAT.md)、確認ループは [calibration 証拠](docs/CALIBRATION_EVIDENCE.md)、寿命管理は [versioning](docs/VERSIONING.md) にまとめています。

## Cubism との境界

PuppetLoom は Cubism Editor API が公開する構造を準備・同期し、表情、motion、physics、表示情報の sidecar を生成できます。本物の `.moc3` を作る真源は Cubism Editor です。公式 API が ArtMesh 頂点や Warp 制御点を書けない場合、bridge は制限を明示し、完全互換と報告しません。手順と必要な Editor バージョンは [Cubism bridge](docs/CUBISM_BRIDGE.md) を参照してください。

## ドキュメント

- [Editor ガイド](docs/EDITOR_GUIDE.md) — 手動確認、草稿、calibration、証拠、runtime preview。
- [Agent 利用ガイド](docs/AGENT_USAGE.md) — 構造化仕様、部位修正、authoring、migration、終了コード。
- [Architecture](docs/ARCHITECTURE.md) — core、renderer、CLI、desktop、外部 Agent の責務境界。
- [Validation](docs/VALIDATION.md) と [Testing](docs/TESTING.md) — 検証済み範囲と、人または実素材による確認が残る範囲。
- [統一 pose model](docs/COHERENT_POSE_MODEL.md) — 頭、体、視線、遠近、occlusion、secondary motion の関係。
- [Cubism bridge](docs/CUBISM_BRIDGE.md) — 公式形式への受け渡しと検証限界。

## 開発と検証

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

build、typecheck、test は現在の core / renderer を再構築し、古い宣言ファイルによる誤った成功を防ぎます。テスト PSD はスクリプト生成で、ユーザーキャラクターを含みません。実行成果物は書き込み前に容量を確認し、inventory と hash を残します。`artifacts:report` は候補を報告するだけで、自動削除しません。貢献方法は [CONTRIBUTING.md](CONTRIBUTING.md) にあります。

## Star History

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/CheshireMew/PuppetLoom/star-history/star-history-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/CheshireMew/PuppetLoom/star-history/star-history.svg">
  <img alt="PuppetLoom の GitHub Star History" src="https://raw.githubusercontent.com/CheshireMew/PuppetLoom/star-history/star-history.svg">
</picture>

## ライセンスと第三者素材

PuppetLoom は [Apache License 2.0](LICENSE) で公開されています。採用したプロジェクト、依存関係の用途、モデル取得境界、完全な帰属情報は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にあります。ユーザーキャラクターやダウンロードした第三者キャラクター例はリポジトリに含めません。
