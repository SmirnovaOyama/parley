// Files added to the message being written. Each one uploads as soon as it's added, so sending is
// instant; the message carries their ids. Big photos are scaled down in the browser first.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, uploadFile, type Attachment } from "./api.ts";
import { t } from "./i18n.ts";

/** Files on one message, and the largest file the server takes (it says so too). */
export const MAX_FILES = 10;
const MAX_BYTES = 30 * 1024 * 1024;

/** Claude sees images up to this long edge and takes up to 5 MB, so larger photos are scaled down. */
const MAX_EDGE = 2576;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const RASTER = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type PendingFile = {
  key: string;
  name: string;
  size: number;
  /** A local preview while it's an image the browser can show. */
  preview: string | null;
  /** How much has uploaded, 0 to 1. */
  progress: number;
  /** Set once it's uploaded. */
  attachment: Attachment | null;
  /** Why it couldn't be added. */
  error: string | null;
};

const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * A photo too big for Claude (or in a format it doesn't read, like HEIC where the browser can
 * open it) comes back scaled to fit and re-encoded: PNG stays PNG when that fits, else JPEG.
 * Anything else, and animated GIFs, go as they are; the server has the last word.
 */
async function prepare(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml" || file.type === "image/gif") return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_IMAGE_BYTES && RASTER.has(file.type)) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const base = file.name.replace(/\.[^.]*$/, "") || "image";
  if (file.type === "image/png") {
    const png = await canvasBlob(canvas, "image/png");
    if (png && png.size <= MAX_IMAGE_BYTES) return new File([png], `${base}.png`, { type: "image/png" });
  }
  // JPEG has no transparency: paint it on white rather than black.
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const jpeg = await canvasBlob(canvas, "image/jpeg", 0.9);
  return jpeg ? new File([jpeg], `${base}.jpg`, { type: "image/jpeg" }) : file;
}

/** The files on the message being written, and what to do with them. */
export function useUploads() {
  const [files, setFiles] = useState<PendingFile[]>([]);
  /** Shown when more files were dropped than a message takes. */
  const [notice, setNotice] = useState<string | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  const aborts = useRef(new Map<string, () => void>());

  const patch = useCallback((key: string, fn: (f: PendingFile) => PendingFile) => {
    setFiles((list) => list.map((f) => (f.key === key ? fn(f) : f)));
  }, []);

  const upload = useCallback(
    async (key: string, file: File) => {
      try {
        const ready = await prepare(file);
        if (!filesRef.current.some((f) => f.key === key)) return;
        if (ready.size > MAX_BYTES) throw new Error(t("Files can be up to {MAX_BYTES} MB", { MAX_BYTES: MAX_BYTES / (1024 * 1024) }));
        const job = uploadFile(ready, ready.name, (progress) => patch(key, (f) => ({ ...f, progress })));
        aborts.current.set(key, job.abort);
        const attachment = await job.promise;
        // Removed while it was on its way: let it go.
        if (!filesRef.current.some((f) => f.key === key)) {
          void api.del(`/uploads/${attachment.id}`).catch(() => {});
          return;
        }
        patch(key, (f) => ({ ...f, name: attachment.name, size: attachment.size, progress: 1, attachment }));
      } catch (err) {
        patch(key, (f) => ({ ...f, error: (err as Error).message }));
      } finally {
        aborts.current.delete(key);
      }
    },
    [patch],
  );

  const add = useCallback(
    (incoming: File[]) => {
      if (!incoming.length) return;
      const room = MAX_FILES - filesRef.current.length;
      const taken = incoming.slice(0, Math.max(0, room));
      setNotice(taken.length < incoming.length ? t("A message can carry up to {MAX_FILES} files", { MAX_FILES }) : null);
      const entries = taken.map((file) => ({
        key: crypto.randomUUID(),
        name: file.name || "file",
        size: file.size,
        preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
        progress: 0,
        attachment: null,
        error: null,
      }));
      filesRef.current = [...filesRef.current, ...entries];
      setFiles(filesRef.current);
      entries.forEach((entry, i) => void upload(entry.key, taken[i]));
    },
    [upload],
  );

  const remove = useCallback((key: string) => {
    const file = filesRef.current.find((f) => f.key === key);
    if (!file) return;
    aborts.current.get(key)?.();
    if (file.attachment) void api.del(`/uploads/${file.attachment.id}`).catch(() => {});
    if (file.preview) URL.revokeObjectURL(file.preview);
    filesRef.current = filesRef.current.filter((f) => f.key !== key);
    setFiles(filesRef.current);
    setNotice(null);
  }, []);

  /** Hands the uploaded files to a message being sent and empties the list (restore puts them back). */
  const take = useCallback(() => {
    const taken = filesRef.current;
    filesRef.current = [];
    setFiles([]);
    setNotice(null);
    return taken;
  }, []);

  const restore = useCallback((taken: PendingFile[]) => {
    filesRef.current = [...taken, ...filesRef.current].slice(0, MAX_FILES);
    setFiles(filesRef.current);
  }, []);

  /** The message went: its previews aren't needed any more. */
  const release = useCallback((taken: PendingFile[]) => {
    for (const f of taken) if (f.preview) URL.revokeObjectURL(f.preview);
  }, []);

  useEffect(
    () => () => {
      for (const abort of aborts.current.values()) abort();
      for (const f of filesRef.current) if (f.preview) URL.revokeObjectURL(f.preview);
    },
    [],
  );

  const uploading = files.some((f) => !f.attachment && !f.error);
  const ready = files.flatMap((f) => (f.attachment ? [f.attachment] : []));
  const failed = files.find((f) => f.error);
  const problem = failed ? t("{name} couldn't be added. {error}", { name: failed.name, error: failed.error ?? "" }) : notice;

  return { files, ready, uploading, problem, add, remove, take, restore, release };
}
