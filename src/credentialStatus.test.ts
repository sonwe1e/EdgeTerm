import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bindings", () => ({
  commands: { credentialStoreStatus: vi.fn() },
}));

import { commands } from "./bindings";
import {
  credentialStoreHint,
  fetchCredentialStoreStatus,
} from "./credentialStatus";

describe("credential store status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows no note while saved passwords survive restarts", () => {
    expect(credentialStoreHint({ persistent: true, reason: null })).toBeNull();
    expect(credentialStoreHint(null)).toBeNull();
  });

  it("names portable mode and an unavailable credential store separately", () => {
    expect(
      credentialStoreHint({ persistent: false, reason: "portable" }),
    ).toEqual({ key: "session.secretsRunOnlyPortable", warning: false });
    expect(
      credentialStoreHint({
        persistent: false,
        reason: "keyStoreUnavailable",
      }),
    ).toEqual({ key: "session.secretsRunOnlyNoKeyStore", warning: false });
  });

  it("warns that saving is refused while the stored file cannot be read", () => {
    expect(
      credentialStoreHint({
        persistent: false,
        reason: "credentialsUnreadable",
      }),
    ).toEqual({ key: "session.secretsUnreadable", warning: true });
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
