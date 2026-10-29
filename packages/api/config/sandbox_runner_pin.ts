// Written by the "Release sandbox runner" workflow; see RELEASING.md.
// BLAME_SANDBOX_RUNNER_IMAGE and BLAME_SANDBOX_RUNNER_VERSION override it.
export const sandboxRunnerPin: { image?: string; version: string } = {
  image:
    'vcr.vercel.com/raphaels-projects-e6b50141/blame-sandbox-runtime/blame-runner@sha256:b2a201b918218d1b4c3a4f5ddac3f5a3eda09cae54eb5fd7f5c4030d716240d8',
  version: '0.3.3',
}
