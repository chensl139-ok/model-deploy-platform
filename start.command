#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装 Node.js 22.12 或更新版本。'
  read -r '?按回车退出…'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  npm ci
fi
echo '请在浏览器打开 http://localhost:5173'
exec npm run dev
