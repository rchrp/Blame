// The sandbox does not pass the image's environment to the runner, so the
// handshake reports this constant. version.test.ts keeps it in step with
// package.json and the Dockerfile.
export const runnerVersion = "0.3.6";
