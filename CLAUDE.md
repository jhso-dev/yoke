# yoke

온톨로지 기반 지식 DB. 코어는 지식 모델이고, 앞뒤는 전부 어댑터다.
AI 에이전트(Claude, Codex 등)가 사용자 맥락에 맞는 지식을 그때그때 주입받는 것이 목적.

## 불변식 (위반 금지)

1. **core는 어떤 어댑터도 import하지 않는다.** 의존 방향은 항상 어댑터 → core.
2. **모든 스토리지 백엔드는 동일한 storage port 인터페이스를 구현하고, 공통 conformance 테스트를 통과한다.** 백엔드별 특수 동작을 core로 새어 나오게 하지 않는다.
3. **프론트 어댑터는 MCP 서버 + thin CLI 두 개뿐이다.** AI 도구별(Claude용, Codex용 …) 어댑터를 따로 만들지 않는다 — 전부 MCP 클라이언트다.
4. **v1은 단일 사용자·로컬 우선.** 멀티테넌시, auth, 분산은 docs/VISION.md의 제외 목록 참고 — 먼저 넣지 말 것.
5. **지식은 core의 단일 commit 경로로만 진입하고, context injection은 verified만 기본 주입한다.** 세부 규칙은 docs/KNOWLEDGE-POLICY.md — 저장은 관대하게, 주입은 엄격하게.

## 용어

- **entity**: 지식의 최소 단위. 타입 + 속성을 가진 노드.
- **relation**: entity 간의 방향성 있는 연결. 그 자체로 지식이다.
- **ontology**: entity 타입과 relation 타입의 스키마. 코드가 아니라 데이터로 정의한다.
- **context injection**: 사용자의 현재 작업 맥락(질의)에 맞는 entity/relation 부분집합을 골라 AI에게 전달하는 행위. yoke의 핵심 가치.
- **storage port**: core가 정의하는 백엔드 인터페이스. SQLite, 벡터 DB, 그래프 DB 어댑터가 이를 구현.
- **decision**: 결론 + 근거 + 기각한 대안을 담는 entity 타입. persona의 원료.
- **persona**: 특정 인물이 출처인 verified 지식에 대한 저장된 질의를 skill로 export한 것. 파생물이며 저장물이 아님(docs/VISION.md 참고). v1 포함.

## 구조

- `docs/VISION.md` — 왜 만드는가, 버전 스코프
- `docs/ARCHITECTURE.md` — 포트/어댑터 경계 정의
- `docs/KNOWLEDGE-POLICY.md` — 지식 진입 게이트, lifecycle, 주입 필터 규칙
- `docs/SPEC.md` — v1 구현 계약 (스키마, port, 게이트, MCP 도구, CLI)
- `docs/ROADMAP.md` — v0.1 → v3.5 버전별 태스크. 개발은 이 순서대로
- `docs/PLAN.md` — v1 상세 구현 계획 (태스크=커밋 단위, 파일·시그니처·테스트·DoD)
- `docs/MARKET.md` — 경쟁 지형과 전략 (2026-07 조사)
- `docs/ENTERPRISE.md` — 멀티테넌시·auth·RBAC·분산 설계 + v0.1부터의 하위 호환 제약
- `docs/BACKENDS.md` — 백엔드 어댑터 확장, RDB read-mapping 설계
- `docs/WEB-UI.md` — 거버넌스 작업대 UI 설계

## 명령어

(코드 생기면 추가: build / test / typecheck / lint)
