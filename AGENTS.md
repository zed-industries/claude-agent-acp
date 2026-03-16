# Repository Guidelines

## Project Structure & Module Organization
This package is a TypeScript ACP adapter for the Claude Agent SDK. Keep production code in `src/`, with the CLI entrypoint in `src/index.ts` and core adapter logic split across files such as `src/acp-agent.ts`, `src/tools.ts`, `src/settings.ts`, and `src/utils.ts`. Place tests in `src/tests/` and follow the existing `*.test.ts` pattern. Store release process notes in `docs/`, and treat `.github/workflows/` as the source of truth for CI expectations.

## Build, Test, and Development Commands
Install dependencies with `npm ci`.

- `npm run build` compiles TypeScript into `dist/`.
- `npm run start` runs the built CLI from `dist/index.js`.
- `npm run dev` rebuilds, then starts the adapter locally.
- `npm run lint` checks `src/**/*.ts` with ESLint.
- `npm run format:check` verifies Prettier formatting.
- `npm run check` runs lint plus formatting checks.
- `npm run test:run` executes the Vitest suite once.
- `npm run test:integration` runs integration tests when `RUN_INTEGRATION_TESTS=true`.

## Coding Style & Naming Conventions
Use TypeScript with strict compiler settings from `tsconfig.json`. Follow Prettier defaults in this repo: 2-space indentation and `printWidth: 100`. Prefer ES module syntax, named exports for shared helpers, and descriptive file names in kebab-case or lower-case (`acp-agent.ts`, `tools.ts`). Use `camelCase` for variables/functions and `PascalCase` for types and classes. ESLint enforces `eqeqeq`, `curly`, `prefer-const`, and disallows unused variables unless prefixed with `_`.

## Testing Guidelines
Vitest runs in a Node environment and discovers files matching `src/**/*.{test,spec}.*`. Keep unit tests near the existing suite under `src/tests/`, name them after the module under test, and cover both happy paths and protocol edge cases. Run `npm run test:coverage` before larger refactors; CI currently requires formatting, lint, build, and `npm run test:run` to pass.

## Commit & Pull Request Guidelines
Recent history uses short imperative subjects, sometimes with Conventional Commit prefixes such as `feat:` (`feat: pass through tools array...`). Follow that style, keep the first line concise, and reference issue or PR numbers when relevant. Pull requests should include a clear behavior summary, note any API or protocol impact, and attach logs or screenshots only when UI/client behavior changes. Ensure CI is green before requesting review.
