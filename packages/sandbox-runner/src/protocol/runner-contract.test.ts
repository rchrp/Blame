import assert from "node:assert/strict";
import test from "node:test";
import { runnerHandshake, runnerProtocolVersion } from "./runner-contract.js";

test("advertises the atomic preview startup runner protocol", () => {
  assert.equal(runnerProtocolVersion, 3);
  assert.deepEqual(
    runnerHandshake({
      clineSdkVersion: "0.0.81",
      runnerVersion: "0.2.13",
      imageDigest: "sha256:test",
      capabilities: {
        terminalSurface: true,
        displaySurface: false,
        dockerCompose: true,
        sharedLoopback: true,
        snapshots: true,
        persistentFilesystem: true,
        publicHttpIngress: true,
        webSockets: true,
        networkPolicy: true,
        credentialBroker: false,
        bidirectionalSync: true,
        maxPublishedPorts: 15,
      },
    }),
    {
      clineSdkVersion: "0.0.81",
      protocolVersion: 3,
      runnerVersion: "0.2.13",
      imageDigest: "sha256:test",
      capabilities: {
        terminalSurface: true,
        displaySurface: false,
        dockerCompose: true,
        sharedLoopback: true,
        snapshots: true,
        persistentFilesystem: true,
        publicHttpIngress: true,
        webSockets: true,
        networkPolicy: true,
        credentialBroker: false,
        bidirectionalSync: true,
        maxPublishedPorts: 15,
      },
    },
  );
});
