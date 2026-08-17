<div align="center">
<pre>
██╗   ██╗ ██████╗ ██╗  ██╗███████╗
╚██╗ ██╔╝██╔═══██╗██║ ██╔╝██╔════╝
 ╚████╔╝ ██║   ██║█████╔╝ █████╗
  ╚██╔╝  ██║   ██║██╔═██╗ ██╔══╝
   ██║   ╚██████╔╝██║  ██╗███████╗
   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝
</pre>

**AI가 믿을 수 있는 지식.**

온톨로지 기반 지식 데이터베이스 · AI 에이전트를 위한 거버넌스 컨텍스트 주입 · MCP 네이티브

MIT · v6.1까지 기능 완성 · [비주얼 소개](https://claude.ai/code/artifact/09d92d76-5eee-453d-ae79-ec40616f6396)

[English](README.md) | **한국어**

</div>

---

메모리를 가진 AI 에이전트는 들은 것을 그대로 되풀이합니다. yoke 위의 AI 에이전트는
출처가 있고, 검토를 통과했으며, 아직 유효한 지식만 말합니다 — 그리고 출처를
인용합니다. 메모리 레이어가 *AI가 무엇을 기억할지*를 자동화한다면, yoke는
*AI가 무엇을 믿어도 되는지*를 관리합니다.

## 왜 믿을 수 있나

신뢰는 약속이 아닙니다 — 코드로 강제되는 다섯 가지 장치입니다:

1. **출처 없이는 들어오지 못한다.** 모든 쓰기는 단일 commit 게이트를 통과하며,
   출처(누가·어디서·언제) 없는 지식은 거절됩니다. 출처 없는 지식은 소문이고,
   소문은 못 들어옵니다.
2. **사람이 검증하기 전엔 믿지 않는다.** 새 지식은 `draft`로 진입해 주입에서
   격리됩니다. AI 에이전트는 MCP로 *기록*만 할 수 있고 승격은 못 합니다 —
   검증은 의도적으로 사람의 행위이며(`yoke verify`), 그걸 하는 MCP 도구는
   없습니다. 기본적으로 `verified`만 AI의 컨텍스트에 닿고, 에이전트가 명시적으로
   요청하면(`includeDraft`) draft도 `[draft]` 표시와 함께 받습니다. 문서화된
   예외 하나: `connect rdb`는 이미 조직의 system of record인 DB를 매핑하므로
   매핑된 행은 verified로 들어옵니다 — docs/BACKENDS.md 참고.
3. **아무것도 조용히 덮이지 않는다.** 저장은 append-only입니다 — 수정은 새 버전이고,
   삭제는 아예 없습니다(폐기는 `deprecated` 상태). 임의 시점의 믿음을 언제든 재구성할 수 있고, 주입되는 모든
   항목에 인용이 붙습니다 — `[type:id@vN] 저자 (confirmed by 승격자), occurred_at` —
   그래서 모든 주장이 감사 가능하고, 누가 썼는지와 누가 보증했는지가 둘 다 남습니다.
   이력이 담을 수 없는 변경은 `rename-type` 하나입니다: 기존 버전 행의 타입을
   다시 쓰며, 그 사실을 감사 행으로 남깁니다.
4. **모순은 드러내되 자동 해소하지 않는다.** 충돌로 연결된 지식은 양쪽 다 보존되고,
   주입도 양쪽을 "상충" 표시와 함께 넘겨 사람이 판단하게 합니다. 불일치의 존재 자체가
   지식이며, 승자를 고르는 건 DB의 일이 아닙니다. 자동 *탐지*는 약한 쪽이고, 그렇게
   측정돼 있습니다: 중복 탐지가 이미 올린 후보만 들여다보므로 실제 임베딩에서 심어둔
   모순 5건 중 1건을 찾고, 서로 모순이 아닌 세부화 쌍 5건 중 5건을 연결했습니다 —
   [품질 측정](#품질-측정) 참고. 직접 연결한 엣지가 메커니즘이고, 탐지는 힌트로
   취급하세요.
5. **지식은 만료된다.** `verified`가 영원하진 않습니다 — 타입별 TTL을 넘기면
   읽기 시점에 `stale`로 강등되어, 누군가 재확인하기 전까지 주입 경로에서
   빠집니다. 낡은 진실은 가장 정중한 형태의 허위정보이고, yoke는 그렇게
   취급합니다.

그리고 주장이 아니라 측정입니다 — 결과가 나쁜 곳까지 포함해서. 주입 품질 eval은 실제
임베딩에서 **오염률 0%**(draft 레코드가 주입에 닿지 않음 — 심는 것이 draft입니다)를
보고하고, 같은 실행에서 모순 *탐지*는 심어둔 모순 5건 중 1건을 찾습니다. 게이트는
버티고, 탐지는 힌트입니다. 두 숫자와 두 번째가 왜 구조적인지는
[품질 측정](#품질-측정)에 있습니다.

로컬·임베디드로 동작합니다 — better-sqlite3 + FTS5 + sqlite-vec, 서버 불필요.

## 컨텍스트를 덜 씁니다

메모리 레이어는 구절을 검색해 붙여넣습니다. yoke는 **레코드**를 주입합니다 — 근거가
붙은 결정, 선호, 사실. 이미 증류된 형태라 지불하는 토큰이 주장 주변의 산문이 아니라
주장 자체입니다.

제3자 하네스에서 측정했습니다 —
[vectorize-io/agent-memory-benchmark](https://github.com/vectorize-io/agent-memory-benchmark)로
PersonaMem 32k, 두 사용자의 42문항. yoke는 메모리 arm일 뿐이고 데이터셋·답변 모델·심판은
하네스가 소유합니다. 답변·심판 모델 `gemma-4-26b-a4b-qat`, 2026-08-15, 결과 파일은
[`bench/`](bench):

| | 주입 컨텍스트 | 정확도 |
|---|---|---|
| 메모리 없음 | 0 | 59.5% (25/42) |
| **yoke** | **1.2k 토큰** | **73.8% (31/42)** |

플로어는 출력값을 그대로 인용한 게 아니라 재채점한 값입니다. 하네스는 컨텍스트가 빈 arm을
무엇을 답했든 오답으로 처리하므로 메모리 없음 arm을 0.0%로 보고하지만, 그 arm은 실제로 42문항
중 25개를 맞혔습니다. 채점기는 `node bench/rescore.mjs bench/results-*.json`이고, 0으로 눌린
플로어는 메모리 시스템이 발표하는 모든 "lift"의 분모입니다.

두 청크 검색 베이스라인과의 비교는 이전 리더(`gemma-4-e4b`) 기준이며, 그 리더에서 yoke는
같은 1.2k 토큰으로 28/42였습니다:

| | 주입 컨텍스트 | 정확도 | 1k 토큰당 정답 |
|---|---|---|---|
| **yoke** | **1.2k 토큰** | 66.7% | **23.5** |
| 키워드 청크 | 5.1k 토큰 | 61.9% | 5.1 |
| dense+sparse 하이브리드, 상위 50청크 | 22.8k 토큰 | 71.4% | 1.3 |

**토큰당 정답이 청크 검색의 4.6배, 하이브리드 검색기의 18배입니다.** 하이브리드는 그 리그에서
가장 높은 정확도(71.4%)를 19배의 컨텍스트로 삽니다 — 작은 모델의 컨텍스트 창 대부분을 질문
하나에 쓰는 셈입니다.

리더를 바꾸면 모든 레벨이 움직이므로 위 두 표는 각각 하나의 리그이고 하나의 비교가 아닙니다.
베이스라인 arm의 결과 파일은 아직 `bench/`에 없고, 현재 리그에서 다시 돌리는 것이
`npm run bench`가 존재하는 이유입니다. **더 강한** 리더가 어떻게 되는지도 측정돼 있고 누구에게도
유리하지 않습니다: `gpt-5-mini`에서 플로어가 24/42로 오르고 yoke는 25/42입니다 — 4지선다는
유능한 모델이 메모리 없이도 정답을 추론할 수 있게 해주기 때문입니다. 어떤 메모리 벤치마크의
정확도든 먼저 답변 모델에 대한 진술로 읽어야 합니다.

[`bench/README.md`](bench/README.md)에 나머지가 있습니다. 그중 가장 중요한 한계: 하네스에는
사람이 없으므로 실행 시 검증 게이트를 엽니다. 이 측정은 yoke의 추출·검색을 재고 거버넌스는
재지 않습니다 — 그건 `npm run eval`의 일입니다.

모든 레코드가 인용을 달고 온다는 점도 붙여넣은 구절은 할 수 없는 일입니다.

## 한눈에 보기

| | |
|---|---|
| **한 줄 요약** | 지식에 최적화된 데이터베이스: 온톨로지로 구조화한 뒤, 지금 맥락에 맞는 검증된 부분집합만 인용과 함께 AI에 주입합니다. |
| **프론트 어댑터** | **MCP 서버**(`inject` · `commit` · `record_decision` · `overview` · `persona` · `use_scope`)와 **thin CLI**. 모든 AI 도구는 그저 MCP 클라이언트 — 도구별 어댑터 없음. |
| **스토리지 백엔드** | `sqlite`(기본, FTS5 + sqlite-vec) · `postgres`(네이티브 스코어드 FTS + pgvector, 의존성 추가 없음) · `opensearch`(네이티브 BM25 + k-NN, 의존성 추가 없음) — 원격 둘은 회사가 이미 운영하는 서버를 그대로 가리킵니다 · `sharded`(테넌트별 연합). 넷 모두 하나의 conformance 스위트를 통과. |
| **캡처 커넥터** | `github-pr`(리뷰 코멘트), `slack`(채널 + 스레드), `notes`(로컬 회의록), `raw`(비정형 자료 — 대화록·문서를 모델이 추출) — 외부 소스 → draft 지식, 원본 시각으로 기록. `rdb`(Postgres/MySQL read-mapping)는 이미 system of record인 DB를 매핑하므로 verified로 들어옵니다. |
| **persona** | "이 동료라면 어떻게 판단할까?" → 그 사람의 기록된 검증 판단을 인용과 함께, 실시간 생성으로. 흉내가 아니라 인용. |
| **공유 작업 컨텍스트** | `collaboration`을 고정하면 팀이 하나의 컨텍스트를 공유 — 스코프는 전사 지식을 가리지 않고 우선순위만 부여. |
| **엔터프라이즈** | 네임스페이스 멀티테넌시 · OIDC/SSO + API 토큰 · RBAC(`verify` 권한이 곧 거버넌스 권한) · 읽기 레플리카 · 온라인 백업 + 시점 복원. |
| **라이선스** | MIT |

## 60초 시작하기

```bash
curl -fsSL https://raw.githubusercontent.com/jhso-dev/yoke/main/scripts/install.sh | bash
# ~/.yoke/app 에 클론·빌드 후 전역 `yoke` 명령을 연결
# (--skip-link 로 연결 생략, --dir PATH 로 위치 변경)

yoke init                                    # ./yoke.db 생성 + 온톨로지 시드
yoke add fact --attr statement="배포는 화요일 오전에만 한다"
yoke review                                  # draft 큐 확인
yoke verify <id>                             # 승격 (또는: yoke verify --all-drafts)
yoke inject "배포 언제 하는 거지"              # 검증된 지식만, 인용과 함께 주입
```

`add`로 넣은 것은 전부 `draft`로 시작합니다. `verify`로 승격하기 전까지는
`inject`에 나오지 않습니다 — 그 게이트가 거버넌스 모델의 핵심입니다. 콜드
스타트에는 `yoke verify --all-drafts`로 일괄 승격하세요.

소스에서 빌드하시겠습니까(기여자)? 직접 클론 후 링크:

```bash
git clone https://github.com/jhso-dev/yoke && cd yoke
npm install && npm run build && npm link   # 전역 `yoke` 명령 제공
```

결정 기록:

```bash
yoke add decision \
  --attr conclusion="Redis로 캐싱" \
  --attr rationale="P99 지연이 목표치를 초과" \
  --attr rejected_alternatives="인프로세스 캐시" \
  --attr rejected_alternatives="memcached"
```

`rejected_alternatives`는 목록 타입이라 `--attr`를 반복해서 목록을 만듭니다 — 한 번만 쓰면
문자열이 되어 게이트가 거부합니다.

## MCP 설정

yoke를 에이전트(Claude Code 등)에 stdio MCP 서버로 붙입니다. 프로젝트 루트
`.mcp.json`:

```json
{
  "mcpServers": {
    "yoke": {
      "command": "yoke",
      "args": ["mcp", "--db", "./yoke.db"]
    }
  }
}
```

노출되는 도구:

- `yoke_inject` — 맥락 질의 → 검증된 지식을 인용과 함께 주입
- `yoke_commit` — 지식 적재 (`draft`로 진입)
- `yoke_record_decision` — 결정 숏컷 (결론 + 근거 + 기각한 대안)
- `yoke_persona` — 사람 스코프 주입 ("이 동료라면 어떻게 판단할까?")
- `yoke_overview` — 코퍼스 한눈에 보기: 타입별 수, 최다 연결 레코드, 저자별 검증 지식
- `yoke_use_scope` — 현재 collaboration을 고정해 세션 전체가 하나의 작업 컨텍스트를 공유

## 임베딩 (Embeddings)

**yoke에는 모델이 딸려 오지 않고, 앞으로도 그렇습니다.** provider 설정은 하나 — OpenAI 호환
임베딩 서비스의 **API 루트** — 그래서 같은 세 줄로 OpenAI, Azure, Ollama, vLLM, TEI, LiteLLM에
모두 닿습니다. `/embeddings`는 yoke가 직접 붙이므로, 뒤에 이미 붙은 URL은
`/v1/embeddings/embeddings`를 요청하며 임베더가 조용히 깨집니다. ONNX 런타임을 번들하면 전역
설치되는 CLI에 플랫폼 바이너리 258MB와 크로스 플랫폼 프리빌드 함정이 하나 더 붙습니다 —
조사한 모든 관행이 모델을 애플리케이션 프로세스 밖에 둡니다.

무료·로컬·키 불필요로는 [Ollama](https://ollama.com):

```bash
ollama pull bge-m3
export YOKE_EMBED_URL=http://localhost:11434/v1
export YOKE_EMBED_MODEL=bge-m3                      # 키 불필요
```

`bge-m3`가 권장 기본값입니다: 한 모델로 100개 이상 언어, 8192 토큰 컨텍스트, 1024 차원, MIT.
**지식이 대부분 영어가 아니라면 `nomic-embed-text`를 쓰지 마세요** — 영어 중심 모델이라 다른
언어의 의미 매칭이 조용히 키워드 검색 수준으로 퇴화합니다. 설정된 것처럼 보이지만 아닙니다.

호스팅 provider를 쓴다면:

```bash
export YOKE_EMBED_URL=https://api.openai.com/v1     # API 루트 — 뒤에 /embeddings 붙이지 않음
export YOKE_EMBED_MODEL=text-embedding-3-large
export YOKE_EMBED_KEY=sk-...
```

**`.mcp.json`에만 두지 말고 셸에 설정하세요.** MCP 서버의 `env`는 그 프로세스에만 적용되므로,
`.mcp.json`에만 넣으면 `yoke add`, `yoke ui`와 모든 커넥터가 벡터 없는 레코드를 씁니다 — 고치기
전 이 저장소의 데이터베이스에서 엔티티 3건 중 1건으로 측정됐습니다.

### 임베딩이 하는 일과, 없을 때 벌어지는 일

| | provider 있음 | 없음 |
|---|---|---|
| 지식 저장 | 예 | **예** — provider가 죽어도 레코드가 거절되는 일은 없습니다 |
| commit 시 중복 후보 | 예 | **아니오, 그리고 `yoke add`가 그렇게 말합니다** — FTS 폴백은 없습니다. 모든 FTS 히트를 중복으로 치면 대부분 오탐이기 때문입니다 |
| `conflicts_with` 자동 탐지 | 예 | 아니오 |
| 검색 / 주입 | 예 | 키워드만 남습니다 — 문장형 질의의 recall@10이 데모 골드셋 기준 82.4%에서 52.0%로 떨어집니다 |

커버리지는 언제든 복구할 수 있습니다 — 벡터는 지식이 아니라 파생 인덱스라서, 새 버전을 쓰지도
인용을 바꾸지도 않습니다:

```bash
yoke backfill --embeddings                 # 현재 모델로 전체 인덱싱
yoke backfill --embeddings --rebuild       # 모델을 바꾼 뒤 (차원이 다름)
```

인덱스 키가 산문으로 바뀌기 전에 쓰인 데이터베이스는 `yoke backfill --embeddings --rebuild` 한
번으로 인덱스 양쪽을 다시 키잉해야 합니다. 그전까지는 옛 키로 검색합니다 — 깨지지는 않고 순위만
나빠집니다.

한 데이터베이스의 벡터 공간은 하나입니다. `--rebuild` 없이 모델을 바꾸면 발견한 차원과 위 복구
명령을 함께 알리며 요란하게 실패합니다 — 섞인 공간은 자신 있게 틀린 이웃을 돌려주기 때문입니다.

## 회사가 이미 운영하는 서버에 연결

Postgres든 OpenSearch든, 이미 운영 중인 서버를 그대로 가리킵니다. 지식은 그쪽에
저장되고, **이 클라이언트의 감사 추적과 API 토큰은 로컬 sqlite에 남습니다**(`--db`가
계속 그 로컬 절반을 가리킵니다 — 남의 데이터베이스에 yoke의 장부를 넣어달라고 하면
거절당할 테니까요). 나머지는 전부 동일하게 동작합니다: `add`, `review`, `verify`,
`inject`, `yoke ui`, MCP.

```bash
# Postgres — 대부분의 조직이 이미 갖고 있는 그 DB. pgvector가 있으면 `similar`까지.
export YOKE_POSTGRES_URL=postgres://user:pass@localhost:5432/db
export YOKE_POSTGRES_SCHEMA=team_a                 # 선택: 한 데이터베이스에 yoke DB 두 개

# — 또는 OpenSearch (둘 다 지정하면 에러입니다: 서로 다른 지식 저장소)
export YOKE_OPENSEARCH_URL=http://localhost:9200
export YOKE_OPENSEARCH_USER=admin YOKE_OPENSEARCH_PASSWORD=…   # 보안 클러스터만
export YOKE_OPENSEARCH_PREFIX=team_a_              # 선택: 한 클러스터에 yoke DB 두 개

yoke init                                          # 스키마/인덱스 생성, 온톨로지 시드
```

검색은 둘 다 네이티브 스코어드(Postgres `ts_rank` / OpenSearch BM25)이고 `similar`도
엔진이 답합니다(pgvector / k-NN). 의존성 추가는 없습니다 — `pg`는 RDB 커넥터용으로
이미 트리에 있었고, OpenSearch 어댑터는 순수 REST입니다.

같은 줄들을 작업 디렉터리의 `.env`에 둬도 됩니다 (`cp .env.example .env`).

## 웹 UI

브라우저에서 쓰는 거버넌스 워크벤치 — CLI가 노출하는 것과 같은 core 함수의 사람용
면입니다. 지식에 질문하는 곳은 아닙니다(그건 MCP로 연결된 AI의 일입니다): 모든 화면은
타입·버전·인용이 붙은 **기록**을 보여줍니다.

```bash
yoke ui                      # http://127.0.0.1:4800 — 로컬, 단독, 인증 없음
yoke serve --auth --host 0.0.0.0   # 팀 공유. `yoke token create` 로 만든 토큰으로 로그인
```

화면: review 큐, conflicts, 온톨로지 브라우저, persona 미리보기, 엔티티 상세, 주입
미리보기("이 쿼리면 내 에이전트가 실제로 뭘 받나?"), 힘기반 그래프 탐색, 감사 로그.
정적 번들 하나, 포트 하나. `yoke serve`에서는 같은 프로세스가 `POST /mcp`도 처리해
팀 배포에 따로 필요한 게 없고, `yoke ui`는 워크벤치만 제공합니다.

서버는 기본적으로 루프백에 바인딩합니다. `yoke ui`는 인증이 없어서 개방은 명시적
`--host`이고, 닿을 수 있는 누구나 이 DB의 지식을 읽고 만들고 폐기하고 이름을 바꿀 수
있다고 경고합니다 — 크레덴셜 발급만은 비루프백 호출자에게 거부됩니다. `yoke serve`는
인증할 수 있으므로 그럴 이유가 없고, `--auth` 없는 비루프백 바인딩을 아예 거부합니다.

## CLI

```
yoke init | add | get | search | list | link | verify | deprecate
yoke review [--stale]                         # 검토 대기 draft / TTL 지난 verified
yoke inject <query> [--include-draft] [--limit n] [--scope <id>] [--depth n] [--as-of ts]
yoke overview | graph [--limit n]             # 코퍼스 한눈에 보기 / 엣지로 보기
yoke conflicts | ontology <list|add-type> | rename-type <from> <to>
yoke persona <person-id> [--out dir] | persona --check <SKILL.md>
yoke history <id> | audit [--since ts] [--until ts] [--limit n] [--shape]
yoke connect github-pr|slack|notes|raw|rdb ...
yoke mcp | ui | serve [--auth] [--host addr] | token <create|list|revoke>
yoke backup <dest.db> [--force] | restore <src.db> [--force]
yoke export --until <ts> --out <new.db>       # --shards <file> 로 백엔드 연합
yoke backfill [--embeddings [--rebuild]]      # 저작 엣지 / 벡터 인덱스 복구
yoke backfill --occurred-at [--dry-run]       # 이전 verify가 덮어쓴 이벤트 시각 복원
```

공통 옵션: `--db`(> `YOKE_DB` env > `./yoke.db`), `--actor`(> `YOKE_ACTOR` env
> `yoke:system`), `--json`(기계용 출력).

환경변수는 작업 디렉터리의 **`.env`**에 둘 수 있습니다 — `cp .env.example .env` 후
필요한 줄의 주석을 해제하면 됩니다. Node 내장 파서가 읽으므로 의존성도, 우리만의
형식도 없습니다. 우선순위는 **CLI 플래그 > 실제 환경변수 > `.env` > 기본값** —
셸 export나 CI 시크릿이 항상 파일을 이깁니다. `.env`는 gitignore되고, 커밋되는
`.env.example`은 yoke 자신이 읽는 `YOKE_*` 변수를 전부 나열합니다.

## 공유 작업 컨텍스트

팀이 하나의 지식 공간을 함께, 실시간으로 쌓습니다. 사용자가 "이건 PAY-42
작업이야"라고 하면 에이전트가 `yoke_use_scope`로 한 번 선언하고, 세션 전체가 그
`collaboration`을 기본값으로 씁니다 — 주입은 그 지식을 앞세우고, 기록되는 것은
자동으로 거기 연결됩니다. 한 사람이 기록(하고 사람이 검증)한 결정은, 다음 질의부터
다른 모든 세션의 컨텍스트에 들어 있습니다.

스코프는 **우선순위일 뿐, 가두지 않습니다**: 고정한 collaboration이 앞장서지만, 쿼리에는
전사 지식과 persona도 함께 흘러듭니다. 그리고 컨텍스트는 작업보다 오래 남습니다 —
collaboration이 끝나도 그 지식은 닫힌 티켓 속으로 사라지지 않고 그래프에 조직의 기억으로
남습니다.

persona는 앵커를 collaboration 대신 사람에 둔 **같은 메커니즘**입니다 — 저작 정보가 그래프
엣지라서, "이 사람이 아는 것"과 "이 작업에 대해 아는 것"은 이름만 다른 하나의 순회입니다.
차이는 하나뿐이고 의도된 것입니다: persona는 엄격합니다. 그 사람이 쓰지 않은 지식을 그
사람의 판단으로 제시하는 건 흉내이기 때문입니다.

## 품질 측정

yoke는 세 가지를 측정하며, 각각 다른 질문에 답합니다.

**주입 품질**(`npm run eval`) — 필터가 버티는가, 탐지가 주장하는 것을 실제로 찾는가.
`YOKE_EMBED_URL`에 `bge-m3`를 연결해 60건 심은 코퍼스에서 2026-08-17 측정:

| 지표 | 정의 | 목표 | 측정값 |
|---|---|---|---|
| 오염률 | 주입 결과 중 draft 비율 | 0% | **0.0%** (후보 40건 중 verified 20건만 주입) |
| 모순 미탐지율 | 반대 결론 decision 쌍 중 conflicts_with 미연결 | 0% | **80.0%** (5건 중 1건 탐지) |
| 오탐 연결률 | 모순이 아닌 같은 주제 쌍이 충돌로 연결된 비율 | 0% | **100.0%** (5건 중 5건) |

**필터는 버티고, 모순 탐지기는 버티지 않습니다. 그리고 그 이유가 구조적입니다.**
4단계는 *중복* 탐지가 이미 올린 레코드만 검토하므로 코사인 0.85 이상만 봅니다. 실제
임베딩에서 "반대"는 "다시 말한 것"보다 덜 유사하게 나옵니다: 반대 결론 쌍 5건은
0.803–0.866(기준선 위 1건), 모순이 아닌 세부화 쌍 5건은 0.859–0.924(5건 전부 위)로
측정됐습니다. 즉 게이트는 재진술을 골라내는데, 그건 중복 찾기에는 정확히 맞고 불일치
찾기에는 거꾸로입니다. 이전의 미탐지율 0%는 심어둔 주제어로 벡터를 만드는 스텁 임베더에서
나온 값입니다 — 후보가 주어졌을 때 4단계가 엣지를 만든다는 것만 증명하고, 모델이 후보를
줄 것이라는 건 증명하지 않았습니다.

오늘 이것이 지불하는 비용을 그대로 적으면: 직접 파일한 `conflicts_with` 엣지는 어디서나
그대로 존중됩니다(주입이 양쪽을 상충 표시로 넘기고, 충돌 화면이 목록으로 보여줍니다).
그러나 **자동 탐지가 모순을 찾아줄 것이라고 믿을 수는 없고**, 서로 세부화하는 레코드를
연결하기도 합니다. `npm run eval`을 직접 돌려보세요 — 임베더 설정이 없으면 스텁으로
떨어지고, 매 실행이 그 사실을 출력합니다.

주입 축의 정밀도는 이 eval이 아니라 아래 `eval:retrieval`입니다.

**persona 품질**(`npm run eval:persona`) — persona가 그 사람의 검증된 판단만 돌려주는가.
심어둔 실패 모드 다섯 가지(같은 주제에 대한 동료의 기록, 저작이 아닌 연결, 남이 쓴 출처,
본인의 draft, 본인의 오래된 기록)에 대해 사칭·draft 누출·stale 누출률 **0%**, recall은
전체와 주제 질의 모두 **100%**입니다.

**검색 품질**(`npm run eval:retrieval -- <db>`) — 올바른 레코드가 돌아오는가. 적재된
코퍼스 위에서 `eval/gold-set.json`으로 측정합니다. 실제 텍스트에 대한 검색을 재는
쪽입니다. 데모 코퍼스 + `bge-m3`, 66개 질의 k=10 기준 recall@10 **85.4%**,
nDCG **75.7%**, accuracy@1 **65.2%** — 관련 레코드 109건 중 89건(2026-08-17 측정).
이 숫자를 움직이는 건 질의를 어떻게 쓰느냐입니다: 에이전트가 보내는 문장형은
recall@10 82.4%, 한두 단어짜리는 100%입니다. 리포트는 합계만이 아니라 아무것도 못
찾은 질의를 이름으로 출력합니다.

정밀도(precision)도 함께 보고되며, 반드시 자기 상한과 함께 읽어야 합니다: k=10에서 상한
**16.5%** 대비 **13.5%**입니다. 골드셋의 질의당 관련 레코드가 2건 미만이라 10칸 중 8칸은
검색이 무엇을 하든 관련될 수 없습니다 — 즉 도달 가능한 값의 82%이고, 이를 올리는 방법은
k를 줄이는 것으로 위 "토큰당 정답"과 같은 트레이드입니다. 키워드 전용이 원시 정밀도
16.4%로 더 높은 건 단지 반환 건수가 적기 때문입니다.

## 문서

| 문서 | 내용 |
|---|---|
| [VISION](docs/VISION.md) | yoke가 존재하는 이유, 버전 스코프, persona · 공유 컨텍스트 |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | 포트/어댑터 경계 |
| [KNOWLEDGE-POLICY](docs/KNOWLEDGE-POLICY.md) | 게이트, 라이프사이클, 주입 필터 규칙 |
| [SPEC](docs/SPEC.md) | 구현 계약 — 스키마, port, 게이트, MCP 도구, CLI |
| [WEB-UI](docs/WEB-UI.md) | 거버넌스 워크벤치 — 12개 화면과 넘지 않는 선 |
| [ROADMAP](docs/ROADMAP.md) | v0.1 → v6.1 구현 완료 — 버전 순서대로, 각 절이 기록 |
| [BACKENDS](docs/BACKENDS.md) | 어댑터 확장 + RDB read-mapping (실사용 검증 노트 포함) |
| [ENTERPRISE](docs/ENTERPRISE.md) | 멀티테넌시, auth, RBAC, 복제, 샤딩 |
| [MARKET](docs/MARKET.md) | 경쟁 지형과 포지셔닝 |

## 라이선스

MIT
