# Agent notes

## Always typecheck, lint and format clean

Non-negotiable. `main` is clean at every commit; there is no "fix lint later"
commit in this repo.

```sh
npm run check      # typecheck + lint + test, the full gate
npm run lint:fix   # biome check --write: fixes lint AND formatting
```

- `npm run lint` is `biome check --error-on-warnings`. Warnings fail. If
  `noExplicitAny` or `noNonNullAssertion` fires, fix the code. Do not silence
  the rule to get green.
- A `pre-commit` hook in `.githooks/` runs typecheck and lint on any staged
  `src/`, `test/` or `scripts/` file. `npm install` wires it up via `prepare`.
- Tests are deliberately not in the hook. They belong to your task's own
  validation step, and a slow hook is a hook people bypass.
- `git commit --no-verify` exists for WIP on a branch. Do not use it to land
  work on `main`.

## npm registry proxy

The dev shell can set `HTTPS_PROXY` and `https_proxy` to an unavailable local proxy. If `npm install` stalls or reports a proxy `503`, confirm the problem with:

```sh
curl -I --connect-timeout 5 https://registry.npmjs.org/commander
```

If the proxy fails but direct access works, retry npm without those variables:

```sh
env -u HTTPS_PROXY -u https_proxy npm install
```

Do not change the user's global npm or proxy configuration.
