#!/usr/bin/env bash
set -euo pipefail
umask 077

port=${VPS_PORT:-22}
root=${VPS_ROOT:-/opt/claro-copilot}
[[ "${VPS_HOST:?}" =~ ^[a-zA-Z0-9.-]+$ ]]
[[ "${VPS_USER:?}" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]]
[[ "$port" =~ ^[0-9]+$ ]]
[[ "$root" =~ ^/[a-zA-Z0-9_/-]+$ ]]
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ "$GITHUB_ACTOR" =~ ^[a-zA-Z0-9_-]+$ ]]
[[ "$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq .object.sha)" == "$GITHUB_SHA" ]] || {
  echo 'This candidate has been superseded by a newer push to main.'
  exit 0
}

read -r claro < candidates/candidate-claro-copiloto/candidate-image.txt
read -r ml < candidates/candidate-claro-ml/candidate-image.txt
prefix="ghcr.io/${GITHUB_REPOSITORY,,}"
[[ "$claro" =~ ^"$prefix/claro-copiloto@sha256:"[a-f0-9]{64}$ ]]
[[ "$ml" =~ ^"$prefix/claro-ml@sha256:"[a-f0-9]{64}$ ]]

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
printf '%s\n' "${VPS_KEY:?}" > "$work/key"
printf '%s\n' "${VPS_KNOWN_HOSTS:?}" > "$work/known_hosts"
remote="$VPS_USER@$VPS_HOST"
ssh_options=(-i "$work/key" -o UserKnownHostsFile="$work/known_hosts" -o StrictHostKeyChecking=yes
  -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=20 -o ServerAliveCountMax=4)

# Release files have no private inputs. Runtime secrets and published model assets stay on the server.
tar -czf "$work/infra.tgz" infra
release="$root/releases/$GITHUB_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
ssh "${ssh_options[@]}" -p "$port" "$remote" "umask 077; install -d '$release'"
scp "${ssh_options[@]}" -P "$port" "$work/infra.tgz" "$remote:$release/infra.tgz"
ssh "${ssh_options[@]}" -p "$port" "$remote" "tar -xzf '$release/infra.tgz' -C '$release' && rm '$release/infra.tgz'"

# Login for this pull only. The token travels on stdin and expires when the job ends.
printf '%s\n' "$GH_TOKEN" | ssh "${ssh_options[@]}" -p "$port" "$remote" "
  set -eu
  umask 077
  export DOCKER_CONFIG=\$(mktemp -d)
  trap 'rm -rf -- \"\$DOCKER_CONFIG\"' EXIT
  docker login ghcr.io --username '$GITHUB_ACTOR' --password-stdin
  bash '$release/infra/vps/deploy.sh' '$root' '$GITHUB_SHA' '$claro' '$ml'
"
