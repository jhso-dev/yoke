# 도입 플레이북 — makers 조직이 yoke로 생산성을 올리는 법

이 문서는 새 기능을 정의하지 않는다. yoke는 이미 캡처·주입·페르소나·거버넌스를 전부 갖췄다. 부족한 것은
기능이 아니라 **루틴**이다. 브리핑·페르소나의 품질은 각 역할이 실제로 남긴 `decision`만큼만 좋다 — 즉
조직 생산성의 레버는 **capture density**(기록 밀도)이지, 코드가 아니다.

역할별로 "무엇을 넣고, 무엇을 되받는가"를 정하고, 그 사이를 세 개의 의식(ritual)으로 잇는다.

## 1. 공통 루프 (모든 역할 동일)

```
캡처(서명·즉시 반영) ─▶ 주입(유효한 것만) ─▶ 신선도(만료 재확인·퇴출) ─┐
   ▲                                                                    │
   └────────────────────────────────────────────────────────────────────┘
```

| 단계 | 무엇 | 도구 |
|---|---|---|
| **캡처** | 결정·사실·용어를 남긴다 — 행위자의 서명과 함께 즉시 살아 있다 | MCP `yoke_commit` / `yoke_record_decision`(에이전트 대화 중) · CLI `yoke add` / `yoke link` · 커넥터 |
| **주입** | AI가 작업 맥락으로 스코프해 **유효한 지식만** 받는다 (stale·퇴출 제외) | `yoke_inject` · `yoke_use_scope` · `yoke_persona` |
| **김매기** | TTL 만료 지식을 담당자가 재확인하거나 사유와 함께 퇴출 — 퇴출 사유는 받았던 모든 세션에 방송된다 (fact 180일, decision 365일) | `yoke review` → `yoke verify` / `yoke deprecate --reason` |

**불변 규칙 두 가지** (yoke가 강제):
- 모든 레코드에 서명이 있다 — `serve --auth`에서는 행위자가 자격증명에 묶인다. 들어온 것은 누군가 책임진다.
- 재확인은 원저자를 보존한다 — head provenance가 아니라 `authored_by` 엣지가 저작의 근거라, 확인자가 바뀌어도
  페르소나·만료 담당자 라우팅은 저자를 따라간다.

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

**개발 역할의 자동 캡처**: `yoke connect github-pr --repo owner/name`으로 머지된 PR과 리뷰 논의를
흡수한다 — 머지된 PR 하나가 결정 하나(제목=결론, 본문=근거, 머지 시각=사건 시각)로, 커넥터의 서명과
함께 들어온다. 사람이 이미 쓰고 리뷰어가 이미 읽은 텍스트가 원료라서 기록 세금이 0이다 (실측:
이 저장소의 머지 PR 51건이 명령 하나로 결정 51건이 됐다). 백필은 명령 한 번, 이후에는 **머지가
캡처 시점**이다 — 머지마다 CI가 델타만 흘려 넣는다:

```yaml
# .github/workflows/yoke-capture.yml — 머지 = 캡처
on:
  pull_request:
    types: [closed]
jobs:
  capture:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - run: npm install -g <yoke 배포 패키지>   # 또는 조직의 설치 경로
      - run: yoke connect github-pr --repo ${{ github.repository }} --since ${{ github.event.pull_request.created_at }} --scope ${{ vars.YOKE_SCOPE }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          YOKE_SERVER: ${{ vars.YOKE_SERVER }}      # 팀 서버
          YOKE_TOKEN: ${{ secrets.YOKE_CAPTURE_TOKEN }}  # 기계 토큰: yoke token create --name ci-capture --scopes read,write
```

외부 ID(`pr:<repo>#<번호>`)가 멱등을 보장하므로 겹쳐 돌아도 중복은 없다. 같은 PR을 다시 흘려도
`skipped`로 끝난다.

## 3. 협업은 역할이 아니라 이니셔티브에 모인다 (cross-role)

`collaboration`을 부서(역할별 사일로)로만 쓰면 협업이 안 나온다. 진짜 협업은 **하나의 이니셔티브(작업 항목)에 여러 역할이
함께 붙는 것**이다 — 배틀그라운드 하나에 PO(스코프)·PD(코어 디자인)·개발(엔진·서버)·사업(투자·글로벌 퍼블리싱)이 다 얽혔듯.

- 이니셔티브마다 `collaboration` 하나를 만들고, 관여하는 **모든 역할의 사람**을 `works_on`으로, 관련 **모든 역할의 레코드**를
  `relates_to`(또는 커밋 시 `--scope`)로 붙인다.
- 그러면 `yoke inject --scope <initiative>` (빈 쿼리 = 브리핑)가 **한 이니셔티브의 cross-functional 지식**을 한 번에 준다 —
  PO 결정 + 디자인 원칙 + 아키텍처 결정 + 사업 판단이 인용과 함께, 모순은 모순대로 표시되어. 이게 팀 생산성의 핵심 화면이다.
