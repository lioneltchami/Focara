#!/usr/bin/env bash
# Create or update lioneltchami/homebrew-tap Casks/focus.rb after a release.
# Usage: update-homebrew-cask.sh <version> <arm64_sha256> <intel_sha256>
# Env: HOMEBREW_TAP_DEPLOY_KEY (SSH private key with write access to the tap).
set -euo pipefail

VERSION="${1:?version required (e.g. 0.1.0)}"
ARM_SHA="${2:?arm64 sha256 required}"
INTEL_SHA="${3:?intel sha256 required}"
TAP_REPO="${TAP_REPO:-lioneltchami/homebrew-tap}"
WORKDIR="$(mktemp -d)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || {
  echo "Invalid version: $VERSION" >&2
  exit 1
}
[[ "$ARM_SHA" =~ ^[a-f0-9]{64}$ && "$INTEL_SHA" =~ ^[a-f0-9]{64}$ ]] || {
  echo "Both DMG checksums must be 64 lowercase hexadecimal characters." >&2
  exit 1
}

KEY_FILE="$WORKDIR/deploy_key"
umask 077
printenv HOMEBREW_TAP_DEPLOY_KEY > "$KEY_FILE"
chmod 600 "$KEY_FILE"
[[ "$(tail -c1 "$KEY_FILE" | wc -l)" -eq 0 ]] && echo >> "$KEY_FILE"
export GIT_SSH_COMMAND="ssh -i $KEY_FILE -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
git clone --depth 1 "git@github.com:${TAP_REPO}.git" "$WORKDIR/tap"

cd "$WORKDIR/tap"
mkdir -p Casks
cat > Casks/focus.rb <<EOF
cask "focus" do
  arch arm: "arm64", intel: "x64"

  version "$VERSION"
  sha256 arm:   "$ARM_SHA",
         intel: "$INTEL_SHA"

  url "https://github.com/lioneltchami/Focus/releases/download/v#{version}/Focus-#{version}-mac-#{arch}.dmg"
  name "Focus"
  desc "Screen recorder with automatic, editable zoom"
  homepage "https://github.com/lioneltchami/Focus"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :sonoma

  app "Focus.app"

  caveats <<~EOS
    Focus is not signed or notarized yet. On first launch, use System Settings > Privacy & Security > Open Anyway.
  EOS
end
EOF

if git ls-files --error-unmatch Casks/focus.rb >/dev/null 2>&1 && git diff --quiet -- Casks/focus.rb; then
  echo "Focus cask already at $VERSION — nothing to commit"
  exit 0
fi

git config user.name "Focus Release Bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add Casks/focus.rb
git commit -m "focus ${VERSION}"
git push origin HEAD
echo "Pushed Homebrew tap update for Focus ${VERSION}"
