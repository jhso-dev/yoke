# yoke — v1 구현 계획 (상세)

ROADMAP의 v0.1~v1.0을 실행 단위로 분해한다. 계약은 SPEC.md가 진실이며,
이 문서는 순서·파일·완료 조건을 정한다. 충돌 시 SPEC 우선.

## 전역 규칙

- **태스크 = 커밋 단위.** 각 태스크는 `tsc --noEmit` + `biome check` + `vitest run`
  green 상태로 커밋한다.
- **의존 방향 검증**: core는 ports/adapters/front를 import하지 않는다.
  (v0.1에서 biome/eslint 룰이 아니라 디렉토리 구조 리뷰로 시작,
  위반이 실제 발생하면 룰 추가 — ROADMAP 외 작업 금지 원칙 유지)
- 하위 호환 제약 4개(ENTERPRISE.md) 상시 적용: 불투명 ID, 단일 core 경로,
  append-only, actor=person 참조.

## 최종 디렉토리 (v1.0 시점)

```
src/
  core/
    types.ts        # Entity, Relation, Provenance, Ontology 타입
    ontology.ts     # 검증 + 시드 + 마이그레이션
    commit.ts       # 게이트 파이프라인 (단일 쓰기 경로)
    lifecycle.ts    # status 전이, 신선도
    inject.ts       # context injection + 인용
    persona.ts      # person 스코프 질의 + SKILL.md 생성
    embedding.ts    # provider 클라이언트 (fetch, OpenAI 호환)
  ports/
    storage.ts      # StoragePort 인터페이스
    conformance.ts  # 공통 테스트 스위트 (test factory)
  adapters/
    storage-sqlite/ # index.ts, schema.sql
  connectors/
    github-pr.ts
  front/
    cli/index.ts    # 서브커맨드 라우팅 (node:util parseArgs)
    mcp/index.ts    # MCP stdio 서버
eval/
  inject-quality.ts # 오염 주입률 측정
```

---

## v0.1 — 코어 모델 + SQLite + 게이트

### 1.1 프로젝트 셋업

- `npm init` — `"type": "module"`, `"bin": {"yoke": "dist/front/cli/index.js"}`
- deps: `better-sqlite3`, `ulid` / devDeps: `typescript`, `vitest`, `@biomejs/biome`,
  `@types/node`, `@types/better-sqlite3`
- tsconfig: strict, NodeNext, outDir dist / biome.json 기본 + import 정렬
- scripts: `build`(tsc), `test`(vitest run), `typecheck`(tsc --noEmit), `lint`(biome check)
- **DoD**: 4개 스크립트 전부 green (빈 src로).

### 1.2 코어 타입 (`core/types.ts`)

SPEC의 Entity/Relation을 그대로 타입화. 추가 결정사항:

- `id`: `ulid()` 생성, 소비처는 불투명 문자열로만 취급
- `EntityInput` 분리: commit이 받는 입력형 (id/status/version/last_confirmed 없음
  — 이것들은 게이트가 부여). **어댑터·front가 Entity를 직접 조립할 수 없게
  타입 수준에서 강제**하는 것이 이 파일의 존재 이유.
- `Provenance.occurred_at`, `last_confirmed`: ISO 8601 string (Date 객체 저장 금지)
- **DoD**: 타입만. 테스트 없음 (로직 없음).

### 1.3 온톨로지 (`core/ontology.ts`)

```ts
type AttrSpec = { type: 'string'|'number'|'boolean'|'string[]', required?: boolean }
type TypeDef  = { name: string, kind: 'entity'|'relation', attrs: Record<string, AttrSpec> }

validateInput(ontology: TypeDef[], input: EntityInput | RelationInput):
  { ok: true } | { ok: false, reason: string }
seedOntology(): TypeDef[]   // person, fact, decision, term, resource
                            // + authored_by, relates_to, supersedes, conflicts_with
```

- decision attrs: `conclusion`(string, required), `rationale`(string, required),
  `rejected_alternatives`(string[])
- 검증기는 직접 구현 (~40줄). ajv/zod 같은 스키마 라이브러리 도입 금지
  — AttrSpec 4종이면 충분하다. <!-- ponytail: 타입 4종 수동 검증. 중첩 객체 스키마가 필요해지면 zod로 -->
- 온톨로지는 storage에 레코드로 저장되지만, v0.1에서는 시드 로드만 구현.
  마이그레이션 명령은 4.4에서.
- **테스트**: 미등록 타입 거절 / required 누락 거절 / 타입 불일치 거절 /
  정상 통과 / relation의 from·to 필수.

