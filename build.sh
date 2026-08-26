#!/bin/sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$root_dir"
output_dir="$root_dir/dist"
temp_dir=$(mktemp -d /tmp/word-lookup-build.XXXXXX)
trap 'rm -rf "$temp_dir"' EXIT

version=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
mkdir -p "$output_dir"

for browser in chromium firefox; do
  package_dir="$temp_dir/$browser"
  mkdir -p "$package_dir"
  cp background.js content.css content.js languages.js settings.css settings.html settings.js README.md LICENSE "$package_dir/"
  cp -r assets "$package_dir/"
  cp manifest.json "$package_dir/manifest.json"

  if [ "$browser" = firefox ]; then
    python3 - "$package_dir/manifest.json" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as file:
    manifest = json.load(file)
manifest["background"] = {"scripts": ["languages.js", "background.js"]}
manifest["browser_specific_settings"] = {
    "gecko": {
        "id": "word-lookup@lasu.dev",
        "strict_min_version": "140.0",
        "data_collection_permissions": {"required": ["websiteContent"]},
    },
    "gecko_android": {"strict_min_version": "142.0"},
}
with open(path, "w", encoding="utf-8") as file:
    json.dump(manifest, file, indent=2, ensure_ascii=False)
    file.write("\n")
PY
  fi

  archive="$output_dir/word-lookup-$version-$browser.zip"
  rm -f "$archive"
  (
    cd "$package_dir"
    zip -qr "$archive" .
  )
done

echo "Created Chromium and Firefox packages in dist/"
