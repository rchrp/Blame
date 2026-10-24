import assert from "node:assert/strict";
import test from "node:test";
import { rootPartition } from "./lima-image-chroot.mjs";

const linux = "0FC63DAF-8483-4772-8E79-3D69D8477DE4";
const efi = "C12A7328-F81F-11D2-BA4B-00A0C93EC93B";

// Layout of an Ubuntu 24.04 cloud image: EFI and /boot first, root last.
const ubuntu = {
  sectorsize: 512,
  partitions: [
    { node: "disk.raw1", start: 2099200, size: 2093023, type: linux },
    { node: "disk.raw15", start: 2048, size: 217088, type: efi },
    { node: "disk.raw16", start: 219136, size: 1880064, type: linux.toLowerCase() },
  ],
};

test("picks the largest Linux partition, which cloud images keep last", () => {
  const root = rootPartition(ubuntu);
  assert.equal(root.node, "disk.raw1");
  assert.equal(root.start * root.sectorSize, 2099200 * 512);
});

test("refuses a root partition that cannot grow into the new space", () => {
  const swapped = {
    ...ubuntu,
    partitions: [
      { node: "disk.raw1", start: 2048, size: 4000000, type: linux },
      { node: "disk.raw2", start: 4002048, size: 1000, type: linux },
    ],
  };
  assert.throws(() => rootPartition(swapped), /not the last one/);
  assert.throws(
    () => rootPartition({ partitions: [{ node: "x", start: 0, size: 1, type: efi }] }),
    /no Linux partition/,
  );
});