- 부서 collab(기능적 홈)은 남겨도 되지만, **에이전트가 앵커하는 단위는 이니셔티브**여야 협업이 산출된다.
- **주입 시점을 훅에 건다 — 세션 시작에, 그리고 세션 도중에.** 브리핑은 에이전트가 호출해야 나온다 — 부르는 것을
  사람 습관에 맡기지 않는다. 그리고 결정은 세션이 열려 있는 동안 뒤집힌다: PO가 방금 확정한 결정, 방금 폐기한 결정은
  **지금 돌아가는 세션**에 닿아야 하고, 세션을 새로 열라는 건 도구가 사람에게 맞추는 게 아니다. 세션 시작 훅은 전체
  브리핑(`yoke inject --scope <initiative>`), 그 뒤 매 도구 호출과 매 프롬프트에 `--unseen`(SPEC "Since, and
  unseen")을 건다 — 이 클라이언트가 아직 받지 않은 것만 내놓고, **받아간 레코드가 그새 바뀌었으면 그것을 먼저**("사용자와
  재확인하라"와 함께), 아무것도 없으면 **출력 없음**이라 컨텍스트에 소음이 들어가지 않는다. 실측 110–130ms/호출(sqlite,
  node 기동 포함).

  **Claude Code는 이 전부가 플러그인이다** — 이 레포의 `plugin/`: 훅 3개 + yoke MCP 등록 + 레포를 워킹
  컨텍스트에 묶는 `/yoke:setup` 스킬.

  ```
  claude plugin marketplace add jhso-dev/yoke
  claude plugin install yoke@yoke        # 이후 레포마다 /yoke:setup 한 번
  ```

  스코프 바인딩은 레포의 `.claude/settings.json` `env.YOKE_SCOPE`(개인 오버라이드는
  `settings.local.json`), 훅은 그 파일을 직접 읽는다. 훅의 단 하나의 강한 규칙: **세션을 깨지 않는다** —
  스코프 미바인딩·yoke 미설치·스토어 불달은 전부 "출력 0, exit 0"이고, 배선 점검은 `/yoke:setup`이 소리 내서
  한다. 아래 수동 스니펫은 **다른 MCP 클라이언트용**으로 남는다 (Claude Code의 `.claude/settings.json`에
  직접 걸어도 물론 동작한다):

  ```json
  {
    "hooks": {
      "SessionStart":     [{ "hooks": [{ "type": "command", "command": "yoke inject --scope <initiative>" }] }],
      "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "yoke inject --scope <initiative> --unseen" }] }],
      "PostToolUse":      [{ "hooks": [{ "type": "command",
        "command": "out=$(yoke inject --scope <initiative> --unseen) && [ -n \"$out\" ] && jq -n --arg c \"$out\" '{hookSpecificOutput:{hookEventName:\"PostToolUse\",additionalContext:$c}}'; exit 0" }] }]
    }
  }
  ```

  `PostToolUse`만 JSON 봉투를 두르는 이유: Claude Code는 `SessionStart`·`UserPromptSubmit`의 평문 stdout은 컨텍스트로
  넣지만 `PostToolUse`의 평문은 넣지 않고 `hookSpecificOutput.additionalContext`만 넣는다(hooks 문서). `YOKE_ACTOR`를
  개발자 id로 두면 감사 행이 누가 받았는지를 기록한다. 다른 MCP 클라이언트는 각자의 훅에 같은 명령을 건다 — yoke 쪽은
  CLI 하나고, 봉투는 클라이언트 것이다.

  **팀 서버(`yoke serve`)에 붙는 경우** 배달 기록은 서버에 있으므로 `yoke inject … --unseen` 자리에 서버를 묻는다 — 같은
  줄, 같은 봉투, 실측 1–5ms(조용할 때 ~1ms). 자격증명은 아래 GitHub 교환이 알아서 받는다 —
  `yoke token create` 는 GitHub 계정이 없는 기계 액터(CI·야간 커넥터)용으로만 남는다:

  ```
  curl -s -H "Authorization: Bearer $YOKE_TOKEN" "$YOKE_SERVER/api/inject?scope=<initiative>&unseen=1"
  ```

  **토큰은 아무도 배포하지 않는다** — 플러그인이 개발자의 `gh` 로그인을 1회 교환해 스스로 받는다
  (SPEC "GitHub exchange"): 서버에 `YOKE_GITHUB_ORG`를 설정하고, 레포
  `.claude/settings.json`에 `YOKE_SERVER`를 두면 끝. 첫 배달에 `yoke: authenticated as <login> via
  GitHub` 한 줄이 공지되고, 서버가 토큰을 회수해도 다음 훅이 알아서 재교환한다. 수동 경로:
  `curl -X POST $YOKE_SERVER/api/login/github -H "Authorization: Bearer $(gh auth token)"`.

  서버는 **그 토큰이 받은 것만** 기준으로 답한다 — PO가 결정을 읽었다고 FE의 훅이 조용해지지 않는다. **ceiling**: 장부는
  읽는 주체 단위(로컬은 DB, 서버는 토큰)라, 같은 주체로 같은 이니셔티브에 세션 두 개가 동시에 열려 있으면 변경을 먼저 읽은
  세션이 소비하고 다른 세션은 못 본다. 세션 단위가 필요해지면 감사 행에 훅 stdin의 `session_id`를 싣는 것이 답이다.

