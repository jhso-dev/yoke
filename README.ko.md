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

MIT · v4.0까지 기능 완성 · [비주얼 소개](https://claude.ai/code/artifact/09d92d76-5eee-453d-ae79-ec40616f6396)

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
   검증은 의도적으로 사람의 행위입니다(`yoke verify`). `verified`만 AI의
   컨텍스트에 닿습니다.
3. **아무것도 조용히 덮이지 않는다.** 저장은 append-only입니다 — 수정은 새 버전,
   삭제는 tombstone. 임의 시점의 믿음을 언제든 재구성할 수 있고, 주입되는 모든
   항목에 인용이 붙습니다 — `[type:id@vN] actor, occurred_at` — 그래서 모든
   주장이 감사 가능합니다.
4. **모순은 드러내되 자동 해소하지 않는다.** 새 지식이 검증된 기록과 충돌하면
   yoke는 둘 다 보존하고 `conflicts_with` 관계로 묶어 사람이 판단하게 합니다.
   불일치의 존재 자체가 지식이며, 승자를 고르는 건 DB의 일이 아닙니다.
5. **지식은 만료된다.** `verified`가 영원하진 않습니다 — 타입별 TTL을 넘기면
   읽기 시점에 `stale`로 강등되어, 누군가 재확인하기 전까지 주입 경로에서
   빠집니다. 낡은 진실은 가장 정중한 형태의 허위정보이고, yoke는 그렇게
   취급합니다.

그리고 주장이 아니라 측정입니다: 주입 품질 eval은 **오염률 0%**, **모순 미탐지율
0%**를 보고합니다(아래 참고).

로컬·임베디드로 동작합니다 — better-sqlite3 + FTS5 + sqlite-vec, 서버 불필요.

## 한눈에 보기

| | |
|---|---|
| **한 줄 요약** | 지식에 최적화된 데이터베이스: 온톨로지로 구조화한 뒤, 지금 맥락에 맞는 검증된 부분집합만 인용과 함께 AI에 주입합니다. |
| **프론트 어댑터** | **MCP 서버**(`inject` · `commit` · `record_decision` · `persona` · `use_scope`)와 **thin CLI**. 모든 AI 도구는 그저 MCP 클라이언트 — 도구별 어댑터 없음. |
| **스토리지 백엔드** | `sqlite`(기본, FTS5 + sqlite-vec) · `kuzu`(임베디드 그래프) · `qdrant`(벡터 검색) · `sharded`(테넌트별 멀티 백엔드 연합). 모두 하나의 conformance 스위트를 통과. |
| **캡처 커넥터** | `github-pr`(리뷰 코멘트), `slack`(채널 + 스레드), `notes`(로컬 회의록), `rdb`(Postgres/MySQL read-mapping) — 외부 소스 → draft 지식. |
| **persona** | "이 동료라면 어떻게 판단할까?" → 그 사람의 기록된 검증 판단을 인용과 함께, 실시간 생성으로. 흉내가 아니라 인용. |
| **공유 작업 컨텍스트** | `workstream`을 고정하면 팀이 하나의 컨텍스트를 공유 — 스코프는 전사 지식을 가리지 않고 우선순위만 부여. |
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
yoke inject "배포 언제"                       # 검증된 지식만, 인용과 함께 주입
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
  --attr rejected_alternatives="인프로세스 캐시"
```

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
- `yoke_use_scope` — 현재 workstream을 고정해 세션 전체가 하나의 작업 컨텍스트를 공유

임베딩 provider(중복·모순 탐지를 활성화)는 환경 변수로 설정합니다. 미설정 시
FTS로 폴백합니다:

```bash
export YOKE_EMBED_URL=https://api.example.com/v1   # OpenAI 호환 /embeddings
export YOKE_EMBED_MODEL=text-embedding-3-small
export YOKE_EMBED_KEY=sk-...
```

무료·로컬·키 불필요로는 [Ollama](https://ollama.com)를 쓸 수 있습니다(실사용 검증
완료 — 중복 경고와 `conflicts_with` 탐지 모두 동작):

```bash
ollama pull nomic-embed-text
export YOKE_EMBED_URL=http://localhost:11434/v1
export YOKE_EMBED_MODEL=nomic-embed-text            # 키 불필요
```

## CLI

```
yoke init | add | get | search | review | verify | deprecate
yoke inject <query> [--include-draft] [--scope <id>]
yoke conflicts | ontology <list|add-type> | persona <person-id>
yoke history <id> | audit [--since ts]
yoke connect github-pr|slack|notes|rdb ...
yoke mcp | ui | serve [--auth] | token <create|list|revoke>
yoke backup | restore | export [--until ts]   # --shards <file> 로 백엔드 연합
```

공통 옵션: `--db`(> `YOKE_DB` env > `./yoke.db`), `--actor`(> `YOKE_ACTOR` env
> `yoke:system`), `--json`(기계용 출력).

## 공유 작업 컨텍스트

팀이 하나의 지식 공간을 함께, 실시간으로 쌓습니다. 사용자가 "이건 PAY-42
작업이야"라고 하면 에이전트가 `yoke_use_scope`로 한 번 선언하고, 세션 전체가 그
`workstream`을 기본값으로 씁니다 — 주입은 그 지식을 앞세우고, 기록되는 것은
자동으로 거기 연결됩니다. 한 사람이 기록(하고 사람이 검증)한 결정은, 다음 질의부터
다른 모든 세션의 컨텍스트에 들어 있습니다.

스코프는 **우선순위일 뿐, 가두지 않습니다**: 고정한 workstream이 앞장서지만, 쿼리에는
전사 지식과 persona도 함께 흘러듭니다. 그리고 컨텍스트는 작업보다 오래 남습니다 —
workstream이 끝나도 그 지식은 닫힌 티켓 속으로 사라지지 않고 그래프에 조직의 기억으로
남습니다.

## 품질 측정

recall 벤치마크 대신, yoke는 **주입 품질**을 측정합니다(`npm run eval`):

| 지표 | 정의 | 목표 | 측정값 |
|---|---|---|---|
| 오염률 | 주입 결과 중 draft 비율 | 0% | **0.0%** (후보 40건 중 verified 20건만 주입) |
| 모순 미탐지율 | 반대 결론 decision 쌍 중 conflicts_with 미연결 비율 | 0% | **0.0%** (5/5 탐지) |

## 문서

| 문서 | 내용 |
|---|---|
| [VISION](docs/VISION.md) | yoke가 존재하는 이유, 버전 스코프, persona · 공유 컨텍스트 |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | 포트/어댑터 경계 |
| [KNOWLEDGE-POLICY](docs/KNOWLEDGE-POLICY.md) | 게이트, 라이프사이클, 주입 필터 규칙 |
| [SPEC](docs/SPEC.md) | 구현 계약 — 스키마, port, 게이트, MCP 도구, CLI |
| [ROADMAP](docs/ROADMAP.md) | v0.1 → v4.0, 전부 완료 |
| [BACKENDS](docs/BACKENDS.md) | 어댑터 확장 + RDB read-mapping (실사용 검증 노트 포함) |
| [ENTERPRISE](docs/ENTERPRISE.md) | 멀티테넌시, auth, RBAC, 복제, 샤딩 |
| [MARKET](docs/MARKET.md) | 경쟁 지형과 포지셔닝 |

## 라이선스

MIT
