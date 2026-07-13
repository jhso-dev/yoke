// StoragePort conformance 스위트 — 어댑터 테스트가 호출하는 test factory.
// vitest를 사용하며, 어떤 백엔드든 동일 계약을 지키는지 검증한다.
// 테스트용 fixture 빌더는 여기(테스트 코드) 안에만 둔다.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Entity, Relation } from "../core/types.js";
import type { StoragePort } from "./storage.js";

let seq = 0;
function nextId(): string {
  seq += 1;
  return `e${seq.toString().padStart(4, "0")}`;
}

function makeEntity(over: Partial<Entity> = {}): Entity {
  return {
    id: over.id ?? nextId(),
    type: over.type ?? "note",
    attributes: over.attributes ?? { title: "hello world" },
    status: over.status ?? "draft",
    version: over.version ?? 1,
    last_confirmed: over.last_confirmed ?? "2026-01-01T00:00:00Z",
    provenance: over.provenance ?? {
      actor: "yoke:system",
      origin: "cli",
      occurred_at: "2026-01-01T00:00:00Z",
    },
    ...(over.embedding ? { embedding: over.embedding } : {}),
  };
}

function makeRelation(
  from: string,
  to: string,
  over: Partial<Relation> = {},
): Relation {
  return {
    id: over.id ?? nextId(),
    type: over.type ?? "relates_to",
    attributes: over.attributes ?? {},
    from,
    to,
    status: over.status ?? "draft",
    version: over.version ?? 1,
    last_confirmed: over.last_confirmed ?? "2026-01-01T00:00:00Z",
    provenance: over.provenance ?? {
      actor: "yoke:system",
      origin: "cli",
      occurred_at: "2026-01-01T00:00:00Z",
    },
  };
}

export function describeStoragePort(
  name: string,
  make: () => Promise<StoragePort>,
): void {
  describe(`StoragePort conformance: ${name}`, () => {
    let port: StoragePort;

    beforeEach(async () => {
      port = await make();
      await port.init();
    });
    afterEach(() => {
      port.close();
    });

    // (1) putEntity → getEntity 왕복
    it("round-trips putEntity → getEntity", async () => {
      const e = makeEntity();
      await port.putEntity(e);
      expect(await port.getEntity(e.id)).toEqual(e);
    });

    // (2) 같은 id 재put → 두 버전 존재, getEntity 최신, version 지정 시 과거
    it("keeps every version on re-put; getEntity returns latest, version selects past", async () => {
      const id = nextId();
      const v1 = makeEntity({ id, version: 1, attributes: { title: "v1" } });
      const v2 = makeEntity({ id, version: 2, attributes: { title: "v2" } });
      await port.putEntity(v1);
      await port.putEntity(v2);
      expect(await port.getEntity(id)).toEqual(v2);
      expect(await port.getEntity(id, 1)).toEqual(v1);
      expect(await port.getEntity(id, 2)).toEqual(v2);
    });

    // (3) 물리 삭제 API 부재 (인터페이스 차원 확인)
    it("exposes no physical-delete API", () => {
      for (const banned of [
        "delete",
        "remove",
        "deleteEntity",
        "removeEntity",
        "purge",
        "drop",
      ]) {
        expect(banned in port).toBe(false);
      }
    });

    // (4) putRelation → neighbors 방향 필터 in/out/양방향
    it("neighbors filters by direction (in/out/both)", async () => {
      const a = nextId();
      const b = nextId();
      const r = makeRelation(a, b, { type: "cites" });
      await port.putRelation(r);
      expect(await port.neighbors(a, undefined, "out")).toEqual([r]);
      expect(await port.neighbors(a, undefined, "in")).toEqual([]);
      expect(await port.neighbors(b, undefined, "in")).toEqual([r]);
      expect(await port.neighbors(b, undefined, "out")).toEqual([]);
      expect(await port.neighbors(a)).toEqual([r]);
      expect(await port.neighbors(b)).toEqual([r]);
    });

    // (5) neighbors relType 필터
    it("neighbors filters by relType", async () => {
      const a = nextId();
      const b = nextId();
      const c = nextId();
      const r1 = makeRelation(a, b, { type: "cites" });
      const r2 = makeRelation(a, c, { type: "contradicts" });
      await port.putRelation(r1);
      await port.putRelation(r2);
      expect(await port.neighbors(a, "cites")).toEqual([r1]);
      expect(await port.neighbors(a, "contradicts")).toEqual([r2]);
      expect(await port.neighbors(a)).toEqual(expect.arrayContaining([r1, r2]));
    });

    // (6) search: FTS 매칭 / 무결과 빈 배열
    it("search matches FTS text and returns [] on no match", async () => {
      const e = makeEntity({ attributes: { title: "photosynthesis basics" } });
      await port.putEntity(e);
      expect(await port.search({ text: "photosynthesis" })).toEqual([e]);
      expect(await port.search({ text: "no-such-token" })).toEqual([]);
    });

    // (6b) search: 접두 매칭 — 조사가 붙은 한국어 토큰도 어간으로 검색된다
    it("search matches token prefixes (Korean suffix tolerance)", async () => {
      const e = makeEntity({
        attributes: { title: "결정은 parseArgs로 한다" },
      });
      await port.putEntity(e);
      expect(await port.search({ text: "parseArgs" })).toEqual([e]);
    });

    // (7) getEntity 미존재 → null
    it("getEntity returns null when absent", async () => {
      expect(await port.getEntity("missing-id")).toBeNull();
    });

    // (8) similar: optional capability — 미구현 시 undefined
    it("exposes similar as optional capability (undefined or function)", () => {
      const cap = port.similar;
      expect(cap === undefined || typeof cap === "function").toBe(true);
    });
  });
}
