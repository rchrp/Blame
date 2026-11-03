import Image from "next/image";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import type { SVGProps } from "react";

import { githubRepositoryUrl } from "@/lib/github";
import { discordInviteUrl } from "@/lib/site";

// The docs header: the Blame mark back to the website, the website's main
// pages, then search, Discord, GitHub and the theme switch.
export function docsLayoutOptions(): BaseLayoutProps {
  return {
    nav: {
      url: "/",
      title: (
        <>
          <Image
            src="/icons/blame-icon-128.png"
            alt=""
            width={28}
            height={28}
            className="size-7"
            priority
          />
          <span className="font-display text-lg">Blame</span>
          <span className="text-fd-muted-foreground text-sm">Docs</span>
        </>
      ),
    },
    githubUrl: githubRepositoryUrl,
    links: [
      { text: "Website", url: "/", active: "none" },
      { text: "Cloud", url: "/cloud", active: "none" },
      { text: "Download", url: "/download", active: "none" },
      {
        type: "icon",
        text: "Discord",
        label: "Blame on Discord",
        icon: <DiscordMark />,
        url: discordInviteUrl,
        external: true,
      },
    ],
  };
}

function DiscordMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.45.87-.61 1.25a18.27 18.27 0 0 0-5.49 0 12.6 12.6 0 0 0-.62-1.25.08.08 0 0 0-.08-.04 19.74 19.74 0 0 0-4.88 1.52.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.23-1.99a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.89.08.08 0 0 1-.01-.13c.13-.09.25-.19.37-.29a.07.07 0 0 1 .08-.01c3.93 1.79 8.18 1.79 12.06 0a.07.07 0 0 1 .08.01c.12.1.24.2.37.29a.08.08 0 0 1-.01.13c-.6.35-1.22.65-1.87.89a.08.08 0 0 0-.04.11c.36.7.77 1.36 1.22 1.99a.08.08 0 0 0 .08.03 19.84 19.84 0 0 0 6-3.03.08.08 0 0 0 .03-.06c.5-5.18-.84-9.67-3.55-13.66a.06.06 0 0 0-.03-.03ZM8.02 15.33c-1.18 0-2.16-1.09-2.16-2.42s.96-2.42 2.16-2.42c1.21 0 2.18 1.1 2.16 2.42 0 1.33-.96 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.09-2.15-2.42s.95-2.42 2.15-2.42c1.21 0 2.18 1.1 2.16 2.42 0 1.33-.95 2.42-2.16 2.42Z" />
    </svg>
  );
}
