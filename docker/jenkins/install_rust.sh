#!/usr/bin/env bash

set -e

# 如果已有 cargo，直接退出
command -v cargo >/dev/null 2>&1 && {
  echo "✔ Rust 已存在：$(cargo --version)"
  exit 0
}

echo ">>> 安装 Rust ..."
curl -sSL https://sh.rustup.rs | sh -s -- -y

# 让当前 shell 立即生效
source "$HOME/.cargo/env"

echo ">>> 安装 wasm-pack ..."
cargo install wasm-pack

echo ">>> 校验安装结果 ..."
cargo --version
wasm-pack --version

echo ">>> 完成！"