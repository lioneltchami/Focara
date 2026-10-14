#!/bin/zsh
# Builds the macOS capture helper (needs Xcode or the Command Line Tools).
set -euo pipefail
cd "${0:A:h}"
mkdir -p build
ARCH=${ARCH:-$(uname -m)}
swiftc -swift-version 5 -O -target "$ARCH-apple-macos14.0" main.swift Recorder.swift -o build/odak-capture
codesign --force --sign - build/odak-capture >/dev/null 2>&1 || true
echo "built native/mac/build/odak-capture"
