// Reads the files in a zip archive: a Word document's text (knowledge bases) and the
// conversations.json inside a ChatGPT or Claude export (importing chats). Stored and deflated
// entries only, which is all those archives use; no encryption, no zip64.
import { inflateRawSync } from "node:zlib";

/**
 * A file in the archive: its name, its size unpacked as the archive states it, and its bytes. A
 * crafted archive can claim any size, so read() takes the most it will unpack and never goes past
 * the stated size either: a few megabytes can't unpack into gigabytes.
 */
export type ZipEntry = { name: string; size: number; read: (maxBytes: number) => Buffer };

/** The archive's entries, or null when the bytes aren't a zip this can read. */
export function readZip(bytes: Buffer): ZipEntry[] | null {
  // The end-of-central-directory record sits in the last 22 bytes plus up to 64 KB of comment.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) return null;
    const method = bytes.readUInt16LE(at + 10);
    const compressed = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    entries.push({
      name,
      size,
      read: (maxBytes) => {
        if (size > maxBytes) throw new Error(`${name} is too big to open`);
        if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name} is damaged`);
        const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
        const data = bytes.subarray(start, start + compressed);
        if (method === 0) return Buffer.from(data);
        if (method === 8) {
          try {
            return inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
          } catch {
            throw new Error(`${name} is damaged`);
          }
        }
        throw new Error(`${name} is packed in a way this can't open`);
      },
    });
  }
  return entries;
}

export const isZip = (bytes: Buffer) => bytes.length > 4 && bytes.readUInt32LE(0) === 0x04034b50;
