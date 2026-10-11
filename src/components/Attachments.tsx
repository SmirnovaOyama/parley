// Files on a message: tiles in the message box while it's being written, and under your message
// once it's sent. Images show as pictures; everything else as a card with its name and size.
import { Icon } from "../icons/Icon.tsx";
import type { Attachment } from "../lib/api.ts";
import { fileSize } from "../lib/format.ts";
import { t } from "../lib/i18n.ts";
import type { PendingFile } from "../lib/uploads.ts";

/** Raster images the browser shows inline (what the server serves inline too). */
const SHOWN = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type Tile = {
  key: string;
  name: string;
  size: number;
  image: string | null;
  /** 0 to 1 while uploading; null once it's there. */
  progress: number | null;
  error: string | null;
};

/**
 * Tiles in a row: a picture, or a file mark with the name and size. Each has a small cross to
 * take it off; while it uploads, a line runs along its foot.
 */
function TileRow({ tiles, onRemove, label }: { tiles: Tile[]; onRemove: (key: string) => void; label: string }) {
  return (
    <ul className="attach-tiles" aria-label={label}>
      {tiles.map((tile) => (
        <li key={tile.key} className={`attach-tile${tile.image && !tile.error ? " is-image" : ""}${tile.error ? " is-failed" : ""}${tile.progress != null ? " is-loading" : ""}`}>
          {tile.image && !tile.error ? (
            <img src={tile.image} alt={tile.name} />
          ) : (
            <>
              <span className="attach-tile-icon" aria-hidden="true">
                <Icon name={tile.error ? "alert" : "file"} size={20} />
              </span>
              <span className="attach-tile-text">
                <span className="attach-tile-name">{tile.name}</span>
                <span className="attach-tile-size">{tile.error ? t("Couldn't add") : tile.progress != null ? t("Adding") : fileSize(tile.size)}</span>
              </span>
            </>
          )}
          {tile.progress != null && (
            <span className="attach-tile-progress" role="progressbar" aria-label={t("Adding {name}", { name: tile.name })} aria-valuenow={Math.round(tile.progress * 100)}>
              <span style={{ width: `${Math.max(4, tile.progress * 100)}%` }} />
            </span>
          )}
          <button type="button" className="attach-tile-remove" onClick={() => onRemove(tile.key)} aria-label={t("Remove {name}", { name: tile.name })}>
            <Icon name="close" size={12} strokeWidth={2.2} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The files on the message being written. */
export function ComposerFiles({ files, onRemove }: { files: PendingFile[]; onRemove: (key: string) => void }) {
  if (!files.length) return null;
  const tiles = files.map((f) => ({
    key: f.key,
    name: f.name,
    size: f.size,
    image: f.preview,
    progress: f.attachment || f.error ? null : f.progress,
    error: f.error,
  }));
  return <TileRow tiles={tiles} onRemove={onRemove} label={t("Files on this message")} />;
}

/** The files kept when editing a message; the cross leaves one out of the new version. */
export function EditFiles({ files, url, onRemove }: { files: Attachment[]; url: (id: string) => string; onRemove: (id: string) => void }) {
  if (!files.length) return null;
  const tiles = files.map((f) => ({
    key: f.id,
    name: f.name,
    size: f.size,
    image: SHOWN.has(f.mime) ? `${url(f.id)}?inline=1` : null,
    progress: null,
    error: null,
  }));
  return <TileRow tiles={tiles} onRemove={onRemove} label={t("Files on this message")} />;
}

/**
 * The files on a sent message, above its words: pictures open full size in a new tab, other files
 * download. One picture shows large; several show as a row of squares.
 */
export function MessageFiles({ files, url }: { files: Attachment[]; url: (id: string) => string }) {
  const images = files.filter((f) => SHOWN.has(f.mime));
  const others = files.filter((f) => !SHOWN.has(f.mime));
  return (
    <div className="msg-files">
      {images.length > 0 && (
        <ul className={`msg-images${images.length === 1 ? " is-single" : ""}`}>
          {images.map((f) => (
            <li key={f.id}>
              <a href={`${url(f.id)}?inline=1`} target="_blank" rel="noopener noreferrer" aria-label={t("Open {name}", { name: f.name })}>
                <img src={`${url(f.id)}?inline=1`} alt={f.name} loading="lazy" />
              </a>
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <ul className="file-cards msg-file-cards">
          {others.map((f) => (
            <li key={f.id}>
              <a className="file-card" href={url(f.id)} download={f.name}>
                <span className="file-card-icon" aria-hidden="true">
                  <Icon name="file" size={22} />
                </span>
                <span className="file-card-text">
                  <span className="file-card-name">{f.name}</span>
                  <span className="file-card-size">{fileSize(f.size)}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
