---
name: impeccable
description: Mandatory whenever a frontend task leaves the agent material visual or UX design discretion, especially for new interfaces, redesigns, substantial polish, or incomplete or absent mockups. Invoke before making design decisions or implementing the UI. Also use for frontend critique, audit, accessibility, responsiveness, typography, layout, color, motion, UX copy, edge cases, and design systems. Not for backend-only, non-UI, or purely mechanical implementation from a complete design source of truth.
---

# Impeccable for Blame

Create product-specific, production-grade frontend work with a clear point of view. The result must be useful, accessible, responsive, coherent with the repository, and visibly designed rather than assembled from generic patterns.

Loading this skill is a hard precondition whenever the lead agent must make material visual or UX choices. Load it before those decisions or any implementation; consulting `frontend_design` is complementary and never a substitute.

This Blame-native edition is adapted from Impeccable 4.1.1. It is self-contained because Blame intentionally exposes revision-safe workspace tools instead of arbitrary shell or out-of-workspace file access.

## Interpret the request

Use the optional command argument as the mode when present:

- `shape`: clarify the experience and return a compact design brief before implementation.
- `critique`: review product fit, hierarchy, interaction, and visual quality without changing code unless the user also asked for changes.
- `audit`: perform evidence-backed accessibility, responsive, theming, performance, and implementation-integrity checks.
- `polish`: refine an existing experience without replacing its identity or behavior.
- `harden`: cover loading, empty, error, success, disabled, permission, overflow, localization, and recovery states.
- `adapt`: improve behavior across viewport, input, zoom, content-length, and device constraints.
- `clarify`: improve labels, instructions, empty states, errors, and action copy.
- `layout`, `typeset`, `colorize`, `animate`, `delight`, `bolder`, `quieter`, `distill`, `onboard`, `optimize`: apply that focused lens while preserving product truth and scope.
- With no explicit mode, infer the smallest mode that satisfies the user. New or substantially redesigned surfaces use the full design workflow; narrow requests preserve the incumbent system.

For audit- or critique-only requests, report findings and do not edit. For implementation requests, the lead Blame agent owns every code change and verification step.

## Ground the work

Before editing:

1. Read the user story, acceptance criteria, attachments, and any selected code context. The brief wins over this skill's defaults.
2. Inspect the target and at least one representative source of visual truth: tokens, theme, shared components, typography, layout, icons, or a neighboring finished surface.
3. Identify the product, audience, user situation, primary job, important data, and what makes this surface unlike a generic SaaS page.
4. Classify the change:
   - **Refinement:** preserve identity, content, behavior, and everything outside scope.
   - **Extension:** inherit the established visual world and add only what the new job requires.
   - **Redesign:** preserve product truth and function while deliberately replacing the visual world.
   - **New surface:** establish a coherent world from the product and audience rather than from category defaults.
5. If a material product or visual choice cannot be inferred safely, ask one concise question. Do not ask for CSS values or make the user choose from generic aesthetic adjectives.

If design judgment would materially improve before implementation, consult `frontend_design` through `consult_specialist` with the exact user requirements, relevant files, incumbent design evidence, and constraints. The specialist advises; the lead still implements.

## Choose the visitor mode

Choose from the surface, not the overall product:

- **Persuade:** the visitor decides and acts. Earn attention with a clear promise, real proof, differentiation, objections, and a concrete next step.
- **Operate:** the user completes a task. Optimize scanability, information priority, reliable state, speed, and expert repetition.
- **Read:** the user understands material. Optimize structure, measure, wayfinding, rhythm, and comprehension.
- **Experience:** the user explores the work itself. Let the artifact lead while navigation and chrome recede.

A developer tool's landing page is Persuade; its dashboard is Operate; its documentation is Read.

## Establish a direction

For a narrow refinement, inherit the existing direction. For a new or replacement surface, decide explicitly:

- **Product mechanism:** the unique thing the product enables.
- **Audience scene:** who uses it, where, under what pressure, and with what prior knowledge.
- **Cultural source:** a real visual system, artifact, publication, workflow, place, or tool familiar to that audience.
- **Structural thesis:** how content and action are organized; not a list of decorative motifs.
- **Signature detail:** one memorable, useful element tied to the product mechanism.
- **Honest risk:** what the direction could get wrong and how the implementation controls it.

Do not average several directions into a safe compromise. Spend boldness in one place and keep the surrounding system disciplined. When the brief leaves direction materially open and the choice would change the product, present at most three meaningfully different, product-grounded directions and recommend one. Otherwise proceed with a clearly stated assumption.

## Build the visual system

### Hierarchy and composition

- Make the primary task and current state obvious within seconds.
- Use size, contrast, spacing, density, alignment, grouping, and sequence before decoration.
- Keep related elements close and separate distinct groups generously. Give headings more space above than below.
- Prefer a composition driven by workflow or content over repetitive section/card scaffolds.
- Use cards only when the grouping, boundary, or interaction needs a container. Avoid nested cards.
- Preserve calm density for operational interfaces; reserve cinematic pacing for persuasive or experiential surfaces.

