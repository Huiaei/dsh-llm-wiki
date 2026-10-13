#!/usr/bin/env bash
# dsh-llm-wiki 安装脚本：把组件复制到 DSH 标准位置。
#
# 用法: ./install.sh [--vault PATH] [--init-vault] [--enable-services] [--dry-run]
#   --vault PATH       vault 根目录（默认 $LLM_WIKI_VAULT，再默认 /mnt/d/DB/Obsidian/LLM-Wiki）
#   --enable-services  同时启用 systemd 用户服务（默认只装单元文件，不启用）
#   --init-vault       若 vault 不存在则创建骨架（wiki/ 11 分类 + raw/inbox + raw/sources）
#   --dry-run          只打印将要做什么，不写任何文件
#
# 退出码: 0 成功 / 1 参数错误 / 3 vault 预检失败
set -euo pipefail

REPO=$(cd "$(dirname "$0")" && pwd)
VAULT=${LLM_WIKI_VAULT:-/mnt/d/DB/Obsidian/LLM-Wiki}
ENABLE_SERVICES=0
INIT_VAULT=0
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --vault) VAULT=${2:?"--vault 需要一个路径"}; shift 2 ;;
    --enable-services) ENABLE_SERVICES=1; shift ;;
    --init-vault) INIT_VAULT=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

