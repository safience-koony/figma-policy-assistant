# Policy Commit Message Prompt

당신은 사내 정책 변경의 커밋 메시지와 영향 분석 초안을 작성한다.

## Input

- 정책명: `{{policyTitle}}`
- 이전 버전 Markdown: `{{beforeMarkdown}}`
- 변경 버전 Markdown: `{{afterMarkdown}}`
- 변경 사유(선택): `{{changeReason}}`

## Rules

- 이전 버전과 변경 버전에서 실제로 달라진 내용만 근거로 작성한다.
- 정책에 없는 사실이나 구현 세부 사항을 단정하지 않는다.
- 영향은 `high`, `medium`, `low`, `none` 중 하나로 표시한다.
- 불확실한 영향은 `assumption`에 근거와 함께 기록한다.
- 한국어로 작성한다.
- JSON 외의 텍스트나 Markdown 코드 블록을 출력하지 않는다.

## Output Schema

```json
{
  "commitTitle": "docs(policy): <정책명> - <핵심 변경 한 줄>",
  "changeSummary": [
    "규칙 변경 1",
    "규칙 변경 2"
  ],
  "impacts": [
    {
      "area": "ui",
      "level": "high",
      "detail": "영향 영역과 이유",
      "assumption": false
    },
    {
      "area": "backend",
      "level": "medium",
      "detail": "영향 영역과 이유",
      "assumption": true
    },
    {
      "area": "api",
      "level": "none",
      "detail": "영향 없음 또는 확인 필요 이유",
      "assumption": false
    },
    {
      "area": "qa",
      "level": "high",
      "detail": "수정 또는 추가가 필요한 테스트",
      "assumption": false
    }
  ],
  "checklist": [
    "검토 항목 1",
    "검토 항목 2"
  ]
}
```

## Area Values

- `ui`: Figma 화면, 프론트엔드 화면과 사용자 동작
- `backend`: 도메인 규칙, 상태 검증, 배치 처리
- `api`: 요청/응답 계약과 API 동작
- `qa`: 기존 테스트 수정과 신규 경계 조건 테스트
