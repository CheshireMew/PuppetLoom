# PuppetLoom 한국어 UI 포팅

[CheshireMew/PuppetLoom](https://github.com/CheshireMew/PuppetLoom)의 데스크톱 앱·에디터 문구를 한국어로 바꾼 저장소입니다.

원저작권은 CheshireMew에게 있습니다. 라이선스는 원본과 같은 **AGPL-3.0-or-later**입니다. `LICENSE`, `LICENSE-NOTICE.md`, `LICENSING.md`를 그대로 따릅니다.

## 다른 사람이 받는 방법

이 저장소는 **공개**입니다. GitHub에서 누구나 받을 수 있습니다.

```powershell
git clone https://github.com/sleeeppy/PuppetLoom.git
cd PuppetLoom
npm ci
npm run build
npm run desktop
```

또는 GitHub 페이지의 **Code → Download ZIP**으로 받아도 됩니다.

Windows x64, Node.js 24 이상, npm 11, WebGL2 그래픽이 필요합니다. 설치형 실행 파일(NSIS)은 이 포팅에 따로 올려 두지 않았습니다. 위처럼 소스에서 실행하면 됩니다.

## 원본과의 차이

- 앱 UI, 제작 센터, 에디터, 환경 점검·검증 메시지: 한국어
- 레이어 이름 분류에 한국어 패턴 추가
- 원본 CLI 도움말·문서 전체 번역은 하지 않음

캐릭터 PSD, 사용자 프로젝트(`workspace/`), See-Through 결과물은 이 저장소에 없습니다.
