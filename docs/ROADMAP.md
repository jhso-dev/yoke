# yoke — Roadmap (풀 구현 기준)

버전 순서대로 개발한다. 각 버전은 배포 가능한 상태로 끝난다.
상위 버전 항목을 하위 버전에서 미리 구현하지 않는다 — 단, 설계가 막지 않게는 한다
(ID 네임스페이스 수용, storage port capability 선언 등. SPEC 참고).

## v0.1 — 코어 모델 + SQLite + 게이트

- [x] 프로젝트 셋업 (TypeScript, better-sqlite3, vitest, biome)
- [x] Entity/Relation 타입 + 온톨로지 레코드 모델 (SPEC 준수)
- [x] storage port 인터페이스 + conformance 테스트 스위트 골격
- [x] storage-sqlite 어댑터 (append-only 버전 행, FTS5)
- [ ] commit 게이트 1·2단계 (온톨로지 검증, provenance 검증)
- [x] 기본 온톨로지 시드 (person/fact/decision/term/resource)
- [ ] CLI: `init` / `add` / `get` / `search`

## v0.2 — lifecycle + 주입

- [ ] status 전이 로직 (draft→verified→stale/deprecated)
- [ ] `inject()` — verified 기본 필터 + 읽기 시점 신선도 판정 (TTL)
- [ ] 인용 형식 출력 (출처 포함)
- [ ] CLI: `review` / `verify <id...>` (일괄)

## v0.3 — MCP 서버

- [ ] MCP stdio 서버 (`yoke mcp`)
- [ ] 도구: `yoke_inject` / `yoke_commit` / `yoke_record_decision`
- [ ] Claude Code 실사용 검증 (성공 기준: 타 세션에서 지식 주입 확인)

## v0.4 — 중복·모순

- [ ] 임베딩 provider 설정 (미설정 시 FTS 폴백)
- [ ] sqlite-vec 통합, storage port `similar` capability
- [ ] 게이트 3·4단계 (중복 후보 제안, conflicts_with 생성)
- [ ] CLI: `conflicts`

## v0.5 — 캡처 커넥터

- [ ] 커넥터 공통 패턴 (외부 소스 → draft entity 적재)
- [ ] github-pr 커넥터 (PR 리뷰 코멘트 → draft decision)
- [ ] CLI: `connect github-pr`

## v0.6 — persona

- [ ] person 스코프 질의 (provenance + relation 탐색)
- [ ] SKILL.md export (`yoke persona <person>`)
- [ ] MCP 도구: `yoke_persona`

## v1.0 — 품질·패키징

- [ ] conformance 스위트 완성 + CI
- [ ] 주입 품질 eval (오염 주입률·모순 미탐지율) — MARKET 전략 6
- [ ] npm 패키징 (`npx yoke`), README, 온보딩 문서

## v2.0 — 백엔드 확장 + 전통 DB 호환

- [ ] 그래프 DB 어댑터 (KuzuDB 임베디드 우선, Neo4j 다음) — conformance 통과
- [ ] 벡터 DB 어댑터 (Qdrant) — similar capability 구현체
- [ ] **RDB read-mapping**: Postgres/MySQL 테이블 → 읽기 전용 entity 매핑
      (테이블-온톨로지 매핑 선언 파일, 엔터프라이즈 쐐기 — MARKET 전략 3)
- [ ] 감사 로그 (게이트·승격·주입의 불변 기록 조회 API)
- [ ] 커넥터 추가: Slack, 회의록

## v2.5 — 웹 UI

- [ ] review/verify 대시보드 (draft 큐, 일괄 승격)
- [ ] conflicts 뷰 (모순 쌍 비교·해소)
- [ ] 온톨로지 브라우저 (타입·관계 시각화)
- [ ] persona 미리보기

## v3.0 — 엔터프라이즈 (멀티테넌시·auth)

- [ ] 서버 모드 (원격 접속: HTTP + MCP remote)
- [ ] auth: OIDC/SSO 연동, API 토큰
- [ ] RBAC: 온톨로지 타입·네임스페이스 단위 권한 (읽기/쓰기/승격 분리 —
      verify 권한이 곧 지식 거버넌스 권한)
- [ ] 멀티테넌시: 네임스페이스 격리 (v0.1의 ID 체계가 수용)
- [ ] 테넌트별 온톨로지 + 공유 온톨로지 상속

## v3.5 — 분산·HA

- [ ] 복제 (읽기 레플리카 — 주입은 읽기가 지배적)
- [ ] 백업/복원, PITR (append-only 이력이 기반)
- [ ] 샤딩은 실측 한계 확인 후 설계 (선행 설계 금지)

## 버전 승격 규칙

하위 버전이 배포·검증되기 전에 상위 버전 착수 금지.
시장 신호(첫 엔터프라이즈 고객, 두 번째 조직)가 오면 v2/v3 내 순서는 조정 가능.
