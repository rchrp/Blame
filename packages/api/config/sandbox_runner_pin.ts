// Written by the "Release sandbox runner" workflow; see RELEASING.md.
// BLAME_SANDBOX_RUNNER_IMAGE and BLAME_SANDBOX_RUNNER_VERSION override it.
export const sandboxRunnerPin: { image?: string; version: string } = {
  image:
    'vcr.vercel.com/raphaels-projects-e6b50141/blame-sandbox-runtime/blame-runner@sha256:969d1b25859bc8ccad761d4638a9204ee52960d2f2f5b1558df6b24a5f8d96f1',
  version: '0.3.8',
}
