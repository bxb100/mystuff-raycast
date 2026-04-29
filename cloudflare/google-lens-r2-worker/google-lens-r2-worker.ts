interface Env {
  GOOGLE_LENS_IMAGES: BucketBinding;
  PUBLIC_BASE_URL?: string;
  UPLOAD_TOKEN?: string;
  MAX_UPLOAD_BYTES?: string;
}

type BucketBinding = {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null,
    options?: {
      httpMetadata?: {
        contentType?: string;
        cacheControl?: string;
      };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<StoredObjectBody | null>;
  head(key: string): Promise<StoredObject | null>;
};

type StoredObject = {
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
};

type StoredObjectBody = StoredObject & {
  body: ReadableStream;
};

type UploadResponse = {
  filename?: string;
  url?: string;
  message?: string;
  error?: string;
};

const IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
} as const;

const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const CACHE_CONTROL = "public, max-age=31536000, immutable";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/upload-image") {
      return handleUpload(request, env, url);
    }

    if (url.pathname.startsWith("/image/")) {
      return handleImage(request, env, url);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ message: "Google Lens R2 image endpoint is ready" });
    }

    return json({ error: "Route unavailable" }, 404);
  },
};

async function handleUpload(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "Use POST for uploads" }, 405);
  }

  if (!isAuthorized(request, env)) {
    return json({ error: "Upload authorization failed" }, 401);
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "Expected multipart/form-data with an image field" }, 415);
  }

  const form = await request.formData();
  const image = form.get("image");

  if (!(image instanceof File)) {
    return json({ error: "Field image must contain a file" }, 400);
  }

  const maxBytes = readMaxUploadBytes(env);
  if (image.size <= 0) {
    return json({ error: "Image file is empty" }, 400);
  }

  if (image.size > maxBytes) {
    return json({ error: `Image exceeds ${maxBytes} bytes` }, 413);
  }

  const normalized = await normalizeImage(image);
  if (!normalized) {
    return json({ error: "Supported image types: png, jpeg, jpg, gif, webp" }, 415);
  }

  const filename = `${Date.now()}-${crypto.randomUUID()}.${normalized.extension}`;

  await env.GOOGLE_LENS_IMAGES.put(filename, image.stream(), {
    httpMetadata: {
      contentType: normalized.contentType,
      cacheControl: CACHE_CONTROL,
    },
    customMetadata: {
      uploadedAt: new Date().toISOString(),
      originalName: image.name || "image",
    },
  });

  return json({
    filename,
    url: `${baseUrl(env, url)}/image/${encodeURIComponent(filename)}`,
    message: "uploaded",
  });
}

async function handleImage(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Use GET or HEAD for images" }, 405);
  }

  const filename = decodeURIComponent(url.pathname.slice("/image/".length));
  if (!isSafeFilename(filename)) {
    return json({ error: "Invalid image filename" }, 400);
  }

  if (request.method === "HEAD") {
    const object = await env.GOOGLE_LENS_IMAGES.head(filename);
    if (!object) {
      return json({ error: "Image missing" }, 404);
    }

    return new Response(null, { headers: objectHeaders(object) });
  }

  const object = await env.GOOGLE_LENS_IMAGES.get(filename);
  if (!object) {
    return json({ error: "Image missing" }, 404);
  }

  return new Response(object.body, { headers: objectHeaders(object) });
}

async function normalizeImage(
  file: File,
): Promise<{ extension: keyof typeof IMAGE_TYPES; contentType: string } | null> {
  const extension = extensionFromName(file.name) ?? extensionFromType(file.type);
  if (!extension) {
    return null;
  }

  const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (!matchesImageSignature(extension, signature)) {
    return null;
  }

  return {
    extension: extension === "jpeg" ? "jpg" : extension,
    contentType: IMAGE_TYPES[extension],
  };
}

function extensionFromName(name: string): keyof typeof IMAGE_TYPES | null {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  const extension = match?.[1]?.toLowerCase();
  return isImageExtension(extension) ? extension : null;
}

function extensionFromType(type: string): keyof typeof IMAGE_TYPES | null {
  const normalizedType = type.split(";")[0]?.toLowerCase();
  const entry = Object.entries(IMAGE_TYPES).find(([, value]) => value === normalizedType);
  return (entry?.[0] as keyof typeof IMAGE_TYPES | undefined) ?? null;
}

function isImageExtension(value: string | undefined): value is keyof typeof IMAGE_TYPES {
  return value === "png" || value === "jpg" || value === "jpeg" || value === "gif" || value === "webp";
}

function matchesImageSignature(extension: keyof typeof IMAGE_TYPES, bytes: Uint8Array): boolean {
  if (extension === "png") {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }

  if (extension === "jpg" || extension === "jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  if (extension === "gif") {
    return bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
  }

  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function objectHeaders(object: StoredObject | StoredObjectBody): Headers {
  const headers = new Headers(CORS_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", headers.get("Cache-Control") ?? CACHE_CONTROL);
  return headers;
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.UPLOAD_TOKEN) {
    return true;
  }

  return request.headers.get("Authorization") === `Bearer ${env.UPLOAD_TOKEN}`;
}

function isSafeFilename(filename: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}\.(png|jpe?g|gif|webp)$/.test(filename);
}

function readMaxUploadBytes(env: Env): number {
  const value = Number(env.MAX_UPLOAD_BYTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_UPLOAD_BYTES;
}

function baseUrl(env: Env, url: URL): string {
  return (env.PUBLIC_BASE_URL || `${url.protocol}//${url.host}`).replace(/\/+$/, "");
}

function json(body: UploadResponse, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "no-store",
    },
  });
}
