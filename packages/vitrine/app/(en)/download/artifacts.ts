// The four builds the download page offers first. download.blame.so/latest
// serves the latest release's file of each name; the page, its structured
// data and its Markdown version all link to these.

export const downloadBaseUrl = 'https://download.blame.so/latest'

export type DownloadArtifact = {
  id: 'macos-arm64' | 'macos-x64' | 'windows-x64' | 'linux-x86_64'
  os: 'macos' | 'windows' | 'linux'
  platform: string
  architecture: string
  fileName: string
  size: string
  updatedAt: string
}

export const primaryArtifacts = [
  {
    id: 'macos-arm64',
    os: 'macos',
    platform: 'macOS',
    architecture: 'Apple silicon',
    fileName: 'blame-mac-arm64.dmg',
    size: '269M',
    updatedAt: '16 Jun 2026',
  },
  {
    id: 'macos-x64',
    os: 'macos',
    platform: 'macOS',
    architecture: 'Intel',
    fileName: 'blame-mac-x64.dmg',
    size: '277M',
    updatedAt: '16 Jun 2026',
  },
  {
    id: 'windows-x64',
    os: 'windows',
    platform: 'Windows',
    architecture: 'x64',
    fileName: 'blame-win-x64.exe',
    size: '215M',
    updatedAt: '28 Jun 2026',
  },
  {
    id: 'linux-x86_64',
    os: 'linux',
    platform: 'Linux',
    architecture: 'x86_64',
    fileName: 'blame-linux-x86_64.AppImage',
    size: '295M',
    updatedAt: '28 Jun 2026',
  },
] satisfies DownloadArtifact[]

export function artifactUrl(fileName: string) {
  return `${downloadBaseUrl}/${fileName}`
}
