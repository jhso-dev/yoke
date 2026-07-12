# yoke — Vision

## 문제

AI 에이전트는 조직/개인의 지식을 모른다. 지식은 위키, DB, 파일, 사람 머릿속에 흩어져 있고,
AI에게 전달되는 건 매번 수동으로 복붙한 조각뿐이다.

## yoke가 하는 것

**지식에 최적화된 DB**: 온톨로지(entity/relation 스키마)로 지식을 구조화해 저장하고,
사용자의 현재 맥락에 맞는 부분집합을 골라 AI에게 주입한다(context injection).

- **앞단**: AI가 소비하기 좋은 인터페이스 — MCP 서버, CLI.
- **뒷단**: 이미 있는 저장소를 활용 — SQLite, 전통 RDB, 벡터 DB, 그래프 DB, 파일.
- **호환**: 전통 DB와 잘 붙는다. 기존 데이터를 yoke 온톨로지로 매핑해 읽을 수 있어야 한다.

## v1 스코프

**포함**: 코어 지식 모델(entity/relation/온톨로지), SQLite 백엔드 1개,
MCP 서버, thin CLI, 기본 검색(키워드 + 관계 탐색),
지식 정책 전체(docs/KNOWLEDGE-POLICY.md — 게이트, lifecycle, 주입 필터,
중복·모순 탐지, 신선도, 승격 CLI),
**persona**(person 스코프 질의 + skill export) 및 캡처 경로 3개(MCP 기록
도구, CLI, GitHub PR 리뷰 커넥터).

v1 구현 순서: 코어 모델 → SQLite → 지식 정책 게이트 → MCP 서버 →
캡처 → persona. persona는 앞 단계 전부를 소비하는 최상층이므로 마지막.

**v1 제외 — 로드맵 버전으로 계획됨 (docs/ROADMAP.md)**:

| 항목 | 버전 | 설계 문서 |
|---|---|---|
| 벡터·그래프 DB 어댑터, RDB read-mapping | v2.0 | docs/BACKENDS.md |
| 감사 로그 | v2.0 | docs/ENTERPRISE.md |
| 웹 UI | v2.5 | docs/WEB-UI.md |
| 멀티테넌시 / auth / RBAC | v3.0 | docs/ENTERPRISE.md |
| 분산 / HA | v3.5 | docs/ENTERPRISE.md |

상위 버전 항목을 하위 버전에서 먼저 구현하는 PR은 거절한다.
단, **설계가 이를 막지 않게는 한다** — 지켜야 할 하위 호환 제약은
각 설계 문서 상단에 명시돼 있다 (예: ENTERPRISE.md의 "v0.1부터 지켜야 하는 제약").

## persona — 사람의 판단 연속성 (v1 포함)

엔터프라이즈 요구: "Nathen(FE 팀장)이 부재해도 Nathen의 기록된 판단 기준으로
업무가 진행된다." yoke에서 이것은 새 시스템이 아니라 **질의 + 포장**이다:

- **persona = 특정 인물이 출처인 verified 지식 + 판단 원칙에 대한 저장된 질의를
  skill(SKILL.md / MCP prompt)로 export한 것.** 하드 규칙 2(출처 필수)가 있어
  모든 지식이 이미 사람과 연결되어 있으므로 가능하다.
- **파생물이지 저장물이 아니다.** 매번 현재 verified 지식에서 생성 — stale 강등이
  persona에 자동 반영된다. 스냅샷/파인튜닝 방식은 거버넌스를 상속받지 못하므로 금지.
- **흉내가 아니라 인용.** 출력은 "Nathen은 X를 이렇게 결정했고 근거는 Y [출처]"
  형식. 환각 persona는 오염 주입이며, 인용 기반이어야 감사 가능하다.
- **판단은 문서가 아니라 결정에 있다.** 기본 온톨로지에 `decision` entity 타입
  (결론·근거·기각한 대안) 포함. 이 타입 없이는 persona가 설 데이터가 안 쌓인다.

persona의 병목은 질의가 아니라 **캡처**다. v1 캡처 경로 3개:

1. **MCP 기록 도구** — AI 에이전트가 작업 중 내린 결정을 `record_decision`으로
   yoke에 적재 (MCP 서버가 이미 v1에 있으므로 도구 하나 추가).
2. **CLI** — 사람이 직접 기록.
3. **외부 소스 커넥터 1개** — 첫 대상은 GitHub PR 리뷰 코멘트(개발 조직에서
   결정 밀도가 가장 높고 API가 단순). Slack·회의록은 같은 커넥터 패턴의 반복이므로
   두 번째부터는 어댑터 추가 작업이다.

시장 조사 기준, person 스코프 판단 연속성을 제공하는 경쟁자는 없다 —
"거버닝된 지식" 포지셔닝의 킬러 유스케이스이며 v1의 승부수다.

## 성공 기준 (v1)

Claude Code에서 MCP로 yoke에 지식을 넣고, 다른 세션에서 맥락 질의로 그 지식이
정확히 주입되는 것을 실사용으로 확인한다.
