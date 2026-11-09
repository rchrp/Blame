// Written by the "Release sandbox runner" workflow; see RELEASING.md.
// BLAME_SANDBOX_RUNNER_IMAGE and BLAME_SANDBOX_RUNNER_VERSION override it.
export const sandboxRunnerPin: { image?: string; version: string } = {
  image:
    'vcr.vercel.com/raphaels-projects-e6b50141/blame-sandbox-runtime/blame-runner@sha256:d691bebe4cfdf9c4dfe2f80d35b72d8d63fbc14b62e500fba0653453a634d828',
  version: '0.3.9',
}
