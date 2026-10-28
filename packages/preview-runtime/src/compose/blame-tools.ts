/** Official static MIT-licensed ttyd 1.7.7 release assets. */
export const ttydVersion = "1.7.7";
export const ttydAssets = {
  x86_64: { sha256: "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55" },
  aarch64: { sha256: "b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165" },
} as const;

/** Run as the runtime user, never through an interactive elevation prompt. */
export function installTtydCommand() {
  return `set -eu
case "$(uname -m)" in
  x86_64) arch=x86_64; checksum=${ttydAssets.x86_64.sha256} ;;
  aarch64|arm64) arch=aarch64; checksum=${ttydAssets.aarch64.sha256} ;;
  *) echo 'Terminal previews need an x86_64 or arm64 runtime.' >&2; exit 1 ;;
esac
mkdir -p /opt/blame/tools
if printf '%s  %s\\n' "$checksum" /opt/blame/tools/ttyd | sha256sum -c --status; then exit 0; fi
temporary=$(mktemp /opt/blame/tools/ttyd.XXXXXX)
trap 'rm -f "$temporary"' EXIT
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 'https://github.com/tsl0922/ttyd/releases/download/${ttydVersion}/ttyd.'"$arch" -o "$temporary"
printf '%s  %s\\n' "$checksum" "$temporary" | sha256sum -c --status
chmod 755 "$temporary"
mv "$temporary" /opt/blame/tools/ttyd`;
}
