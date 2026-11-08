#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# shortcut: amd64 only; add a reviewed architecture-specific archive before arm64 builds.
archive=$(mktemp -d)
trap 'rm -rf "$archive"' EXIT HUP INT TERM
url=https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
for attempt in 1 2 3; do
    if curl --fail --location --continue-at - --connect-timeout 20 --max-time 180 --output "$archive/ffmpeg-release-amd64-static.tar.xz" "$url"; then
        break
    fi
    [ "$attempt" -lt 3 ] || exit 1
done
curl --fail --location --retry 3 --retry-all-errors --connect-timeout 20 --max-time 180 --output "$archive/ffmpeg-release-amd64-static.tar.xz.md5" "$url.md5"
(cd "$archive"; md5sum -c ffmpeg-release-amd64-static.tar.xz.md5)
tar -xJf "$archive/ffmpeg-release-amd64-static.tar.xz" -C "$archive"
mkdir -p .containers/ffmpeg
cp "$archive"/ffmpeg-*-amd64-static/ffmpeg "$archive"/ffmpeg-*-amd64-static/ffprobe .containers/ffmpeg/
chmod 755 .containers/ffmpeg/ffmpeg .containers/ffmpeg/ffprobe
.containers/ffmpeg/ffmpeg -version >/dev/null
.containers/ffmpeg/ffprobe -version >/dev/null
sha256sum .containers/ffmpeg/ffmpeg .containers/ffmpeg/ffprobe