## 4. 세 개의 의식 (capture density를 만드는 것)

1. **결정 즉시 기록** — 에이전트가 결정 순간 `yoke_record_decision`을 유도하도록 팀 프롬프트/스킬에 규약을 박는다.
   "결정했으면 근거·기각 대안과 함께 남긴다"가 습관이 되어야 밀도가 붙는다. 기록은 즉시 scope 전체에 반영된다 —
   전파를 기다리는 큐가 없다.
2. **주간 김매기** — 재확인 큐를 소비 순으로 비운다(`yoke review`, 가장 많이 주입된 것 먼저). 아직 맞으면
   `yoke verify`로 재확인, 아니면 `yoke deprecate --reason`으로 퇴출 — 사유는 그 레코드를 받았던 모든 세션에
   방송되므로, 퇴출이 곧 전파다. 스쿼드의 오너 1명이 주 1회 훑는다.
3. **틀린 것 즉시 회수** — 잘못 들어온 레코드를 발견한 사람이 그 자리에서 `deprecate --reason`한다. 큐를 기다리지
   않는다 — 회수 방송이 도는 동안이 유일한 피해 창이다.

## 5. 채택 순서 (bottom-up)

위에서 강제로 깔지 않는다. 지식은 격리, 온톨로지(어휘)는 공유한다.

1. **개별 개발자** — 로컬 `yoke mcp`(단일 사용자·무인증). 자기 결정을 남기고 자기 에이전트가 즉시 주입받는다.
   여기서 가치를 체감해야 다음이 붙는다.
2. **스쿼드** — 스쿼드별 네임스페이스(`--ns <squad>`) + 김매기 오너. `yoke serve --auth`로 팀 접근을 연다. 이때부터
   거버넌스(재확인 큐, RBAC의 read/write/admin 분리)가 실제로 작동한다.
3. **조직** — 스쿼드들이 온톨로지(공통 어휘)를 공유하되 각자의 지식은 네임스페이스로 격리. 크로스-스쿼드 지식 공유는
   설계상 없다 — 팀은 어휘를 공유하지 레코드를 공유하지 않는다.

## 6. 성공 지표

| 지표 | 무엇을 본다 | 측정 |
|---|---|---|
| 캡처율 | 역할별 주간 신규 `decision` 수 | `yoke audit` / `yoke overview` |
| 주입 적중 | AI가 맞는 지식을 받는가 | `npm run eval:retrieval -- <db> <gold>` (recall@10 / accuracy@1) |
| 페르소나 커버리지 | 사람별 source knowledge 수 | `yoke persona <person>` (source knowledge n) |
| 만료 큐 건강도 | 재확인이 밀리지 않는가 | `yoke review` 길이 |
| 오염률 | stale·퇴출이 새어 주입되지 않는가 (항상 0%) | `npm run eval` |

## 7. 스케일 검증 (도입 전 리허설)

조직에 깔기 전, 루프가 수만 건 규모에서 배관되는지 먼저 확인한다. 「크래프톤 웨이」를 묘사한 합성 테스트 코퍼스로
리허설한다 — 4역할·다인물·페르소나 검증이 가능한 하나의 스토리라인이며, 공개된 사실을 묘사한 합성 데이터다.

```
node scripts/gen-kraftonway-corpus.mjs kraftonway.db 30000     # 커밋 경로로 로드 (작성자 서명 유지)
npm run eval:retrieval -- kraftonway.db eval/gold-set-kraftonway.json   # 역할별 검색 품질
npm run eval && npm run eval:persona                           # 주입·페르소나 안전성 (자족)
node dist/front/cli/index.js persona person:kim-changhan --db kraftonway.db   # 페르소나 실물
node dist/front/cli/index.js inject "" --scope collab:pubg --db kraftonway.db  # cross-role 브리핑(PUBG 이니셔티브)
```

코퍼스는 부서 collab 4개 위에 **cross-role 이니셔티브**(`collab:pubg`·`tera-launch`·`portfolio-pivot`·`ipo-2021`)를 얹어,
PUBG 하나에 PO·PD·개발·사업 지식이 함께 붙는다(§3). 임베더가 있으면(`YOKE_EMBED_URL`/`YOKE_EMBED_MODEL`) 하이브리드 검색·중복/모순 탐지까지 켜진다. 없으면 키워드 전용으로
로드되며, 이는 벡터 절반이 빠진 완전한 코퍼스다. 생성기 상세는 `scripts/gen-kraftonway-corpus.mjs` 헤더 참조.
