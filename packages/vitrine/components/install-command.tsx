"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import styles from "./install-command.module.css";

const copiedFor = 1800;

// A one-line install command in a frosted pill, with its platform (unless
// the page names it already) and a copy button. Where the clipboard is out of
// reach, the button selects the command so it can be copied by hand.
export function InstallCommand({
  className = "",
  command,
  platform,
  showPlatform = true,
}: {
  className?: string;
  command: string;
  platform: string;
  showPlatform?: boolean;
}) {
  const codeRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), copiedFor);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      const code = codeRef.current;
      if (code) window.getSelection()?.selectAllChildren(code);
    }
  };

  return (
    <div className={`${styles.command} ${className}`}>
      {showPlatform ? (
        <span className={styles.platform}>{platform}</span>
      ) : null}
      <code ref={codeRef} className={styles.code}>
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        className={styles.copy}
        aria-label={`Copy the ${platform} install command`}
        title="Copy"
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </div>
  );
}
