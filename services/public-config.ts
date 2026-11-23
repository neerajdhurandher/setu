import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

export type PublicConfig = {
  mode: "public";
  origin: string;
  host: string;
  sessionSecret: string;
  trustedProxyCidrs: string[];
  iceServers: { urls: string | string[] }[];
  sessionTtlMs: number;
  maxSocketBytes: number;
};
export type DeploymentConfig = { mode: "lan" } | PublicConfig;

function normalizeIP(value: string) {
  if (value.startsWith("::ffff:") && isIP(value.slice(7)) === 4)
    return value.slice(7);
  return value;
}

function ipNumber(raw: string): { bits: number; value: bigint } | undefined {
  const ip = normalizeIP(raw);
  const family = isIP(ip);
  if (family === 4)
    return {
      bits: 32,
      value: ip
        .split(".")
        .reduce((n, part) => n * BigInt(256) + BigInt(part), BigInt(0)),
    };
  if (family !== 6 || ip.includes("%")) return;
  let expanded = ip;
  if (expanded.includes(".")) {
    const end = expanded.lastIndexOf(":");
    const v4 = ipNumber(expanded.slice(end + 1))!;
    expanded = `${expanded.slice(0, end)}:${(v4.value >> BigInt(16)).toString(16)}:${(v4.value & BigInt(65535)).toString(16)}`;
  }
  const halves = expanded.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const parts =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
      : left;
  return {
    bits: 128,
    value: parts.reduce(
      (n, part) => (n << BigInt(16)) + BigInt(`0x${part}`),
      BigInt(0),
    ),
  };
}

function parseCidr(cidr: string) {
  const [address, prefix, ...extra] = cidr.split("/");
  const ip = ipNumber(address);
  const bits = prefix === undefined ? ip?.bits : Number(prefix);
  if (
    !ip ||
    extra.length ||
    (prefix !== undefined && !/^\d+$/.test(prefix)) ||
    bits === undefined ||
    !Number.isInteger(bits) ||
    bits < 1 ||
    bits > ip.bits
  )
    throw new Error(
      "SETU_TRUSTED_PROXY_CIDRS must contain exact IPs or valid nonzero CIDRs.",
    );
  return { ...ip, shift: BigInt(ip.bits - bits) };
}

export function isTrustedProxy(address: string, cidrs: string[]) {
  const ip = ipNumber(address);
  if (!ip) return false;
  return cidrs.some((cidr) => {
    const network = parseCidr(cidr);
    return (
      ip.bits === network.bits &&
      ip.value >> network.shift === network.value >> network.shift
    );
  });
}

function boundedInteger(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  max: number,
) {
  const raw = env[key];
  const value = raw === undefined ? fallback : Number(raw);
  if (
    (raw !== undefined && !/^\d+$/.test(raw)) ||
    !Number.isSafeInteger(value) ||
    value < 1000 ||
    value > max
  )
    throw new Error(`${key} is outside its allowed bounds.`);
  return value;
}

export function loadDeploymentConfig(
  env: Record<string, string | undefined> = process.env,
): DeploymentConfig {
  const mode = env.SETU_MODE ?? "lan";
  if (mode === "lan") return { mode };
  if (mode !== "public") throw new Error("SETU_MODE must be lan or public.");
  let url: URL;
  try {
    url = new URL(env.SETU_PUBLIC_URL ?? "");
  } catch {
    throw new Error(
      "Public mode requires SETU_PUBLIC_URL as an HTTPS canonical origin.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    env.SETU_PUBLIC_URL !== url.origin
  )
    throw new Error(
      "SETU_PUBLIC_URL must be an HTTPS canonical origin without a path.",
    );
  const sessionSecret = env.SETU_SESSION_SECRET ?? "";
  if (
    sessionSecret.length < 32 ||
    sessionSecret.length > 1024 ||
    /\s/.test(sessionSecret) ||
    new Set(sessionSecret).size < 8
  )
    throw new Error(
      "SETU_SESSION_SECRET must contain at least 32 random non-whitespace characters.",
    );
  const trustedProxyCidrs = (env.SETU_TRUSTED_PROXY_CIDRS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!trustedProxyCidrs.length || trustedProxyCidrs.length > 32)
    throw new Error("Public mode requires SETU_TRUSTED_PROXY_CIDRS.");
  trustedProxyCidrs.forEach(parseCidr);
  const urls = (env.SETU_STUN_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    urls.length > 8 ||
    urls.some(
      (s) =>
        s.length > 256 ||
        !/^stuns?:[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/.test(s) ||
        (s.match(/:(\d+)$/) &&
          (Number(s.match(/:(\d+)$/)![1]) < 1 ||
            Number(s.match(/:(\d+)$/)![1]) > 65535)),
    )
  )
    throw new Error(
      "SETU_STUN_URLS must contain only STUN server URLs without credentials.",
    );
  return {
    mode,
    origin: url.origin,
    host: url.host,
    sessionSecret,
    trustedProxyCidrs,
    iceServers: urls.length ? [{ urls }] : [],
    sessionTtlMs: boundedInteger(
      env,
      "SETU_SESSION_TTL_MS",
      24 * 60 * 60 * 1000,
      24 * 60 * 60 * 1000,
    ),
    maxSocketBytes: boundedInteger(
      env,
      "SETU_SOCKET_MAX_BYTES",
      64 * 1024,
      64 * 1024,
    ),
  };
}

function singleHeader(request: IncomingMessage, name: string) {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i].toLowerCase() === name) count++;
  const value = request.headers[name];
  return count === 1 && typeof value === "string" ? value : undefined;
}

/** The proxy must overwrite, not append, all forwarded headers. */
export function publicClientIP(
  request: IncomingMessage,
  config: PublicConfig,
  requireOrigin = false,
) {
  if (
    !isTrustedProxy(
      request.socket.remoteAddress ?? "",
      config.trustedProxyCidrs,
    ) ||
    singleHeader(request, "host") !== config.host ||
    singleHeader(request, "x-forwarded-host") !== config.host ||
    singleHeader(request, "x-forwarded-proto") !== "https" ||
    request.headers.forwarded !== undefined
  )
    return;
  const origin = singleHeader(request, "origin");
  if (
    (requireOrigin || request.headers.origin !== undefined) &&
    origin !== config.origin
  )
    return;
  const ip = singleHeader(request, "x-forwarded-for");
  if (!ip || !ipNumber(ip)) return;
  return normalizeIP(ip);
}

export function isLoopback(address: string) {
  const ip = normalizeIP(address);
  return ip === "::1" || (isIP(ip) === 4 && ip.startsWith("127."));
}
