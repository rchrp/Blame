export const githubRepository = "rchrp/Blame";
export const githubRepositoryUrl = `https://github.com/${githubRepository}`;
export const githubReleasesUrl = `${githubRepositoryUrl}/releases`;
export const githubIssuesUrl = `${githubRepositoryUrl}/issues`;
export const githubContributingUrl = `${githubRepositoryUrl}/blob/main/CONTRIBUTING.md`;
export const githubLicenseUrl = `${githubRepositoryUrl}/blob/main/LICENSE`;
export const harnessSourceUrl = `${githubRepositoryUrl}/tree/main/packages/agent-runtime/src/harness`;

const starCountFormat = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatStarCount(stars: number) {
  return starCountFormat.format(stars);
}
