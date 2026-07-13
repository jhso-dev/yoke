# yoke

**AI에 주입되는 지식의 Git.**

경쟁자는 기억(memory, 자동)을 판다. yoke는 지식(knowledge, 거버닝)을 판다.
메모리 레이어는 AI가 *뭘 기억할지*를 자동화하고, yoke는 AI가 *뭘 믿을지*를 관리한다.

- **단일 쓰기 경로**: 모든 지식은 commit 게이트(온톨로지 검증 → 출처 검증 →
  중복·모순 탐지 → draft 적재)를 통과한다. 우회 경로 없음.
- **verified만 주입**: `draft`/`stale`/`deprecated`는 AI 맥락에 들어가지 않는다.
  부패 신호를 주입하지 않는다.
- **append-only + 감사 가능**: 수정은 새 버전 행. 모든 주입에 인용
  (`[type:id@vN] actor, occurred_at`)이 붙는다.
- **로컬/임베디드**: better-sqlite3 + FTS5 + sqlite-vec. 서버 불필요.

## 60초 퀵스타트

```bash
npm install -g yoke      # 또는: npx yoke <cmd>

yoke init                                    # ./yoke.db 생성 + 온톨로지 시드
yoke add fact --attr statement="배포는 화요일 오전에만 한다"
yoke review                                  # draft 큐 확인
yoke verify <id>                             # 승격 (또는 yoke verify --all-drafts)
yoke inject "배포 시점"                       # verified 지식만 인용과 함께 주입
```

`add`로 들어온 지식은 `draft`다. `verify`로 승격되기 전까지 `inject`에 나오지 않는다 —
이것이 거버넌스의 핵심이다. `yoke verify --all-drafts`로 콜드 스타트 시 일괄 승격.

decision 기록:

```bash
yoke add decision \
  --attr conclusion="Redis로 캐싱한다" \
  --attr rationale="P99 지연이 목표를 초과" \
  --attr rejected_alternatives="in-process cache"
```

## MCP 등록

에이전트(Claude Code 등)에서 stdio MCP 서버로 붙인다. 프로젝트 루트 `.mcp.json`:

```json
{
  "mcpServers": {
    "yoke": {
      "command": "npx",
      "args": ["yoke", "mcp", "--db", "./yoke.db"]
    }
  }
}
```

제공 도구: `yoke_inject`(맥락 질의 → verified 주입), `yoke_commit`(지식 적재),
`yoke_record_decision`(decision 숏컷), `yoke_persona`(person 스코프 주입).

임베딩 provider(중복·모순 탐지 활성화)는 환경변수로 설정한다. 미설정 시 FTS 폴백:

```bash
export YOKE_EMBED_URL=https://api.example.com/v1   # OpenAI 호환 /embeddings
export YOKE_EMBED_MODEL=text-embedding-3-small
export YOKE_EMBED_KEY=sk-...
```

## CLI

```
yoke init | add | get | search | review | verify | deprecate
yoke inject <query> [--include-draft]
yoke conflicts | ontology <list|add-type> | persona <person-id>
yoke connect github-pr --repo owner/name
yoke mcp [--db path]
```

공통 옵션: `--db`(> `YOKE_DB` env > `./yoke.db`), `--actor`(> `YOKE_ACTOR` env >
`yoke:system`), `--json`(기계용 출력).

## 품질 측정

recall 벤치마크 대신 **주입 품질**을 측정한다 (`npm run eval`):

| 지표 | 정의 | 목표 | 실측 |
|---|---|---|---|
| 오염 주입률 | inject 결과 중 draft 비율 | 0% | **0.0%** (40 후보 중 20 verified만 주입) |
| 모순 미탐지율 | 반대 결론 decision 쌍 중 conflicts_with 미생성 비율 | 0% | **0.0%** (5/5 탐지) |

## 라이선스

MIT
