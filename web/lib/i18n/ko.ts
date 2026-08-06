// 한국어. `typeof en`으로 타입이 고정되어 있어 키를 빠뜨리면 컴파일이 실패한다 —
// 번역 누락이 화면에 빈칸으로 나가는 대신 빌드에서 잡힌다.
//
// 번역하지 않는 것은 '저장된 값'이다: 상태 이름(draft, verified, stale, deprecated), 감사 로그의
// 동작 이름, 타입·관계 이름(authored_by), CLI 명령과 스코프 이름. 이것들은 DB와 CLI에 그대로
// 들어 있는 문자열이라 화면에서 다른 말로 바꾸면 같은 것을 가리키는 이름이 두 벌이 된다.
//
// 사람에게 시키는 말은 번역한다. 처음에는 '제품 용어는 번역하지 않는다'로 잡았는데, 그 규칙이
// verify·deprecate 버튼을 한국어 화면에 영어로 남겼다 — 버튼은 저장된 값이 아니라 지시문이다.
// 그래서 동작으로 쓰인 verify는 '검증', deprecate는 '폐기'이고, 상태로 쓰인 verified·deprecated는
// 그대로 둔다. 이 구분은 감사 로그가 이미 쓰고 있던 것과 같다: 이름은 사실이고, 뜻풀이는 번역한다.

import type { en } from "./en";

