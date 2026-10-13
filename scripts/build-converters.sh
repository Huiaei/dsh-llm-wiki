#!/usr/bin/env bash
# 构建所有 Go 转换器到 converters/bin/。
#
# 为什么单独一个脚本：转换器是独立进程，产物不进版本库（.gitignore 已排除
# converters/bin/），所以需要一条可重复的构建路径。Go 模块代理在本机走不通，
# 默认用 goproxy.cn；模块已进缓存后离线也能构建。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO/converters/bin"
export GOFLAGS="${GOFLAGS:--mod=mod}"
export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"

if ! command -v go >/dev/null 2>&1; then
  echo "build-converters: 未找到 go，跳过（转换器不可用，但不影响管线）" >&2
  exit 0
fi

mkdir -p "$OUT"
built=0
for dir in "$REPO"/converters/*/; do
  [ -f "$dir/go.mod" ] || continue
  name="convert-$(basename "$dir")"
  echo "构建 $name ..."
  ( cd "$dir" && go build -o "$OUT/$name" . )
  built=$((built + 1))
done

if [ "$built" -eq 0 ]; then
  echo "build-converters: 没有找到 Go 转换器" >&2
  exit 0
fi
echo "完成：$built 个转换器 -> $OUT"
