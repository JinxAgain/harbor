import "./_localstorage-stub";
import assert from "node:assert/strict";
import test from "node:test";
import { activeProfileId, activeProfileIsPrimary } from "@/lib/active-profile-id";

test("activeProfileId falls back to primary profile when activeId is null", () => {
  const profile = { id: "p_test_profile_123", name: "Jinx", isPrimary: true };
  localStorage.setItem(
    "harbor.profiles.v1",
    JSON.stringify({ profiles: [profile], activeId: null }),
  );

  assert.equal(activeProfileId(), "p_test_profile_123");
  assert.equal(activeProfileIsPrimary(), true);
});

test("activeProfileId falls back to first profile when no primary flag", () => {
  const profile = { id: "p_test_profile_456", name: "Test" };
  localStorage.setItem(
    "harbor.profiles.v1",
    JSON.stringify({ profiles: [profile], activeId: null }),
  );

  assert.equal(activeProfileId(), "p_test_profile_456");
  assert.equal(activeProfileIsPrimary(), false);
});

test("activeProfileId respects activeId when explicitly set", () => {
  const p1 = { id: "p_1", name: "One", isPrimary: true };
  const p2 = { id: "p_2", name: "Two", isPrimary: false };
  localStorage.setItem(
    "harbor.profiles.v1",
    JSON.stringify({ profiles: [p1, p2], activeId: "p_2" }),
  );

  assert.equal(activeProfileId(), "p_2");
  assert.equal(activeProfileIsPrimary(), false);
});
