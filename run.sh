#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8788}"

# 优先用环境变量，其次仓库里 scripts/make-dev-certs.sh 生成的那对
if [ -z "${SSL_CERTFILE:-}" ] && [ -f certs/dev.crt ] && [ -f certs/dev.key ]; then
  export SSL_CERTFILE="certs/dev.crt"
  export SSL_KEYFILE="certs/dev.key"
fi

if [ ! -d node_modules/ws ]; then
  npm install
fi

if [ -n "${SSL_CERTFILE:-}" ] && [ -n "${SSL_KEYFILE:-}" ] && [ -f "$SSL_CERTFILE" ] && [ -f "$SSL_KEYFILE" ]; then
  echo "[doudizhu] HTTPS on https://${HOST}:${PORT}/doudizhu/"
else
  unset SSL_CERTFILE SSL_KEYFILE || true
  echo "[doudizhu] HTTP on http://${HOST}:${PORT}/doudizhu/"
  echo "[doudizhu] 手机要「添加到主屏幕」需要 HTTPS：先跑 scripts/make-dev-certs.sh"
fi

exec node src/server.js
