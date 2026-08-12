import { describe, expect, it, vi } from "vitest";

vi.mock("../auth-profiles/constants.js", async () => {
  const actual = await vi.importActual<typeof import("../auth-profiles/constants.js")>(
    "../auth-profiles/constants.js",
  );
  return { ...actual, OAUTH_REFRESH_CALL_TIMEOUT_MS: 10 };
});

import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import { AuthStorage } from "./auth-storage.js";

function createStorage(
  refreshToken: () => Promise<{ access: string; refresh: string; expires: number }>,
) {
  const storage = AuthStorage.inMemory({
    "test-oauth": {
      type: "oauth",
      access: "expired-access",
      refresh: "expired-refresh",
      expires: 1,
    },
  });
  getAuthStorageOAuthProviderRegistry(storage).register({
    id: "test-oauth",
    name: "Test OAuth",
    async login() {
      throw new Error("not used");
    },
    refreshToken,
    getApiKey(credentials) {
      return credentials.access;
    },
  });
  return storage;
}

describe("AuthStorage OAuth refresh ownership", () => {
  it("persists late success and reuses it after the caller deadline", async () => {
    const stalled = Promise.withResolvers<{
      access: string;
      refresh: string;
      expires: number;
    }>();
    const refreshToken = vi.fn(async () => await stalled.promise);
    const storage = createStorage(refreshToken);

    await expect(storage.getApiKey("test-oauth")).resolves.toBeUndefined();
    expect(storage.drainErrors()[0]?.message).toContain("exceeded caller deadline");
    stalled.resolve({
      access: "late-access",
      refresh: "late-refresh",
      expires: Date.now() + 10 * 60_000,
    });
    await vi.waitFor(() => {
      expect(storage.get("test-oauth")).toMatchObject({
        access: "late-access",
        refresh: "late-refresh",
      });
    });

    await expect(storage.getApiKey("test-oauth")).resolves.toBe("late-access");
    expect(refreshToken).toHaveBeenCalledOnce();
  });

  it("times out a queued follower without a second provider invocation", async () => {
    const stalled = Promise.withResolvers<{
      access: string;
      refresh: string;
      expires: number;
    }>();
    const refreshToken = vi.fn(async () => await stalled.promise);
    const storage = createStorage(refreshToken);

    const first = storage.getApiKey("test-oauth");
    await vi.waitFor(() => expect(refreshToken).toHaveBeenCalledOnce());
    const follower = storage.getApiKey("test-oauth");
    await expect(Promise.all([first, follower])).resolves.toEqual([undefined, undefined]);
    stalled.reject(new Error("late provider failure"));
    expect(storage.drainErrors()).toHaveLength(2);
    expect(refreshToken).toHaveBeenCalledOnce();
  });
});
