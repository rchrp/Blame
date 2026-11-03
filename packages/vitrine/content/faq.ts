import { pricingBillingOptions } from "@blame/pricing-card/offer";

// The questions people ask before they choose a plan. The pricing page shows
// them, and its structured data and the Markdown versions for AI agents
// quote the same text. Answers follow the README and the published policies.

export type FaqEntry = {
  id: string;
  question: string;
  answer: string;
  // A page that says more, shown after the answer.
  link?: { label: string; path: string };
};

const { monthly, yearly } = pricingBillingOptions;

export const pricingFaq: readonly FaqEntry[] = [
  {
    id: "free",
    question: "Is Blame really free?",
    answer:
      "Yes. The whole desktop app is free and open source under the AGPL-3.0: projects, the backlog, conversations, agents, local worktrees, and local previews, with your own AI providers. Blame Cloud only pays for services that Blame hosts.",
  },
  {
    id: "premium",
    question: "What does Blame Cloud add?",
    answer: `Managed Cloud Previews, cloud voice transcription, and hosted file uploads, including deployment source archives, for $${monthly.price} a month or $${yearly.price} a year. Existing usage limits apply.`,
  },
  {
    id: "ai-costs",
    question: "Who pays for the AI models?",
    answer:
      "Agents use your own API key or subscription with the provider you choose, and that provider bills its own usage, with or without Blame Cloud.",
  },
  {
    id: "providers",
    question: "Which AI providers can I use?",
    answer:
      "Any of the 50 supported providers, with your own API key or subscription, plus any OpenAI-compatible endpoint. You can use a different model for each agent.",
  },
  {
    id: "where-code-runs",
    question: "Where does my code run?",
    answer:
      "On your computer: in a Lima VM on macOS, a WSL distribution on Windows, and native worktrees with Docker on Linux. Code is sent to the AI provider you choose when an agent needs it. Cloud Previews, part of Blame Cloud, sync a workspace snapshot to a managed sandbox.",
  },
  {
    id: "account",
    question: "Why do I need an account?",
    answer:
      "Your account syncs stories, conversations, Code Practices, provider connections, and MCP configuration between computers, and is needed for Blame Cloud. The account is free.",
  },
  {
    id: "cancel-refund",
    question: "Can I cancel or get a refund?",
    answer:
      "You can cancel anytime from the billing portal, and paid access lasts until the end of the current period. Eligible consumers can withdraw within 14 days of subscribing, and a valid withdrawal is refunded in full.",
    link: { label: "Read the Refund Policy", path: "/refund-policy" },
  },
  {
    id: "after-premium",
    question: "What happens to my files if I stop Blame Cloud?",
    answer:
      "They stay accessible. Ending a subscription stops the hosted services, such as new hosted uploads and Cloud Previews, not your access to the files you already uploaded.",
  },
  {
    id: "self-host",
    question: "Can I self-host the backend?",
    answer:
      "Not as a turnkey setup yet. The development setup in the repository's CONTRIBUTING.md runs the whole stack locally.",
  },
];
