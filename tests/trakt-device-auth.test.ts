// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import "./_localstorage-stub.ts";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  (globalThis as { window?: unknown }).window = globalThis;
}

import {
  TRAKT_API_BASE,
  TRAKT_CLIENT_ID,
  TRAKT_CLIENT_SECRET,
} from "../src/lib/trakt/config.ts";
import {
  requestDeviceCode,
  pollForToken,
} from "../src/lib/trakt/device-auth.ts";
import { traktRequest } from "../src/lib/trakt/client.ts";
import { setSession } from "../src/lib/trakt/session.ts";

test("requestDeviceCode posts client_id to https://api.trakt.tv/oauth/device/code", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        device_code: "dev_123",
        user_code: "USER123",
        verification_url: "https://trakt.tv/activate",
        expires_in: 600,
        interval: 5,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const code = await requestDeviceCode();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.trakt.tv/oauth/device/code");
    assert.equal(calls[0].init?.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
      client_id: TRAKT_CLIENT_ID,
    });
    assert.equal(code.deviceCode, "dev_123");
    assert.equal(code.userCode, "USER123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pollForToken polls https://api.trakt.tv/oauth/device/token with client credentials, retrying on 400 and resolving on 200", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let pollCount = 0;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    pollCount += 1;
    if (pollCount === 1) {
      return new Response(JSON.stringify({}), { status: 400 });
    }
    return new Response(
      JSON.stringify({
        access_token: "acc_token_abc",
        refresh_token: "ref_token_xyz",
        created_at: 1000,
        expires_in: 7200,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const updates: any[] = [];
    await new Promise<void>((resolve, reject) => {
      const handle = pollForToken(
        {
          deviceCode: "dev_123",
          userCode: "USER123",
          verificationUrl: "https://trakt.tv/activate",
          expiresIn: 600,
          pollIntervalSec: 0.01,
        },
        (result) => {
          updates.push(result);
          if (result.kind === "authorized") {
            handle.cancel();
            resolve();
          } else if (result.kind === "error") {
            handle.cancel();
            reject(new Error(result.message));
          }
        }
      );
    });

    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.url, "https://api.trakt.tv/oauth/device/token");
      assert.doesNotMatch(call.url, /harbor\.site/);
      assert.equal(call.init?.method, "POST");
      assert.deepEqual(JSON.parse(call.init?.body as string), {
        code: "dev_123",
        client_id: TRAKT_CLIENT_ID,
        client_secret: TRAKT_CLIENT_SECRET,
      });
    }

    assert.equal(updates.length, 1);
    assert.equal(updates[0].kind, "authorized");
    assert.equal(updates[0].session.accessToken, "acc_token_abc");
    assert.equal(updates[0].session.refreshToken, "ref_token_xyz");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("traktRequest refreshes expired tokens on HTTP 401 via https://api.trakt.tv/oauth/token", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  setSession({
    accessToken: "expired_token",
    refreshToken: "valid_refresh_token",
    createdAt: 100,
    expiresIn: 100,
    username: "testuser",
  });

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });

    if (url.endsWith("/oauth/token")) {
      return new Response(
        JSON.stringify({
          access_token: "refreshed_access_token",
          refresh_token: "new_refresh_token",
          created_at: Math.floor(Date.now() / 1000),
          expires_in: 7200,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const authHeader = (init?.headers as Record<string, string>)?.[
      "Authorization"
    ];
    if (authHeader === "Bearer expired_token") {
      return new Response("Unauthorized", { status: 401 });
    }

    if (authHeader === "Bearer refreshed_access_token") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Unexpected call", { status: 500 });
  };

  try {
    const result = await traktRequest<{ ok: boolean }>("/test-path", {
      authed: true,
    });
    assert.deepEqual(result, { ok: true });

    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, `${TRAKT_API_BASE}/test-path`);
    assert.equal(calls[1].url, "https://api.trakt.tv/oauth/token");
    assert.doesNotMatch(calls[1].url, /harbor\.site/);
    assert.equal(calls[1].init?.method, "POST");
    assert.deepEqual(JSON.parse(calls[1].init?.body as string), {
      refresh_token: "valid_refresh_token",
      client_id: TRAKT_CLIENT_ID,
      client_secret: TRAKT_CLIENT_SECRET,
      redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
      grant_type: "refresh_token",
    });
    assert.equal(calls[2].url, `${TRAKT_API_BASE}/test-path`);
    assert.equal(
      (calls[2].init?.headers as Record<string, string>)["Authorization"],
      "Bearer refreshed_access_token"
    );
  } finally {
    globalThis.fetch = originalFetch;
    setSession(null);
  }
});
