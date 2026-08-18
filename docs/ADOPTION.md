# 도입 플레이북 — makers 조직이 yoke로 생산성을 올리는 법

이 문서는 새 기능을 정의하지 않는다. yoke는 이미 캡처·검증·주입·페르소나·거버넌스를 전부 갖췄다. 부족한 것은
기능이 아니라 **루틴**이다. 브리핑·페르소나의 품질은 각 역할이 실제로 남긴 `decision`만큼만 좋다 — 즉
조직 생산성의 레버는 **capture density**(기록 밀도)이지, 코드가 아니다.

역할별로 "무엇을 넣고, 무엇을 되받는가"를 정하고, 그 사이를 세 개의 의식(ritual)으로 잇는다.

## 1. 공통 루프 (모든 역할 동일)

```
캡처(draft) ─▶ 검증(사람 게이트) ─▶ 주입(검증된 것만) ─▶ 신선도(만료 재확인) ─┐
   ▲                                                                          │
   └──────────────────────────────────────────────────────────────────────────┘
```

| 단계 | 무엇 | 도구 |
|---|---|---|
| **캡처** | 결정·사실·용어를 draft로 남긴다 | MCP `yoke_commit` / `yoke_record_decision`(에이전트 대화 중) · CLI `yoke add` / `yoke link` · 커넥터 |
| **검증** | 사람이 draft를 verified로 승격 (거버넌스의 핵심 행위) | `yoke review` → `yoke verify` |
| **주입** | AI가 작업 맥락으로 스코프해 **검증된 지식만** 받는다 | `yoke_inject` · `yoke_use_scope` · `yoke_persona` |
| **신선도** | TTL 만료 지식을 담당자가 재확인 (fact 180일, decision 365일) | `yoke review --stale` |

**불변 규칙 두 가지** (yoke가 강제):
- 에이전트는 draft만 만든다. verify/deprecate는 사람만. → 검증 권한이 곧 지식 거버넌스 권한.
- 승격/검증은 원저자를 보존해야 한다. **`yoke verify --all-drafts`로 한 계정 일괄 승격 금지** — head provenance를
  덮어써 작성자를 지우고 페르소나·만료 담당자 라우팅을 무력화한다. 검토 스윕은 레코드별 작성자를 유지하며 승격한다.

## 2. 역할별 캡처 · 소비

기존 온톨로지에 그대로 매핑된다(새 타입 불필요). 역할 고유 타입이 필요하면 `yoke ontology add-type <json>`으로
**데이터로** 확장한다(코드 변경 없음).

| 역할 | 캡처(주로 남기는 것) | 소비(주로 되받는 것) |
|---|---|---|
| **PO** | `decision`(제품 우선순위 + 기각 대안) · `term`(도메인 용어) · `collaboration`(이니셔티브) | 과거 PO 결정 페르소나, 워크스트림 브리핑 |
| **PD** | `decision`(디자인 원칙·트레이드오프) · `resource`(Figma 등 레퍼런스) | 디자인 결정 페르소나, 디자인 시점 주입 |
| **개발** | `decision`(아키텍처·기술 + 기각 대안, ADR 형태) · `fact`(시스템 동작) · `derived_from`(근거) | 코딩 중 in-flow 주입, 아키텍처 페르소나 |
| **사업팀** | `term`(도메인 어휘) · `fact`(시장·운영) · `decision`(전략) | 용어집, 브리핑 |

핵심은 `decision`이다: `conclusion`(결론) + `rationale`(근거) + `rejected_alternatives`(기각 대안). 기각 대안이
"판단의 절반"이며 페르소나의 원료다. 결론만 남기고 대안을 버리면 나중에 "왜 그때 그렇게 안 했지?"에 답할 수 없다.

**개발 역할의 자동 캡처**: `yoke connect github-pr --repo owner/name`으로 PR 논의를 draft로 흡수한다. 사람이 매번
타이핑하지 않아도 결정의 원료가 쌓인다.

## 3. 협업은 역할이 아니라 이니셔티브에 모인다 (cross-role)

`collaboration`을 부서(역할별 사일로)로만 쓰면 협업이 안 나온다. 진짜 협업은 **하나의 이니셔티브(작업 항목)에 여러 역할이
함께 붙는 것**이다 — 배틀그라운드 하나에 PO(스코프)·PD(코어 디자인)·개발(엔진·서버)·사업(투자·글로벌 퍼블리싱)이 다 얽혔듯.

- 이니셔티브마다 `collaboration` 하나를 만들고, 관여하는 **모든 역할의 사람**을 `works_on`으로, 관련 **모든 역할의 레코드**를
  `relates_to`(또는 커밋 시 `--scope`)로 붙인다.
- 그러면 `yoke inject --scope <initiative>` (빈 쿼리 = 브리핑)가 **한 이니셔티브의 cross-functional 지식**을 한 번에 준다 —
  PO 결정 + 디자인 원칙 + 아키텍처 결정 + 사업 판단이 인용과 함께, 모순은 모순대로 표시되어. 이게 팀 생산성의 핵심 화면이다.
