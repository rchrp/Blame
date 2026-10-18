import type { Transition, Variants } from "motion/react"

// Shared motion vocabulary, so every screen moves the same way.

// Fast start, long soft landing. Used for most entrances.
export const easeOutExpo = [0.16, 1, 0.3, 1] as const
// Symmetric, for elements that travel from one place to another.
export const easeInOut = [0.65, 0, 0.35, 1] as const

export const springSnappy: Transition = {
  type: "spring",
  stiffness: 520,
  damping: 38,
  mass: 0.8,
}

export const springSoft: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 30,
}

// Whole-screen changes inside the onboarding stage.
export const screenVariants: Variants = {
  initial: { opacity: 0, y: 18, scale: 0.985, filter: "blur(10px)" },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: { duration: 0.6, ease: easeOutExpo },
  },
  exit: {
    opacity: 0,
    y: -12,
    scale: 0.99,
    filter: "blur(8px)",
    transition: { duration: 0.32, ease: easeInOut },
  },
}

// Parent that reveals its children one after another.
export const staggerContainer = (stagger = 0.06, delay = 0): Variants => ({
  initial: {},
  animate: { transition: { staggerChildren: stagger, delayChildren: delay } },
})

export const riseIn: Variants = {
  initial: { opacity: 0, y: 12, filter: "blur(4px)" },
  animate: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.5, ease: easeOutExpo },
  },
}

// Steps of a wizard: slides in the direction of travel.
export const stepVariants: Variants = {
  initial: (direction: number) => ({
    opacity: 0,
    x: direction * 28,
    filter: "blur(6px)",
  }),
  animate: {
    opacity: 1,
    x: 0,
    filter: "blur(0px)",
    transition: { duration: 0.38, ease: easeOutExpo },
  },
  exit: (direction: number) => ({
    opacity: 0,
    x: direction * -20,
    filter: "blur(6px)",
    transition: { duration: 0.16, ease: easeInOut },
  }),
}
