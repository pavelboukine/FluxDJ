/**
 * Shared by the browser signing panel and the server signing action.
 * The browser exports the drawing at exactly this size (the pad keeps a 3:1
 * aspect ratio); the server accepts a small range around it and re-encodes.
 */
export const SIGNATURE_EXPORT_WIDTH = 900;
export const SIGNATURE_EXPORT_HEIGHT = 300;
export const SIGNATURE_LIMITS = {
  minWidth: 300,
  maxWidth: 1800,
  minHeight: 100,
  maxHeight: 600,
  /** Encoded PNG bytes, before and after re-encoding (the bucket limit). */
  maxBytes: 256 * 1024,
} as const;
/** "data:image/png;base64," plus base64 of maxBytes. */
export const MAX_SIGNATURE_DATA_URL_LENGTH = 22 + Math.ceil(SIGNATURE_LIMITS.maxBytes / 3) * 4;
export const SIGNATURE_BUCKET = "contract-signatures";

export type SignInput = {
  typedName: string;
  consentAccepted: boolean;
  consentVersion: string;
  contentSha256: string;
  /** data:image/png;base64,... */
  signature: string;
};

export type SignResult =
  | { status: "signed"; signedAt: string; typedName: string; replayed: boolean }
  | { status: "error"; code: string; message: string };
