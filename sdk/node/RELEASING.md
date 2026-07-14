# Releasing @otok/node

Publishing is automated: pushing a `sdk-node-v*` tag runs
[`.github/workflows/release-sdk-node.yml`](../../.github/workflows/release-sdk-node.yml),
which typechecks, builds, tests, and runs `npm publish --access public --provenance`
from `sdk/node/`.

## One-time npm-side setup

Preferred auth is **npm trusted publishing (OIDC)** — no long-lived token in the repo.

> npm cannot configure a trusted publisher for a package that does not exist on
> the registry yet, so the **first** publish of `@otok/node` must use a token
> (see fallback below). After v0.1.0 exists, switch to trusted publishing and
> remove the token.

1. On npmjs.com, go to the package page → **Settings** → **Trusted Publisher**
   (`https://www.npmjs.com/package/@otok/node/access`).
2. Select **GitHub Actions** and enter:
   - Organization or user: `SlikkDev`
   - Repository: `otok-api`
   - Workflow filename: `release-sdk-node.yml`
   - Environment name: leave empty
3. Save. The workflow's `id-token: write` permission handles the rest — when a
   trusted publisher is configured, OIDC auth takes precedence and the
   `NPM_TOKEN` secret can be deleted.

## Token fallback (required for the first publish)

1. On npmjs.com: **Access Tokens** → **Generate New Token** → **Granular Access
   Token**, with read/write permission scoped to the `@otok` org (or the
   `@otok/node` package once it exists), automation-friendly (bypass 2FA).
2. Add it as the `NPM_TOKEN` repository secret in
   `SlikkDev/otok-api` → Settings → Secrets and variables → Actions.
3. The workflow passes it as `NODE_AUTH_TOKEN`; when the secret is unset the
   env line is empty and OIDC is used instead.

## Release procedure

1. Bump `version` in `sdk/node/package.json` (and the `SDK_VERSION` constant in
   `sdk/node/src/http.ts`), commit to `main`.
2. Tag and push — the tag version must match `package.json` (the workflow
   enforces this):

   ```bash
   git tag sdk-node-v0.1.0
   git push origin sdk-node-v0.1.0
   ```

3. Watch the **Release @otok/node** run under the repo's Actions tab; the
   package appears at <https://www.npmjs.com/package/@otok/node>.
