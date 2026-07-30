/**
 * Side-effect imports of stylesheets.
 *
 * Next declares these itself in the generated `next-env.d.ts`, but that file only exists after a build
 * has run. Declaring them here means `pnpm typecheck` succeeds on a clean checkout, before any build.
 */
declare module '*.css';
