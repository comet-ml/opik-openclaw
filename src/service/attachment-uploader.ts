import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Opik } from "opik";
import {
  ATTACHMENT_UPLOADS_ENABLED,
  ATTACHMENT_UPLOAD_PART_SIZE_BYTES,
  DEFAULT_UPLOADED_ATTACHMENT_CACHE_MAX_KEYS,
  LOCAL_ATTACHMENT_UPLOAD_MAGIC_ID,
} from "./constants.js";
import { collectMediaPathsFromUnknown, guessMimeType, resolveEntityId } from "./media.js";

type AttachmentsApi = {
  startMultiPartUpload: (request: {
    fileName: string;
    numOfFileParts: number;
    mimeType?: string;
    projectName?: string;
    entityType: "trace" | "span";
    entityId: string;
    path: string;
  }) => Promise<{ uploadId: string; preSignUrls: string[] }>;
  completeMultiPartUpload: (request: {
    fileName: string;
    projectName?: string;
    entityType: "trace" | "span";
    entityId: string;
    fileSize: number;
    mimeType?: string;
    uploadId: string;
    uploadedFileParts: Array<{ eTag: string; partNumber: number }>;
  }) => Promise<void>;
};

type OpikWithAttachmentsApi = Opik & {
  api?: {
    attachments?: AttachmentsApi;
  };
};

type AttachmentUploaderDeps = {
  getClient: () => Opik | null;
  getAttachmentBaseUrl: () => string;
  onWarn: (message: string) => void;
  formatError: (err: unknown) => string;
  uploadedAttachmentCacheMaxKeys?: number;
  attachmentsEnabled?: boolean;
};

export type ScheduledMediaUpload = {
  entityType: "trace" | "span";
  entity: unknown;
  projectName: string;
  reason: string;
  payloads: unknown[];
};