run() {
  if [ "$DRY" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi
}

# ── F7-0: vault 预检 ──
# 原脚本对 vault 路径完全不检查，无条件写 ~/.dsh 配置并启用服务。
# 路径错时后果是静默的：插件每轮注入空内容，管线在根文件系统上造幽灵目录树。
echo "==> 0/5 vault 预检: $VAULT"
if [ ! -d "$VAULT" ]; then
  if [ "$INIT_VAULT" != 1 ]; then
    echo "    [失败] vault 目录不存在: $VAULT" >&2
    echo "    请先挂载该路径，或用 --vault / LLM_WIKI_VAULT 指定正确位置；" >&2
    echo "    若这确实是一个新库，加 --init-vault 让本脚本创建骨架。" >&2
    exit 3
  fi
  echo "    vault 不存在，--init-vault 将创建骨架"
fi

# F7-6 / O10-⑤: --init-vault 建库骨架。刻意只建目录、不写内容文件：
# index.md 由管线生成，schema.md 是用户的规则文件 —— 替用户编一份规则比缺文件更糟。
if [ "$INIT_VAULT" = 1 ]; then
  for d in "$VAULT" "$VAULT/raw/inbox" "$VAULT/raw/sources" \
           "$VAULT/wiki/决策" "$VAULT/wiki/发现" "$VAULT/wiki/概念" "$VAULT/wiki/项目" \
           "$VAULT/wiki/流程" "$VAULT/wiki/命令" "$VAULT/wiki/规则" "$VAULT/wiki/提示" \
           "$VAULT/wiki/记忆" "$VAULT/wiki/基因" "$VAULT/wiki/引用"; do
    run mkdir -p "$d"
  done
  echo "    已创建 vault 骨架（wiki/ 11 分类 + raw/inbox + raw/sources）"
fi
if [ ! -d "$VAULT/wiki" ] && [ "$INIT_VAULT" != 1 ]; then
  echo "    [警告] $VAULT 下没有 wiki/ 目录 —— 安装继续，但管线会拒绝写入（见 vaultHealth）。" >&2
fi
echo "    OK"

echo "==> 1/5 插件 -> ~/.dsh/profiles/web/"
run mkdir -p "$HOME/.dsh/profiles/web"
run cp "$REPO/plugin/dsh-llm-wiki.mjs" "$HOME/.dsh/profiles/web/"

PATCH="$HOME/.dsh/profiles/web/cordis.patch.yml"
if [ -f "$PATCH" ] && grep -q llm-wiki "$PATCH"; then
  echo "     cordis.patch.yml 已含 llm-wiki 条目，跳过"
else
  # F7-1: 追加前备份，并保证原文件以换行结尾。
  # 原脚本直接 cat >>：若末行无换行，追加的 "- insert:" 会与上一行粘成
  # "somekey: value- insert:"，整个 YAML 直接损坏。
  if [ -f "$PATCH" ]; then
    run cp "$PATCH" "$PATCH.bak.$(date +%Y%m%d%H%M%S)"
    if [ -n "$(tail -c 1 "$PATCH" 2>/dev/null || true)" ]; then
      if [ "$DRY" = 1 ]; then echo "  [dry-run] 为 $PATCH 补尾换行"
      else printf '\n' >> "$PATCH"; fi
    fi
  fi
  # F7-2: 带上 config.vault。原脚本追加的块没有这个字段，于是插件永远回退到
  # DEFAULT_VAULT —— 脚本里的 $VAULT 变量实际上从没生效过。
  BLOCK="
# dsh-llm-wiki（LLM-Wiki 生命周期插件）
- insert:
    - id: llm-wiki
      name: ./dsh-llm-wiki.mjs
      config:
        vault: \"$VAULT\"
"
  if [ "$DRY" = 1 ]; then
    echo "  [dry-run] 将向 $PATCH 追加:"
    printf '%s\n' "$BLOCK" | sed 's/^/    /'
  else
    printf '%s' "$BLOCK" >> "$PATCH"
    echo "     已挂载 cordis.patch.yml（vault: $VAULT）"
  fi
fi

echo "==> 2/5 技能 -> ~/.agents/skills/"
run mkdir -p "$HOME/.agents/skills/wiki-search" "$HOME/.agents/skills/wiki-write"
for s in wiki-search wiki-write; do
  # F7-3: SKILL.md 里的 vault 路径写成 {{VAULT}} 占位符，安装时替换成本机实际路径。
  # 原脚本直接 cp，而仓库里的 SKILL.md 硬编码 /mnt/d/... —— README 只能让用户「自行修改」。
  if [ "$DRY" = 1 ]; then
    echo "  [dry-run] 将写入 $HOME/.agents/skills/$s/SKILL.md（{{VAULT}} -> $VAULT）"
  else
    sed "s|{{VAULT}}|$VAULT|g" "$REPO/skills/$s/SKILL.md" > "$HOME/.agents/skills/$s/SKILL.md"
  fi
done

echo "==> 3/5 脚本 -> ~/bin/"
run mkdir -p "$HOME/bin/lib"
run cp "$REPO/scripts/llm-wiki-pipeline.mjs" "$HOME/bin/"
run cp "$REPO/scripts/embed-proxy.mjs" "$HOME/bin/"
run cp "$REPO/scripts/wiki-convert.mjs" "$HOME/bin/"
# F7-4: 必须一起装 scripts/lib/。O1/O2 之后管线 import "./lib/frontmatter.mjs" 与
# "./lib/hash.mjs"，只 cp 单文件会让它在运行时 ERR_MODULE_NOT_FOUND —— 而插件是
# detached + stdio:"ignore" 启动它的，这个错误没有任何人看得见。
for f in "$REPO"/scripts/lib/*.mjs; do
  [ -e "$f" ] || continue
  run cp "$f" "$HOME/bin/lib/"
done
run chmod +x "$HOME/bin/llm-wiki-pipeline.mjs" "$HOME/bin/embed-proxy.mjs" "$HOME/bin/wiki-convert.mjs"

# O10-③: 转换器是独立进程，产物不进版本库，所以这里要么复制已构建的二进制，要么现场构建。
# 构建失败不致命 —— 管线不依赖转换器，只是文档摄取不可用。
if [ "$DRY" != 1 ] && ! ls "$REPO"/converters/bin/convert-* >/dev/null 2>&1; then
  echo "     转换器未构建，尝试 scripts/build-converters.sh ..."
  bash "$REPO/scripts/build-converters.sh" >&2 || true
fi
for c in "$REPO"/converters/bin/convert-*; do
  [ -e "$c" ] || continue
  run cp "$c" "$HOME/bin/"
  run chmod +x "$HOME/bin/$(basename "$c")"
done

echo "==> 4/5 systemd 单元 -> ~/.config/systemd/user/"
run mkdir -p "$HOME/.config/systemd/user"
for u in llm-wiki-pipeline.service llm-wiki-pipeline.timer embed-proxy.service; do
  run cp "$REPO/systemd/$u" "$HOME/.config/systemd/user/"
done
if [ "$ENABLE_SERVICES" = 1 ]; then
  run systemctl --user daemon-reload
  run systemctl --user enable --now embed-proxy.service
  run systemctl --user enable --now llm-wiki-pipeline.timer
else
  # F7-5: 默认不启用。原脚本 `enable --now` 会立刻拉起一个监听 11434 的代理进程
  # 和一个每日跑的管线 —— 装完即生效，用户没有任何机会先看一眼配置。
  echo "     已安装单元文件，未启用（加 --enable-services 或手动启用）"
  echo "     systemctl --user daemon-reload && systemctl --user enable --now llm-wiki-pipeline.timer"
fi

echo "==> 5/5 提示"
echo "  vault 路径: $VAULT"
echo "  自检（不写任何东西）: node ~/bin/llm-wiki-pipeline.mjs --all --dry-run"
echo "  首次记忆体同步: node ~/bin/llm-wiki-pipeline.mjs --sync"
echo "  重启 dsh-web 使插件生效: systemctl --user restart dsh-web"
echo "  向量（可选）: mnemon embed --all"
echo "  文档摄取（可选）: node ~/bin/wiki-convert.mjs <文件> --inbox $VAULT/raw/inbox --sources $VAULT/raw/sources --json"
echo "安装完成。"
