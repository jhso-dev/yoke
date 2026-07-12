# yoke — Architecture

포트/어댑터(hexagonal). 코어는 순수 TypeScript, I/O 없음.

```
        AI 도구들 (Claude, Codex, Cursor, …)
                    │ MCP 프로토콜
   ┌────────────────┼────────────────┐
   │  front adapters│                │
   │  ┌───────────┐ │ ┌───────────┐  │
   │  │ MCP server│ │ │ thin CLI  │  │
   │  └─────┬─────┘ │ └─────┬─────┘  │
   │        └───────┴───────┘        │
   │                ▼                │
   │      ┌──────────────────┐       │
   │      │       core       │       │
   │      │ ontology · query │       │
   │      │ context injection│       │
   │      └────────┬─────────┘       │
   │               ▼ storage port    │
   │  ┌────────┐ ┌────────┐ ┌─────┐  │
   │  │ sqlite │ │ vector │ │ ... │  │  ← v1은 sqlite만
   │  └────────┘ └────────┘ └─────┘  │
   └─────────────────────────────────┘
```

## 핵심 결정

1. **프론트 어댑터는 MCP 하나로 수렴.** Claude/Codex/Cursor 전부 MCP 클라이언트이므로
   도구별 어댑터를 만들지 않는다. CLI는 사람용 + 스크립트용 thin wrapper.
2. **storage port는 core가 정의.** 백엔드 어댑터가 이를 구현한다. 인터페이스는
   entity/relation CRUD + 검색 프리미티브만. 백엔드 고유 기능(벡터 유사도 등)은
   optional capability로 선언하고, core는 없으면 폴백한다.
3. **온톨로지는 데이터.** entity 타입/relation 타입 스키마는 yoke 안에 저장되는
   레코드이지, TypeScript 타입이 아니다. 조직마다 온톨로지가 다르기 때문.
4. **conformance 테스트가 계약이다.** storage port 구현체는 전부 동일한 테스트
   스위트를 통과해야 한다. 새 백엔드 추가 = 어댑터 구현 + 이 스위트 통과.
5. **전통 DB 호환은 read-mapping부터.** 기존 RDB 테이블을 온톨로지에 매핑해
   읽기 전용 entity로 노출하는 것이 첫 단계. 양방향 동기화는 그 다음.

## 디렉토리 (코드 생기면)

```
src/
  core/          # 지식 모델, 온톨로지, 질의, context injection. import 방향: 없음(순수)
  ports/         # storage port 인터페이스 + conformance 테스트 스위트
  adapters/
    storage-sqlite/
  front/
    mcp/         # MCP 서버
    cli/
```

경계 검증은 lint로 강제한다(core → adapters/front import 금지). 코드 생길 때 룰 추가.
