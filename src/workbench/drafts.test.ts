import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedDraft,
  draftCount,
  draftsForWorkspace,
  ensureDraftsLoaded,
  importLegacyDrafts,
  LEGACY_STORAGE_KEY,
  reloadDrafts,
  removeDraft,
  resetDraftsForTests,
  saveDraft,
} from "./drafts";
import type { Draft } from "./draftTypes";

const backend = vi.hoisted(() => ({
  stored: new Map<string, Draft>(),
  failSave: false,
  failDelete: false,
  failList: false,
}));

vi.mock("../bindings", () => ({
  commands: {
    draftSave: async (draft: Draft) => {
      if (backend.failSave) throw new Error("No space left on device");
      backend.stored.set(draft.docId, structuredClone(draft));
      return draft;
    },
    draftDelete: async (docId: string) => {
      if (backend.failDelete) throw new Error("Access is denied");
      backend.stored.delete(docId);
    },
    draftLoad: async (docId: string) => backend.stored.get(docId) ?? null,
    draftList: async () => {
      if (backend.failList) throw new Error("The draft directory is unreadable");
      return {
        drafts: [...backend.stored.values()],
        dir: "/home/lab/.config/EdgeTerm/drafts",
        bytes: [...backend.stored.values()].reduce(
          (total, draft) => total + draft.content.length,
          0,
        ),
        unreadable: 0,
      };
    },
  },
}));

const draft = (id: string, updatedAt: number, content = "print(1)\n"): Draft => ({
  docId: id,
  workspaceId: id.split("::")[0] ?? "w1",
  serverKey: "lab@gpu-01:22",
  serverLabel: "gpu-01",
  projectName: "baseline",
  path: `src/${id}.py`,
  absolutePath: `/data/vfi/base/src/${id}.py`,
  content,
  baseHash: `base-${id}`,
  updatedAt,
});

describe("editor drafts", () => {
  beforeEach(() => {
    backend.stored.clear();
    backend.failSave = false;
    backend.failDelete = false;
    backend.failList = false;
    localStorage.clear();
    resetDraftsForTests();
  });

  it("restores unsaved content with the base it was written against", async () => {
    expect(await saveDraft(draft("w1::/a.py", 10, "changed\n"))).toEqual({
      ok: true,
      error: null,
    });
    await reloadDrafts();
    const found = cachedDraft("w1::/a.py");
    expect(found?.content).toBe("changed\n");
    expect(found?.baseHash).toBe("base-w1::/a.py");
    expect(draftCount()).toBe(1);
  });

  it("keeps two large drafts; a second save never removes the first", async () => {
    const a = "a".repeat(800_000);
    const b = "b".repeat(800_000);
    await saveDraft(draft("w1::/a.py", 1, a));
    await saveDraft(draft("w1::/b.py", 2, b));

    await reloadDrafts();
    expect(draftCount()).toBe(2);
    expect(cachedDraft("w1::/a.py")?.content.length).toBe(800_000);
    expect(cachedDraft("w1::/b.py")?.content.length).toBe(800_000);
    // And the backend still holds both after a restart-style reload.
    expect(backend.stored.size).toBe(2);
  });

  it("reports a failed write instead of pretending the edit is safe", async () => {
    await saveDraft(draft("w1::/a.py", 1, "first"));
    backend.failSave = true;
    const result = await saveDraft(draft("w1::/a.py", 2, "second"));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("space");
    // The previous draft is untouched, and the mirror still shows it.
    expect(backend.stored.get("w1::/a.py")?.content).toBe("first");
    expect(cachedDraft("w1::/a.py")?.content).toBe("first");
  });

  it("keeps a draft visible when deleting it fails", async () => {
    await saveDraft(draft("w1::/a.py", 1));
    backend.failDelete = true;
    const result = await removeDraft("w1::/a.py");
    expect(result.ok).toBe(false);
    expect(cachedDraft("w1::/a.py")).not.toBeNull();
  });

  it("filters drafts by project after a reload", async () => {
    await saveDraft(draft("w1::/a.py", 1));
    await saveDraft(draft("w2::/b.py", 2));
    await reloadDrafts();
    expect(draftsForWorkspace("w1").map((entry) => entry.docId)).toEqual(["w1::/a.py"]);
    expect(draftsForWorkspace("w3")).toEqual([]);
  });

  it("surfaces an unreadable store instead of showing an empty list", async () => {
    backend.failList = true;
    await ensureDraftsLoaded();
    const result = await reloadDrafts();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unreadable");
  });

  it("imports drafts written by the previous local-storage version", async () => {
    localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({
        "w1::/a.py": {
          ...draft("w1::/a.py", 5, "legacy edit"),
          serverKey: "lab@gpu-01:22",
          serverLabel: "gpu-01",
          projectName: "baseline",
        },
      }),
    );
    expect(await importLegacyDrafts()).toBe(1);
    expect(cachedDraft("w1::/a.py")?.content).toBe("legacy edit");
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it("keeps the legacy copy when the disk write fails", async () => {
    localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({ "w1::/a.py": draft("w1::/a.py", 5, "legacy edit") }),
    );
    backend.failSave = true;
    expect(await importLegacyDrafts()).toBe(0);
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();
  });
});
