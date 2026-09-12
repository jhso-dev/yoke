// The suite runs on the developer's own machine, and that machine may be USING yoke: a repo bound to
// a team server exports YOKE_SERVER and YOKE_SCOPE into everything the client spawns, and a person
// who points YOKE_DB at their store exports that. Inherited, those steer the code under test —
// measured, twice in one afternoon: the hook suite read the live team server instead of its fixture
// store, and a CLI case asserting the DEFAULT database path got the bound one. Both failed for a
// reason that had nothing to do with the change in front of them.
//
// So the suite starts from no ambient yoke configuration at all. A case that needs a variable sets it
// (and the ones that spawn children pass their own env), which is the only way a test's environment
// should ever be decided.
//
// `YOKE_TEST_*` survives: those name the live backends CI provides (OpenSearch, Postgres), and
// stripping them would silently skip the suites that exist to exercise them.
for (const key of Object.keys(process.env))
  if (key.startsWith("YOKE_") && !key.startsWith("YOKE_TEST_"))
    delete process.env[key];
