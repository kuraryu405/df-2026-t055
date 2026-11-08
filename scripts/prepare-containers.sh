#!/bin/sh
set -eu
umask 022
cd "$(dirname "$0")/.."
# Build on the host/Cloud Build, because the target VM cannot execute Docker RUN.
npm ci
npm run build
rm -rf .containers/runtime
mkdir -p .containers/runtime/apps .containers/runtime/packages
cp package.json package-lock.json .containers/runtime/
for app in api generator web; do
    mkdir -p ".containers/runtime/apps/$app"
    cp "apps/$app/package.json" ".containers/runtime/apps/$app/"
done
cp -R apps/api/src .containers/runtime/apps/api/
cp -R apps/generator/src apps/generator/fixtures .containers/runtime/apps/generator/
cp -R apps/web/dist .containers/runtime/apps/web/
mkdir -p .containers/runtime/packages/shared
cp packages/shared/package.json .containers/runtime/packages/shared/
cp -R packages/shared/src .containers/runtime/packages/shared/
npm ci --omit=dev --ignore-scripts --prefix .containers/runtime
chmod -R a+rX .containers/runtime
# The local-only adapter needs a writable scratch directory during smoke checks.
mkdir -p .containers/runtime/.local
chmod 1777 .containers/runtime/.local
test -f .containers/runtime/apps/web/dist/index.html
test -f .containers/runtime/node_modules/zod/package.json
test -f .containers/runtime/apps/generator/fixtures/towel-a.json