### 1.4 storage port + conformance (`ports/`)

- `storage.ts`: SPEC의 인터페이스 그대로 + `init(): Promise<void>`, `close()`
- `conformance.ts`: **test factory** — 어댑터 테스트가 호출:

```ts
export function describeStoragePort(name: string, make: () => Promise<StoragePort>)
```

포함 케이스 (최소 세트, v1.0에서 확장):
1. putEntity → getEntity 왕복
2. **putEntity 같은 id 재호출 → 두 버전 존재, getEntity는 최신, version 지정 시 과거**
3. 물리 삭제 API가 없음 (인터페이스 차원 확인)
4. putRelation → neighbors 방향 필터 (in/out/양방향)
5. neighbors relType 필터
6. search: FTS 매칭 / 무결과 빈 배열
7. getEntity 미존재 → null
8. similar 미구현 어댑터에서 undefined (capability 부재 확인)

- **DoD**: 스위트가 인메모리 fake로 자기 검증 통과 (fake는 테스트 헬퍼로만, src에 두지 않음).

### 1.5 storage-sqlite (`adapters/storage-sqlite/`)

schema.sql:

```sql
CREATE TABLE entities (
  id TEXT NOT NULL, version INTEGER NOT NULL,
  type TEXT NOT NULL, status TEXT NOT NULL,
  attributes TEXT NOT NULL,          -- JSON
  provenance TEXT NOT NULL,          -- JSON
  last_confirmed TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
) WITHOUT ROWID;
CREATE TABLE relations ( ... 동일 골격 + from_id, to_id ... );
CREATE VIRTUAL TABLE entities_fts USING fts5(id UNINDEXED, text);
-- text = type + attributes 직렬화. put 시 최신 버전만 유지 (delete+insert)
```

- WAL 모드, `PRAGMA foreign_keys` 불사용(append-only라 FK 무의미)
- getEntity 최신 = `ORDER BY version DESC LIMIT 1`
- **DoD**: conformance 통과 (`:memory:` + 임시 파일 양쪽).

### 1.6 commit 게이트 (`core/commit.ts`)

```ts
class CommitRejected extends Error { reason: 'ontology'|'provenance' }

commit(port: StoragePort, ontology: TypeDef[], input: EntityInput|RelationInput,
       prov: Provenance): Promise<{ entity: Entity, duplicates: Entity[] }>
```

v0.1은 파이프라인 1·2단계만: 온톨로지 검증 → provenance 검증(actor/origin/occurred_at
비어있지 않음) → id·version·status='draft'·last_confirmed 부여 → put.
`duplicates`는 v0.4까지 항상 `[]` (시그니처는 지금 고정 — 호출자 변경 방지).

- **기존 id 재커밋 = 새 버전** (수정 경로도 게이트 통과, 동일 검증)
- **테스트**: 거절 2종 / draft 부여 / 재커밋 버전 증가 / relation 커밋.

### 1.7 CLI 골격 (`front/cli/index.ts`)

- `node:util` parseArgs. commander 등 도입 금지 (서브커맨드 10개 수준).
- `yoke init [--db path]` — 기본 `./yoke.db`. DB 생성 + 온톨로지 시드 저장.
- `yoke add <type> --actor <id> [--attr k=v ...]` — commit 경유. 거절 사유 출력.
- `yoke get <id> [--version n]`
- `yoke search <query>`
- DB 경로 해석: `--db` > `YOKE_DB` env > `./yoke.db` (공통 헬퍼 1개)
- **DoD**: 스모크 테스트 1개 (init→add→search 를 자식 프로세스로 실행) +
  수동 시나리오 확인. CLI 출력은 사람용 텍스트, `--json` 플래그로 기계용.

---

## v0.2 — lifecycle + 주입

### 2.1 lifecycle (`core/lifecycle.ts`)

```ts
verify(port, ids: string[], actor: string): Promise<Entity[]>
  // status→verified, last_confirmed=now. 새 버전 행 (append-only)
deprecate(port, id, actor)
isFresh(e: Entity, ontology: TypeDef[], now: string): boolean
  // TypeDef에 ttl_days?: number 추가 (기본: fact 180, decision 365, person/term/resource 무제한)
```

- stale은 **저장하지 않는다** — 읽기 시점에 `verified && !isFresh` → stale로 판정.
  deprecated만 명시 저장. (SPEC의 읽기 시점 판정 구현)
