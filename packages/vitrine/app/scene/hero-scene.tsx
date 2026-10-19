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
}

export function HeroScene({
  terrainPreset = 'default',
  celebration = false,
}: HeroSceneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current

    if (!container) {
      return undefined
    }

    const scene = createHeroScene(container, { terrainPreset, celebration })

    return () => {
      scene.dispose()
    }
  }, [celebration, terrainPreset])

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className="absolute inset-0 -z-20"
    />
  )
}
