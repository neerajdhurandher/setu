import { Zip, ZipPassThrough } from "fflate";

export async function createDownloadArchive(
  files: { name: string; url: string }[],
): Promise<Blob> {
  if (!files.length) throw new Error("No received files are available.");
  const chunks: ArrayBuffer[] = [];
  const names = new Set<string>();
  let archiveError: Error | null = null;
  const zip = new Zip((error, data) => {
    if (error) archiveError = error;
    else chunks.push(data.slice().buffer);
  });

  try {
    for (const file of files) {
      const base =
        Array.from(file.name.split(/[\\/]/).pop() || "")
          .filter(
            (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
          )
          .join("") || "file";
      const safe = base === "." || base === ".." ? "file" : base;
      const dot = safe.lastIndexOf(".");
      const stem = dot > 0 ? safe.slice(0, dot) : safe;
      const extension = dot > 0 ? safe.slice(dot) : "";
      let name = safe;
      for (let suffix = 2; names.has(name); suffix++)
        name = `${stem} (${suffix})${extension}`;
      names.add(name);

      const response = await fetch(file.url);
      if (!response.ok || !response.body)
        throw new Error(`Could not read ${file.name}. Download unavailable.`);
      const entry = new ZipPassThrough(name);
      zip.add(entry);
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          entry.push(value);
          if (archiveError) throw archiveError;
        }
        entry.push(new Uint8Array(), true);
      } finally {
        reader.releaseLock();
      }
      if (archiveError) throw archiveError;
    }
    zip.end();
    if (archiveError) throw archiveError;
    return new Blob(chunks, { type: "application/zip" });
  } catch (error) {
    zip.terminate();
    throw error;
  }
}
