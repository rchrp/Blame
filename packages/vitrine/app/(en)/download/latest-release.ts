import type { DownloadArtifact } from './artifacts'

// download.blame.so/latest redirects to this repository's latest published
// release, so its tag, sizes and dates describe exactly what users get.
const latestReleaseUrl = 'https://api.github.com/repos/rchrp/Blame/releases/latest'
const revalidateSeconds = 600

type GitHubRelease = {
  tag_name: string
  assets: { name: string; size: number; updated_at: string }[]
}

type LatestRelease = {
  tag: string | null
  artifacts: DownloadArtifact[]
}

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

export async function loadLatestRelease(
  fallbackArtifacts: DownloadArtifact[],
): Promise<LatestRelease> {
  const release = await fetchLatestRelease()

  if (!release) {
    return { tag: null, artifacts: fallbackArtifacts }
  }

  return {
    tag: release.tag_name,
    artifacts: fallbackArtifacts.map((artifact) => {
      const asset = release.assets.find((candidate) => candidate.name === artifact.fileName)

      if (!asset) {
        return artifact
      }

      return {
        ...artifact,
        size: `${Math.round(asset.size / 1024 ** 2)}M`,
        updatedAt: dateFormat.format(new Date(asset.updated_at)),
      }
    }),
  }
}

async function fetchLatestRelease() {
  try {
    const response = await fetch(latestReleaseUrl, {
      headers: { Accept: 'application/vnd.github+json' },
      next: { revalidate: revalidateSeconds },
    })

    if (!response.ok) {
      return null
    }

    return (await response.json()) as GitHubRelease
  } catch {
    return null
  }
}
