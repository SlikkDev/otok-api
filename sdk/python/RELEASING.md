# Releasing otok (Python)

Publishing is automated: pushing a `sdk-python-v*` tag runs
[`.github/workflows/release-sdk-python.yml`](../../.github/workflows/release-sdk-python.yml),
which lints, type-checks, tests, builds the sdist + wheel (`python -m build`),
and uploads them to PyPI from `sdk/python/`.

## One-time PyPI-side setup

Auth is **PyPI trusted publishing (OIDC)** — no token stored in the repo, ever.
Unlike npm, PyPI supports configuring a *pending* publisher for a project that
does not exist yet, so even the first release needs no token.

1. On [pypi.org](https://pypi.org), log in and go to **Your account** →
   **Publishing** (<https://pypi.org/manage/account/publishing/>).
2. Under **Add a new pending publisher** (GitHub tab), enter:
   - PyPI project name: `otok`
   - Owner: `SlikkDev`
   - Repository name: `otok-api`
   - Workflow name: `release-sdk-python.yml`
   - Environment name: leave empty
3. Save. The first successful workflow run creates the `otok` project and the
   pending publisher becomes its permanent trusted publisher. The workflow's
   `id-token: write` permission (scoped to the publish job) handles the rest.

## Release procedure

1. Bump `__version__` in `sdk/python/src/otok/_version.py` — the single
   source of truth: `pyproject.toml` reads it at build time (hatch
   `dynamic = ["version"]`) and the `User-Agent` header uses it. Commit to
   `main`.
2. Tag and push — the tag version must match `_version.py` (the workflow
   enforces this):

   ```bash
   git tag sdk-python-v0.1.0
   git push origin sdk-python-v0.1.0
   ```

3. Watch the **Release otok (Python)** run under the repo's Actions tab; the
   package appears at <https://pypi.org/project/otok/>.

## Manual fallback (workflow_dispatch)

If you cannot push tags directly, run the **Release otok (Python)** workflow
manually from the Actions tab (**Run workflow** on `main`). It publishes the
version currently in `src/otok/_version.py` (after checking that the matching
`sdk-python-v<version>` tag does not already exist) and then pushes that tag
from the runner.
