#!/usr/bin/env bash
# Proves the C++ ZRCore is bit-exact with the shipping js/game3d-core.js.
#
# Needs only a C++17 compiler and Node. No Unreal, no Mac, no Xcode — which is
# the point: the hardest part of the port is verifiable anywhere, including in
# CI, before anybody builds the game.
#
#   ./verify.sh              # all five tracks
#   ./verify.sh miombo       # just one
set -euo pipefail

cd "$(dirname "$0")"
CORE=../Source/ZambiaRush/Private/Core
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

CXX=${CXX:-c++}
echo "building zrcore_verify with $CXX..."
"$CXX" -O2 -std=c++17 -Wall -Wextra -I "$CORE" \
    zrcore_verify.cpp "$CORE/ZRCore.cpp" "$CORE/ZRMath.cpp" -o "$OUT/zrcore_verify"

TRACKS=("$@")
[ ${#TRACKS[@]} -eq 0 ] && TRACKS=(miombo baobab kasanka zambezi falls)

FAIL=0
for T in "${TRACKS[@]}"; do
    node zrcore_reference.js "$T" > "$OUT/ref.txt"
    "$OUT/zrcore_verify"       "$T" > "$OUT/got.txt"
    if diff -q "$OUT/ref.txt" "$OUT/got.txt" >/dev/null; then
        printf '  %-8s bit-exact (%s lines)\n' "$T" "$(wc -l < "$OUT/ref.txt" | tr -d ' ')"
    else
        printf '  %-8s MISMATCH\n' "$T"
        diff "$OUT/ref.txt" "$OUT/got.txt" | head -20
        FAIL=1
    fi
done

if [ $FAIL -eq 0 ]; then
    echo "ZRCore matches js/game3d-core.js exactly."
else
    echo "ZRCore has diverged from js/game3d-core.js. Do not build on this."
    exit 1
fi
