// oauth.ts — minimal OAuth 2.1 + PKCE authorization server.
// Enables ChatGPT, Grok, and other MCP clients that require OAuth discovery.
// Issued access_token = BRAIN_ACCESS_KEY, so the existing /mcp Bearer check just works.

import { createHash, randomBytes } from "crypto";
import express, { Router } from "express";
import type { Request, Response } from "express";

const router = Router();
// Parse application/x-www-form-urlencoded (authorize form POSTs) and JSON (register, token)
router.use(express.urlencoded({ extended: false }));
router.use(express.json());

// ---------- in-memory stores (resets on restart — fine for short-lived auth codes) ----------
const clients = new Map<string, Record<string, unknown>>();
const codes   = new Map<string, { code_challenge: string; redirect_uri: string; expires: number }>();

function randomId(bytes = 16): string { return randomBytes(bytes).toString("base64url"); }
function base64url(buf: Buffer): string { return buf.toString("base64url"); }
function pkceVerify(verifier: string, challenge: string): boolean {
  return base64url(createHash("sha256").update(verifier).digest()) === challenge;
}

// ---------- discovery ----------
router.get("/.well-known/oauth-authorization-server", (req: Request, res: Response) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code"],
    response_types_supported: ["code"],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

router.get("/.well-known/oauth-protected-resource", (req: Request, res: Response) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({ resource: base, authorization_servers: [base] });
});

// ---------- dynamic client registration ----------
router.post("/register", (req: Request, res: Response) => {
  const client_id = randomId();
  clients.set(client_id, { client_id, ...req.body });
  res.status(201).json({
    client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: "none",
    ...req.body,
  });
});

// ---------- authorize (GET = show form, POST = verify key + issue code) ----------
function authForm(params: {
  state: string; client_id: string; redirect_uri: string;
  code_challenge: string; code_challenge_method: string; error?: string;
}): string {
  const { state, client_id, redirect_uri, code_challenge, code_challenge_method, error } = params;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Brain Auth</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:400px;margin:80px auto;padding:0 16px}
  h2{margin-bottom:4px}p{margin-top:4px}
  input[type=password]{width:100%;padding:8px;margin:8px 0 16px;box-sizing:border-box;font-size:1rem;border:1px solid #ccc;border-radius:4px}
  button{padding:10px 24px;background:#1a1a1a;color:#fff;border:none;cursor:pointer;font-size:1rem;border-radius:4px}
  .err{color:#c00;margin-bottom:12px;font-weight:500}
</style></head>
<body>
  <h2>🧠 Brain Access</h2>
  ${error ? `<p class="err">${error}</p>` : ""}
  <p>Enter your Brain Access Key to authorize this connection.</p>
  <form method="POST" action="/authorize">
    <input type="hidden" name="state" value="${state}">
    <input type="hidden" name="client_id" value="${client_id}">
    <input type="hidden" name="redirect_uri" value="${redirect_uri}">
    <input type="hidden" name="code_challenge" value="${code_challenge}">
    <input type="hidden" name="code_challenge_method" value="${code_challenge_method}">
    <input type="password" name="access_key" placeholder="Brain Access Key" autofocus>
    <button type="submit">Authorize</button>
  </form>
</body></html>`;
}

router.get("/authorize", (req: Request, res: Response) => {
  const q = req.query as Record<string, string>;
  res.send(authForm({
    state: q.state ?? "", client_id: q.client_id ?? "",
    redirect_uri: q.redirect_uri ?? "", code_challenge: q.code_challenge ?? "",
    code_challenge_method: q.code_challenge_method ?? "S256",
  }));
});

router.post("/authorize", (req: Request, res: Response) => {
  const b = req.body as Record<string, string>;
  const { state = "", client_id = "", redirect_uri = "",
          code_challenge = "", code_challenge_method = "S256", access_key = "" } = b;
  const ACCESS_KEY = process.env.BRAIN_ACCESS_KEY ?? "";
  if (!ACCESS_KEY || access_key !== ACCESS_KEY) {
    res.send(authForm({ state, client_id, redirect_uri, code_challenge,
      code_challenge_method, error: "Invalid key — try again." }));
    return;
  }
  const code = randomId(24);
  codes.set(code, { code_challenge, redirect_uri, expires: Date.now() + 5 * 60 * 1000 });
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(302, url.toString());
});

// ---------- token ----------
router.post("/token", (req: Request, res: Response) => {
  const { grant_type, code, code_verifier } = req.body as Record<string, string>;
  if (grant_type !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" }); return;
  }
  const entry = codes.get(code);
  if (!entry || Date.now() > entry.expires) {
    codes.delete(code);
    res.status(400).json({ error: "invalid_grant", error_description: "code expired or not found" }); return;
  }
  if (!pkceVerify(code_verifier, entry.code_challenge)) {
    res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" }); return;
  }
  codes.delete(code); // single use
  res.json({
    access_token: process.env.BRAIN_ACCESS_KEY ?? randomId(32),
    token_type: "Bearer",
    expires_in: 31536000,
  });
});

export { router as oauthRouter };
