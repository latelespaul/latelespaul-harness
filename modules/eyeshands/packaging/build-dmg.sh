#!/bin/bash
# Build the unsigned Eyes & Hands disk image and the Spoon zip (design part 16, options E and H).
#
#   build-dmg.sh [--out DIR] [--hammerspoon-zip FILE]   build dist/EyesHands.dmg, dist/EyesHands.spoon.zip, dist/SHA256SUMS
#   build-dmg.sh --verify-app APP                       check one Hammerspoon.app as the build does
#   build-dmg.sh --check-layout DIR                     check one staged (or mounted) disk image folder
#   build-dmg.sh --stage-spoon DEST                     write the shipped Spoon (with LICENSE, bin/eyeshands and bin/hsx) to DEST
#
# The image holds the official, unmodified Hammerspoon.app, EyesHands.spoon (with the CLI in its bin/),
# an Applications link, "Read Me First.html" (the README as a page) and Licenses/. It holds no unsigned
# app, no installer and no .command script. The build downloads the pinned Hammerspoon release, checks
# its SHA-256, then checks the app with codesign and spctl: a notarized Developer ID signature from the
# Hammerspoon team. Any mismatch stops the build, so the image never ships a changed copy. The build
# then mounts the new image read-only at a temporary folder (never in Finder) and checks it again.
# macOS tools only: curl, shasum, ditto, codesign, spctl, hdiutil, PlistBuddy, file, and python3 for
# the README page. No signing identity and no secret.
set -euo pipefail

HS_VERSION="1.1.1"
HS_URL="https://github.com/Hammerspoon/hammerspoon/releases/download/${HS_VERSION}/Hammerspoon-${HS_VERSION}.zip"
HS_SHA256="11bb1c90faf5427f37c7bd4fe7eab9774ae43e1d5cb020c5b3088dac32849efa"
HS_TEAM="VQCYSNZB89"                      # the Hammerspoon developers' Apple team id
HS_BUNDLE_ID="org.hammerspoon.Hammerspoon"
VOLNAME="Eyes & Hands"
README_PAGE="Read Me First.html"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MODULE="$(dirname "$HERE")"
REPO="$(cd "$MODULE/../.." && pwd -P)"

die() { echo "build-dmg: $*" >&2; exit 1; }
say() { echo "build-dmg: $*"; }

# verify_app APP: the official Hammerspoon, signed and notarized by its team, at the pinned version.
verify_app() {
  local app="$1" out
  [ -d "$app" ] || die "no app bundle at $app"
  codesign --verify --deep --strict "$app" >/dev/null 2>&1 \
    || die "codesign --verify --deep --strict failed for $app: the app is unsigned or changed"
  out="$(codesign -dv --verbose=2 "$app" 2>&1)" || die "codesign cannot read the signature of $app"
  grep -qx "TeamIdentifier=$HS_TEAM" <<<"$out" \
    || die "$app is not signed by the Hammerspoon team ($HS_TEAM): $(grep '^TeamIdentifier=' <<<"$out" || echo 'no team id')"
  grep -q "^Authority=Developer ID Application: .*($HS_TEAM)\$" <<<"$out" \
    || die "$app has no Developer ID Application signature from team $HS_TEAM"
  out="$(spctl -a -vv -t execute "$app" 2>&1)" || die "spctl rejects $app: $out"
  grep -qx "source=Notarized Developer ID" <<<"$out" || die "spctl does not report a notarized Developer ID app: $out"
  grep -q "^origin=Developer ID Application: .*($HS_TEAM)\$" <<<"$out" || die "spctl reports another origin: $out"
  local plist="$app/Contents/Info.plist" id ver
  id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist" 2>/dev/null || true)"
  ver="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist" 2>/dev/null || true)"
  [ "$id" = "$HS_BUNDLE_ID" ] || die "$app has bundle id '$id', not $HS_BUNDLE_ID"
  [ "$ver" = "$HS_VERSION" ] || die "$app is version '$ver', not the pinned $HS_VERSION"
  say "verified $app: Hammerspoon $ver, notarized Developer ID, team $HS_TEAM"
}

# check_layout DIR: exactly the five expected items, and nothing that Gatekeeper would block.
check_layout() {
  local dir="$1" name bad entry have=() want=(Applications EyesHands.spoon Hammerspoon.app Licenses "$README_PAGE")
  [ -d "$dir" ] || die "no folder at $dir"
  while IFS= read -r -d '' entry; do
    name="$(basename "$entry")"
    case "$name" in .DS_Store|.fseventsd|.Trashes|.background) continue ;; esac
    have+=("$name")
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -print0)
  [ "$(printf '%s\n' ${have[@]+"${have[@]}"} | LC_ALL=C sort)" = "$(printf '%s\n' "${want[@]}" | LC_ALL=C sort)" ] \
    || die "unexpected top level in $dir: $(printf '[%s] ' ${have[@]+"${have[@]}"})"
  [ -L "$dir/Applications" ] && [ "$(readlink "$dir/Applications")" = "/Applications" ] \
    || die "$dir/Applications is not a link to /Applications"
  [ -f "$dir/$README_PAGE" ] || die "$dir/$README_PAGE is not a file"
  [ -d "$dir/Licenses" ] && [ -d "$dir/EyesHands.spoon" ] && [ -d "$dir/Hammerspoon.app" ] \
    || die "Licenses, EyesHands.spoon and Hammerspoon.app must be folders"
  [ -f "$dir/EyesHands.spoon/init.lua" ] || die "$dir/EyesHands.spoon has no init.lua"
  [ -f "$dir/EyesHands.spoon/LICENSE" ] || die "$dir/EyesHands.spoon has no LICENSE"
  # Outside Hammerspoon.app: no app, installer, image or .command script, no link, no binary code.
  bad="$(find "$dir" -mindepth 1 -path "$dir/Hammerspoon.app" -prune -o -path "$dir/Applications" -prune -o \
    \( -iname '*.app' -o -iname '*.pkg' -o -iname '*.mpkg' -o -iname '*.command' -o -iname '*.tool' \
       -o -iname '*.dmg' -o -iname '*.terminal' -o -type l \) -print)"
  [ -z "$bad" ] || die "forbidden item in the image: $bad"
  while IFS= read -r -d '' entry; do
    case "$(file -b "$entry")" in *Mach-O*) die "binary code outside Hammerspoon.app: $entry" ;; esac
  done < <(find "$dir" -mindepth 1 -path "$dir/Hammerspoon.app" -prune -o -path "$dir/Applications" -prune -o -type f -print0)
  say "layout of $dir is as expected"
}