- 부서 collab(기능적 홈)은 남겨도 되지만, **에이전트가 앵커하는 단위는 이니셔티브**여야 협업이 산출된다.
- **주입 시점을 세션 시작에 건다**: 브리핑은 에이전트가 호출해야 나온다 — 부르는 것을 사람 습관에 맡기지 말고,
  클라이언트의 세션 시작 훅이 `yoke inject "" --scope <initiative>`를 실행해 출력을 세션 첫 컨텍스트로 넣는다
  (Claude Code는 `SessionStart` 훅; 다른 MCP 클라이언트는 각자의 시작 훅·프롬프트). yoke에 새 기능이 필요 없는
  순수 클라이언트 설정이다 — 코어는 브리핑 계약(정렬·상한·omitted 고지)을 이미 제공한다.

## 4. 세 개의 의식 (capture density를 만드는 것)

1. **결정 즉시 기록** — 에이전트가 결정 순간 `yoke_record_decision`을 유도하도록 팀 프롬프트/스킬에 규약을 박는다.
   "결정했으면 근거·기각 대안과 함께 남긴다"가 습관이 되어야 밀도가 붙는다.
2. **주간 검증 스윕** — 검토 큐를 소비 순으로 비운다(`yoke review`). 승격 마찰을 0에 가깝게. 스쿼드의 검증 오너 1명이
   주 1회 훑는다. (거부 액션은 없다 — 부정 신호는 `yoke deprecate`.)
3. **만료 재확인** — `yoke review --stale`(가장 많이 주입된 것 먼저)로 오래된 지식을 담당자에게 되돌린다. 만료를 고치는
   것이 아니라 바꿔야 할 사람에게 넘기는 것이 핵심.

## 5. 채택 순서 (bottom-up)

위에서 강제로 깔지 않는다. 지식은 격리, 온톨로지(어휘)는 공유한다.

1. **개별 개발자** — 로컬 `yoke mcp`(단일 사용자·무인증). 자기 결정을 draft로 남기고 자기 에이전트가 주입받는다.
   여기서 가치를 체감해야 다음이 붙는다.
2. **스쿼드** — 스쿼드별 네임스페이스(`--ns <squad>`) + 검증 오너. `yoke serve --auth`로 팀 접근을 연다. 이때부터
   거버넌스(검토/만료 큐, RBAC의 read/write/verify 분리)가 실제로 작동한다.
3. **조직** — 스쿼드들이 온톨로지(공통 어휘)를 공유하되 각자의 지식은 네임스페이스로 격리. 크로스-스쿼드 지식 공유는
   설계상 없다 — 팀은 어휘를 공유하지 레코드를 공유하지 않는다.

## 6. 성공 지표

| 지표 | 무엇을 본다 | 측정 |
|---|---|---|
| 캡처율 | 역할별 주간 신규 `decision` 수 | `yoke audit` / `yoke overview` |
| 주입 적중 | AI가 맞는 지식을 받는가 | `npm run eval:retrieval -- <db> <gold>` (recall@10 / accuracy@1) |
| 페르소나 커버리지 | 사람별 source knowledge 수 | `yoke persona <person>` (source knowledge n) |
| 만료 큐 건강도 | 재확인이 밀리지 않는가 | `yoke review --stale` 길이 |
| 오염률 | draft가 새어 주입되지 않는가 (항상 0%) | `npm run eval` |

## 7. 스케일 검증 (도입 전 리허설)

조직에 깔기 전, 루프가 수만 건 규모에서 배관되는지 먼저 확인한다. 「크래프톤 웨이」를 묘사한 합성 테스트 코퍼스로
리허설한다 — 4역할·다인물·페르소나 검증이 가능한 하나의 스토리라인이며, 공개된 사실을 묘사한 합성 데이터다.

```
node scripts/gen-kraftonway-corpus.mjs kraftonway.db 30000     # 커밋 경로·작성자별 verify로 로드
npm run eval:retrieval -- kraftonway.db eval/gold-set-kraftonway.json   # 역할별 검색 품질
npm run eval && npm run eval:persona                           # 주입·페르소나 안전성 (자족)
node dist/front/cli/index.js persona person:kim-changhan --db kraftonway.db   # 페르소나 실물
node dist/front/cli/index.js inject "" --scope collab:pubg --db kraftonway.db  # cross-role 브리핑(PUBG 이니셔티브)
```

코퍼스는 부서 collab 4개 위에 **cross-role 이니셔티브**(`collab:pubg`·`tera-launch`·`portfolio-pivot`·`ipo-2021`)를 얹어,
PUBG 하나에 PO·PD·개발·사업 지식이 함께 붙는다(§3). 임베더가 있으면(`YOKE_EMBED_URL`/`YOKE_EMBED_MODEL`) 하이브리드 검색·중복/모순 탐지까지 켜진다. 없으면 키워드 전용으로
로드되며, 이는 벡터 절반이 빠진 완전한 코퍼스다. 생성기 상세는 `scripts/gen-kraftonway-corpus.mjs` 헤더 참조.
