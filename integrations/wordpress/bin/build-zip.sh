#!/usr/bin/env bash
#
# Build the distributable plugin zip: otok-for-woocommerce-<version>.zip
#
# Deterministic: the plugin tree is staged into a temp dir, every file's
# mtime is normalized to a fixed timestamp, entries are added in sorted
# order, and zip's extra platform attributes are stripped (-X) — so the
# same tree content produces a byte-identical zip on any machine.
#
# The zip contains the full shippable plugin (includes/, assets/,
# lib/action-scheduler/, languages/, readme.txt, uninstall.php, LICENSE)
# under the top-level folder `otok-for-woocommerce` (the folder name IS the
# plugin slug — never rename it). Output lands in integrations/wordpress/dist/
# and is gitignored; release zips are never committed.

set -euo pipefail

SLUG="otok-for-woocommerce"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${ROOT}/${SLUG}"
DIST="${ROOT}/dist"

# All zip entry mtimes are pinned to this fixed instant (UTC) for
# reproducibility. Bump it only if a reason ever appears; the value itself
# is arbitrary.
STAMP="2026-01-01 00:00:00 UTC"

[ -f "${SRC}/${SLUG}.php" ] || { echo "error: ${SRC}/${SLUG}.php not found" >&2; exit 1; }

VERSION="$(sed -n 's/^ \* Version:[[:space:]]*\([0-9][0-9a-zA-Z.-]*\).*/\1/p' "${SRC}/${SLUG}.php" | head -1)"
[ -n "${VERSION}" ] || { echo "error: could not parse Version from ${SLUG}.php" >&2; exit 1; }

OUT="${DIST}/${SLUG}-${VERSION}.zip"

STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT

# Stage a clean copy of the shippable tree. Everything under the plugin
# directory ships (Action Scheduler and languages included) — only editor/OS
# droppings are excluded, so an unexpected exclusion can never truncate the
# bundle.
cp -a "${SRC}" "${STAGE}/${SLUG}"
find "${STAGE}/${SLUG}" \( -name '.DS_Store' -o -name 'Thumbs.db' -o -name '.gitkeep' \) -delete

# Normalize permissions and mtimes for reproducibility.
find "${STAGE}/${SLUG}" -type d -exec chmod 755 {} +
find "${STAGE}/${SLUG}" -type f -exec chmod 644 {} +
find "${STAGE}/${SLUG}" -exec touch -d "${STAMP}" {} +

mkdir -p "${DIST}"
rm -f "${OUT}"

# Sorted entry order + -X (no platform extra fields) = deterministic bytes.
(
	cd "${STAGE}"
	find "${SLUG}" -type f | LC_ALL=C sort | TZ=UTC zip -q -X "${OUT}" -@
)

FILES="$(unzip -l "${OUT}" | tail -1 | awk '{print $2}')"
echo "built ${OUT} (version ${VERSION}, ${FILES} files)"
echo "sha256: $(sha256sum "${OUT}" | cut -d' ' -f1)"
