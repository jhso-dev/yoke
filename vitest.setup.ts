// The suite starts from no ambient yoke configuration. A repo bound to a team server exports
// YOKE_SERVER and YOKE_SCOPE into everything the client spawns, and a person who points YOKE_DB at
// their own store exports that — inherited, they steer the code under test. A case that needs a
// variable sets it, which is the only way a test's environment should be decided.
//
// YOKE_TEST_* survives: those name the live backends CI provides, and stripping them would silently
// skip the suites that exist to exercise them.
for (const key of Object.keys(process.env))
  if (key.startsWith("YOKE_") && !key.startsWith("YOKE_TEST_"))
    delete process.env[key];