export const ko: typeof en = {
  common: {
    loading: "불러오는 중…",
    none: "없음",
    close: "닫기",
    create: "생성",
    creating: "생성 중…",
    saving: "저장 중…",
    verify: "검증",
    reconfirm: "재확인",
    verifyHint: "레코드를 승격하거나 오래된 레코드를 재확인합니다",
    deprecate: "폐기",
    link: "연결",
    linking: "연결 중…",
    expand: "펼치기",
    browse: "둘러보기",
    graph: "그래프",
    openRecord: "레코드 열기",
    openInGraph: "그래프에서 보기",
    openAsRecord: "레코드로 열기",
    notInNamespace: "이 네임스페이스에 없음",
    notFound: "이 네임스페이스에서 찾을 수 없음",
    required: "온톨로지에서 필수로 지정한 속성",
    draftNotice: "draft로 저장되며 검증이 필요합니다",
    copyFull: "클릭하면 전체 복사",
    copy: "복사",
    copied: "복사됨",
    type: "타입",
    status: "상태",
    actor: "기록자",
    record: "레코드",
    source: "출처",
    relation: "관계",
    relations: "관계",
    direction: "방향",
    attributes: "속성",
    title: "제목",
    version: "v",
    when: "시각",
    action: "동작",
    detail: "내용",
    otherEnd: "상대편",
    prev: "이전",
    next: "다음",
    page: (page: number, pages: number, total: number) =>
      `${pages}페이지 중 ${page}페이지 · 총 ${total}개`,
  },
  nav: {
    review: "리뷰",
    conflicts: "모순",
    ontology: "온톨로지",
    persona: "페르소나",
    collaboration: "협업",
    browse: "둘러보기",
    inject: "주입",
    graph: "그래프",
    audit: "감사 로그",
    tokens: "토큰",
    screens: "화면",
    openMenu: "내비게이션 열기",
    closeMenu: "내비게이션 닫기",
  },
  theme: {
    label: "테마",
    system: "시스템",
    light: "라이트",
    dark: "다크",
  },
  home: {
    eyebrow: "팀이 공유하는 협업 지식",
    heading: "팀원 모두가 같은 Context에서 일하게 합니다",
    lede: "YOKE는 프로젝트마다 사람, 결정, 사실, 자료, 용어를 한곳에 모아 팀이 같은 정보를 공유하도록 돕습니다.",
    cards: {
      collaboration: {
        title: "협업",
        body: "프로젝트마다 팀과 에이전트가 함께 사용하는 Context를 만듭니다. 참여자와 연결된 지식, 현재 상황을 정리한 브리핑을 한곳에서 확인할 수 있습니다.",
      },
      govern: {
        title: "검증",
        body: "레코드를 리뷰하고 검증합니다. 오래된 레코드는 재확인하고, 더 이상 쓰지 않는 레코드는 폐기합니다.",
      },
      inject: {
        title: "주입",
        body: "질문을 입력하면 에이전트가 실제로 받을 지식과 출처를 확인할 수 있습니다.",
      },
      graph: {
        title: "탐색",
        body: "사람, 사실, 결정, 리소스, 용어, 협업을 그래프로 따라갑니다.",
      },
      share: {
        title: "공유",
        body: "필요한 권한 범위를 지정해 토큰을 만든 뒤, 로그인 URL을 팀원이나 테스트 사용자에게 공유합니다.",
      },
    },
  },
  chrome: {
    connecting: "연결 중…",
    readOnly: "읽기 전용",
    readOnlyHint: "읽기 전용 복제본입니다. 변경 내용은 원본에 저장합니다",
    namespaceHint: "테넌트 네임스페이스",
    signOut: "로그아웃",
    signIn: "로그인",
    ungated: "인증 없음",
    authedAs: (actor: string) => `${actor}(으)로 인증됨`,
    signOutHint:
      "이 브라우저에 저장된 자격증명만 삭제합니다. 토큰은 `yoke token revoke`로 폐기하세요",
    ungatedHint: "로컬 단일 사용자 모드에서는 자격증명이 필요하지 않습니다",
    summary: "요약",
  },
  create: {
    newRecord: "새 레코드",
    draftNotice:
      "에이전트가 커밋한 레코드와 마찬가지로 draft로 저장되며, 검증이 필요합니다.",
    pickType: "타입 고르기",
    noAttrs: "이 타입에는 선언된 속성이 없어 속성 없이 생성됩니다.",
    duplicates: (n: number, names: string) =>
      `생성했지만 비슷한 레코드가 이미 ${n}개 있습니다: ${names}`,
    // "중복이 없다"가 아니라 "비교를 안 했다" — 이 구분이 요점입니다.
    notChecked:
      "생성했습니다. 다만 무엇과도 비교하지 않았습니다: 이 작업 공간에 임베딩 제공자가 설정되지 않아 중복 탐지가 실행되지 않았습니다.",
  },
  review: {
    heading: "리뷰 대기열",
    lede: "아직 검증하지 않은 draft를 확인합니다. 사람이 승격하기 전까지 에이전트에는 주입되지 않습니다.",
    selectAll: "전체 선택",
    empty: "대기 중인 draft가 없습니다",
    draftCount: (n: number) => `draft ${n}개`,
    // draft/verified/stale은 저장되는 상태 이름이라 영어를 유지하고, 탭 이름은 사람에게 하는
    // 설명이므로 번역합니다 — 같은 Verify 버튼이 두 대기열에서 다른 뜻이라 어느 쪽인지가 분명해야 합니다.
    tabDrafts: "검증 안 됨",
    tabStale: "기한 지남",
    staleLede:
      "verified였다가 타입에 정해둔 신선도 기간을 넘긴 레코드입니다. 기간이 지난 순간부터 주입에서 빠졌지만 아무에게도 알리지 않았습니다 — 이 화면이 그걸 위해 있습니다. Verify는 여전히 맞다고 재확인하는 것이고, Deprecate는 폐기합니다.",
    staleEmpty: "기한이 지난 verified 레코드가 없습니다",
    staleScanned: (n: number, scanned: number) =>
      `살펴본 verified 레코드 ${scanned}개 중 ${n}개가 기한을 넘겼습니다`,
    staleMore: "아직 살펴보지 않은 레코드가 남아 있습니다",
    // Was singular and said "this record" while listing thirty people about a hundred records.
    staleOwners:
      "이 사람들에게 재확인을 요청하세요 — 숫자는 각자가 기록한 오래된 레코드 수입니다:",
    staleOwnerCount: (n: number) => `${n}`,
  },
  browse: {
    heading: "둘러보기",
    lede: "이 네임스페이스의 모든 레코드를 오래된 순서대로 표시합니다. 연결되지 않았거나 오래된 레코드, 아직 검토하지 않은 draft를 확인할 수 있습니다.",
    allTypes: "모든 타입",
    anyStatus: "모든 상태",
    shown: (n: number, more: boolean) =>
      `${n}개 표시${more ? " (더 있음)" : ""}`,
    noMatch: "이 필터와 일치하는 레코드가 없습니다",
    search: "레코드 본문 검색",
    searchHint:
      "yoke 자신이 폴백으로 쓰는 그 전문 검색입니다 — 답이 아니라 상태가 붙은 레코드를 돌려줍니다",
    clear: "지우기",
    noSearchMatch: "그 텍스트와 일치하는 레코드가 없습니다",
    searchTruncated: (limit: number) =>
      `일치하는 것 중 앞의 ${limit}개만 표시합니다. 검색은 전체가 아니라 상한이 있는 집합을 돌려줍니다 — 검색어를 좁히거나, 에이전트가 받을 것은 yoke inject로 확인하세요.`,
  },
  entity: {
    noId: "레코드 ID가 없습니다. 다음 화면에서 레코드를 선택하세요:",
    noTextAttributes: "(텍스트 속성 없음)",
    provenance: "출처 정보",
    recordedBy: "기록자",
    origin: "경로",
    occurredAt: "발생 시각",
    lastConfirmed: "최종 확인",
    citation: "인용",
    versionHistory: "버전 이력",
    storedStatus: "저장된 상태",
    standsAlone: "연결된 레코드가 없습니다",
    otherRecordId: "상대 레코드 id",
    swapDirection: "이 레코드가 어느 쪽인지 바꾸기",
    pointsAt: "상대 레코드를 가리킴",
    isPointedAt: "상대가 이 레코드를 가리킴",
    copyId: "클릭하면 복사",
  },
  collaboration: {
    heading: "협업",
    headingOne: "협업",
    lede: "하나의 협업에 참여하는 사람과 연결된 지식을 확인합니다. scope를 지정하면 에이전트가 이 협업의 맥락을 우선해 답합니다.",
    newOne: "새 협업",
    all: "전체 협업 목록",
    emptyList:
      "등록된 협업이 없습니다. 직접 만들거나 에이전트가 yoke_use_scope로 만들도록 요청하세요",
    people: "이 협업에 참여하는 사람",
    peopleNote:
      "참여자 명단은 협업에 관한 지식이 아니므로 브리핑에는 포함하지 않습니다",
    noMembers:
      "아직 참여자가 없습니다. 위에서 사람을 선택하거나 다음 명령을 실행하세요:",
    person: "사람",
    addSomeone: "사람 추가…",
    addToWork: "이 일에 추가",
    everyoneAdded: "기록된 사람이 모두 이미 참여 중입니다",
    readJudgment: "이 사람의 기록된 판단 보기",
    briefing: "에이전트가 받는 브리핑",
    briefingNote:
      "inject(scope)가 반환하는 verified 레코드를 최근 확인 순서대로 표시합니다. 이 미리보기는 감사 로그에 기록됩니다",
    briefingEmpty: "이 협업에 연결된 지식이 없습니다",
    attached: "연결된 레코드",
    attachedNote:
      "레코드가 이 협업을 가리킵니다. 협업을 폐기해도 연결된 레코드는 유지됩니다",
    attachedEmpty:
      "연결된 레코드가 없습니다. --scope로 기록하면 여기에 표시됩니다",
    truncated: (shown: number, total: number, rest: number) =>
      `이 협업의 레코드 ${total}개 중 ${shown}개를 최근 확인 순서대로 표시합니다. 표시하지 않은 레코드도 삭제되지 않습니다. 에이전트가 구체적으로 질문하면 이 협업의 레코드를 우선해 전체 지식을 검색합니다. (${rest}개 미표시)`,
  },
  conflicts: {
    heading: "모순",
    lede: "서로 모순되는 verified 레코드를 확인합니다. yoke는 두 레코드를 모두 보존하며 어느 쪽이 맞는지 결정하지 않습니다. 한쪽을 폐기하거나, 불일치 자체가 중요한 정보라면 둘 다 유지하세요.",
    empty: "기록된 모순이 없습니다",
    alreadyRetired: "이미 폐기됨",
  },
  ontology: {
    heading: "온톨로지",
    lede: "이 네임스페이스에서 사용하는 엔티티 타입과 관계 타입을 확인합니다. *는 필수 속성을 뜻합니다. TTL은 해당 타입의 verified 레코드를 최신으로 유지하는 기간이며, 이 기간이 지나면 주입에서 제외됩니다. 스키마 레코드는 지식이 아니므로 인용이 없습니다.",
    entityTypes: "엔티티 타입",
    relationTypes: "관계 타입",
    freshness: "신선도 (ttl)",
    neverStale: "오래되지 않음",
    days: (n: number) => `${n}일`,
    declare: "타입 선언",
    declareNote:
      "기존 이름으로 저장하면 새 버전이 추가됩니다. yoke ontology add-type과 같은 append-only 방식으로 변경합니다.",
    name: "이름",
    kind: "종류",
    entity: "엔티티",
    relation: "관계",
    attrsHint: "— 쉼표로 구분, * = 필수",
    ttlHint: "— 일 단위, 비우면 오래되지 않음",
    saveType: "타입 저장",
    maintenance: "유지보수",
    maintenanceNote: "네임스페이스 전체에 적용하는 복구 작업입니다",
    backfill: "authorship 백필",
    backfillHint:
      "시스템이 authored_by 엣지를 자동으로 만들기 전에 커밋한 레코드에서 해당 엣지를 다시 생성합니다",
    backfillDone: (scanned: number, created: number) =>
      `레코드 ${scanned}개 확인, authorship 엣지 ${created}개 추가`,
    renameFrom: "이름 바꿀 타입",
    attrsExample: "title*, owner",
    renamePlaceholder: "타입 이름 바꾸기…",
    newName: "새 이름",
    rename: "이름 바꾸기",
    renameHint: "타입 선언과 저장된 모든 행의 이름을 이력까지 변경합니다",
    renameDone: (from: string, to: string, rows: number) =>
      `${from}에서 ${to}로 변경 — ${rows}개 행 재작성`,
  },
  persona: {
    heading: "페르소나",
    lede: "한 사람이 남긴 verified 지식을 확인합니다. 에이전트가 그 사람의 판단을 물으면 해당 레코드와 출처를 전달합니다. 그 사람의 말투를 흉내 낸 글은 만들지 않습니다.",
    headingOne: "페르소나",
    all: "전체 페르소나",
    emptyList:
      "아직 지식을 기록한 사람이 없습니다. 누군가 레코드를 커밋하면 해당 페르소나를 확인할 수 있습니다",
    search: "이 사람의 레코드 검색",
    noMatch: "이 사람이 남긴 레코드 중 검색어와 일치하는 항목이 없습니다",
    matched: (shown: number, total: number) => `${total}개 중 ${shown}개 일치`,
    exportHint: (id: string) => `yoke persona ${id} --out ./skills`,
    decisions: "판단의 근거가 되는 결정",
    noDecisions: "이 사람이 기록한 결정이 없습니다",
    otherKnowledge: "그 밖의 지식",
  },
  inject: {
    heading: "주입 미리보기",
    ledeBefore: "이 질문에 대해 에이전트가 실제로 받을 내용을 확인합니다. ",
    ledeAfter:
      " 호출과 같은 필터와 순서로 인용을 표시합니다. stale·deprecated 레코드는 항상 제외합니다.",
    queryPlaceholder: "에이전트가 무슨 일을 하고 있나요?",
    scopePlaceholder: "scope (협업 또는 사람 id, 선택)",
    run: "미리보기",
    includeDraft: "draft 포함",
    prompt:
      "질문을 입력하세요. scope만 입력하면 해당 맥락의 브리핑을 확인할 수 있습니다",
    draftsIncluded:
      "검토 대기 중인 항목을 확인할 수 있도록 draft도 표시합니다. 에이전트에는 이 draft를 전달하지 않습니다.",
    wouldBeInjected: "주입될 내용",
    scopeNote: (id: string) => `scope: ${id} (범위를 제한하지 않고 우선합니다)`,
    truncated: (shown: number, total: number) =>
      `${total}개 중 ${shown}개를 표시합니다. 에이전트도 같은 내용을 받고, 나머지 정보를 찾으려면 더 구체적으로 질문하라는 안내를 함께 받습니다. 더 많이 미리 보려면 limit을 늘리세요.`,
    empty:
      "이 질문과 일치하는 verified 지식이 없어 에이전트에 전달할 내용이 없습니다",
    asOf: "기준 시점",
    asOfHint:
      "그 시점이었다면 어떻게 답했을지 보여줍니다. 각 레코드를 그때 유효했던 버전으로 되돌리고, 신선도도 그 날짜로 판단합니다",
    asOfClear: "현재",
    asOfActive: (when: string) =>
      `과거 시점 보기입니다. ${when} 기준으로 주입됐을 내용이며, 지금 주입되는 내용이 아닙니다.`,
    asOfCeiling:
      "후보는 여전히 현재 검색 인덱스에서 가져오므로, 그 뒤에 본문이 바뀐 레코드는 빠질 수 있습니다. 과거에 바뀐 것은 대부분 상태이고 그건 반영합니다.",
  },
  graph: {
    heading: "그래프",
    ledeAnchored:
      "선택한 레코드에서 두 단계까지 연결된 항목을 표시합니다. 노드를 클릭하면 해당 노드를 중심으로 이웃을 펼칩니다.",
    lede: "이 네임스페이스의 모든 레코드와 관계를 표시합니다. 노드를 클릭하면 해당 노드를 중심으로 이웃을 펼칩니다.",
    wholeNamespace: "전체 네임스페이스",
    counts: (nodes: number, links: number) =>
      `노드 ${nodes}개 · 관계 ${links}개`,
    legend:
      "화살표는 엣지의 목적지를 가리킵니다 · 점선은 지식이 아닌 관계입니다 (authorship, membership)",
    empty: "이 네임스페이스에 표시할 레코드가 없습니다",
    nodes: "노드",
    nodesNote:
      "그래프와 같은 데이터를 키보드와 스크린 리더로 탐색할 수 있습니다",
    expanded: (nodes: number, links: number) =>
      `레코드 +${nodes}개, 관계 +${links}개`,
    expandedNothing:
      "이미 그려져 있습니다 — 이 레코드에서 한 단계 안에 새로운 것이 없습니다",
  },
  audit: {
    heading: "감사 로그",
    lede: "조회한 지식과 수행한 거버넌스 작업을 append-only 방식으로 기록합니다. 화면의 필터는 현재 불러온 기록에만 적용됩니다. 전체 이력을 확인하려면 ",
    ledeAfter: " 명령을 사용하세요.",
    since: "시작 시각",
    sinceHint: "현지 시각 기준",
    allActions: "모든 동작",
    allActors: "모든 기록자",
    shown: (shown: number, loaded: number) =>
      `불러온 ${loaded}개 중 ${shown}개`,
    empty: "이 구간에 감사 이벤트가 없습니다",
    nothing: "없음",
    more: (n: number) => `외 ${n}개`,
    meaning: {
      inject: "에이전트가 지식을 받았습니다",
      inject_preview: "사람이 에이전트가 받을 내용을 미리 봤습니다",
      persona: "한 사람의 기록된 판단이 읽혔습니다",
      verify: "레코드가 승격되었습니다",
      deprecate: "레코드가 폐기되었습니다",
      rename_type: "온톨로지 타입이 저장된 모든 행에서 변경되었습니다",
      read: "레코드 하나를 전부 열어 봤습니다 — 속성·버전·관계",
      search: "누군가 텍스트로 질의해 일치하는 레코드를 받았습니다",
    } as Record<string, string>,
  },
  tokens: {
    heading: "토큰",
    lede: "브라우저 공유와 원격 접근에 사용할 API 토큰을 관리합니다. secret은 토큰을 만들 때 한 번만 표시됩니다. 접근을 차단하려면 토큰 이름으로 폐기하세요.",
    create: "토큰 생성",
    name: "이름",
    namePlaceholder: "친구-readonly",
    scopes: "스코프",
    scopesHint: "쉼표로 구분",
    created: "토큰 생성됨",
    createdNote: "지금 저장하세요. yoke에는 해시만 저장됩니다.",
    secret: "비밀 토큰",
    shareUrl: "공유 URL",
    empty: "토큰 없음",
    revoke: "폐기",
  },
  login: {
    heading: "로그인",
    lede: "발급받은 API 토큰이나 OIDC id_token을 입력하세요. yoke는 비밀번호를 저장하지 않습니다.",
    token: "토큰",
    credential: "자격증명",
    checking: "확인 중…",
    submit: "로그인",
    rejected: "자격증명이 거부되었습니다",
    noTokenBefore:
      "토큰이 없다면 yoke를 실행 중인 서버에서 다음 명령을 실행하세요:",
    noTokenAfter:
      "이 스코프는 draft 승격을 허용합니다. verify는 별도로 부여해야 하는 거버넌스 권한입니다.",
    addPrefix: "draft를 승격해야 한다면:",
  },
  errors: {
    forbiddenHint:
      "이 자격증명에는 해당 작업에 필요한 스코프가 없습니다. 다음 명령으로 발급하세요: yoke token create --scopes read,verify",
  },
};
