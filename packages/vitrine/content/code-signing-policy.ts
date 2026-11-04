import type {
  LegalBlock,
  LegalSection,
} from "@/components/legal-document-page";
import { legalDocumentReadyForPublication } from "@/content/legal-publication";

const paragraph = (text: string): LegalBlock => ({ type: "paragraph", text });
const list = (...items: string[]): LegalBlock => ({ type: "list", items });
const notice = (title: string, paragraphs: readonly string[]): LegalBlock => ({
  type: "notice",
  title,
  paragraphs,
});

// Required by SignPath Foundation, which signs Blame's Windows releases for
// free: linked as "Code signing policy" from the home and download pages.
// Mirrors CODE_SIGNING_POLICY.md at the repository root.
export const codeSigningEffectiveDate = "2 November 2026";
export const codeSigningLastUpdated = "4 November 2026";
export const codeSigningVersion = "1.0";

// Until SignPath Foundation approves Blame, the attribution is announced, not
// claimed. Once approved, set this to true: the attribution becomes a plain
// statement and the pending notice disappears.
const windowsSigningApproved = false;

const attribution =
  "Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org)";

export const codeSigningIntroduction = [
  "This policy describes how Blame's releases are built and signed, who may approve a signature, and where to find what the app sends. The same policy is kept in the source repository at https://github.com/rchrp/Blame/blob/main/CODE_SIGNING_POLICY.md.",
] as const;

export const codeSigningSections = [
  {
    id: "windows",
    title: "1. Windows",
    blocks: windowsSigningApproved
      ? [paragraph(`${attribution}.`)]
      : [
          notice("Not signed yet", [
            "Blame plans to apply to SignPath Foundation for free code signing for open-source projects. Until Windows releases are signed, the installer is not signed and Windows SmartScreen may warn about it.",
            `Once approved, Windows releases will carry this attribution: ${attribution}.`,
          ]),
        ],
  },
  {
    id: "signed-files",
    title: "2. What is signed",
    blocks: [
      list(
        "Windows: Blame.exe, the application, and blame-win-x64.exe, its installer.",
        "macOS: the application and its runtime helpers, signed with an Apple Developer ID certificate and notarized by Apple.",
      ),
      paragraph(
        "Only files built from Blame's source are signed. Third-party binaries that Blame ships unchanged, such as Electron's libraries, ripgrep, node-pty's helpers and pnpm, keep their upstream signature or none.",
      ),
    ],
  },
  {
    id: "builds",
    title: "3. How releases are built",
    blocks: [
      paragraph(
        "Every release is built from a tag in the public repository https://github.com/rchrp/Blame by GitHub Actions on GitHub-hosted runners. No release is built or signed on a personal machine. For Windows, the release workflow sends the unsigned files to SignPath, and an approver approves each signing request by hand before they are signed. The release process is described at https://github.com/rchrp/Blame/blob/main/RELEASING.md.",
      ),
    ],
  },
  {
    id: "team-roles",
    title: "4. Team roles",
    blocks: [
      list(
        "Committers and reviewers: [Raphael Charpentier](https://github.com/rchrp)",
        "Approvers: [Raphael Charpentier](https://github.com/rchrp)",
      ),
      paragraph(
        "Contributions from anyone else arrive as pull requests, which a reviewer checks before they are merged. Every team member uses multi-factor authentication on GitHub and SignPath.",
      ),
    ],
  },
  {
    id: "privacy",
    title: "5. Privacy",
    blocks: [
      paragraph(
        "The privacy policy at https://blame.so/privacy describes the data Blame sends, where it goes and how to turn it off. The Windows installer shows a summary of it before installing and lets you turn off usage telemetry and the update check at launch; Settings > Desktop > Privacy offers the same switches.",
      ),
    ],
  },
  {
    id: "reporting",
    title: "6. Reporting a problem",
    blocks: [
      paragraph(
        "To report a signed file that you believe is malicious or misattributed, write to security@blame.so.",
      ),
    ],
  },
] satisfies readonly LegalSection[];

export const codeSigningReadyForPublication = legalDocumentReadyForPublication(
  true,
  codeSigningSections,
);
