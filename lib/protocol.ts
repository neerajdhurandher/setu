import { z } from "zod";

export const MAX_FILE_SIZE = 1024 ** 3;
export const CHUNK_SIZE = 64 * 1024;
export const RETENTION_MS = 24 * 60 * 60 * 1000;

export const identitySchema = z.object({
  sessionId: z.uuid(),
  name: z.string().trim().min(1).max(40),
  platform: z.enum(["desktop", "mobile", "tablet"]),
  os: z.string().max(30),
  pin: z
    .string()
    .regex(/^(?:[0-9]{4,8})?$/)
    .default(""),
});

export const offerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    recipientId: z.string().min(1).max(100),
    name: z.string().min(1).max(255),
    size: z.number().int().min(0).max(MAX_FILE_SIZE),
    mime: z.string().max(120),
  }),
  z.object({
    kind: z.enum(["text", "link", "clipboard"]),
    recipientId: z.string().min(1).max(100),
    content: z
      .string()
      .trim()
      .min(1)
      .max(64 * 1024),
  }),
]);

export type Platform = z.infer<typeof identitySchema>["platform"];
export type ShareKind = z.infer<typeof offerSchema>["kind"];
export type TransferStatus =
  | "pending"
  | "transferring"
  | "paused"
  | "completed"
  | "rejected"
  | "cancelled"
  | "failed";

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  os: string;
}

export interface Transfer {
  id: string;
  senderId: string;
  recipientId: string;
  senderName: string;
  recipientName: string;
  kind: ShareKind;
  name: string;
  size: number;
  mime: string;
  content?: string;
  offset: number;
  status: TransferStatus;
  createdAt: number;
}

export interface Activity extends Transfer {
  direction: "sent" | "received";
}

export interface Welcome {
  selfId: string;
  devices: Device[];
  history: Activity[];
  addresses: string[];
}

export type Reply<T = object> =
  ({ ok: true } & T) | { ok: false; error: string };

export function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** unit).toFixed(unit > 0 ? 1 : 0)} ${["B", "KB", "MB", "GB"][unit]}`;
}

export function isSafeLink(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
