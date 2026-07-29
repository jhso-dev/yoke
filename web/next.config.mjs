// Static export only. Next is a BUILD TOOL here, never a server: `output: 'export'` is the
// mechanism that keeps "no second deployable" true rather than aspirational (WEB-UI.md).
//
// Consequently unusable, by construction: route handlers, server actions, middleware, next/image,
// SSR and ISR. Nothing in web/ may reach for them.
/** @type {import('next').NextConfig} */
export default {
  output: "export",
  // Emits out/entity/index.html rather than out/entity.html, so the static handler's
  // directory → index.html rule is all the routing the server needs.
  trailingSlash: true,
  // Dynamic segments are impossible under export (ids are ULIDs from a DB that does not exist at
  // build time), so every detail view reads its id from a query param instead.
  devIndicators: false,
  // The repo has a lockfile at the root and one in web/; without this Next guesses a workspace root
  // from further up the filesystem and warns on every build.
  outputFileTracingRoot: import.meta.dirname,
};
