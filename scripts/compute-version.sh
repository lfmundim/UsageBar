#!/usr/bin/env bash
set -euo pipefail

MAJOR=$(node -e 'const v=require("./version.json"); console.log(v.major)')
MINOR=$(node -e 'const v=require("./version.json"); console.log(v.minor)')

LAST_BUMP=$(git log -1 --format=%H -- version.json 2>/dev/null || true)

if [ -z "${LAST_BUMP}" ]; then
  PATCH=$(git rev-list --count HEAD)
else
  PATCH=$(git rev-list --count "${LAST_BUMP}..HEAD")
fi

VERSION="${MAJOR}.${MINOR}.${PATCH}"

node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '${VERSION}';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n', 'utf8');
"

echo "Version set to ${VERSION}"
