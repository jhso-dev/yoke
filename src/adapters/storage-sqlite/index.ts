// storage-sqlite — StoragePort의 better-sqlite3 구현 (SPEC.md / PLAN 1.5).
// append-only: (id, version) 행만 추가. FTS5는 최신 버전만 유지(delete+insert).
// sqlite-vec(vec0)로 임베딩/similar 지원 (PLAN 4.2) — 최신 버전만 유지(FTS와 동일 정책).

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { serializeText } from "../../core/embedding.js";
import type { TypeDef } from "../../core/ontology.js";
import type { Entity, Relation } from "../../core/types.js";
import type { StoragePort, TextQuery } from "../../ports/storage.js";

// 스키마는 .sql 파일 대신 TS 상수 (번들링 단순화). created_at은 Entity 계약 밖의
// 내부 컬럼이라 DB default로 채운다 — put 인자로 받지 않는다.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  attributes TEXT NOT NULL,          -- JSON
  provenance TEXT NOT NULL,          -- JSON
  last_confirmed TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (id, version)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS relations (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  attributes TEXT NOT NULL,          -- JSON
  provenance TEXT NOT NULL,          -- JSON
  last_confirmed TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  PRIMARY KEY (id, version)
) WITHOUT ROWID;

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(id UNINDEXED, text);

