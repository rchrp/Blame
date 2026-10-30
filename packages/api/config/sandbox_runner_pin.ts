// Written by the "Release sandbox runner" workflow; see RELEASING.md.
// BLAME_SANDBOX_RUNNER_IMAGE and BLAME_SANDBOX_RUNNER_VERSION override it.
export const sandboxRunnerPin: { image?: string; version: string } = {
  image:
    'vcr.vercel.com/raphaels-projects-e6b50141/blame-sandbox-runtime/blame-runner@sha256:5bb247504d1e1a32af696e5e32debc17c448298b195fb82700eb489945ad4954',
  version: '0.3.4',
}
