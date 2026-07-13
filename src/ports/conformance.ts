// StoragePort conformance suite — the vitest wrapper adapter tests invoke.
// The cases themselves are runner-neutral data in conformance-cases.ts (shared
// with the standalone kuzu runner, which cannot run inside a vitest fork).

import { afterEach, beforeEach, describe, it } from "vitest";
import { conformanceCases } from "./conformance-cases.js";
import type { StoragePort } from "./storage.js";

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

    for (const c of conformanceCases) {
      it(c.name, () => c.run(port));
    }
  });
}
