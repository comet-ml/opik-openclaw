const MEDIA_IMAGE_REFERENCE_RE =
  /\bmedia:(?:https?:\/\/[^\s"'`]+|\.[/][^\s"'`]+|[/][^\s"'`]+|[^\s"'`]+)\.(?:jpe?g|png|webp|gif)(?=[\s"'`]|$)/gi;

export function sanitizeStringForOpik(value: string): string {
  const normalizedNewlines = value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r");
  return normalizedNewlines.replace(MEDIA_IMAGE_REFERENCE_RE, "media:<image-ref>");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function sanitizeValueForOpik(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeStringForOpik(value);
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const sanitized = sanitizeValueForOpik(item);
      if (sanitized !== item) changed = true;
      return sanitized;
    });
    return changed ? next : value;
  }

  if (isPlainObject(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const sanitized = sanitizeValueForOpik(child);
      next[key] = sanitized;
      if (sanitized !== child) changed = true;
    }
    return changed ? next : value;
  }

  return value;
}
