import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { NextFunction, Request, Response } from "express";

const GOOGLE_SECURETOKEN_CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

export interface VerifiedFirebaseToken {
  uid: string;
  email: string;
  emailVerified: boolean;
  issuer: string;
  audience: string;
  expiresAt: number;
}

export interface AuthenticatedOwnerRequest extends Request {
  firebaseOwner?: VerifiedFirebaseToken;
}

interface CertCache {
  certs: Record<string, string>;
  expiresAtMs: number;
}

let certCache: CertCache | null = null;
let cachedProjectId: string | null | undefined;

export function getServerFirebaseProjectId(): string | null {
  const envProjectId = (process.env.FIREBASE_PROJECT_ID || "").trim();
  if (envProjectId) return envProjectId;

  if (cachedProjectId !== undefined) {
    return cachedProjectId;
  }

  try {
    const configPath = path.resolve(process.cwd(), "firebase-applet-config.json");
    if (!fs.existsSync(configPath)) {
      cachedProjectId = null;
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as { projectId?: string };
    const id = typeof raw.projectId === "string" ? raw.projectId.trim() : "";
    cachedProjectId = id && !id.includes("remixed-project-id") ? id : null;
    return cachedProjectId;
  } catch {
    cachedProjectId = null;
    return null;
  }
}

export function getServerOwnerRestrictions(): { ownerUid?: string; ownerEmail: string } {
  const ownerUid = (process.env.FIREBASE_OWNER_UID || "").trim() || undefined;
  const ownerEmail = (
    process.env.FIREBASE_OWNER_EMAIL || "zla264995@gmail.com"
  )
    .trim()
    .toLowerCase();
  return { ownerUid, ownerEmail };
}

function decodeBase64UrlJson<T>(segment: string): T {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const raw = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(raw) as T;
}

function decodeBase64UrlBuffer(segment: string): Buffer {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

async function fetchPublicCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (certCache && now < certCache.expiresAtMs) {
    return certCache.certs;
  }

  const resp = await fetch(GOOGLE_SECURETOKEN_CERTS_URL);
  if (!resp.ok) {
    throw new Error(`Failed to fetch Firebase public keys (${resp.status}).`);
  }

  const certs = (await resp.json()) as Record<string, string>;
  const cacheControl = resp.headers.get("cache-control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeSec = maxAgeMatch ? Math.max(60, parseInt(maxAgeMatch[1], 10)) : 3600;

  certCache = {
    certs,
    expiresAtMs: now + maxAgeSec * 1000,
  };
  return certs;
}

/**
 * Verifies a Firebase Auth ID token (RS256) using Google's public X.509 certificates.
 * Works on both AI Studio Starter Tier and user-owned Firebase projects without
 * requiring IAM roles or service account private keys.
 */
export async function verifyFirebaseIdToken(
  idToken: string,
  overrideProjectId?: string
): Promise<VerifiedFirebaseToken> {
  const projectId = (overrideProjectId || getServerFirebaseProjectId() || "").trim();
  if (!projectId) {
    throw new Error("Server Firebase projectId is not configured.");
  }

  const parts = idToken.trim().split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed Firebase ID token.");
  }

  const [headerSeg, payloadSeg, sigSeg] = parts;
  const header = decodeBase64UrlJson<{ alg?: string; kid?: string }>(headerSeg);
  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("Unsupported Firebase ID token signature algorithm.");
  }

  const certs = await fetchPublicCerts();
  const certPem = certs[header.kid];
  if (!certPem) {
    throw new Error("Unknown Firebase ID token signing key.");
  }

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${headerSeg}.${payloadSeg}`);
  verifier.end();

  const signature = decodeBase64UrlBuffer(sigSeg);
  if (!verifier.verify(certPem, signature)) {
    throw new Error("Invalid Firebase ID token signature.");
  }

  const payload = decodeBase64UrlJson<{
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
    email_verified?: boolean;
  }>(payloadSeg);

  const nowSec = Math.floor(Date.now() / 1000);
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;

  if (payload.aud !== projectId) {
    throw new Error("Firebase ID token audience mismatch.");
  }
  if (payload.iss !== expectedIssuer) {
    throw new Error("Firebase ID token issuer mismatch.");
  }
  if (!payload.sub || typeof payload.sub !== "string" || payload.sub.length > 128) {
    throw new Error("Invalid Firebase ID token subject.");
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) {
    throw new Error("Firebase ID token has expired.");
  }
  if (typeof payload.iat !== "number" || payload.iat > nowSec + 300) {
    throw new Error("Firebase ID token issued-at timestamp is invalid.");
  }

  return {
    uid: payload.sub,
    email: typeof payload.email === "string" ? payload.email.toLowerCase() : "",
    emailVerified: payload.email_verified === true,
    issuer: payload.iss,
    audience: payload.aud,
    expiresAt: payload.exp,
  };
}

/**
 * Reusable Express middleware for future owner-only /api/affiliate/* routes.
 * Enforces verified Bearer Firebase ID token + single-owner email/UID gate.
 */
export async function requireOwnerAuth(
  req: AuthenticatedOwnerRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authorization Bearer token is required." });
    return;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    res.status(401).json({ error: "Missing Firebase ID token." });
    return;
  }

  try {
    const verified = await verifyFirebaseIdToken(token);
    const { ownerUid, ownerEmail } = getServerOwnerRestrictions();

    if (!verified.emailVerified) {
      res.status(403).json({ error: "Verified email address is required." });
      return;
    }
    if (ownerUid && verified.uid !== ownerUid) {
      res.status(403).json({ error: "Owner UID mismatch." });
      return;
    }
    if (ownerEmail && verified.email !== ownerEmail) {
      res.status(403).json({ error: "Access restricted to the platform owner." });
      return;
    }

    req.firebaseOwner = verified;
    next();
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : "Invalid Firebase authentication token.",
    });
  }
}
