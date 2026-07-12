# yoke — Backends (v2.0 설계)

storage port 구현체 확장과 전통 DB 호환의 설계 방향. 착수 시점(v2.0)에 상세화한다.

## 원칙

- 모든 백엔드는 동일한 storage port + conformance 스위트 통과 (불변식 2).
- 백엔드 고유 기능은 optional capability(`similar` 등)로 선언, core는 폴백 보유.
- 새 백엔드 추가 = 어댑터 1개 디렉토리 + conformance 통과. core 수정 없음.
  core 수정이 필요해지면 그것은 port 설계 결함이므로 port를 먼저 고친다.

## 어댑터 로드맵

| 어댑터 | 시점 | 선택 이유 |
|---|---|---|
| storage-sqlite | v0.1 | 임베디드, FTS5 + sqlite-vec으로 v1 전체 커버 |
| storage-kuzu | v2.0 | 임베디드 그래프 DB — 인프라 없이 그래프 질의 강화. Cognee도 채택한 검증된 경로 |
| storage-qdrant | v2.0 | similar capability 전용 구현체. 대규모 임베딩 |
| storage-neo4j | v2.x | 엔터프라이즈 기존 Neo4j 투자 보호용. 수요 확인 후 |
| storage-postgres | v2.x | 서버 모드(v3)의 기본 백엔드 후보 (pgvector로 similar 겸용) |

## capability 매트릭스 (설계 시 갱신)

| | FTS | similar | graph traversal | 임베디드 |
|---|---|---|---|---|
| sqlite | ✓ | ✓(sqlite-vec) | 앱 레벨 | ✓ |
| kuzu | — | ✓ | ✓(네이티브) | ✓ |
| qdrant | — | ✓ | — | — |
| postgres | ✓ | ✓(pgvector) | 앱 레벨 | — |

`neighbors()`의 다단계 탐색이 병목이 되는 시점이 graph capability를 port에
승격하는 시점이다 — 그 전에 미리 추가하지 않는다.

## 전통 DB read-mapping (v2.0 — 엔터프라이즈 쐐기)

기존 RDB를 이관 없이 온톨로지로 노출한다. 어댑터가 아니라 **커넥터**다
(storage port 구현이 아니라 읽기 전용 entity 소스).

- 매핑 선언 파일(yaml): 테이블/뷰 → entity 타입, 컬럼 → attribute,
  FK → relation. 예: `employees` → `person`, `employees.manager_id` → `reports_to`.
- 매핑된 entity는 `status: verified` 취급하되 `provenance.origin: 'rdb:...'`로
  구분 — 원본 DB가 이미 조직의 진실 공급원이므로 draft 격리 불필요.
  단 신선도는 적용(마지막 동기화 시각 = last_confirmed).
- 읽기 전용이 원칙. 양방향 동기화는 요구가 실재할 때 별도 설계(충돌 해소가
  본질적으로 어렵다 — 안이하게 넣지 않는다).
- 대상 순서: Postgres → MySQL. 나머지는 수요 순.

## 커넥터 로드맵 (캡처 계열)

github-pr(v0.5) → Slack, 회의록(v2.0) → Confluence/Notion(수요 순).
공통 패턴: 외부 소스 → draft entity 적재 (read-mapping과 달리 게이트 통과).
