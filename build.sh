#!/bin/sh
set -eu

version="0.1.0"
root_dir=$(pwd)
output_dir="$root_dir/dist"
temp_dir=$(mktemp -d /tmp/word-lookup-build.XXXXXX)
trap 'rm -rf "$temp_dir"' EXIT

mkdir -p "$output_dir"

for browser in chromium firefox; do
  package_dir="$temp_dir/$browser"
  mkdir -p "$package_dir"
  cp background.js content.css content.js settings.css settings.html settings.js README.md LICENSE "$package_dir/"
  cp -r assets "$package_dir/"
  cp "manifest.$browser.json" "$package_dir/manifest.json"
  (
    cd "$package_dir"
    zip -qr "$output_dir/word-lookup-$version-$browser.zip" .
  )
done

echo "Created Chromium and Firefox packages in dist/"
