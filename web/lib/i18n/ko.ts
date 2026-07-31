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
    verifyHint: "승격하거나, 오래된 레코드를 재확인합니다",
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
    required: "온톨로지가 필수로 선언한 속성",
    draftNotice: "draft로 들어가며 검증이 필요합니다",
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
    prev: "← 이전",
    next: "다음 →",
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
  },
  theme: {
    label: "테마",
    system: "시스템",
    light: "라이트",
    dark: "다크",
  },
  home: {
    eyebrow: "협업 단위로 묶이는 에이전트 지식",
    heading: "협업에 필요한 지식을 하나로",
    lede: "YOKE는 함께 일하는 사람들과 에이전트가 같은 맥락에서 협업할 수 있도록, 믿을 수 있는 정보를 한곳에 모아 공유합니다.\n\n누가 어떤 일을 하고 있는지, 어떤 결정이 내려졌는지, 알아야 할 사실과 참고 자료는 무엇인지 쉽게 확인할 수 있습니다.\n\n에이전트에는 사람이 확인한 정보만 전달되며, 아직 검토되지 않은 초안은 제외됩니다.",
    cards: {
      collaboration: {
        title: "협업",
        body: "프로젝트마다 팀과 에이전트가 함께 사용하는 Context를 만듭니다. 참여자와 연결된 지식, 현재 상황을 정리한 브리핑을 한곳에서 확인할 수 있습니다.",
      },
      govern: {
        title: "검증",
        body: "레코드를 리뷰, 검증, 재확인, 폐기해 에이전트가 믿을 수 있는 범위를 관리합니다.",
      },
      inject: {
        title: "주입",
        body: "질문에 대해 에이전트가 실제로 받을 지식과 출처를 그대로 확인합니다.",
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
    readOnlyHint: "읽기 전용 복제본입니다: 쓰기는 원본으로 갑니다",
    namespaceHint: "테넌트 네임스페이스",
    signOut: "로그아웃",
    signIn: "로그인",
    ungated: "인증 없음",
    authedAs: (actor: string) => `${actor}(으)로 인증됨`,
    signOutHint:
      "이 브라우저의 자격증명만 지웁니다. 토큰 자체는 `yoke token revoke`로 폐기하세요",
    ungatedHint: "로컬 단일 사용자 모드 — 자격증명이 필요 없습니다",
    summary: "요약",
  },
  create: {
    newRecord: "새 레코드",
    draftNotice:
      "에이전트가 커밋한 것과 똑같이, draft로 들어가고 검증이 필요합니다.",
    pickType: "타입 고르기",
    noAttrs: "이 타입은 속성을 선언하지 않습니다 — 속성 없이 생성됩니다.",
    duplicates: (n: number, names: string) =>
      `생성했지만 비슷한 레코드가 이미 ${n}개 있습니다: ${names}`,
  },
  review: {
    heading: "리뷰 대기열",
    lede: "올려두었지만 아직 믿기로 하지 않은 것들입니다. 여기 있는 것은 에이전트에 닿지 않습니다 — draft는 사람이 승격하기 전까지 주입에서 보류됩니다.",
    selectAll: "전체 선택",
    empty: "draft 없음 — 대기열이 비었습니다",
    draftCount: (n: number) => `draft ${n}개`,
  },
  browse: {
    heading: "둘러보기",
    lede: "이 네임스페이스의 모든 레코드, 최신이 아래쪽입니다. 가진 것의 모양을 보는 용도입니다 — 고립된 것, 오래된 구석, 아무도 검토하지 않은 draft.",
    allTypes: "모든 타입",
    anyStatus: "모든 상태",
    shown: (n: number, more: boolean) =>
      `${n}개 표시${more ? " (더 있음)" : ""}`,
    noMatch: "이 필터에 맞는 것이 없습니다",
  },
  entity: {
    noId: "id가 없습니다 — 이 화면은 여기서 들어옵니다:",
    noTextAttributes: "(텍스트 속성 없음)",
    provenance: "출처 정보",
    recordedBy: "기록자",
    origin: "경로",
    occurredAt: "발생 시각",
    lastConfirmed: "최종 확인",
    citation: "인용",
    versionHistory: "버전 이력",
    storedStatus: "저장된 상태",
    standsAlone: "없음 — 이 레코드는 홀로 있습니다",
    otherRecordId: "상대 레코드 id",
    swapDirection: "이 레코드가 어느 쪽인지 바꾸기",
    pointsAt: "상대 레코드를 가리킴",
    isPointedAt: "상대가 이 레코드를 가리킴",
    copyId: "클릭하면 복사",
  },
  collaboration: {
    heading: "협업",
    headingOne: "협업",
    lede: "함께 일하는 한 가지, 그리고 거기 붙어 있는 사람과 지식입니다. 여기에 주입을 고정하면 에이전트가 이 일의 맥락에서 먼저 답합니다.",
    newOne: "새 협업",
    all: "전체 협업 목록",
    emptyList:
      "아직 없습니다 — 위에서 만들거나, 에이전트가 yoke_use_scope로 만들게 하세요",
    people: "이 일에 붙어 있는 사람",
    peopleNote:
      "여기에는 보이지만 브리핑에는 일부러 넣지 않습니다 — 명단은 그 일에 대한 지식이 아닙니다",
    noMembers:
      "아직 아무도 연결되지 않았습니다 — 위에서 고르거나 다음을 실행하세요:",
    person: "사람",
    addSomeone: "사람 추가…",
    addToWork: "이 일에 추가",
    everyoneAdded: "기록된 사람이 모두 이미 참여 중입니다",
    readJudgment: "이 사람의 기록된 판단 보기",
    briefing: "에이전트가 받는 브리핑",
    briefingNote:
      "inject(scope)가 반환하는 그대로입니다 — verified만, 최근 확인 순, 미리보기로 감사 기록됨",
    briefingEmpty: "이 일의 맥락에 아직 아무것도 없습니다",
    attached: "붙어 있는 레코드",
    attachedNote:
      "← 이쪽을 가리킵니다: 링크는 레코드가 들고 있고, 이 일이 레코드를 담고 있는 것이 아닙니다. 이 일을 폐기해도 저 레코드들은 그대로입니다",
    attachedEmpty: "없음 — --scope로 포착될 때 여기에 붙습니다",
    truncated: (shown: number, total: number, rest: number) =>
      `이 일의 레코드 ${total}개 중 ${shown}개, 최근 확인 순으로 표시했습니다. 나머지는 사라진 것이 아닙니다 — 에이전트가 구체적인 질문을 하면 이 일의 레코드를 먼저 놓고 전체를 검색합니다. (${rest}개 미표시)`,
  },
  conflicts: {
    heading: "모순",
    lede: "서로 모순되는 verified 레코드입니다. yoke는 양쪽을 모두 보존하고 승자를 고르지 않습니다 — 한쪽을 폐기하거나, 공존시키세요. 불일치 자체가 지식일 때는 공존이 정답입니다.",
    empty: "기록된 모순이 없습니다",
    alreadyRetired: "이미 폐기됨",
  },
  ontology: {
    heading: "온톨로지",
    lede: "이 네임스페이스가 인식하는 엔티티·관계 타입입니다. *는 필수 속성이고, TTL은 그 타입의 verified 레코드가 다시 보류되기까지 신선하게 유지되는 기간입니다. 이것들은 스키마 레코드이지 지식이 아니라서 인용이 없습니다.",
    entityTypes: "엔티티 타입",
    relationTypes: "관계 타입",
    freshness: "신선도 (ttl)",
    neverStale: "오래되지 않음",
    days: (n: number) => `${n}일`,
    declare: "타입 선언",
    declareNote:
      "이미 있는 이름으로 저장하면 새 버전이 됩니다 — yoke ontology add-type이 수행하는 append-only 마이그레이션과 같습니다.",
    name: "이름",
    kind: "종류",
    entity: "엔티티",
    relation: "관계",
    attrsHint: "— 쉼표로 구분, * = 필수",
    ttlHint: "— 일 단위, 비우면 오래되지 않음",
    saveType: "타입 저장",
    maintenance: "유지보수",
    maintenanceNote: "네임스페이스 전체 복구 — 같은 두 명령, 같은 효과",
    backfill: "authorship 백필",
    backfillHint:
      "게이트가 엣지를 만들기 전에 커밋된 레코드의 authored_by를 다시 도출합니다",
    backfillDone: (scanned: number, created: number) =>
      `레코드 ${scanned}개 확인, authorship 엣지 ${created}개 추가`,
    renameFrom: "이름 바꿀 타입",
    attrsExample: "title*, owner",
    renamePlaceholder: "타입 이름 바꾸기…",
    newName: "새 이름",
    rename: "이름 바꾸기",
    renameHint: "선언과 저장된 모든 행을 이력까지 다시 씁니다",
    renameDone: (from: string, to: string, rows: number) =>
      `${from} → ${to}로 변경 — ${rows}개 행 재작성`,
  },
  persona: {
    heading: "페르소나",
    lede: "한 사람이 남긴 verified 지식입니다 — 에이전트가 '이 사람이라면 어떻게 결정할까'를 물을 때 받는 것입니다. 그 사람의 레코드와 출처이지, 그 사람 말투로 쓴 글이 아닙니다.",
    headingOne: "페르소나",
    all: "전체 페르소나",
    emptyList:
      "아직 기록된 사람이 없습니다 — 페르소나는 그 사람이 남긴 것에 대한 질의라서, 무언가를 커밋하는 순간 시작됩니다",
    search: "이 사람의 레코드 검색",
    noMatch: "이 사람이 남긴 것 중 맞는 것이 없습니다",
    matched: (shown: number, total: number) => `${total}개 중 ${shown}개 일치`,
    exportHint: (id: string) => `yoke persona ${id} --out ./skills`,
    decisions: "판단의 근거가 되는 결정",
    noDecisions:
      "기록된 결정이 없습니다 — 페르소나의 병목은 조회가 아니라 포착입니다",
    otherKnowledge: "그 밖의 지식",
  },
  inject: {
    heading: "주입 미리보기",
    ledeBefore: "이 질문에 대해 에이전트가 받는 그대로입니다 — 실제 ",
    ledeAfter:
      " 호출과 같은 필터, 같은 순서, 같은 인용입니다. stale·deprecated 레코드는 무엇을 요청하든 나오지 않습니다.",
    queryPlaceholder: "에이전트가 무슨 일을 하고 있나요?",
    scopePlaceholder: "scope (협업 또는 사람 id, 선택)",
    run: "미리보기",
    includeDraft: "draft 포함",
    prompt: "질문을 입력하거나, scope만 입력해 그 맥락의 브리핑을 보세요",
    draftsIncluded:
      "draft가 포함되었습니다. 에이전트는 이것들을 받지 않습니다 — 검토를 기다리는 것이 무엇인지 보이도록 표시만 한 것입니다.",
    wouldBeInjected: "주입될 내용",
    scopeNote: (id: string) => `scope: ${id} (우선할 뿐 가두지 않습니다)`,
    truncated: (shown: number, total: number) =>
      `${total}개 중 ${shown}개 표시 — 에이전트도 같은 페이지를 받고, 나머지는 구체적으로 질문하라는 안내를 함께 받습니다. 더 보려면 limit을 올리세요.`,
    empty:
      "맞는 verified 지식이 없습니다 — 이 질문에 에이전트는 아무것도 받지 못합니다",
  },
  graph: {
    heading: "그래프",
    ledeAnchored:
      "한 레코드에서 두 홉까지입니다. 노드를 클릭하면 중심으로 옮기고 이웃을 펼칩니다.",
    lede: "이 네임스페이스의 모든 레코드와 관계입니다. 노드를 클릭하면 중심으로 옮기고 이웃을 끌어옵니다.",
    wholeNamespace: "전체 네임스페이스",
    counts: (nodes: number, links: number) =>
      `노드 ${nodes}개 · 관계 ${links}개`,
    legend:
      "화살표는 엣지의 목적지를 가리킵니다 · 점선 = 지식이 아님 (authorship, membership)",
    empty: "이 네임스페이스에 그릴 것이 없습니다",
    nodes: "노드",
    nodesNote:
      "같은 데이터를 키보드로 탐색할 수 있는 형태로 — 위 캔버스는 스크린 리더가 읽지 못합니다",
  },
  audit: {
    heading: "감사 로그",
    lede: "읽힌 지식과 수행된 거버넌스 행위의 append-only 추적입니다. 여기 필터는 불러온 구간만 좁힐 뿐 전체 이력을 좁히지 않습니다 — 전체를 훑으려면 ",
    ledeAfter: "를 쓰세요.",
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
    } as Record<string, string>,
  },
  tokens: {
    heading: "토큰",
    lede: "브라우저 공유와 원격 접근에 쓰는 API 토큰입니다. secret은 한 번만 보입니다. 접근을 끊으려면 이름으로 폐기하세요.",
    create: "토큰 생성",
    name: "이름",
    namePlaceholder: "친구-readonly",
    scopes: "스코프",
    scopesHint: "쉼표로 구분",
    created: "토큰 생성됨",
    createdNote: "지금 저장하세요. yoke는 해시만 저장합니다.",
    secret: "비밀 토큰",
    shareUrl: "공유 URL",
    empty: "토큰 없음",
    revoke: "폐기",
  },
  login: {
    heading: "로그인",
    lede: "API 토큰이나 OIDC id_token을 붙여넣으세요. yoke는 비밀번호를 저장하지 않습니다 — 이미 발급해둔 자격증명입니다.",
    token: "토큰",
    credential: "자격증명",
    checking: "확인 중…",
    submit: "로그인",
    rejected: "자격증명이 거부되었습니다",
    noTokenBefore: "토큰이 없나요? yoke를 실행 중인 서버에서:",
    noTokenAfter:
      "draft 승격을 허용합니다 — verify는 거버넌스 권한이라 부여되는 것이지 가정되지 않습니다.",
    addPrefix: "draft를 승격해야 한다면:",
  },
  errors: {
    forbiddenHint:
      "이 자격증명에는 해당 동작의 스코프가 없습니다. 다음으로 발급하세요: yoke token create --scopes read,verify",
  },
};
