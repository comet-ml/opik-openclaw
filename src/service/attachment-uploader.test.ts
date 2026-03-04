import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Opik } from "opik";
import { LOCAL_ATTACHMENT_UPLOAD_MAGIC_ID } from "./constants.js";
import { createAttachmentUploader } from "./attachment-uploader.js";

type MockAttachmentsApi = {
  startMultiPartUpload: ReturnType<typeof vi.fn>;
  completeMultiPartUpload: ReturnType<typeof vi.fn>;
};

async function createTempMediaFile(ext = ".png"): Promise<{ dir: string; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "opik-attachment-uploader-"));
  const filePath = join(dir, `sample${ext}`);
  await writeFile(filePath, "test-bytes", "utf8");
  return { dir, filePath };
}

function createAttachmentsApi(): MockAttachmentsApi {
  return {
    startMultiPartUpload: vi.fn(async () => ({
      uploadId: LOCAL_ATTACHMENT_UPLOAD_MAGIC_ID,
      preSignUrls: ["https://upload.example.com/file"],
    })),
    completeMultiPartUpload: vi.fn(async () => undefined),
  };
}

describe("attachment uploader", () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200, headers: { etag: "etag-1" } })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("encodes attachment path with URL-safe base64", async () => {
    const { dir, filePath } = await createTempMediaFile();
    tempDirs.push(dir);

    const attachmentsApi = createAttachmentsApi();
    const client = { api: { attachments: attachmentsApi } };
    const baseUrl = "https://foo.bar/opik?a=1";

    const uploader = createAttachmentUploader({
      getClient: () => client as unknown as Opik,
      getAttachmentBaseUrl: () => baseUrl,
      onWarn: () => undefined,
      formatError: (err) => String(err),
    });

    uploader.scheduleMediaAttachmentUploads({
      entityType: "trace",
      entity: { id: "trace-1" },
      projectName: "openclaw",
      reason: "test",
      payloads: [`media:${filePath}`],
    });
    await uploader.waitForUploads();

    const request = attachmentsApi.startMultiPartUpload.mock.calls[0]?.[0] as { path: string };
    expect(request.path).toBe(Buffer.from(baseUrl, "utf8").toString("base64url"));
    expect(request.path.includes("/")).toBe(false);
    expect(request.path.includes("+")).toBe(false);
  });

  test("uses a bounded uploaded-key cache to avoid unbounded growth", async () => {
    const first = await createTempMediaFile();
    const second = await createTempMediaFile();
    const third = await createTempMediaFile();
    tempDirs.push(first.dir, second.dir, third.dir);

    const attachmentsApi = createAttachmentsApi();
    const client = { api: { attachments: attachmentsApi } };

    const uploader = createAttachmentUploader({
      getClient: () => client as unknown as Opik,
      getAttachmentBaseUrl: () => "https://www.comet.com/opik/api",
      onWarn: () => undefined,
      formatError: (err) => String(err),
      uploadedAttachmentCacheMaxKeys: 2,
    });

    for (const filePath of [first.filePath, second.filePath, third.filePath]) {
      uploader.scheduleMediaAttachmentUploads({
        entityType: "trace",
        entity: { id: "trace-1" },
        projectName: "openclaw",
        reason: "test",
        payloads: [`media:${filePath}`],
      });
      await uploader.waitForUploads();
    }
    expect(attachmentsApi.startMultiPartUpload).toHaveBeenCalledTimes(3);

    uploader.scheduleMediaAttachmentUploads({
      entityType: "trace",
      entity: { id: "trace-1" },
      projectName: "openclaw",
      reason: "test",
      payloads: [`media:${first.filePath}`],
    });
    await uploader.waitForUploads();
    expect(attachmentsApi.startMultiPartUpload).toHaveBeenCalledTimes(4);

    uploader.scheduleMediaAttachmentUploads({
      entityType: "trace",
      entity: { id: "trace-1" },
      projectName: "openclaw",
      reason: "test",
      payloads: [`media:${third.filePath}`],
    });
    await uploader.waitForUploads();
    expect(attachmentsApi.startMultiPartUpload).toHaveBeenCalledTimes(4);
  });

  test("does not cache a key when attachments API is unavailable", async () => {
    const { dir, filePath } = await createTempMediaFile();
    tempDirs.push(dir);

    const attachmentsApi = createAttachmentsApi();
    let client: { api?: { attachments?: MockAttachmentsApi } } = { api: {} };

    const uploader = createAttachmentUploader({
      getClient: () => client as unknown as Opik,
      getAttachmentBaseUrl: () => "https://www.comet.com/opik/api",
      onWarn: () => undefined,
      formatError: (err) => String(err),
    });

    uploader.scheduleMediaAttachmentUploads({
      entityType: "trace",
      entity: { id: "trace-1" },
      projectName: "openclaw",
      reason: "no-api",
      payloads: [`media:${filePath}`],
    });
    await uploader.waitForUploads();
    expect(attachmentsApi.startMultiPartUpload).not.toHaveBeenCalled();

    client = { api: { attachments: attachmentsApi } };
    uploader.scheduleMediaAttachmentUploads({
      entityType: "trace",
      entity: { id: "trace-1" },
      projectName: "openclaw",
      reason: "api-ready",
      payloads: [`media:${filePath}`],
    });
    await uploader.waitForUploads();
    expect(attachmentsApi.startMultiPartUpload).toHaveBeenCalledTimes(1);
  });

  test("does not upload incidental media paths embedded in plain text", async () => {
    const { dir, filePath } = await createTempMediaFile();
    tempDirs.push(dir);

    const attachmentsApi = createAttachmentsApi();
    const client = { api: { attachments: attachmentsApi } };

    const uploader = createAttachmentUploader({
      getClient: () => client as unknown as Opik,
      getAttachmentBaseUrl: () => "https://www.comet.com/opik/api",
      onWarn: () => undefined,
      formatError: (err) => String(err),
    });

    uploader.scheduleMediaAttachmentUploads({
      entityType: "trace",
      entity: { id: "trace-1" },
      projectName: "openclaw",
      reason: "plain-text-path",
      payloads: [`debug dump: unexpected path ${filePath} from prior run`],
    });
    await uploader.waitForUploads();

    expect(attachmentsApi.startMultiPartUpload).not.toHaveBeenCalled();
  });

  test("uploads direct path values without requiring media: prefix", async () => {
    const { dir, filePath } = await createTempMediaFile();
    tempDirs.push(dir);

    const attachmentsApi = createAttachmentsApi();
    const client = { api: { attachments: attachmentsApi } };

    const uploader = createAttachmentUploader({
      getClient: () => client as unknown as Opik,
      getAttachmentBaseUrl: () => "https://www.comet.com/opik/api",
      onWarn: () => undefined,
      formatError: (err) => String(err),
    });

    uploader.scheduleMediaAttachmentUploads({
      entityType: "trace",
      entity: { id: "trace-1" },
      projectName: "openclaw",
      reason: "direct-path-value",
      payloads: [filePath],
    });
    await uploader.waitForUploads();

    expect(attachmentsApi.startMultiPartUpload).toHaveBeenCalledTimes(1);
  });

  test("skips uploads when attachment uploads are disabled", async () => {
    const { dir, filePath } = await createTempMediaFile();
    tempDirs.push(dir);

    const attachmentsApi = createAttachmentsApi();
    const client = { api: { attachments: attachmentsApi } };

    const uploader = createAttachmentUploader({
      getClient: () => client as unknown as Opik,
      getAttachmentBaseUrl: () => "https://www.comet.com/opik/api",
      onWarn: () => undefined,
      formatError: (err) => String(err),
      attachmentsEnabled: false,
    });

    uploader.scheduleMediaAttachmentUploads({
      entityType: "trace",
      entity: { id: "trace-1" },
      projectName: "openclaw",
      reason: "disabled",
      payloads: [`media:${filePath}`],
    });
    await uploader.waitForUploads();

    expect(attachmentsApi.startMultiPartUpload).not.toHaveBeenCalled();
  });
});