-- 게이트 비경유. append-only: name별 버전 누적, load 시 최신만.
CREATE TABLE IF NOT EXISTS ontology_types (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  def TEXT NOT NULL,                 -- JSON (TypeDef 전문)
  PRIMARY KEY (name, version)
);
`;

interface EntityRow {
  id: string;
  version: number;
  type: string;
  status: string;
  attributes: string;
  provenance: string;
  last_confirmed: string;
}

interface RelationRow extends EntityRow {
  from_id: string;
  to_id: string;
}

function rowToEntity(r: EntityRow): Entity {
  return {
    id: r.id,
    version: r.version,
    type: r.type,
    status: r.status as Entity["status"],
    attributes: JSON.parse(r.attributes),
    provenance: JSON.parse(r.provenance),
    last_confirmed: r.last_confirmed,
  };
}

function rowToRelation(r: RelationRow): Relation {
  return { ...rowToEntity(r), from: r.from_id, to: r.to_id };
}

export class SqliteStorage implements StoragePort {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
  }

  async init(): Promise<void> {
    this.db.pragma("journal_mode = WAL");
    sqliteVec.load(this.db);
    this.db.exec(SCHEMA);
  }

  // vec0 테이블은 첫 임베딩 삽입 시 lazy 생성한다. 차원(N)은 첫 벡터 길이로 고정 —
  // provider별 차원이 다르고 삽입 전엔 알 수 없으므로 env 고정보다 견고하다.
  // ponytail: 차원은 최초 임베딩에 고정. provider를 바꿔 차원이 달라지면 벡터 테이블 재생성 필요.
  private ensureVecTable(dim: number): void {
    const exists = this.db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='entity_vec'`,
      )
      .get();
    if (!exists) {
      this.db.exec(
        `CREATE VIRTUAL TABLE entity_vec USING vec0(id TEXT PRIMARY KEY, embedding float[${dim}])`,
      );
    }
  }

  close(): void {
    this.db.close();
  }

  async putEntity(e: Entity): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO entities (id, version, type, status, attributes, provenance, last_confirmed)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.version,
        e.type,
        e.status,
        JSON.stringify(e.attributes),
        JSON.stringify(e.provenance),
        e.last_confirmed,
      );
    // FTS는 최신 버전만: id 행 제거 후 최신 버전 텍스트 재삽입.
    const latest = this.db
      .prepare(
        `SELECT type, attributes FROM entities WHERE id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(e.id) as { type: string; attributes: string };
    this.db.prepare(`DELETE FROM entities_fts WHERE id = ?`).run(e.id);
    this.db
      .prepare(`INSERT INTO entities_fts (id, text) VALUES (?, ?)`)
      .run(e.id, serializeText(latest.type, latest.attributes));

    // 벡터도 최신 버전만 유지 (FTS와 동일 delete+insert). embedding 있을 때만 손댄다 —
    // 임베딩 없는 버전으로 재put하면 기존 벡터는 그대로 둔다 (entities에 벡터 컬럼이 없어
    // 최신 벡터를 재구성할 수 없다).
    if (e.embedding) {
      this.ensureVecTable(e.embedding.length);
      this.db.prepare(`DELETE FROM entity_vec WHERE id = ?`).run(e.id);
      this.db
        .prepare(`INSERT INTO entity_vec (id, embedding) VALUES (?, ?)`)
        .run(
          e.id,
          Buffer.from(
            e.embedding.buffer,
            e.embedding.byteOffset,
            e.embedding.byteLength,
          ),
        );
    }
  }

  async getEntity(id: string, version?: number): Promise<Entity | null> {
    const row =
      version === undefined
        ? this.db
            .prepare(
              `SELECT * FROM entities WHERE id = ? ORDER BY version DESC LIMIT 1`,
            )
            .get(id)
        : this.db
            .prepare(`SELECT * FROM entities WHERE id = ? AND version = ?`)
            .get(id, version);
    return row ? rowToEntity(row as EntityRow) : null;
  }

  async putRelation(r: Relation): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO relations (id, version, type, status, attributes, provenance, last_confirmed, from_id, to_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.version,
        r.type,
        r.status,
        JSON.stringify(r.attributes),
        JSON.stringify(r.provenance),
        r.last_confirmed,
        r.from,
        r.to,
      );
  }

  async neighbors(
    id: string,
    relType?: string,
    dir?: "in" | "out",
  ): Promise<Relation[]> {
    const dirClause =
      dir === "out"
        ? "from_id = @id"
        : dir === "in"
          ? "to_id = @id"
          : "(from_id = @id OR to_id = @id)";
    const typeClause = relType === undefined ? "" : " AND type = @relType";
    // 최신 버전 relation만 반환 (append-only 재커밋 대비).
    const rows = this.db
      .prepare(
        `SELECT r.* FROM relations r
         WHERE r.version = (SELECT MAX(version) FROM relations WHERE id = r.id)
           AND ${dirClause}${typeClause}`,
      )
      .all({ id, relType }) as RelationRow[];
    return rows.map(rowToRelation);
  }

  async search(q: TextQuery): Promise<Entity[]> {
    // 사용자 텍스트를 FTS5 phrase로 감싸 특수문자(-, :, * 등) 구문 오류 방지.
    // 접두 매칭(*): 한국어 조사가 붙은 토큰("parseArgs로")도 어간("parseArgs")으로 검색되게.
    const match = `"${q.text.replace(/"/g, '""')}"*`;
    const typeClause = q.type === undefined ? "" : " AND e.type = @type";
    const statusClause =
      q.status === undefined ? "" : " AND e.status = @status";
    const limitClause = q.limit === undefined ? "" : " LIMIT @limit";
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entities_fts f
         JOIN entities e ON e.id = f.id
           AND e.version = (SELECT MAX(version) FROM entities WHERE id = e.id)
         WHERE f.text MATCH @match${typeClause}${statusClause}${limitClause}`,
      )
      .all({
        match,
        type: q.type,
        status: q.status,
        limit: q.limit,
      }) as EntityRow[];
    return rows.map(rowToEntity);
  }

  /** KNN 유사 entity. vec0 테이블 미생성(임베딩 삽입 이력 없음)이면 빈 배열.
   * 반환 entity에는 .embedding을 복원해 담는다 — 게이트가 코사인 유사도를 계산해 임계 판정한다. */
  async similar(embedding: Float32Array, k: number): Promise<Entity[]> {
    const exists = this.db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='entity_vec'`,
      )
      .get();
    if (!exists) return [];
    const query = Buffer.from(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength,
    );
    const hits = this.db
      .prepare(
        `SELECT id, embedding FROM entity_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
      )
      .all(query, k) as { id: string; embedding: Buffer }[];
    const out: Entity[] = [];
    for (const h of hits) {
      const e = await this.getEntity(h.id);
      if (!e) continue;
      const buf = h.embedding;
      out.push({
        ...e,
        embedding: new Float32Array(
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        ),
      });
    }
    return out;
  }

  // --- StoragePort 밖의 어댑터 확장: 온톨로지 시드 저장/로드 (CLI init용) ---

  /** append-only로 온톨로지 정의 저장. name별 다음 버전으로 누적. */
  saveOntology(defs: TypeDef[]): void {
    const nextVersion = this.db.prepare(
      `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM ontology_types WHERE name = ?`,
    );
    const insert = this.db.prepare(
      `INSERT INTO ontology_types (name, version, def) VALUES (?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: TypeDef[]) => {
      for (const def of rows) {
        const { v } = nextVersion.get(def.name) as { v: number };
        insert.run(def.name, v, JSON.stringify(def));
      }
    });
    tx(defs);
  }

  /** status로 최신 버전 entity 필터 (StoragePort 밖 — CLI review/verify --all-drafts용).
   * search는 text 필수라 부적합하고, StoragePort에 list(filter)를 추가하면 계약 변경이라
   * saveOntology와 같은 어댑터 확장 메서드로 둔다. */
  listByStatus(status: string): Entity[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entities e
         WHERE e.version = (SELECT MAX(version) FROM entities WHERE id = e.id)
           AND e.status = ?
         ORDER BY e.created_at`,
      )
      .all(status) as EntityRow[];
    return rows.map(rowToEntity);
  }

  /** provenance.actor로 entity 필터 (StoragePort 밖 — persona 6.1용).
   * search는 text 기반이라 provenance를 못 걸러 부적합하고, listByStatus와 동일 패턴.
   * actor 매칭은 이력 전체(모든 버전) 대상 — verify가 최신 버전 provenance를 승격자로
   * 갱신해도 원저자의 기여가 소실되지 않는다 (append-only 이력이 원저자를 보존).
   * 반환은 매칭된 id의 최신 버전 행. */
  listByActor(actor: string): Entity[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entities e
         WHERE e.version = (SELECT MAX(version) FROM entities WHERE id = e.id)
           AND e.id IN (
             SELECT id FROM entities
             WHERE json_extract(provenance, '$.actor') = ?
           )
         ORDER BY e.created_at`,
      )
      .all(actor) as EntityRow[];
    return rows.map(rowToEntity);
  }

  /** type별 최신 버전 relation 목록 (StoragePort 밖 — CLI conflicts용).
   * neighbors는 특정 id 기준이라 전역 목록에 부적합해 어댑터 확장 메서드로 둔다. */
  listRelationsByType(type: string): Relation[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM relations r
         WHERE r.version = (SELECT MAX(version) FROM relations WHERE id = r.id)
           AND r.type = ?
         ORDER BY r.created_at`,
      )
      .all(type) as RelationRow[];
    return rows.map(rowToRelation);
  }

  /** name별 최신 버전만, 최초 등록 순서로 로드. */
  loadOntology(): TypeDef[] {
    const rows = this.db
      .prepare(
        `SELECT def FROM ontology_types t
         WHERE t.version = (SELECT MAX(version) FROM ontology_types WHERE name = t.name)
         ORDER BY (SELECT MIN(rowid) FROM ontology_types WHERE name = t.name)`,
      )
      .all() as { def: string }[];
    return rows.map((r) => JSON.parse(r.def) as TypeDef);
  }
}
