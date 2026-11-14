export const siteOrigin = "https://blame.so";
export const siteUrl = new URL(siteOrigin);
export const discordInviteUrl = "https://discord.gg/AfjG6aUyxe";
// Bump the version whenever the card changes: Discord, Slack and X cache the
// image by its URL, so the same URL keeps showing the old card.
export const socialImagePath = "/social/blame-social-card.jpg?v=2";

export function absoluteSiteUrl(pathname: string) {
  return new URL(pathname, siteUrl).toString();
}
