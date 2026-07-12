# yoke — Market (2026-07 조사)

## 한마디 포지셔닝

**"AI에 주입되는 지식의 Git."**
경쟁자는 기억(memory, 자동)을 팔고, yoke는 지식(knowledge, 거버닝)을 판다.
메모리 레이어는 AI가 뭘 기억할지를 자동화하고, yoke는 AI가 뭘 믿을지를 관리한다.

## 경쟁 지형 (5개 카테고리)

| 카테고리 | 플레이어 | 우리와의 관계 |
|---|---|---|
| AI 메모리 레이어 | **Cognee**(임베디드 그래프+벡터, 최근접 경쟁), **Zep/Graphiti**(바이템포럴, 모순 무효화), Mem0, Letta, LangMem | 정면 겹침. 단 전원 "자동" 지향, 거버넌스 없음 |
| MCP 메모리 서버 | Basic Memory, Knowledge Graph Memory(공식 레퍼런스), RAG Memory | 개인용 수준. 우리의 초기 유통 채널이기도 |
| 온톨로지/KG DB | TypeDB, Stardog(RDB 가상 그래프 페더레이션), Graphwise/Ontotext, Fluree | 거버넌스 있으나 무겁고 고가, SPARQL 세계 |
| GraphRAG 프레임워크 | MS GraphRAG, LlamaIndex, txtai, RAGFlow, R2R | 파이프라인이지 시스템 오브 레코드 아님 |
| 엔터프라이즈 검색 SaaS | Glean, Onyx(오픈소스), GoSearch, Guru, Dust | 문서 검색이지 구조화 지식 관리 아님 |

## 정직한 평가

Cognee + Graphiti를 합치면 우리 기술 설계의 ~70%가 이미 존재한다.
기술로는 차별화 불가. **신뢰 모델로 차별화한다.**

## 전략

1. **카테고리 분리**: "자동 메모리" vs "거버닝된 지식". lifecycle·사람이 관장하는
   승격·verified만 주입·감사 가능 이력. 경쟁자들은 "자동"이 세일즈 포인트라
   이 방향으로 못 온다(자기 피치 부정). 구조적 해자.
2. **빈 사분면**: 엔터프라이즈 거버넌스 × 로컬/임베디드 경량. `npx yoke`로 시작해
   조직의 지식 시스템 오브 레코드로 성장.
3. **전통 DB read-mapping이 엔터프라이즈 쐐기**: "기존 RDB를 이관 없이 온톨로지로
   읽어 AI에 주입" — 이 세그먼트에서 경량 MCP 네이티브로 하는 곳 없음.
4. **채택 경로**: 개발자 개인(MCP 서버) → 팀(거버넌스 발동) → 조직. 톱다운 영업 아님.
5. **persona가 킬러 유스케이스**: person 스코프 판단 연속성은 조사 범위 내 경쟁자 전무.
6. **측정으로 증명**: recall 벤치마크(Zep DMR 94.8%) 대신 주입 품질
   (오염 지식 주입률, 모순 미탐지율) eval을 자체 정의.

**하지 말 것**: 대화 자동 추출(Mem0), RAG 파이프라인(LlamaIndex), 문서 검색(Glean) 정면승부.

## 리스크

- 거버넌스 마찰이 비싸면 "번거로운 Mem0"로 보인다 → 승격을 극단적으로 싸게(일괄 verify).
- "AI가 틀린 사내 지식을 답했다"는 시장 고통이 늦게 오면 차별화 체감이 늦다
  → v1은 개인에게 즉시 유용한 MCP 서버로 진입.

## 출처

- https://atlan.com/know/best-ai-agent-memory-frameworks-2026/
- https://www.cognee.ai/blog/guides/best-ai-memory-layers-for-ai-agents-in-2026-comparison
- https://arxiv.org/abs/2501.13956 (Zep 논문)
- https://github.com/getzep/graphiti
- https://mcp.directory/blog/claude-code-memory-mcp-servers-2026
- https://flur.ee/blog/enterprise-kg-buyers-guide-2026
- https://www.firecrawl.dev/blog/best-open-source-rag-frameworks
- https://onyx.app/insights/glean-alternatives
