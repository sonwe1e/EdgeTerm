import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bindings", () => ({
  commands: { credentialStoreStatus: vi.fn() },
}));

import { commands } from "./bindings";
import {
  credentialStoreHintKey,
  fetchCredentialStoreStatus,
} from "./credentialStatus";

describe("credential store status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows no note while saved passwords survive restarts", () => {
    expect(credentialStoreHintKey({ persistent: true, reason: null })).toBeNull();
    expect(credentialStoreHintKey(null)).toBeNull();
  });

  it("names portable mode and an unavailable credential store separately", () => {
    expect(
      credentialStoreHintKey({ persistent: false, reason: "portable" }),
    ).toBe("session.secretsRunOnlyPortable");
    expect(
      credentialStoreHintKey({
        persistent: false,
        reason: "keyStoreUnavailable",
      }),
    ).toBe("session.secretsRunOnlyNoKeyStore");
  });

  it("passes the backend status through", async () => {
    const status = { persistent: false, reason: "portable" } as const;
    vi.mocked(commands.credentialStoreStatus).mockResolvedValue(status);
    await expect(fetchCredentialStoreStatus()).resolves.toEqual(status);
    expect(commands.credentialStoreStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps working when the query fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(commands.credentialStoreStatus).mockRejectedValue(
      new Error("no ipc"),
    );
    await expect(fetchCredentialStoreStatus()).resolves.toBeNull();
    expect(logged).toHaveBeenCalled();
  });
});
