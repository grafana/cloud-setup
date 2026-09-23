#!/usr/bin/env sh
# Packs the package the way `npm publish` would, installs the tarball into a
# throwaway project, and runs the installed binary.
#
# Nothing else checks this. The test suite imports from dist directly, so it
# cannot see a missing shebang, a wrong `bin` path, a file that `files` excludes,
# or an import that resolves inside the repo but is missing from `dependencies` —
# each of which installs fine and fails the moment a user runs the CLI.
set -eu

WORKDIR="$(mktemp -d)"
# shellcheck disable=SC2064 # WORKDIR is fixed here, so expand it now.
trap "rm -rf '$WORKDIR'" EXIT

# prepack rebuilds from a cleaned dist, so the tarball cannot carry a stale
# output whose source no longer exists.
TARBALL_NAME="$(npm pack --pack-destination "$WORKDIR" --silent | tail -1)"
if [ -z "$TARBALL_NAME" ] || [ ! -f "$WORKDIR/$TARBALL_NAME" ]; then
  echo "Error: npm pack produced no tarball." >&2
  exit 1
fi
TARBALL="$WORKDIR/$TARBALL_NAME"
echo "packed $TARBALL_NAME"

BIN_PATH="$(node -p "require('./package.json').bin['cloud-setup']")"
if ! tar tzf "$TARBALL" | grep -qx "package/$BIN_PATH"; then
  echo "Error: bin '$BIN_PATH' is not in the tarball. Check the 'files' field." >&2
  exit 1
fi

# A bin without a shebang is installed as a symlink that the shell cannot run.
if [ "$(tar xzfO "$TARBALL" "package/$BIN_PATH" | head -c 2)" != "#!" ]; then
  echo "Error: bin '$BIN_PATH' has no shebang." >&2
  exit 1
fi

cd "$WORKDIR"
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund "$TARBALL" >/dev/null 2>&1

OUTPUT="$(./node_modules/.bin/cloud-setup --help)"
case "$OUTPUT" in
  *"@grafana/cloud-setup"*) ;;
  *)
    echo "Error: the installed binary ran but did not print the expected help text." >&2
    printf '%s\n' "$OUTPUT" >&2
    exit 1
    ;;
esac

echo "installed binary runs on node $(node -v)"