- **테스트**: verify 버전 증가 / TTL 경과 판정 / 무제한 타입 / deprecate.

### 2.2 inject (`core/inject.ts`)

```ts
inject(port, ontology, query: string, opts?: { includeDraft?: boolean, limit?: number })
  : Promise<{ items: Array<{ entity, effectiveStatus, citation: string }> }>
```

- 파이프라인: search(+ v0.4부터 similar 병합) → effectiveStatus 계산 →
  기본 verified만 → citation 생성
- citation 형식 고정: `[{type}:{id}@v{version}] {actor}, {occurred_at}` —
  이 형식이 감사 추적의 최소 단위. 테스트로 고정.
- **테스트**: draft 제외 / includeDraft 시 라벨 / stale 제외 / citation 형식.

### 2.3 CLI: `review` / `verify`

- `yoke review` — draft 목록 (id, type, 요약, 출처). **한 화면에 훑고 일괄 결정**이
  목적이므로 페이징보다 압축 표시 우선.
- `yoke verify <id...>` / `yoke verify --all-drafts` (콜드 스타트용 일괄)
- **DoD**: add(draft) → inject에 안 나옴 → verify → 나옴, E2E 스모크.

---

## v0.3 — MCP 서버

### 3.1 서버 골격 (`front/mcp/index.ts`)

- deps 추가: `@modelcontextprotocol/sdk`, `zod` (SDK 도구 스키마용 peer)
- stdio transport. `yoke mcp [--db path]`로 기동.

### 3.2 도구 3개

| 도구 | 입력(zod) | 동작 |
|---|---|---|
| `yoke_inject` | query, includeDraft? | inject() 결과를 인용 포함 텍스트로 |
| `yoke_commit` | type, attributes, actor | commit() — 거절 시 사유를 도구 에러로 |
| `yoke_record_decision` | conclusion, rationale, rejected_alternatives?, actor | decision 커밋 숏컷 |

- 도구 설명문이 곧 에이전트 UX — "결정을 내렸으면 record_decision을 호출하라"는
  트리거 조건을 설명문에 명시 (MCP 서버의 채택률이 여기서 갈린다).

### 3.3 실사용 검증 (v1 성공 기준 선행 확인)

- `.mcp.json` 등록 → Claude Code 세션 A에서 record_decision →
  세션 B에서 yoke_inject로 주입 확인. **결과를 README 초안에 기록.**
- **DoD**: 위 시나리오 + vitest는 도구 핸들러 단위 테스트만 (transport 테스트 불필요).

---

## v0.4 — 중복·모순

### 4.1 임베딩 (`core/embedding.ts`)

- OpenAI 호환 `/v1/embeddings`를 fetch로 직접 호출 (SDK 금지, ~30줄).
- 설정: `YOKE_EMBED_URL`, `YOKE_EMBED_MODEL`, `YOKE_EMBED_KEY` env.
  미설정 → `null` 반환 → 호출측 FTS 폴백. 실패도 폴백 + stderr 경고
  (임베딩 장애가 commit을 막으면 안 된다 — 게이트 하드 규칙이 아님).

### 4.2 sqlite-vec 통합

- `sqlite-vec` dep 추가, `vec0` 가상 테이블 (최신 버전만 유지, FTS와 동일 정책)
- storage-sqlite에 `similar()` 구현 → conformance의 capability 케이스 활성화.

### 4.3 게이트 3·4단계 (`core/commit.ts` 확장)

- 3단계: similar(있으면) 또는 FTS로 top-5 → 코사인 유사도/휴리스틱 임계 초과를
  `duplicates`로 반환. **자동 병합·자동 거절 금지** — 호출자(CLI가 "유사 지식 존재"
  경고, MCP가 도구 결과에 포함)가 판단.
  <!-- ponytail: 임계값 상수 하나(0.85)로 시작. 정밀도 문제가 실측되면 타입별 임계로 -->
- 4단계: 동일 대상에 대한 반대 결론 탐지는 **decision 타입 한정 휴리스틱**으로 시작
  (동일 subject 관계 + 높은 유사도 + 다른 conclusion) → conflicts_with 생성.
  범용 모순 탐지는 v1 이후 (NLI 모델 영역, 지금 안 함).
- **테스트**: 중복 후보 반환 / 임계 미달 시 빈 배열 / conflicts_with 생성·양쪽 보존.

### 4.4 CLI: `conflicts` / `ontology`

