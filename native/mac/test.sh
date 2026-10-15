#!/bin/zsh
# Tests for the macOS capture helper that need no screen recording permission.
set -euo pipefail
cd "${0:A:h}"
mkdir -p build
ARCH=${ARCH:-$(uname -m)}
for t in WavTest KeyframeTest EndOfRecordingTest; do
  swiftc -swift-version 5 -O -target "$ARCH-apple-macos14.0" -parse-as-library "tests/$t.swift" Recorder.swift -o "build/$t"
  echo "== $t"; "build/$t"
done
