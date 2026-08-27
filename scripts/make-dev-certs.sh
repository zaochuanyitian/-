#!/usr/bin/env bash
# 生一份本机自签证书，给局域网 / 手机「添加到主屏幕」用。
# iPhone 还要把 certs/dev.crt 拷过去：设置 → 通用 → VPN与设备管理 → 安装描述文件，
# 再在 设置 → 通用 → 关于本机 → 证书信任设置 里打开完全信任。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout certs/dev.key \
  -out certs/dev.crt \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,DNS:*.local,IP:127.0.0.1"
echo "写好了 certs/dev.crt 和 certs/dev.key"
echo "启动：SSL_CERTFILE=certs/dev.crt SSL_KEYFILE=certs/dev.key npm start"
