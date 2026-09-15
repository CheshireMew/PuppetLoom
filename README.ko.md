> 이 저장소는 [CheshireMew/PuppetLoom](https://github.com/CheshireMew/PuppetLoom)의 **한국어 UI 포팅**입니다. 데스크톱 앱과 앱 안 메시지는 한국어입니다. 라이선스는 원본과 같은 AGPL-3.0-or-later입니다.

<!-- readme-header:start -->

<p align="center">
  <img src="./assets/readme/logo.svg" width="112" alt="PuppetLoom">
</p>

<h1 align="center">PuppetLoom</h1>

<p align="center">
  <strong>레이어로 나뉜 캐릭터 PSD를, 자동 제작·검증·계속 캘리브레이션할 수 있는 2D 동적 캐릭터로 바꿉니다.</strong>
</p>

<p align="center">
  <a href="./README.md">中文</a> · <a href="./README.en.md">English</a> · <a href="./README.ja.md">日本語</a> · <strong>한국어</strong> | <a href="./docs/AGENT_USAGE.md">문서</a> | <a href="./CONTRIBUTING.md">기여</a> | <a href="https://github.com/CheshireMew/PuppetLoom/issues">피드백</a>
</p>

<p align="center">
  <a href="https://x.com/0xCheshire" title="X"><img src="https://img.shields.io/badge/X-%400xCheshire-000000?logo=x&amp;logoColor=white" alt="X：@0xCheshire"></a>
  <a href="https://t.me/CheshireBTC" title="Telegram"><img src="https://img.shields.io/badge/Telegram-CheshireBTC-26A5E4?logo=telegram&amp;logoColor=white" alt="Telegram：CheshireBTC"></a>
  <a href="https://blog.blacknico.com/" title="Blog"><img src="https://img.shields.io/badge/Blog-blog.blacknico.com-2E7D32?logo=rss&amp;logoColor=white" alt="블로그：blog.blacknico.com"></a>
  <a href="https://blacknico.com/" title="Homepage"><img src="https://img.shields.io/badge/Home-blacknico.com-1F6FEB?logo=googlechrome&amp;logoColor=white" alt="홈페이지：blacknico.com"></a>
</p>

<p align="center">
  <a href="https://github.com/CheshireMew/PuppetLoom/stargazers"><img src="https://img.shields.io/github/stars/CheshireMew/PuppetLoom?style=flat" alt="GitHub Stars"></a>
  <a href="https://github.com/CheshireMew/PuppetLoom/forks"><img src="https://img.shields.io/github/forks/CheshireMew/PuppetLoom?style=flat" alt="GitHub Forks"></a>
  <a href="https://github.com/CheshireMew/PuppetLoom/blob/main/LICENSE"><img src="https://img.shields.io/github/license/CheshireMew/PuppetLoom?style=flat" alt="Repository License"></a>
</p>

<!-- readme-header:end -->

<p align="center">
  <img src="./assets/readme/puppetloom-cover-v2.png" width="100%" alt="PuppetLoom: 레이어 캐릭터를 움직이게">
</p>

## 레이어 PSD에서, 계속 만들 수 있는 캐릭터까지

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="레이어 PSD가 구조화 바인딩과 revision 증거를 거쳐 스스로 움직이는 2D 캐릭터가 됩니다">
</p>

PuppetLoom은 Windows 데스크톱 앱, 결정적 CLI, 일반 폴더 프로젝트 형식, 외부 Agent Skill을 한 흐름으로 묶습니다. 레이어 캐릭터 PSD를 읽고 보수적인 초기 바인딩을 만들고, 중립 자세와 12개 동작 자세를 검증한 뒤, 매 수정을 복원 가능한 revision으로 남기고, 투명 데스크톱 창에서 실행합니다. 데스크톱 앱은 생성, 확인, 재생, 사람이 직접 고치는 일을 맡고, 외부 Agent는 공개 CLI와 저장소 Skill로 캐릭터를 만들거나 고칩니다. 소프트웨어 안에 Agent 대화창이나 숨은 모델 호출은 없습니다.

첫 결과는 “지금 있는 소재가 허용하는 범위에서 그럴듯하게 움직이는 것”을 목표로 합니다. PuppetLoom 자체는 없는 눈 감기나 입 모양을 파라미터로 가짜로 만들지 않습니다. 전체 Agent 제작 흐름은 원화 스타일로 정말 빠진 표정 소재를 보강할 수 있고, 이미 있는 다문 입은 다시 그리지 않습니다. 동작이 위험하면 범위를 줄이거나 막고, 캘리브레이션은 증거를 만든 뒤에야 현재 revision을 바꿉니다.

이 포팅에서 앱 UI와 사용자에게 보이는 메시지는 한국어입니다. 레이어 이름 분류에 한국어 패턴도 넣었습니다. CLI 도움말과 기술 문서 전체는 아직 원문입니다.

## See-Through와 효과의 한계

한 장의 원화에서 시작하는 자동 흐름은 [See-Through](https://github.com/shitagaki-lab/see-through)의 애니메 캐릭터 레이어 분해에 기대고 있습니다. See-Through는 확인된 원화를 원본 캔버스 좌표와 투명 채널이 있는 레이어 PSD로 바꿉니다. 이 PSD가 PuppetLoom의 구조 분석, 바인딩, 검증으로 들어가는 중요한 다리입니다. See-Through 저자와 논문 [“See-through: Single-image Layer Decomposition for Anime Characters”](https://arxiv.org/abs/2602.03749)에 감사합니다. PuppetLoom은 See-Through 코드나 모델을 내장하거나 다시 배포하지 않습니다. 기본은 공식 온라인 데모이고, 온라인을 쓸 수 없고 사용자가 직접 고를 때만 로컬 배포를 고려합니다.

PuppetLoom의 목표는 자동화로 비교적 빠르게, 괜찮고 쓸 수 있는 단순한 2D 동적 캐릭터를 얻는 것입니다. 전문 맞춤 Live2D를 대체하지는 않습니다. 자동 레이어 분리와 자동 바인딩은 가려지는 속살, 표정 소재, 움직일 구조를 그리는 작업이나, 큰 고개 돌림, 세밀한 메시, 복잡한 물리, 연출 박자를 다듬는 작업을 대신하기 어렵습니다. 완성도를 더 높이려면 캐릭터 화가와 Live2D 모델러에게 맡기는 편이 맞습니다.

## 무엇을 얻나

| 하고 싶은 일 | PuppetLoom이 주는 결과 |
| --- | --- |
| PSD로 캐릭터 만들기 | 레이어 사전 검사, Alpha 연결 영역과 노이즈 판단, 의미 제어점, 불규칙 ArtMesh, 보수적 바인딩, 강한 검증을 통과한 뒤에야 공개되는 일반 프로젝트 폴더. |
| 자연스럽게 대기하고 움직이기 | 호흡, 시선이 먼저 가는 고개 돌림, 목과 상체 따라가기, 무게에 맞춰 늦게 오는 머리/옷/꼬리, 짧은 동작 조각으로 만든 자율 타임라인. |
| 외부 Agent로 만들거나 고치기 | 구조화 명세 → 읽기 전용 계획 → 부위별 실행. 각 부위는 정확한 revision, 부분 전후 비교, 연속 동작표, 차단 항목, 최종 검증을 돌려줍니다. |
| 직접 확인하고 미세 조정 | 레이어, 축, 메시, 가중치, 반응 파라미터를 고치는 데스크톱 에디터. 초안은 복원 가능하고, 저장·수락·거부·복원마다 기록이 남습니다. |
| 캐릭터 구동과 녹화 | 마우스, 카메라, 마이크, 단축키, 외부 입력을 우선순위·혼합 가중치·TTL로 합성. 다시 재생할 수 있는 입력 JSON과 복원 가능한 WebM을 저장합니다. |
| 캐릭터 일괄 관리 | 제작 센터에서 한 장 레이어 작업, 여러 프로젝트 점검, 능력 공백, 환경 검사, 업데이트를 모읍니다. 프로젝트 사이 분석은 반복 문제와 이미 수락한 증거에서만 후보를 냅니다. |
| 방송과 공연 | 좌우 눈, 눈썹, 미소, 볼, A/I/U/E/O, 상체와 양손 입력. 의상/소품/프리셋, 충돌 제약, 비파괴 Take, OSC/VMC, MIDI, 패드, 컨트롤 패널. |
| 웹이나 OBS로 내보내기 | 투명 Web/OBS 폴더와 단일 파일 Web SDK. 상태와 동작은 웹 API로 계속 제어할 수 있습니다. |
| Cubism에 넘기기 | 한 번에 편집 가능한 cmo3, moc3, 텍스처와 exp3/motion3/physics3/cdi3를 내보냅니다. 프로젝트 버전과 런타임 버전을 따로 고를 수 있고, Editor API 인수인계 경로도 남깁니다. |

프로젝트는 PSD의 보이는 레이어, 순서, 좌표, 투명도, 혼합 모드 기록을 유지합니다. 표준/사용자 파라미터, 1차원·2차원 키 형태, 디포머, 표정, 파라미터 물리, 이름 있는 행동을 지원합니다. 고개를 돌리면 먼 쪽 눈을 좁히고 옮기지만, 눈과 눈썹은 항상 완전히 불투명합니다. 귀나 옆머리 같은 바깥 부품만 얼굴 가장자리에 가까워지면 덜 보이고, 가까운 머리와 먼 머리의 그리기 순서는 방향에 따라 바뀔 수 있습니다.

이미 있는 프로젝트는 `extensions plan/apply`로 다음 복원 가능 revision에 다발 머리, 여섯 점 옆얼굴 깊이, 명시적 몸통 부피 곡선을 넣을 수 있습니다. 프로젝트를 다시 만들 필요는 없습니다. `actions plan/apply`는 실제 레이어를 보고 표준 표정, 끄덕임, 도리도리, 인사, 관찰, 짧은 말하기, 몸 튕김, 손 흔들기, 발걸음, 귀 튕김, 꼬리 흔들기를 채우고, 부위마다 완료·없음·소재 부족을 보고합니다.

## 빠른 시작

지금은 Windows x64만 검증했습니다. 일반 사용자는 프로젝트가 만드는 NSIS 설치 파일을 쓸 수 있습니다. 소스에서 실행하려면 Node.js 24 이상, npm 11, WebGL2 그래픽이 필요합니다. 이 한국어 포팅에는 설치 파일을 따로 올려 두지 않았습니다. 아래처럼 소스에서 실행하면 됩니다.

```powershell
git clone https://github.com/sleeeppy/PuppetLoom.git
cd PuppetLoom
npm ci
npm run build
npm run desktop
```

또는 GitHub의 **Code → Download ZIP**으로 받아도 됩니다.

저장소 루트의 `启动PuppetLoom.cmd`도 같은 데스크톱 입구입니다. 빌드 결과가 없으면 자동으로 만듭니다. 사용자 데이터, 캐시, 로그는 설정한 PuppetLoom 데이터 루트에 쓰고, 저장소와 섞지 않습니다.

캐릭터 PSD, 사용자 프로젝트(`workspace/`), See-Through 결과물은 이 저장소에 없습니다.

## 캐릭터 만들고 실행하기

1. 레이어 캐릭터 PSD를 만들기 창에 끌어다 놓습니다. 원본 캐릭터 그림은 선택입니다. 다시 합성했을 때 캐릭터가 바뀌었는지 비교할 때만 씁니다.
2. Alpha 연결 영역, 확신 높은 노이즈, 남긴 그림 디테일, 자동 분할과 폴백 분할 결과를 확인합니다.
3. 새 폴더나 빈 폴더를 고릅니다. PuppetLoom은 옆 폴더에서 만들기와 강한 검증을 끝낸 뒤에야 목표 폴더에 한 번에 올립니다.
4. 캘리브레이션 에디터에서 확인하거나 고치거나, 바로 투명 캐릭터 창을 엽니다.

캐릭터 창은 항상 위, 마우스 관통, 시스템 마우스 따라가기, 이 컴퓨터 카메라 얼굴 추적, 마이크 입 모양, 그리고 그 프로젝트에 실제로 있는 표정과 동작을 지원합니다. 메인 창은 마지막 위치, 크기, 최대화를 복원하고, 캐릭터 창은 프로젝트별로 위치, 크기, 항상 위, 따라가기 모드, 배율을 복원합니다. 모니터를 바꾸면 보이는 영역으로 다시 옮깁니다. 마우스 관통은 재시작 후 복원하지 않아서, 창을 못 만지는 일을 막습니다. 카메라는 먼저 자연스럽게 뜬 눈과 다문 입 기준을 잡고, 0이 아닌 중립 점수, 한쪽 눈 오검출, 재연결 잔여를 걸러서 눈이나 입이 반투명 교차 페이드에 오래 머물지 않게 합니다.

영상 녹화는 투명, 검정, 흰색, 그린스크린, 사용자 단색 배경을 고를 수 있고, 출력 해상도, 24/30/60 FPS, 수동 또는 타이머 종료, 이미 켜 둔 마이크 녹음을 설정할 수 있습니다. 녹화 중에는 경과 시간을 보여주고, 타이머 녹화는 남은 시간도 보여줍니다. 멈추면 파일 마무리 단계를 분명히 보여 주고, 성공하면 미리보기에서 저장 결과를 확인합니다. 일반 녹화는 WebM만 만듭니다. 재현이나 디버그가 필요하면 동작 데이터를 추가로 체크해서, 마우스 따라가기, 얼굴 추적, 입 모양, 표정, 동작, 외부 제어를 다시 재생할 수 있는 JSON을 저장합니다. 재생은 프로젝트 revision을 확인하고 실시간 입력을 잠시 끊습니다. 창이 갑자기 닫혀도 `.partial.webm`과 중단 보고서를 남겨서, 녹화를 조용히 잃지 않습니다.

## 외부 Agent에게 맡기기

저장소 CLI를 실행할 수 있는 외부 Agent가 [`skills/live2d-puppet/SKILL.md`](skills/live2d-puppet/SKILL.md)를 읽게 한 뒤, PSD나 기존 PuppetLoom 프로젝트와 결과 중심 요청을 줍니다.

> 저장소의 live2d-puppet Skill로 이 레이어 PSD를 PuppetLoom 프로젝트로 만들어 주세요. 있는 소재만 쓰고, 먼저 기준 증거를 보여 준 다음 부위별로 작업하고, 이미 수락한 revision은 모두 남겨 주세요.

이미 있는 캐릭터를 고칠 때는 꼭짓점 번호를 말하지 말고, 눈으로 보고 싶은 변화를 말합니다.

> 고개 돌림과 앞머리 따라가기를 개선해 주세요. 얼굴 부피는 유지하고, 머리 뿌리가 떨어지면 안 되고, 반동은 조금 더 작게. 이미 수락한 눈과 입 결과는 건드리지 마세요.

정식 쓰기 경로는 `agent specification` → `agent plan --spec` → `agent apply --spec`입니다. 외부 Agent는 자연어와 시각 증거를 이해하고, PuppetLoom은 구조화 명세를 결정적으로 실행하고 검증한 뒤, 각 부위를 `completed`, `not-present`, `needs-assets`, `blocked`로 기록합니다. 전체 흐름은 [Agent 호출 설명](docs/AGENT_USAGE.md)을 보세요.

화면 녹화나 외부 제어를 빠르게 보여 주려면 `.\skills\live2d-puppet\scripts\demo_puppetloom.ps1 -Project D:\Puppets\my-character -KeepOpen`을 실행합니다. 먼저 에디터 작업 공간 다섯 곳을 보여 주고, 공개 runtime CLI로 캐릭터 창을 구동합니다. 데모는 읽기 전용이라 revision과 캘리브레이션 초안을 바꾸지 않습니다. 자세한 한계는 같은 Skill의 실시간 데모 흐름이 관리합니다.

## CLI: 첫 프로젝트 끝내기

결정적 명령은 모두 JSON을 돌려줄 수 있습니다. 아래 연속 경로는 PSD를 검사하고, Git이 무시하는 `workspace` 폴더에 프로젝트를 만든 뒤, 검증하고 캐릭터 창을 엽니다.

```powershell
$input = "D:\Characters\my-character.psd"
$project = Join-Path $PWD "workspace\my-character"

node .\apps\cli\dist\index.js inspect --input $input --json
node .\apps\cli\dist\index.js create --input $input --output $project --seed 42 --json
node .\apps\cli\dist\index.js verify --project $project --json
node .\apps\cli\dist\index.js play --project $project
```

정확한 revision은 `describe`, `render`, `record`, `compare`, `history`로 확인합니다. 다음 복원 가능 revision은 `calibrate`, `author`, `actions`, `extensions` 또는 구조화 `agent` 흐름으로 만듭니다. 소스 PSD가 정말 바뀌었을 때만 `migrate`로 새 프로젝트를 만들고, `export`는 지금 유효한 revision을 새 이식 가능 폴더에 굽습니다. 전체 명령과 종료 코드는 [Agent 호출 설명](docs/AGENT_USAGE.md)을 보세요.

일상 대량 제작은 `source`, `doctor`, `library scan`, `tracking-assets`, `production-config`, `take`, `improvements analyze`, `export-web`을 씁니다. 이 명령은 데스크톱 제작 센터와 프로젝트 형식을 공유합니다. 구체적인 흐름은 [제작 센터와 대량 생산](docs/PRODUCTION_WORKFLOW.md)을 보세요.

## 프로젝트, revision, 증거

PuppetLoom 프로젝트는 비공개 압축이 아니라 일반 폴더입니다. 프로젝트 목록, 소스 PSD, 텍스처, 현재 캘리브레이션, revision 세션, 보고서, 선택 소재 요청, 입력·공연 녹화가 들어갑니다. 쓰기 작업은 base revision과 프로젝트 잠금을 확인하고, 검증과 증거가 모두 끝난 뒤에야 현재 revision을 한 번 바꿉니다. 복원도 새 추적 가능 revision을 만들고, 기록은 지우지 않습니다.

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

필드와 호환 규칙은 [프로젝트 형식](docs/PROJECT_FORMAT.md), 사람과 Agent가 같이 쓰는 검토 순환은 [캘리브레이션 증거 설명](docs/CALIBRATION_EVIDENCE.md), 산출물 수명은 [버전과 산출물 관리](docs/VERSIONING.md)를 보세요.

## Cubism의 실제 한계

PuppetLoom의 `cubism export`는 PSD2Live가 쓰는 Umamo 인코더로 `.cmo3`와 `.moc3`를 직접 만들고, 텍스처, 동작, 표정, 물리를 같이 냅니다. 처음에는 `node scripts/setup-cubism-exporter.mjs`로 의존성을 맞춥니다. 데스크톱 내보내기 센터와 CLI는 같은 구현을 씁니다. 기본 프로젝트 목표는 Editor 5.3.01부터, 런타임 목표는 SDK 5.0이며, 버전은 따로 고를 수 있습니다. 내보내기는 현재 revision의 실제 메시 운동을 남기지만, 프로그램 디포머는 메시 키 형태로 바뀌므로 원본 모델링 계층과 완전히 같다고 말할 수 없습니다. 파일을 만든 뒤에도 눈으로 다시 봐야 합니다. [Cubism 내보내기와 Editor 브리지](docs/CUBISM_BRIDGE.md)를 보세요.

## 문서

- [캘리브레이션 에디터 설명](docs/EDITOR_GUIDE.md): 사람이 확인, 초안, 캘리브레이션, 증거, 실행 미리보기.
- [Agent 호출 설명](docs/AGENT_USAGE.md): 구조화 명세, 부위별 재작업, authoring, 마이그레이션, 종료 코드.
- [아키텍처 설명](docs/ARCHITECTURE.md): core, renderer, CLI, desktop, 외부 Agent의 책임 경계.
- [검증 기록](docs/VALIDATION.md)과 [테스트 설명](docs/TESTING.md): 이미 확인한 경로, 그리고 실제 소재나 사람 판단이 아직 필요한 범위.
- [통일 자세 모델](docs/COHERENT_POSE_MODEL.md): 머리, 몸, 시선, 원근, 가림, 이차 운동의 관계.
- [Cubism 공식 형식 브리지](docs/CUBISM_BRIDGE.md): 공식 형식 인수인계와 호환 제한.
- [제작 센터와 대량 생산](docs/PRODUCTION_WORKFLOW.md): 소스 준비, 여러 프로젝트 점검, 추적 2.0, 캐릭터 상태, 제약, Take, 프로젝트 사이 분석.
- [Runtime 어댑터와 Web SDK](docs/RUNTIME_INTEGRATION.md): OSC/VMC, MIDI, 패드, 컨트롤 패널, OBS, 웹 임베드.
- [Windows 설치, 업데이트, 환경 검사](docs/WINDOWS_DISTRIBUTION.md): NSIS 설치 파일, D 드라이브 캐시, 업데이트 채널, 환경 점검.

문서 본문은 아직 원문입니다.

## 개발과 검증

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

`build`, `typecheck`, `test`는 현재 core와 renderer 소스를 다시 빌드해서, 낡은 선언 파일 때문에 테스트가 가짜로 통과하지 않게 합니다. 테스트 PSD는 전부 스크립트가 만들며 사용자 캐릭터는 넣지 않습니다. 실행 산출물은 쓰기 전에 용량과 디스크 여유를 확인하고, 목록과 해시를 남깁니다. `artifacts:report`는 정리 후보만 보고하고 자동으로 지우지 않습니다. 실제 캐릭터 기준은 소재 용도 선언과 revision 잠금이 있는 목록으로 돌립니다. 저장소에 명시적으로 등록된 캐릭터 미술 예외는 `skills/live2d-puppet/assets/blue-whale-maid-reference/` 장기 참고 팩뿐입니다. 테스트 fixture, 런타임 산출물, 개인 사용자 프로젝트가 아니며, 다른 실제 캐릭터 소재는 커밋하면 안 됩니다. 기여 약속은 [CONTRIBUTING.md](CONTRIBUTING.md)를 보세요.

## Star History

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/CheshireMew/PuppetLoom/star-history/star-history-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/CheshireMew/PuppetLoom/star-history/star-history.svg">
  <img alt="PuppetLoom GitHub Star History" src="https://raw.githubusercontent.com/CheshireMew/PuppetLoom/star-history/star-history.svg">
</picture>

## 라이선스와 서드파티

PuppetLoom은 [GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)](LICENSE)를 씁니다. 버전 선언은 [LICENSE-NOTICE.md](LICENSE-NOTICE.md)를 보세요. 참고한 프로젝트, 의존성 용도, 런타임 모델 다운로드 한계, 전체 감사는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있습니다. 저장소에는 사용자 캐릭터 그림이나 내려받은 서드파티 캐릭터 샘플을 올리지 않습니다.
