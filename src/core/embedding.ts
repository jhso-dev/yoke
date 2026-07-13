// 임베딩 provider 클라이언트 (SPEC Embedder 계약, PLAN 4.1).
// core는 Embedder 함수형을 주입받는다 — 여기 fetch 구현체를 두되 테스트는 결정적 스텁을 쓴다.
// 임베딩 장애는 commit을 막지 않는다 (null 반환 → FTS 폴백, 경고만).

/** 텍스트 → 임베딩 벡터. null = 사용 불가(미설정·실패) → 호출측 FTS 폴백. */
export type Embedder = (text: string) => Promise<Float32Array | null>;

// FTS/임베딩 대상 텍스트 직렬화 — 어댑터(FTS)와 core(commit)가 같은 규칙을 써야
// 임베딩과 키워드 인덱스가 동일한 표현을 본다. 그래서 core에 두고 어댑터가 import한다
// (어댑터→core 방향만 허용 — core가 어댑터를 import하면 의존 방향 불변식 위반).
export function serializeText(type: string, attributesJson: string): string {
  return `${type} ${attributesJson}`;
}

type Env = Record<string, string | undefined>;

/**
 * OpenAI 호환 /embeddings 엔드포인트 fetch Embedder.
 * YOKE_EMBED_URL / YOKE_EMBED_MODEL 미설정 시 항상 null인 no-op을 반환한다.
 * YOKE_EMBED_KEY는 있으면 Bearer 인증에 쓰고, 없으면 생략 (키 불필요한 로컬 endpoint 허용).
 * SDK 금지 — fetch 직접 호출.
 */
export function makeFetchEmbedder(env: Env): Embedder {
  const url = env.YOKE_EMBED_URL;
  const model = env.YOKE_EMBED_MODEL;
  const key = env.YOKE_EMBED_KEY;
  if (!url || !model) return async () => null;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (key) headers.authorization = `Bearer ${key}`;

  return async (text: string): Promise<Float32Array | null> => {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, input: text }),
      });
      if (!res.ok) {
        console.error(
          `yoke: embedding request failed (${res.status}) — FTS 폴백`,
        );
        return null;
      }
      const json = (await res.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const vec = json.data?.[0]?.embedding;
      if (!Array.isArray(vec)) {
        console.error("yoke: embedding response malformed — FTS 폴백");
        return null;
      }
      return Float32Array.from(vec);
    } catch (e) {
      console.error(
        `yoke: embedding error (${(e as Error).message}) — FTS 폴백`,
      );
      return null;
    }
  };
}
