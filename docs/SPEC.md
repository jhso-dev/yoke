# yoke — Spec (v1 계약 정의)

구현이 따라야 할 계약만 정의한다. 배경·이유는 ARCHITECTURE/KNOWLEDGE-POLICY 참고.
구현 중 계약 변경이 필요하면 이 문서를 먼저 고치고 코드를 고친다.

## Entity

```ts
{
  id: string          // ULID. 네임스페이스 프리픽스 수용 가능한 불투명 문자열
  type: string        // 온톨로지에 등록된 entity 타입 (미등록 시 commit 거절)
  attributes: Record<string, unknown>  // 온톨로지의 타입별 스키마로 검증
  status: 'draft' | 'verified' | 'stale' | 'deprecated'
  provenance: {
    actor: string     // person entity id 또는 agent 식별자 (필수)
    origin: string    // 'cli' | 'mcp' | 'connector:github-pr' | ...
    occurred_at: string  // ISO 8601 (필수)
  }
  version: number     // 1부터. 수정은 새 버전 행 추가 (덮어쓰기 금지)
  last_confirmed: string  // ISO 8601. verify 시 갱신
  embedding?: Float32Array // 중복 탐지·시맨틱 검색용 (sqlite-vec)
}
```

## Relation

entity와 동일 골격(id/type/status/provenance/version). 추가로:

```ts
{ from: string, to: string }  // entity id. 방향성 있음
```

## 기본 온톨로지 (시드)

- entity 타입: `person`, `fact`, `decision`(attributes: conclusion, rationale,
  rejected_alternatives[]), `term`, `resource`
- relation 타입: `authored_by`, `relates_to`, `supersedes`, `conflicts_with`(예약)
- **온톨로지 저장**: 별도 `ontology_types` 테이블에 append-only 버전으로 저장.
  **commit 게이트를 거치지 않는다** — 게이트가 참조하는 대상이므로 순환 금지.
  변경은 `yoke ontology` 명령의 명시적 마이그레이션으로만.
- **부트스트랩**: `yoke init`이 well-known id `yoke:system`인 person entity를
  시드한다(provenance.actor는 자기 자신). 이후 모든 actor 해석:
  `--actor` 플래그 > `YOKE_ACTOR` env > `yoke:system`.

## Storage Port

```ts
interface StoragePort {
  putEntity(e: Entity): Promise<void>        // append-only (새 버전 행)
  getEntity(id: string, version?: number): Promise<Entity | null>
  putRelation(r: Relation): Promise<void>
  neighbors(id: string, relType?: string, dir?: 'in'|'out'): Promise<Relation[]>
  search(q: TextQuery): Promise<Entity[]>    // 키워드 (FTS)
  // optional capability — 없으면 core가 키워드 검색으로 폴백
  similar?(embedding: Float32Array, k: number): Promise<Entity[]>
}
```

모든 구현체는 `ports/conformance/` 공통 테스트 스위트를 통과해야 한다.
v1 구현체: `storage-sqlite` (better-sqlite3 + FTS5 + sqlite-vec).

## Commit 게이트 (단일 쓰기 경로)

`commit(input, provenance)` 파이프라인 — 순서 고정:

1. 온톨로지 검증 (타입·attributes 스키마) → 실패 시 거절
2. provenance 필수 필드 검증 → 실패 시 거절
3. 유사 entity 조회 (similar 있으면 임베딩, 없으면 FTS)
   → 중복 후보 반환 (자동 병합 금지, 호출자에게 제안)
4. 모순 감지 시 `conflicts_with` relation 생성 (양쪽 보존)
5. status='draft', version 부여 후 저장

## 주입 (context injection)

`inject(query, opts)`:

- 기본 필터: `status === 'verified'` 그리고 신선하지 않으면 제외
  (신선도 = `last_confirmed` + 온톨로지 타입별 TTL, **읽기 시점 계산**)
- `opts.includeDraft` 시 draft 포함하되 결과에 상태 라벨 명시.
  stale/deprecated는 옵션과 무관하게 **항상 제외** (주입은 엄격하게 —
  부패 신호를 주입하지 않는다. stale 열람은 review/CLI의 몫)
- 반환: entity 목록 + 각각의 출처(감사 가능한 인용 형식)

## MCP 도구

| 도구 | 역할 |
|---|---|
| `yoke_inject` | 맥락 질의 → verified 지식 주입 (인용 포함) |
| `yoke_commit` | 지식 적재 (게이트 통과) |
| `yoke_record_decision` | decision entity 전용 commit 숏컷 |
| `yoke_persona` | person 스코프 주입 ("Nathen이라면") |

## CLI 명령

```
yoke init                  # DB 생성 + 기본 온톨로지 시드
yoke add / get / search    # 기본 CRUD·검색
yoke review                # draft 목록
yoke verify <id...>        # 승격 (일괄), last_confirmed 갱신
yoke deprecate <id...>     # 폐기 (모순 해소 등)
yoke conflicts             # conflicts_with 목록
yoke ontology <subcmd>     # 타입 조회/마이그레이션
yoke persona <person>      # persona skill(SKILL.md) 생성/export
yoke connect github-pr     # PR 리뷰 코멘트 → draft decision 적재
yoke mcp                   # MCP 서버 기동 (stdio)
```

## persona 소비 경로

**주 경로 — MCP 실시간 주입**: `yoke_persona` 도구. 호출 시점의 verified 지식에서
person 스코프 질의를 실행해 인용 포함 텍스트로 반환 — 일반 지식 주입과 동일 흐름.
매 호출이 곧 재생성이므로 파생물 원칙이 자동 충족된다.

**보조 경로 — SKILL.md export** (`yoke persona <person> --out`): MCP 연결이 없는
환경용 오프라인 스냅샷. frontmatter(name/description) + 인용 목록 +
"인용 없는 답변 금지" 지시. 파일에 생성 시각·소스 지식 버전을 기록해
낡은 스냅샷임을 판별 가능하게 한다.

## Embedder 계약

```ts
type Embedder = (text: string) => Promise<Float32Array | null>
```

- core는 이 함수형을 주입받는다 (fetch 구현체는 core/embedding.ts가 제공하되,
  테스트는 결정적 스텁 주입). null = 사용 불가 → FTS 폴백.
- 임베딩 대상 텍스트 = FTS 직렬화(type + attributes)와 동일 함수 사용.
- 임베딩 실패는 commit을 막지 않는다 (경고 후 진행 — 하드 규칙 아님).

## 시간 주입

시간이 필요한 core 함수(commit, verify, isFresh, persona export)는
`now: string`(ISO 8601)을 파라미터로 받는다. core 내부에서 `new Date()` 호출 금지 —
테스트 결정성과 재현 가능성의 기반. Date 획득은 front(CLI/MCP) 계층에서만.

## 기술 스택

TypeScript, Node ≥ 20, better-sqlite3, sqlite-vec, MCP SDK(@modelcontextprotocol/sdk).
임베딩: 기본 로컬 모델 없음 — v1은 provider 설정(예: OpenAI/Anthropic 호환 endpoint)
1개, 미설정 시 similar 비활성 + FTS 폴백.