### Typography

- Define clear display, body, label, and utility roles using the project's available type system.
- Use obvious scale and weight steps, readable line height, and a body measure around 65–75 characters when appropriate.
- Test real copy, long labels, filenames, code, numbers, localization expansion, and zoom at every supported breakpoint.
- Use monospace for code, data, or measurement, not as a costume for “technical.”
- Avoid gradient text and generic eyebrow/kicker labels above headings; let hierarchy and language carry emphasis.

### Color and depth

- Use a small purposeful palette with semantic roles and tokens. Respect established theme behavior.
- Verify normal text at 4.5:1 and large text at 3:1 where WCAG AA applies; verify focus and control contrast too.
- Tint secondary text to belong to colored surfaces instead of dropping unrelated gray onto them.
- Use shadow, blur, border, and translucency only when they explain elevation, focus, material, or interaction.
- Do not choose light or dark mode by product category; choose from the real use scene and existing product contract.

### Icons, imagery, and assets

- Reuse the established icon family or authored SVGs with coherent stroke, weight, and optical sizing.
- Do not substitute emoji or Unicode glyphs for a real icon system.
- Use imagery that carries product truth or atmosphere the brief actually needs. Preserve aspect ratio, useful alt text, responsive sources, and layout stability.
- Do not fabricate testimonials, metrics, customer logos, screenshots, or commercial claims.

### Interaction and motion

- Cover default, hover, focus, active, disabled, loading, error, empty, success, and permission states when relevant.
- Preserve semantic HTML, labels, logical tab order, visible focus, keyboard paths, screen-reader names, and suitable touch targets.
- Treat motion as feedback or spatial explanation. Prefer a small number of authored moments, fast exponential ease-out, interruption safety, and a meaningful reduced-motion alternative.
- Avoid identical entrance animations on every section, animation of layout properties without reason, and decorative effects that compromise responsiveness.

### Copy

- Use the product's vocabulary, concrete nouns, active verbs, and sentence case.
- Controls name the action. Errors name what happened and how to recover. Empty states invite the next useful action.
- Keep terminology consistent across buttons, confirmations, toasts, errors, and navigation.
- Ask before replacing factual copy or adding claims.

## Refuse generic defaults

Unless the brief or established system specifically earns them, avoid:

- a page made from same-sized icon/heading/text cards;
- nested cards, gratuitous modals, and interchangeable dashboard metric tiles;
- excessive gradients, glass, blur, glow, rounded rectangles, or decorative noise;
- colored side borders as the main identity of alerts or cards;
- hard offset shadows outside a genuinely neobrutalist system;
- sparklines, progress rings, and fake analytics standing in for meaningful content;
- a one-note accent palette or category-default purple-on-dark styling;
- decoration that could be moved to an unrelated product unchanged.

These are defaults to question, not reasons to fight an explicit brief. Product truth and the user's pinned direction always win.

## Production hardening

Check the complete path rather than one ideal screenshot:

- realistic minimum, typical, maximum, missing, and malformed content;
- mobile, intermediate, and wide layouts; zoom; text scaling; reduced motion; keyboard and pointer input;
- loading, empty, offline, error, partial success, success, disabled, destructive, and permission-limited states;
- wrapping, truncation, overflow, sticky/fixed elements, safe areas, scroll containment, and focus visibility;
- theme switching, semantic token use, image loading, layout shift, runtime errors, and interaction latency;
- factual copy, destructive confirmations, recovery paths, and state persistence.

Fix the cause at the narrowest correct level: reuse an existing shared primitive, promote a genuinely reusable token, or make a local correction. Do not create a design-system abstraction for one exception.

## Verify in bounded passes

Build fully, then inspect the rendered experience in one batched pass across the representative desktop and mobile sizes. Fix the discovered issues together and confirm once more at most. Do not spend open-ended rounds polishing one corner.

When `open_component_preview` is available, check the component's states, themes and widths there, following the `component-preview` skill. Use the app's preview for the requested workflow, navigation and the component's integration in its page.

Verification must include:

- the requested workflow with real content;
- hierarchy, alignment, spacing, typography, contrast, focus, and responsive composition;
- meaningful UI states and long-content behavior;
- console/runtime errors and the repository's focused checks;
- a final diff review for accidental churn, dead code, temporary assets, and inconsistencies.

A passing build is not visual proof. A clean screenshot is not functional proof. State what was verified and what remains unproven.

## Final self-critique

Before finishing, ask:

- Could this interface belong to any unrelated SaaS product if the nouns changed?
- Is the main action and current state obvious?
- Does every visual decision support product truth, user work, or a coherent world?
- Are the rough states as intentional as the ideal state?
- Did the implementation preserve the user's scope and the repository's system?

If the answer exposes generic work, revise the structure, language, hierarchy, interaction, or signature detail—not merely the accent color.