export function createAttachmentUploader(deps: AttachmentUploaderDeps) {
  let attachmentQueue: Promise<void> = Promise.resolve();
  const attachmentsEnabled = deps.attachmentsEnabled ?? ATTACHMENT_UPLOADS_ENABLED;
  const inFlightAttachmentKeys = new Set<string>();
  const uploadedAttachmentKeys = new Map<string, number>();
  const uploadedAttachmentCacheMaxKeys = Math.max(
    1,
    Math.floor(deps.uploadedAttachmentCacheMaxKeys ?? DEFAULT_UPLOADED_ATTACHMENT_CACHE_MAX_KEYS),
  );

  function markUploadedAttachmentKey(key: string): void {
    uploadedAttachmentKeys.delete(key);
    uploadedAttachmentKeys.set(key, Date.now());

    while (uploadedAttachmentKeys.size > uploadedAttachmentCacheMaxKeys) {
      const oldestKey = uploadedAttachmentKeys.keys().next().value as string | undefined;
      if (!oldestKey) break;
      uploadedAttachmentKeys.delete(oldestKey);
    }
  }

  function scheduleAttachmentUpload(job: () => Promise<void>): void {
    attachmentQueue = attachmentQueue.then(job).catch((err: unknown) => {
      deps.onWarn(`opik: attachment upload task failed: ${deps.formatError(err)}`);
    });
  }

  async function uploadFileAttachment(params: {
    entityType: "trace" | "span";
    entityId: string;
    projectName: string;
    filePath: string;
    reason: string;
  }): Promise<void> {
    if (!attachmentsEnabled) return;
    const baseClient = deps.getClient();
    if (!baseClient) return;

    const existingKey = `${params.entityType}:${params.entityId}:${params.filePath}`;
    if (uploadedAttachmentKeys.has(existingKey) || inFlightAttachmentKeys.has(existingKey)) return;

    const client = baseClient as OpikWithAttachmentsApi;
    const attachmentsApi = client.api?.attachments;
    if (!attachmentsApi) return;
    inFlightAttachmentKeys.add(existingKey);

    try {
      const stats = await stat(params.filePath);
      if (!stats.isFile() || stats.size <= 0) return;

      const bytes = await readFile(params.filePath);
      const totalSize = bytes.byteLength;
      const mimeType = guessMimeType(params.filePath);
      const fileName = basename(params.filePath) || "attachment.bin";
      const partCount = Math.max(1, Math.ceil(totalSize / ATTACHMENT_UPLOAD_PART_SIZE_BYTES));
      const pathBase64 = Buffer.from(deps.getAttachmentBaseUrl(), "utf8").toString("base64url");

      const started = await attachmentsApi.startMultiPartUpload({
        fileName,
        numOfFileParts: partCount,
        mimeType,
        projectName: params.projectName,
        entityType: params.entityType,
        entityId: params.entityId,
        path: pathBase64,
      });

      const urls = started.preSignUrls ?? [];
      if (urls.length === 0) return;

      if (started.uploadId === LOCAL_ATTACHMENT_UPLOAD_MAGIC_ID) {
        const localResponse = await fetch(urls[0], {
          method: "PUT",
          body: bytes,
        });
        if (!localResponse.ok) {
          throw new Error(`local attachment upload failed status=${localResponse.status}`);
        }
        markUploadedAttachmentKey(existingKey);
        return;
      }

      if (urls.length < partCount) {
        throw new Error(
          `insufficient pre-signed URLs (got ${urls.length}, expected ${partCount})`,
        );
      }

      const uploadedParts: Array<{ eTag: string; partNumber: number }> = [];
      for (let partNumber = 1; partNumber <= partCount; partNumber++) {
        const start = (partNumber - 1) * ATTACHMENT_UPLOAD_PART_SIZE_BYTES;
        const end = Math.min(start + ATTACHMENT_UPLOAD_PART_SIZE_BYTES, totalSize);
        const chunk = bytes.subarray(start, end);
        const url = urls[partNumber - 1];

        const partResponse = await fetch(url, {
          method: "PUT",
          body: chunk,
        });
        if (!partResponse.ok) {
          throw new Error(
            `attachment part upload failed status=${partResponse.status} part=${partNumber}/${partCount}`,
          );
        }

        const eTag = partResponse.headers.get("etag") ??
          partResponse.headers.get("ETag") ??
          "";
        uploadedParts.push({ eTag, partNumber });
      }

      await attachmentsApi.completeMultiPartUpload({
        fileName,
        projectName: params.projectName,
        entityType: params.entityType,
        entityId: params.entityId,
        fileSize: totalSize,
        mimeType,
        uploadId: started.uploadId,
        uploadedFileParts: uploadedParts,
      });
      markUploadedAttachmentKey(existingKey);
    } catch (err) {
      deps.onWarn(
        `opik: attachment upload failed (${params.reason}, entity=${params.entityType}:${params.entityId}, path=${params.filePath}): ${deps.formatError(err)}`,
      );
    } finally {
      inFlightAttachmentKeys.delete(existingKey);
    }
  }

  function scheduleMediaAttachmentUploads(params: ScheduledMediaUpload): void {
    if (!attachmentsEnabled) return;
    const entityId = resolveEntityId(params.entity);
    if (!entityId) return;

    const mediaPaths = new Set<string>();
    for (const payload of params.payloads) {
      collectMediaPathsFromUnknown(payload, mediaPaths);
    }
    if (mediaPaths.size === 0) return;

    for (const filePath of mediaPaths) {
      scheduleAttachmentUpload(() =>
        uploadFileAttachment({
          entityType: params.entityType,
          entityId,
          projectName: params.projectName,
          filePath,
          reason: params.reason,
        })
      );
    }
  }

  async function waitForUploads(): Promise<void> {
    await attachmentQueue.catch(() => undefined);
  }

  function reset(): void {
    inFlightAttachmentKeys.clear();
    uploadedAttachmentKeys.clear();
  }

  return {
    scheduleMediaAttachmentUploads,
    waitForUploads,
    reset,
  };
}
