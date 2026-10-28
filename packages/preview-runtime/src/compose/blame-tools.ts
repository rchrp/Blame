const ttydNotice =
  'MIT License\n\nCopyright (c) 2016-2022 Shuanglei Tao <tsl0922@gmail.com>\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.';

/** Official static MIT-licensed ttyd 1.7.7 release assets. */
export const ttydVersion = "1.7.7";
export const ttydAssets = {
  x86_64: {
    sha256: "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55",
  },
  aarch64: {
    sha256: "b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165",
  },
} as const;

/** Runs without interactive elevation; native Linux uses a user-owned folder. */
export function installTtydCommand(directory = "/opt/blame/tools") {
  const quoted = "'" + directory.replace(/'/g, "'\"'\"'") + "'";
  return `set -eu
tools=${quoted}
case "$(uname -m)" in
  x86_64) arch=x86_64; checksum=${ttydAssets.x86_64.sha256} ;;
  aarch64|arm64) arch=aarch64; checksum=${ttydAssets.aarch64.sha256} ;;
  *) echo 'Terminal previews need an x86_64 or arm64 runtime.' >&2; exit 1 ;;
esac
mkdir -p "$tools"
chmod 755 "$tools"
cat > "$tools/NOTICE" <<'BLAME_TTYD_NOTICE'
${ttydNotice}
BLAME_TTYD_NOTICE
chmod 644 "$tools/NOTICE"
if printf '%s  %s\\n' "$checksum" "$tools/ttyd" | sha256sum -c --status; then chmod 755 "$tools/ttyd"; exit 0; fi
temporary=$(mktemp "$tools/ttyd.XXXXXX")
trap 'rm -f "$temporary"' EXIT
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 'https://github.com/tsl0922/ttyd/releases/download/${ttydVersion}/ttyd.'"$arch" -o "$temporary"
printf '%s  %s\\n' "$checksum" "$temporary" | sha256sum -c --status
chmod 755 "$temporary"
mv "$temporary" "$tools/ttyd"`;
}
