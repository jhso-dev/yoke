// Test-only: run the CLI the way it actually runs — against a server holding the named store.
//
// `--db` still names the corpus; it is what a `yoke serve` would have been started on, and this
// stands one up for the call. Per call rather than per file so no two cases share server state, and
// so the actor and namespace a case passes are the ones the request carries.

import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { makeFetchEmbedder } from "../../core/embedding.js";
import { createServeServer } from "../serve/index.js";
import { runCli } from "./index.js";

type Env = Record<string, string | undefined>;

/** The commands that act on a machine: they open the file themselves and need no server. */
const LOCAL = new Set(["init", "serve", "ui", "mcp", "token"]);

export async function cli(argv: string[], env: Env = {}): Promise<number> {
  const i = argv.indexOf("--db");
  const db = i >= 0 ? argv[i + 1] : env.YOKE_DB;
  const j = argv.indexOf("--shards");
  const shards = j >= 0 ? argv[j + 1] : env.YOKE_SHARDS;
  if ((!db && !shards) || LOCAL.has(argv[0]) || env.YOKE_SERVER)
    return runCli(argv, env);
  // `--shards` names a store too, and it is the server's to open — so the server opens it and the
  // call keeps its flags, exactly as it would against a `yoke serve --shards`.
  const store = shards
    ? await (
        await import("../../adapters/storage-sharded/index.js")
      ).makeShardedStorage(shards)
    : new SqliteStorage(db as string);
  await store.init();
  // `serve`, not `ui`: it is what a person runs, and it is the tier that reads the caller's actor
  // and namespace off the request when nothing authenticates them.
  const server = createServeServer({
    store,
    defaultActor: "yoke:system",
    auth: false,
    embedder: makeFetchEmbedder(env),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    return await runCli(argv, {
      ...env,
      YOKE_SERVER: `http://127.0.0.1:${port}`,
    });
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
}
