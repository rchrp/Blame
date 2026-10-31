export function LandingRevealStyles() {
  return (
    <style>{`
      .hero-stage canvas:not(.animated-border-effect-canvas) {
        opacity: 0;
        transform: scale(1.015);
        animation: sceneCanvasReveal 920ms cubic-bezier(0.2, 0.8, 0.2, 1) 160ms forwards;
      }

      .landing-reveal {
        opacity: 0;
        transform: translate3d(0, 18px, 0);
        animation: landingReveal 760ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
      }

      .landing-reveal-header {
        animation-delay: 80ms;
      }

      .landing-reveal-eyebrow {
        animation-delay: 150ms;
      }

      .landing-reveal-title {
        animation-delay: 220ms;
      }

      .landing-reveal-copy {
        animation-delay: 330ms;
      }

      .landing-reveal-actions {
        animation-delay: 430ms;
      }

      .landing-reveal-mockup {
        animation-delay: 540ms;
        transform: translate3d(0, 24px, 0) scale(0.985);
      }

      .scene-warmup {
        animation: sceneWarmupExit 560ms cubic-bezier(0.3, 0, 0, 1) 820ms forwards;
      }

      .scene-warmup-scan {
        animation: warmupScan 940ms cubic-bezier(0.7, 0, 0.2, 1) 120ms forwards;
      }

      .story-title {
        text-wrap: balance;
        font-size: clamp(2.25rem, 4.5vw, 4.25rem);
        letter-spacing: normal;
        line-height: 1.08;
      }

      .story-eyebrow {
        color: var(--primary);
        font-family: Arial, Helvetica, ui-sans-serif, sans-serif;
        font-size: clamp(0.875rem, 1.05vw, 1rem);
        font-weight: 400;
        letter-spacing: 0.1em;
        line-height: 1.3;
        text-transform: uppercase;
      }

      .story-copy {
        color: rgb(150, 150, 156);
        font-family: Arial, Helvetica, ui-sans-serif, sans-serif;
        font-size: clamp(1.125rem, 1.65vw, 1.4375rem);
        font-weight: 400;
        letter-spacing: 0;
        line-height: 1.58;
      }

      .user-story-state-effect {
        position: relative;
        padding: 1px;
        box-shadow:
          0 0 0 1px oklch(0.7 0.17 250 / 25%),
          0 0 14px oklch(0.65 0.2 250 / 32%);
      }

      .workspace-smart-sweep {
        display: inline-block;
        color: transparent;
        background-image: linear-gradient(
          105deg,
          #8fdcff 28%,
          #8fdcff 40%,
          #c4b5fd 48%,
          #a78bfa 54%,
          #8fdcff 62%,
          #8fdcff 76%
        );
        background-size: 300% 100%;
        background-position: 100% 0;
        background-clip: text;
        -webkit-background-clip: text;
        animation: workspaceSmartSweep 4s ease-out infinite;
      }

      .highlights-rail {
        scrollbar-width: none;
      }

      .highlights-rail::-webkit-scrollbar {
        display: none;
      }

      .specialist-card {
        isolation: isolate;
        position: relative;
      }

      .specialist-card::before {
        background: radial-gradient(
          ellipse 90% 140% at top left,
          var(--agent-response-color) 0%,
          var(--agent-response-glow-color) 42%,
          transparent 78%
        );
        border-radius: inherit;
        content: "";
        inset: -1px;
        mask:
          linear-gradient(#000 0 0) content-box,
          linear-gradient(#000 0 0);
        mask-composite: exclude;
        opacity: 0;
        padding: 2px;
        pointer-events: none;
        position: absolute;
        transition: opacity 300ms ease;
        z-index: 1;
      }

      .specialist-card:hover {
        border-color: transparent;
        box-shadow:
          0 0 0 1px var(--agent-response-glow-color),
          0 0 28px var(--agent-response-glow-color);
      }

      .specialist-card:hover::before {
        opacity: 1;
      }

      .story-reveal {
        opacity: 1;
        transform: translate3d(0, 0, 0);
      }

      .story-reveal[data-visible="false"] {
        opacity: 0;
        transform: translate3d(0, var(--story-reveal-distance), 0);
      }

      .story-reveal[data-visible="true"] {
        opacity: 1;
        transform: translate3d(0, 0, 0);
        transition:
          opacity 760ms cubic-bezier(0.22, 1, 0.36, 1) var(--story-reveal-delay),
          transform 760ms cubic-bezier(0.22, 1, 0.36, 1) var(--story-reveal-delay);
      }

      @keyframes sceneCanvasReveal {
        to {
          opacity: 1;
          transform: scale(1);
        }
      }

      @keyframes landingReveal {
        to {
          opacity: 1;
          transform: translate3d(0, 0, 0) scale(1);
        }
      }

      @keyframes sceneWarmupExit {
        to {
          opacity: 0;
          transform: scale(1.015);
          visibility: hidden;
        }
      }

      @keyframes warmupScan {
        from {
          transform: translateX(-115%);
        }
        to {
          transform: translateX(115%);
        }
      }

      @keyframes workspaceSmartSweep {
        from {
          background-position: 100% 0;
        }
        to {
          background-position: 0 0;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .hero-stage canvas,
        .landing-reveal,
        .scene-warmup,
        .scene-warmup-scan,
        .story-reveal,
        .story-reveal[data-visible="false"],
        .story-reveal[data-visible="true"],
        .specialist-card,
        .workspace-smart-sweep {
          animation: none;
          opacity: 1;
          transform: none;
          transition: none;
        }

        .workspace-smart-sweep {
          color: #8fdcff;
          background: none;
        }

        .specialist-card::before {
          transition: none;
        }

        .scene-warmup {
          visibility: hidden;
        }
      }
    `}</style>
  );
}
