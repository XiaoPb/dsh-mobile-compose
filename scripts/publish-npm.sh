#!/usr/bin/env bash
# 把当前包发布到 npm，并在每一步之后**确认版本真的公开**，而不是只看 npm publish 的退出码。
#
# 为什么要这么写：npm 现在可能「接受」发布请求却不让版本立刻公开——
#   · 账号/令牌是 stage-only 策略（registry 回 E_STAGE_REQUIRED），请求被收进 Staged Packages 等 2FA 批准；
#   · 包第一次发布、或可信发布方没登记时，OIDC 也会被拒。
# 这两种情况 npm CLI 的退出码都可能是 0，只看 rc 会得出「发布成功」的错误结论。
#
# 策略（与 dsh-roboto-mono 的 release.yml 同一套思路，多了逐方式验证 + token 兜底）：
#   1. 版本已公开               → 直接跳过（重跑安全）
#   2. Trusted Publishing(OIDC) → 发布 + 轮询确认公开
#   3. 仍未公开                 → 回退 NPM_TOKEN 再发一次 + 轮询确认公开
#   4. 两条路都没公开           → 打印诊断（registry 状态 / staged 列表 / 错误原文 / 中文处置建议）并失败
#
# 环境变量：
#   PACKAGE_NAME              必填，例如 @xiaopb/dsh-mobile-compose
#   VERSION                   默认读 package.json
#   REGISTRY                  默认 https://registry.npmjs.org/
#   NODE_AUTH_TOKEN           可选；token 兜底用（Actions 里来自 secrets.NPM_TOKEN）
#   POLL_ATTEMPTS             确认公开的轮询次数，默认 10
#   POLL_INTERVAL             轮询间隔秒，默认 6
#   GITHUB_OUTPUT             由 Actions 注入；用于输出 method=<发布方式>
#   ACTIONS_ID_TOKEN_REQUEST_URL  由 Actions 注入；存在即认为可以走 OIDC
#   PROBE_REGISTRY            默认 1；0 表示失败诊断时不访问 registry（本地/单测用）
set -euo pipefail

PACKAGE_NAME="${PACKAGE_NAME:?PACKAGE_NAME is required}"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
REGISTRY="${REGISTRY:-https://registry.npmjs.org/}"
REGISTRY="${REGISTRY%/}"
REG_HOST="${REGISTRY#*://}"
POLL_ATTEMPTS="${POLL_ATTEMPTS:-10}"
POLL_INTERVAL="${POLL_INTERVAL:-6}"
SPEC="${PACKAGE_NAME}@${VERSION}"
WORKDIR="${WORKDIR:-$(mktemp -d)}"
mkdir -p "$WORKDIR"

log() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

set_output() { # key value
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
  fi
  printf '    [output] %s=%s\n' "$1" "$2"
}

# ---------- 版本是否已公开 ----------
is_public() {
  npm view "$SPEC" version --registry "$REGISTRY" > /dev/null 2>&1
}

wait_public() { # $1 = 方式标签；成功 0，超时 1
  local label="$1" attempt raw
  for ((attempt = 1; attempt <= POLL_ATTEMPTS; attempt++)); do
    if is_public; then
      info "第 $attempt 次确认：$SPEC 已公开（$label）"
      return 0
    fi
    raw="$(npm view "$SPEC" version --registry "$REGISTRY" 2>&1 || true)"
    raw="$(printf '%s' "$raw" | head -n 2 | tr '\n' ' ')"
    info "第 $attempt/$POLL_ATTEMPTS 次确认：尚未公开 · ${raw:-（无输出）}"
    if [ "$attempt" -lt "$POLL_ATTEMPTS" ]; then sleep "$POLL_INTERVAL"; fi
  done
  return 1
}

# ---------- 单次发布尝试 ----------
PUB_RC=0
PUB_LOG=''
publish_once() { # $1 = trusted|token，$2 = 1 带 provenance / 0 不带
  local mode="$1" prov="$2"
  local npmrc="$WORKDIR/npmrc-$mode"
  local extra=()
  PUB_LOG="$WORKDIR/publish-$mode.log"

  if [ "$mode" = "token" ]; then
    # 显式写死 registry + token，避免 setup-node 生成的 npmrc 被后面那次 `npm install -g npm@latest` 影响
    printf 'registry=%s\n//%s/:_authToken=%s\n' \
      "$REGISTRY" "$REG_HOST" "${NODE_AUTH_TOKEN}" > "$npmrc"
  else
    # 可信发布：npmrc 里绝不能有 token，否则 npm 不会走 OIDC
    printf 'registry=%s\n' "$REGISTRY" > "$npmrc"
  fi
  if [ "$prov" = "1" ]; then extra+=("--provenance"); fi

  log "npm publish（方式：$mode，provenance：$prov）"
  info "registry=$REGISTRY  userconfig=$npmrc"
  set +e
  NPM_CONFIG_USERCONFIG="$npmrc" npm publish --registry "$REGISTRY" --access public ${extra[@]+"${extra[@]}"} 2>&1 | tee "$PUB_LOG"
  PUB_RC=${PIPESTATUS[0]}
  set -e
  info "退出码：$PUB_RC"
}

