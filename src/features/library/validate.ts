/**
 * Import validation at a trust boundary. Filename and reported MIME are
 * untrusted text; the byte signature is the only authoritative signal, and all
 * three must agree before a PDF is accepted.
 *
 * Section 5: check extension, reported MIME and format signatures together;
 * bound file size; show actionable errors for unsupported, damaged, encrypted
 * and oversized files.
 */

export const PDF_MAX_BYTES = 100 * 1024 * 1024;
export const PDF_PHONE_TIER_BYTES = 50 * 1024 * 1024;

/** Some hosts report octet-stream or nothing at all for a .pdf. */
const PDF_MIME_ALLOW = new Set(["application/pdf", "application/x-pdf", "application/octet-stream", ""]);

/** Spec permits leading junk before %PDF-, so the header is searched, not read at 0. */
const HEADER_WINDOW = 1024;
/** Trailer encryption markers can sit anywhere; scan a bounded prefix only. */
const ENCRYPT_SCAN_BYTES = 65536;

export type DeviceTier = "desktop" | "phone";

/** Section 5 import lifecycle. Semantic processing has its own state and never blocks this one. */
export type ImportState = "validating" | "opening" | "saving" | "ready" | "temporary" | "failed";

export type ImportErrorCode =
  | "empty"
  | "unsupported-extension"
  | "unsupported-format"
  | "mime-mismatch"
  | "damaged"
  | "encrypted"
  | "oversized";

export type ImportError = { code: ImportErrorCode; message: string; action: string };

/** A non-blocking, still-actionable finding (password prompt, render-only warning). */
export type ImportNotice = { code: ImportErrorCode; message: string; action: string };

export type ImportInput = {
  /** untrusted */
  name: string;
  /** untrusted, may be "" */
  mimeType: string;
  byteSize: number;
  tier: DeviceTier;
  /** first min(byteSize, 1024) bytes */
  head: Uint8Array;
};

export type ImportValidation =
  | {
      ok: true;
      state: ImportState;
      passwordRequired: boolean;
      /** above the device tier: render only, semantic parsing stays off */
      renderOnly: boolean;
      semantic: boolean;
      notices: ImportNotice[];
    }
  | { ok: false; state: "failed"; errors: ImportError[] };

export type SignatureKind = "pdf" | "zip" | "rtf" | "image" | "ole" | "unknown";

const latin1 = (b: Uint8Array, n = b.length): string => {
  let s = "";
  const end = Math.min(n, b.length);
  for (let i = 0; i < end; i++) s += String.fromCharCode(b[i] as number);
  return s;
};

const startsWith = (b: Uint8Array, sig: readonly number[]): boolean =>
  sig.every((v, i) => b[i] === v);

/**
 * Byte-level format detection. Never trusts the filename.
 * ponytail: PDF only. EPUB/TXT/MD signatures belong to Track D's validator.
 */
export function detectSignature(head: Uint8Array): SignatureKind {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // %PDF-
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06]) || startsWith(head, [0x50, 0x4b, 0x07, 0x08]))
    return "zip";
  if (latin1(head, 5) === "{\\rtf") return "rtf";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47]) || startsWith(head, [0xff, 0xd8, 0xff])) return "image";
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0])) return "ole";
  if (latin1(head, HEADER_WINDOW).includes("%PDF-")) return "pdf";
  return "unknown";
}

export const hasPdfExtension = (name: string): boolean => /\.pdf$/i.test(name.trim());

export const isAllowedPdfMime = (mime: string): boolean => PDF_MIME_ALLOW.has(mime.trim().toLowerCase());

/**
 * `/Encrypt` in the trailer is the only cheap pre-adapter hint available without
 * parsing. The adapter remains authoritative; this never denies a valid file.
 */
export const looksEncrypted = (head: Uint8Array): boolean => latin1(head, ENCRYPT_SCAN_BYTES).includes("/Encrypt");

const fail = (errors: ImportError[]): ImportValidation => ({ ok: false, state: "failed", errors });

export function validatePdfImport(input: ImportInput): ImportValidation {
  const notices: ImportNotice[] = [];
  const limit = input.tier === "phone" ? PDF_PHONE_TIER_BYTES : PDF_MAX_BYTES;

  if (input.byteSize === 0)
    return fail([
      { code: "empty", message: "This file is empty (0 bytes).", action: "Choose the file again; the copy on disk may be truncated." },
    ]);

  if (input.byteSize > PDF_MAX_BYTES)
    return fail([
      {
        code: "oversized",
        message: `This PDF is ${(input.byteSize / 1024 / 1024).toFixed(1)} MiB; the supported limit is 100 MiB.`,
        action: "Split the PDF, or compress it below 100 MiB, then import it again.",
      },
    ]);

  switch (detectSignature(input.head)) {
    case "pdf":
      break;
    case "zip":
      return fail([
        {
          code: "unsupported-format",
          message: "This is a ZIP archive (EPUB or DOCX), not a PDF.",
          action: "EPUB files open from the library directly. Convert DOCX to PDF first.",
        },
      ]);
    case "rtf":
      return fail([
        { code: "unsupported-format", message: "This is an RTF file, not a PDF.", action: "Export it as PDF, then import that." },
      ]);
    case "image":
      return fail([
        {
          code: "unsupported-format",
          message: "This is an image file, not a PDF.",
          action: "Scanned images are not converted automatically; OCR is not available in this release.",
        },
      ]);
    case "ole":
      return fail([
        { code: "unsupported-format", message: "This is a legacy Office document, not a PDF.", action: "Save it as PDF, then import that." },
      ]);
    case "unknown":
      return fail([
        {
          code: "damaged",
          message: "This file has no readable PDF header, so it is damaged or incomplete.",
          action: "Re-download or re-export the file and try again.",
        },
      ]);
  }

  if (!hasPdfExtension(input.name))
    return fail([
      {
        code: "unsupported-extension",
        message: `The file name does not end in .pdf ("${input.name}").`,
        action: "Rename it to end in .pdf, or re-export it with a .pdf name.",
      },
    ]);

  if (!isAllowedPdfMime(input.mimeType))
    return fail([
      {
        code: "mime-mismatch",
        message: `The system reports this file as "${input.mimeType}", not a PDF type.`,
        action: "Re-export the file as PDF; a renamed non-PDF is rejected on purpose.",
      },
    ]);

  const passwordRequired = looksEncrypted(input.head);
  const aboveTier = input.byteSize > limit;
  if (aboveTier)
    notices.push({
      code: "oversized",
      message: `This PDF is ${(input.byteSize / 1024 / 1024).toFixed(1)} MiB, above the ${input.tier} tier of ${(limit / 1024 / 1024).toFixed(0)} MiB.`,
      action: "It opens in render-only mode; text extraction stays off until the file is smaller.",
    });
  if (passwordRequired)
    notices.push({
      code: "encrypted",
      message: "This PDF is password protected.",
      action: "Enter its password when asked. The password is kept in memory for this session only.",
    });

  return {
    ok: true,
    state: "validating",
    passwordRequired,
    renderOnly: aboveTier,
    semantic: !aboveTier,
    notices,
  };
}
