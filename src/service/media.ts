import { extname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { isPlainObject } from "./payload-sanitizer.js";

const MEDIA_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".svg",
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".oga",
  ".flac",
  ".opus",
  ".caf",
  ".weba",
  ".webm",
  ".mp4",
  ".mov",
  ".mkv",
]);

const MEDIA_SCHEME_LOCAL_PATH_RE =
  /\bmedia:((?:~\/|\/)[^\s"'`]+?\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|svg|mp3|wav|m4a|aac|ogg|oga|flac|opus|caf|weba|webm|mp4|mov|mkv))(?=[\s"'`]|$)/gi;

const FILE_SCHEME_LOCAL_PATH_RE =
  /\bfile:\/\/((?:~\/|\/)[^\s"'`]+?\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|svg|mp3|wav|m4a|aac|ogg|oga|flac|opus|caf|weba|webm|mp4|mov|mkv))(?:\?[^\s"'`]*)?(?=[\s"'`]|$)/gi;

const MARKDOWN_LOCAL_MEDIA_PATH_RE =
  /!?\[[^\]]*]\((?:file:\/\/)?((?:~\/|\/)[^)\s]+?\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|svg|mp3|wav|m4a|aac|ogg|oga|flac|opus|caf|weba|webm|mp4|mov|mkv))(?:\?[^)\s]*)?(?:\s+["'][^"']*["'])?\)/gi;

export function normalizeLocalMediaPath(candidate: string): string | undefined {
  const trimmed = candidate.trim().replace(/[),.;:]+$/, "");
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("/") && !trimmed.startsWith("~/")) return undefined;

  const expanded = trimmed.startsWith("~/") ? resolve(homedir(), trimmed.slice(2)) : trimmed;
  const normalized = resolve(expanded);
  if (!isAbsolute(normalized)) return undefined;

  const extension = extname(normalized).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(extension)) return undefined;
  return normalized;
}

function decodeMaybeEncodedPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function addMediaPathCandidate(target: Set<string>, candidate: string): void {
  const normalized = normalizeLocalMediaPath(candidate);
  if (normalized) target.add(normalized);
}

export function collectMediaPathsFromString(value: string, target: Set<string>): void {
  // Accept direct path values in structured payload fields (for example, image.path),
  // but avoid scanning arbitrary prose/log text for incidental absolute paths.
  addMediaPathCandidate(target, value);

  for (const match of value.matchAll(MEDIA_SCHEME_LOCAL_PATH_RE)) {
    addMediaPathCandidate(target, match[1] ?? "");
  }

  // Keep extraction conservative: only parse explicit local file URI references.
  for (const match of value.matchAll(FILE_SCHEME_LOCAL_PATH_RE)) {
    addMediaPathCandidate(target, decodeMaybeEncodedPath(match[1] ?? ""));
  }

  // Support explicit markdown links/images without scanning arbitrary plain text paths.
  for (const match of value.matchAll(MARKDOWN_LOCAL_MEDIA_PATH_RE)) {
    addMediaPathCandidate(target, decodeMaybeEncodedPath(match[1] ?? ""));
  }
}

export function collectMediaPathsFromUnknown(value: unknown, target: Set<string>): void {
  if (typeof value === "string") {
    collectMediaPathsFromString(value, target);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMediaPathsFromUnknown(item, target);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) {
      collectMediaPathsFromUnknown(child, target);
    }
  }
}

export function guessMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    case ".svg":
      return "image/svg+xml";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".ogg":
    case ".oga":
      return "audio/ogg";
    case ".flac":
      return "audio/flac";
    case ".opus":
      return "audio/opus";
    case ".caf":
      return "audio/x-caf";
    case ".weba":
      return "audio/webm";
    case ".webm":
      return "video/webm";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".mkv":
      return "video/x-matroska";
    default:
      return "application/octet-stream";
  }
}

export function resolveEntityId(entity: unknown): string | undefined {
  if (!entity || typeof entity !== "object") return undefined;
  const maybeEntity = entity as { id?: unknown; data?: { id?: unknown } };
  const id = maybeEntity.data?.id ?? maybeEntity.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