stage_spoon() {   # stage_spoon DEST: the Spoon with the licence, and the CLI and its hsx in bin/
  local dest="$1"
  ditto --norsrc --noextattr "$MODULE/EyesHands.spoon" "$dest"
  ditto --norsrc --noextattr "$REPO/LICENSE" "$dest/LICENSE"
  mkdir -p "$dest/bin"
  ditto --norsrc --noextattr "$MODULE/bin/eyeshands" "$dest/bin/eyeshands"
  ditto --norsrc --noextattr "$MODULE/bin/hsx" "$dest/bin/hsx"
  chmod 755 "$dest/bin/eyeshands"
  find "$dest" \( -name '__pycache__' -o -name '.DS_Store' \) -prune -exec rm -rf {} +
}

build() {
  local out="$1" hs_zip="$2"
  command -v hdiutil >/dev/null || die "hdiutil not found: the build runs only on macOS"
  mkdir -p "$out"
  out="$(cd "$out" && pwd -P)"
  local work; work="$(mktemp -d "${TMPDIR:-/tmp}/eh-dmg.XXXXXX")"
  local mnt="$work/mnt"
  # shellcheck disable=SC2064
  trap "hdiutil detach -quiet '$mnt' 2>/dev/null || true; rm -rf '$work'" EXIT
  if [ -z "$hs_zip" ]; then
    say "downloading Hammerspoon $HS_VERSION"
    hs_zip="$work/Hammerspoon.zip"
    curl -fsSL --retry 3 -o "$hs_zip" "$HS_URL" || die "download failed: $HS_URL"
  fi
  [ -f "$hs_zip" ] || die "no file at $hs_zip"
  local sum; sum="$(shasum -a 256 "$hs_zip" | awk '{print $1}')"
  [ "$sum" = "$HS_SHA256" ] || die "SHA-256 of $hs_zip is $sum, not the pinned $HS_SHA256"
  mkdir "$work/hs"
  ditto -x -k "$hs_zip" "$work/hs"
  [ "$(find "$work/hs" -mindepth 1 -maxdepth 1 ! -name '__MACOSX' | wc -l | tr -d ' ')" = 1 ] && [ -d "$work/hs/Hammerspoon.app" ] \
    || die "the Hammerspoon zip does not hold exactly Hammerspoon.app"
  verify_app "$work/hs/Hammerspoon.app"

  local stage="$work/stage"
  mkdir -p "$stage/Licenses"
  ditto "$work/hs/Hammerspoon.app" "$stage/Hammerspoon.app"   # keeps the signature and extended attributes
  verify_app "$stage/Hammerspoon.app"
  stage_spoon "$stage/EyesHands.spoon"
  ln -s /Applications "$stage/Applications"
  python3 -I "$HERE/readme-html.py" "$MODULE/README.md" "$stage/$README_PAGE"
  ditto --norsrc --noextattr "$HERE/licenses/" "$stage/Licenses/"
  check_layout "$stage"

  rm -f "$out/EyesHands.dmg" "$out/EyesHands.spoon.zip" "$out/SHA256SUMS"
  hdiutil create -quiet -volname "$VOLNAME" -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$out/EyesHands.dmg"
  ( cd "$stage" && ditto -c -k --norsrc --noextattr --keepParent EyesHands.spoon "$out/EyesHands.spoon.zip" )

  # Check what ships: the image, mounted read-only at a temporary folder, hidden from Finder.
  mkdir "$mnt"
  hdiutil attach -quiet -readonly -nobrowse -noautoopen -mountpoint "$mnt" "$out/EyesHands.dmg"
  verify_app "$mnt/Hammerspoon.app"
  check_layout "$mnt"
  hdiutil detach -quiet "$mnt"
  ( cd "$out" && shasum -a 256 EyesHands.dmg EyesHands.spoon.zip > SHA256SUMS )
  say "wrote $out/EyesHands.dmg, $out/EyesHands.spoon.zip and $out/SHA256SUMS"
}

usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

out="$REPO/dist" hs_zip=""
case "${1:-}" in
  --verify-app) [ $# -eq 2 ] || usage; verify_app "$2"; exit 0 ;;
  --check-layout) [ $# -eq 2 ] || usage; check_layout "$2"; exit 0 ;;
  --stage-spoon) [ $# -eq 2 ] || usage; [ ! -e "$2" ] || die "$2 exists"; stage_spoon "$2"; exit 0 ;;
esac
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || usage; out="$2"; shift 2 ;;
    --hammerspoon-zip) [ $# -ge 2 ] || usage; hs_zip="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done
build "$out" "$hs_zip"
