import assert from "node:assert/strict";
import { test } from "node:test";
import { unzipSync } from "fflate";
import { createDownloadArchive } from "../lib/download-archive";

test("ZIP preserves bytes, handles duplicate basenames, and strips unsafe paths", async () => {
  const files = [
    { name: "../folder/photo.txt", data: new Uint8Array([0, 1, 127, 255]) },
    { name: "other\\photo.txt", data: new Uint8Array([42]) },
    { name: "photo (2).txt", data: new Uint8Array([43]) },
    { name: "empty.txt", data: new Uint8Array() },
    { name: "..", data: new Uint8Array([44]) },
    { name: "note\0.txt", data: new Uint8Array([45]) },
    { name: "résumé.txt", data: new Uint8Array([46]) },
  ];
  const urls = files.map((file) => URL.createObjectURL(new Blob([file.data])));
  try {
    const archive = await createDownloadArchive(
      files.map((file, index) => ({ name: file.name, url: urls[index] })),
    );
    const extracted = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    assert.deepEqual(Object.keys(extracted), [
      "photo.txt",
      "photo (2).txt",
      "photo (2) (2).txt",
      "empty.txt",
      "file",
      "note.txt",
      "résumé.txt",
    ]);
    Object.values(extracted).forEach((data, index) =>
      assert.deepEqual(data, files[index].data),
    );
  } finally {
    urls.forEach((url) => URL.revokeObjectURL(url));
  }
});

test("ZIP fails explicitly for empty selections and unavailable downloads", async () => {
  await assert.rejects(createDownloadArchive([]), /No received files/);
  const url = URL.createObjectURL(new Blob(["missing"]));
  URL.revokeObjectURL(url);
  await assert.rejects(createDownloadArchive([{ name: "missing.txt", url }]));
});
