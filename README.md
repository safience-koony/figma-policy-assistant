# Figma 정책 도우미 (MVP)

Figma 화면을 캡처 → 화면 의미 추출(Vision) → 사내 정책 검색(RAG) → **출처가 붙은** 정책 요약·개발 체크리스트를 사이드패널에 띄우는 Chrome Extension 프로토타입.

```
Figma 탭 ──캡처──▶ Extension ──POST /api/analyze──▶ Server
                                                     ├─ Vision: 화면 → {screen, domain, keywords}
                                                     ├─ Retriever: BM25(+embedding) → Top 5 청크
                                                     └─ LLM: 발췌문에만 근거해 요약 + sourceIds
```

`node-id`는 "어디 화면이었는지" 기록용일 뿐, 매칭 근거는 스크린샷과 화면에서 읽힌 텍스트다. 그래서 Figma에서 노드가 바뀌어도 같은 도메인으로 판단된다.

## 구조

```
figma-plugin/       Figma 개발용 플러그인 (선택 프레임 즉시 감지)
extension/          Chrome Extension (MV3)
  manifest.json
  background.js     탭 캡처 + 사이드패널
  content.js        Figma URL → fileKey / nodeId (기록용)
  sidepanel.html/css/js   390px 사이드패널 UI
server/
  src/chunker.js    마크다운 → heading 경로가 붙은 청크 (출처 표기의 근거)
  src/retriever.js  한국어 BM25 (+ VOYAGE_API_KEY 있으면 임베딩 하이브리드)
  src/llm.js        Claude Vision / 요약 / Q&A, 키 없으면 MOCK
  src/index.js      /api/analyze, /api/ask, /api/policy/:id
  policies/*.md     샘플 정책 문서 (시연용 가상 문서)
  scripts/test-pipeline.js  검색 품질 회귀 테스트
design/ui-preview.html      사이드패널 전체 상태 디자인 시트
```

## Figma Plugin (Development)

Figma에서 `Plugins > Development > Import plugin from manifest...`를 선택한 뒤
`figma-plugin/manifest.json`을 지정하세요. 플러그인은 `selectionchange` 이벤트로
선택 프레임을 즉시 감지하고, 개발 중에는 `http://localhost:8787/api/figma-selection`에 전달합니다.

## 실행

```bash
cd server
npm install
cp .env.example .env      # 키 없이도 MOCK 모드로 전 과정이 돌아감
npm start                 # http://localhost:8787
npm run test:pipeline     # 검색 품질 확인 (6/6 passed)
```

### LLM 프로바이더

`.env` 의 `LLM_PROVIDER` 로 고른다. API 크레딧 없이도 **이미 로그인된 CLI 를 서브프로세스로 호출**해 쓸 수 있다.

| 값 | 호출 방식 | 비용 | 지연 |
|---|---|---|---|
| `api` | `ANTHROPIC_API_KEY` 로 Messages API 직접 호출 | API 크레딧 | 2~4초 |
| `codex` | `codex exec -i <png> -o <out> -` (stdin 프롬프트) | ChatGPT 구독 | 10~20초 |
| `claude` | `claude -p --output-format json --allowedTools Read` | Claude 구독 | 10~20초 |
| `mock` | 호출 없음 | 0 | 즉시 |

CLI 모드는 **그 CLI 가 로그인된 머신에서만** 동작하고, 에이전트를 한 번 기동하는 구조라 API 직접 호출보다 느리다. 개인·사내 프로토타입용이며, 서버를 배포하거나 여러 사람이 쓰게 되면 `api` 로 돌아와야 한다.

Extension: `chrome://extensions` → 개발자 모드 → **압축해제된 확장 프로그램 로드** → `extension/` 선택 → Figma 탭에서 툴바 아이콘 클릭.

> `manifest.json`을 고친 뒤에는 `chrome://extensions`에서 **새로고침(↻)** 을 눌러야 권한 변경이 반영된다.

### 캡처 권한

`captureVisibleTab`은 리터럴 `<all_urls>` 호스트 권한이나 **그 탭에 부여된 `activeTab`** 을 요구한다. `figma.com` 호스트 권한만으로는 통과하지 못하고, `activeTab`은 툴바 아이콘을 클릭한 그 순간에만 부여되어 탭을 옮기면 사라진다.

그래서 `<all_urls>`를 설치 시점이 아니라 **`optional_host_permissions`로 두고 필요할 때 요청**한다. 캡처가 막히면 사이드패널이 "권한 허용" 버튼을 띄우고, 클릭하면 `chrome.permissions.request({ origins: ['<all_urls>'] })` 로 승격한 뒤 분석을 이어서 진행한다. 설치 직후에는 모든 사이트 접근 경고가 뜨지 않고, 한 번 허용하면 이후 탭을 옮겨도 캡처가 깨지지 않는다.

## 설계상 중요한 선택

| 결정 | 이유 |
|---|---|
| 정책 전체를 LLM에 안 넣고 검색 → Top 5만 전달 | 정책이 500개가 되어도 속도·비용·정확도가 유지됨 |
| 청크 id를 `파일명#n`, 인용을 heading 경로로 | 답변마다 `연차 신청 정책 > 5. 신청 취소 > 5.2` 형태의 검증 가능한 출처가 붙음 |
| 기본 검색이 BM25 (외부 의존성 0) | 키·벡터 DB 없이 바로 돌아감. `retriever.js`만 pgvector/Qdrant로 교체 가능 |
| 한국어 토크나이저 = 어절 + 문자 bigram | 형태소 분석기 없이 "연차/연차를/연차의" 매칭. 정확도 부족하면 여기만 교체 |
| 프롬프트에 "발췌문에 없으면 추측 금지" | 개발자가 재검증할 수 있어야 도구로서 가치가 있음 |
| MOCK 모드 내장 | API 키 없이 UI·검색·연동을 먼저 검증 |

## 다음 단계

1. **정책 소스 연동** — Notion/Confluence → `policies/` 동기화 스크립트. 청크에 원문 URL을 넣으면 출처 배지가 실제 문서로 딥링크된다.
2. **임베딩 하이브리드** — `VOYAGE_API_KEY`만 넣으면 켜짐. 정책 100개 이상부터 체감된다.
3. **캐시** — `fileKey + nodeId + 스크린샷 해시`로 분석 결과 캐시. 같은 화면 재분석 비용 제거.
4. **확장** — Swagger / GitHub 코드 / QA 테스트 케이스를 같은 Retriever 인터페이스로 추가.

## 한계 (알고 시작해야 할 것)

- 캡처는 **보이는 영역**만이라, 긴 화면은 스크롤 위치에 따라 결과가 달라진다. → 프레임 단위 캡처(Figma REST `images` API)로 보강 가능.
- 화면이 와이어프레임 수준이면 Vision 신뢰도가 낮다. UI에 신뢰도를 노출해 사용자가 판단하게 했다.
- 정책 문서의 품질이 곧 답변 품질이다. 문서가 heading 구조를 갖추지 않으면 출처 표기가 뭉개진다.
## Policy Change Prompt

정책 버전 Diff를 커밋 메시지와 영향 분석 초안으로 바꾸는 프롬프트는
[`server/prompts/policy-commit-message.md`](server/prompts/policy-commit-message.md)에 있습니다.
