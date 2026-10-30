// Written by the "Release sandbox runner" workflow; see RELEASING.md.
// BLAME_SANDBOX_RUNNER_IMAGE and BLAME_SANDBOX_RUNNER_VERSION override it.
export const sandboxRunnerPin: { image?: string; version: string } = {
  image:
    'vcr.vercel.com/raphaels-projects-e6b50141/blame-sandbox-runtime/blame-runner@sha256:bbc3b98fe2fbc21fd34b7fc13db9e4226a8a7b9157a620264bc27fefb1c64f7e',
  version: '0.3.5',
}
