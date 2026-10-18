#!/bin/sh
set -eu

cd -- "$(dirname -- "$0")"

export CPROJECT_PORT="${CPROJECT_PORT:-18787}"
export TZ="${TZ:-Asia/Taipei}"

if ! npm ls --all --include=dev > /dev/null 2>&1; then
    printf '%s\n' '依賴套件缺少或版本不符，正在依 package-lock.json 安裝…'
    npm ci --include=dev
fi

npm run build

# Replace the shell so stop signals reach the backend directly.
exec node --import tsx server/index.ts