- `yoke conflicts` — 쌍 목록 + 각 출처. 해소는 `yoke verify`/`deprecate`로 (전용 명령 없음).
- `yoke ontology list` / `yoke ontology add-type <json-file>` (마이그레이션 = 온톨로지
  레코드 새 버전 — entity와 동일한 append-only 메커니즘 재사용).

---

## v0.5 — 캡처 커넥터

### 5.1 커넥터 계약 (`connectors/`)

```ts
type Connector = { name: string, pull(since?: string): AsyncIterable<EntityInput & { externalId: string }> }
```

- 커넥터는 **EntityInput 생산자일 뿐** — 저장은 반드시 commit 게이트 경유 (우회 금지).
- 멱등성: `externalId`(예: PR 코멘트 URL)를 attributes에 저장,
  재실행 시 동일 externalId 존재하면 skip. 이것이 커넥터 공통 패턴의 전부다 —
  프레임워크를 만들지 않는다.

### 5.2 github-pr 커넥터

- GitHub REST (fetch + `GITHUB_TOKEN`). octokit 도입 금지 (엔드포인트 2개:
  pulls 목록, review comments).
- 매핑: 리뷰 코멘트 → `decision` draft (conclusion=코멘트 본문 요약 없이 원문,
  rationale=스레드 맥락, actor=코멘트 작성자 → person entity 자동 생성-or-참조).
- `yoke connect github-pr --repo owner/name [--since date]`
- **테스트**: fixture JSON → EntityInput 매핑 / 멱등 재실행. (실 API는 수동 1회)

---

## v0.6 — persona

### 6.1 person 스코프 질의 (`core/persona.ts`)

```ts
personaQuery(port, ontology, personId): Promise<{ decisions, facts, principles }>
```

- provenance.actor = personId **또는** authored_by relation → 해당 인물 지식 수집,
  verified+fresh만 (inject와 동일 필터 재사용 — 새 필터 로직 작성 금지).

### 6.2 SKILL.md export

- `yoke persona <person-id> [--out dir]` → SKILL.md 생성:
  frontmatter(name: persona-{person}, description) + 판단 원칙 섹션 +
  결정 목록(conclusion/rationale/citation) + **"인용 없는 답변 금지, 기록에 없으면
  '기록 없음'이라고 답하라"** 지시문.
- 파일 헤더에 생성 시각 + 소스 지식 (id@version) 목록 — 재생성 원칙의 감사 근거.
- **테스트**: 스냅샷 테스트 1개 (고정 fixture → SKILL.md 출력 고정).

### 6.3 MCP `yoke_persona`

- 입력: person, query? — personaQuery 결과를 인용 포함 텍스트로.

---

## v1.0 — 품질·패키징

### 7.1 CI

- GitHub Actions: typecheck + lint + vitest (conformance 포함), Node 20/22 매트릭스.

### 7.2 주입 품질 eval (`eval/inject-quality.ts`)

- 시나리오 생성: 사실 N개를 절반 verified, 절반 draft(오염 가정)로 시드 →
  질의 세트 실행 → **오염 주입률 = 주입 결과 중 draft 비율 (목표 0%)**,
  모순 미탐지율 = 심어둔 반대 결론 쌍 중 conflicts_with 미생성 비율.
- vitest가 아니라 실행 스크립트 (`npm run eval`) — 수치가 산출물 (MARKET 전략 6의
  마케팅 근거 데이터가 된다).

### 7.3 패키징

- `npm pack` 검증, `npx yoke init` 콜드 스타트 확인 (better-sqlite3/sqlite-vec
  프리빌드 바이너리가 npx 환경에서 동작하는지 — **가장 흔한 배포 함정, 실기기 확인**).
- README: 한마디 포지셔닝 + 60초 퀵스타트 + MCP 등록법.

---

## 순서 의존성 요약

```
1.1 → 1.2 → 1.3 ─┐
        1.4 ─────┼→ 1.6 → 1.7 → [v0.2] 2.1 → 2.2 → 2.3 → [v0.3] 3.x
        1.5 ─────┘                → [v0.4] 4.1 → 4.2 → 4.3 → 4.4
                                  → [v0.5] 5.x → [v0.6] 6.x → [v1.0] 7.x
```

v0.4와 v0.3은 순서 교환 가능 (둘 다 v0.2에만 의존). 기본은 ROADMAP 순서.

## 명시적 비목표 (v1 기간 중 요청돼도 거절)

모노레포 분리, DI 컨테이너, 이벤트 버스, 플러그인 시스템, 설정 파일 포맷
(env + 플래그로 충분), 국제화, 로깅 프레임워크(console + stderr로 충분).
