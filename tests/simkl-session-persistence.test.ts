import "./_localstorage-stub";
import assert from "node:assert/strict";
import test from "node:test";
import { getSession, resetForProfile } from "@/lib/simkl/session";
import { setSecret } from "@/lib/secret-store";

test("simkl getSession recovers session when activeId was null but profile exists", () => {
  const profileId = "p_user_simkl_test";
  localStorage.setItem(
    "harbor.profiles.v1",
    JSON.stringify({
      profiles: [{ id: profileId, name: "Test User", isPrimary: true }],
      activeId: null,
    }),
  );

  // Store the secret under the profile key (as saved when the user logged in)
  setSecret(
    `harbor.simkl.session.v1.${profileId}`,
    JSON.stringify({ accessToken: "test_token_abc", username: "Test User" }),
  );

  resetForProfile();
  const session = getSession();
  assert.ok(session, "session should be loaded");
  assert.equal(session.username, "Test User");
  assert.equal(session.accessToken, "test_token_abc");
});

test("simkl getSession recovers session from orphaned default key for primary profile", () => {
  const profileId = "p_user_simkl_migrated";
  localStorage.setItem(
    "harbor.profiles.v1",
    JSON.stringify({
      profiles: [{ id: profileId, name: "Test User 2", isPrimary: true }],
      activeId: profileId,
    }),
  );

  // Store under orphaned .default key
  setSecret(
    "harbor.simkl.session.v1.default",
    JSON.stringify({ accessToken: "legacy_token", username: "Test User 2" }),
  );

  resetForProfile();
  const session = getSession();
  assert.ok(session, "session should be migrated from default");
  assert.equal(session.username, "Test User 2");
  assert.equal(session.accessToken, "legacy_token");
});
