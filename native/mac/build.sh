#!/bin/zsh
# Builds the macOS capture helper (needs Xcode or the Command Line Tools).
# UNIVERSAL=1 builds one binary for both Apple Silicon and Intel Macs (used for releases).
set -euo pipefail
cd "${0:A:h}"
mkdir -p build
build() { swiftc -swift-version 5 -O -target "$1-apple-macos14.0" main.swift Recorder.swift -o "$2"; }
if [[ "${UNIVERSAL:-0}" == 1 ]]; then
  build arm64 build/odak-capture-arm64
  build x86_64 build/odak-capture-x86_64
  lipo -create build/odak-capture-arm64 build/odak-capture-x86_64 -output build/odak-capture
  rm build/odak-capture-arm64 build/odak-capture-x86_64
else
  build "${ARCH:-$(uname -m)}" build/odak-capture
fi
codesign --force --sign - build/odak-capture >/dev/null 2>&1 || true
echo "built native/mac/build/odak-capture ($(lipo -archs build/odak-capture))"
