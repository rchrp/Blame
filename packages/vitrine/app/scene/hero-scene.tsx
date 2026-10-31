'use client'

import { useEffect, useRef } from 'react'
import {
  createHeroScene,
  type HeroSceneTerrainPreset,
} from '@blame/hero-scene'

export type { HeroSceneTerrainPreset }

type HeroSceneProps = {
  terrainPreset?: HeroSceneTerrainPreset
  celebration?: boolean
  // Degrees the camera looks up, to give the sky more of the frame.
  lookUp?: number
}

// The 3D terrain behind a hero, with a soft-focus rim like the presentation
// video's: the picture blurs towards the edges of the frame.
export function HeroScene({
  terrainPreset = 'default',
  celebration = false,
  lookUp = 0,
}: HeroSceneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current

    if (!container) {
      return undefined
    }

    const scene = createHeroScene(container, { terrainPreset, celebration, lookUp })

    return () => {
      scene.dispose()
    }
  }, [celebration, lookUp, terrainPreset])

  return (
    <div aria-hidden="true" className="absolute inset-0 -z-20">
      <div ref={containerRef} className="absolute inset-0" />
      <div className="hero-scene-rim pointer-events-none absolute inset-0" />
    </div>
  )
}