grep_log() { grep -Eiq "$1" "${2:-$PUB_LOG}" 2>/dev/null; }

# ---------- 诊断 ----------
diagnose() {
  local enc status body
  enc="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$PACKAGE_NAME")"

  log "诊断：npm / node 版本"
  info "npm $(npm --version) · node $(node --version) · registry $REGISTRY"
  if [ -n "${NODE_AUTH_TOKEN:-}" ]; then
    local identity
    identity="$(npm whoami --registry "$REGISTRY" 2>&1 | head -n 2 | tr '\n' ' ' || true)"
    info "token 身份：${identity:-（无法识别）}"
  fi

  log "诊断：包是否存在于 npm"
  body="$(npm view "$PACKAGE_NAME" version dist-tags --registry "$REGISTRY" 2>&1 || true)"
  info "$(printf '%s' "$body" | head -n 6 | tr '\n' ' ')"

  log "诊断：registry 上该版本的状态（能否看到 staged）"
  if [ "${PROBE_REGISTRY:-1}" = "0" ]; then
    info "（PROBE_REGISTRY=0，跳过 registry 探测）"
  elif [ -n "${NODE_AUTH_TOKEN:-}" ]; then
    status="$(curl -sS -m 20 -H "Authorization: Bearer $NODE_AUTH_TOKEN" \
      "$REGISTRY/-/package/$enc/version/$VERSION/status" 2>&1 || true)"
  else
    status="$(curl -sS -m 20 "$REGISTRY/-/package/$enc/version/$VERSION/status" 2>&1 || true)"
  fi
  if [ "${PROBE_REGISTRY:-1}" != "0" ]; then
    info "${status:-（无响应）}"
  fi

  log "诊断：npm stage list（npm ≥ 11.15 才有）"
  info "$(npm stage list "$PACKAGE_NAME" --registry "$REGISTRY" 2>&1 | head -n 12 || true)"

  log "诊断：发布日志里的报错行"
  info "$(grep -E 'npm (error|ERR!)|E_STAGE_REQUIRED|E403|E401|EOTP|E404' \
    "$WORKDIR"/publish-*.log 2>/dev/null | tail -n 8 || true)"
}

# =====================================================================
log "目标：$PACKAGE_NAME@$VERSION（tag v$VERSION）"

if is_public; then
  log "该版本已在 npm 公开，跳过发布"
  set_output method "already published"
  exit 0
fi

# ---------- 1) Trusted Publishing (OIDC) ----------
if [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
  publish_once trusted 1
  # provenance 在缺 OIDC 权限/registry 不支持时会单独失败，去掉 provenance 再试一次
  if [ "$PUB_RC" -ne 0 ] && grep_log 'provenance|sigstore|id-token|oidc'; then
    info "provenance 相关失败，去掉 --provenance 重试可信发布"
    publish_once trusted 0
  fi
  if wait_public "trusted publishing"; then
    set_output method "trusted publishing (OIDC)"
    exit 0
  fi
  info "可信发布没有让版本公开（常见原因：该包还没登记 Trusted Publisher、或账号是 stage-only 策略）"
else
  info "没有 OIDC 上下文（ACTIONS_ID_TOKEN_REQUEST_URL 缺失），跳过可信发布"
fi

# ---------- 2) NPM_TOKEN 兜底 ----------
if [ -n "${NODE_AUTH_TOKEN:-}" ]; then
  publish_once token 1
  if [ "$PUB_RC" -ne 0 ] && grep_log 'provenance|sigstore|id-token|oidc'; then
    info "provenance 相关失败，去掉 --provenance 重试 token 发布"
    publish_once token 0
  fi
  if wait_public "NPM_TOKEN"; then
    set_output method "NPM_TOKEN"
    exit 0
  fi
  info "token 发布同样没有让版本公开"
else
  info "没有 NODE_AUTH_TOKEN（仓库 Secret NPM_TOKEN 未配置），跳过 token 兜底"
fi

# ---------- 3) 失败 + 诊断 ----------
diagnose
cat <<'EOF'

::error title=Version not public::npm 接受了发布请求，但版本始终没有在 registry 上公开。请按顺序排查：
  1) npm 网页 → 包页面 → Staged Packages：若有本次版本，点 Approve（需要 2FA）。stage-only 策略与
     「包首次发布」都会走这条路，CI 无法代替人工 2FA。
  2) 包首次发布时，先在本地 `npm login && npm publish --access public` 走一次（或 `npm stage publish`），
     让包名在 registry 上存在；之后再去 npm 包设置里登记 Trusted Publisher（repo + release.yml）。
  3) 确认仓库 Secret NPM_TOKEN 是**可发布**的 granular token（不能是 stage-only / read-only，且 allowed
     packages 包含本包），并确认上面的「诊断」里 whoami 能识别到正确账号。
EOF
exit 1
