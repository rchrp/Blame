import { validateRunConfigurations } from '#services/project_initializations_service'
import { parsePreviewManifest } from '@blame/preview-contract'
import { test } from '@japa/runner'

const manifest = parsePreviewManifest({
  confidence: 'high',
  project: {},
  setup: [],
  caches: [],
  risks: [],
  probes: [],
  services: [
    {
      id: 'cli',
      kind: 'preview',
      container: { image: 'python:3.13-slim' },
      command: 'greeter',
      surface: { type: 'terminal' },
      endpoints: [],
    },
  ],
  devices: [
    {
      id: 'iphone',
      platform: 'ios',
      projectDir: '.',
      toolchain: 'xcode',
      build: { project: 'App.xcodeproj', scheme: 'App' },
      app: { bundleId: 'com.example.app' },
    },
  ],
})

const base = {
  id: 'run',
  name: 'Run',
  command: 'greeter',
  cwd: '.',
  default: true,
  scopes: ['.'],
}

test.group('project initialization preview surfaces', () => {
  test('accepts terminal and device run configurations', ({ assert }) => {
    assert.doesNotThrow(() =>
      validateRunConfigurations(
        [
          { ...base, category: 'terminal', services: ['cli'], previewService: 'cli' },
          {
            ...base,
            id: 'ios',
            default: false,
            category: 'mobile',
            services: [],
            previewTarget: 'iphone',
          },
        ],
        manifest
      )
    )
  })

  test('rejects mismatched surfaces', ({ assert }) => {
    for (const configuration of [
      { ...base, category: 'service' as const, services: ['cli'], previewService: 'cli' },
      { ...base, category: 'terminal' as const, services: ['cli'] },
      {
        ...base,
        category: 'terminal' as const,
        services: ['cli'],
        previewService: 'cli',
        previewUrl: 'http://localhost:7681/',
      },
      { ...base, category: 'desktop' as const, services: [], previewTarget: 'iphone' },
      { ...base, category: 'mobile' as const, services: [], previewTarget: 'android' },
    ]) {
      assert.throws(() => validateRunConfigurations([configuration], manifest))
    }
  })
})
