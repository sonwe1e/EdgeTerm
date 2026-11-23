import { beforeEach, describe, expect, it } from "vitest";

import { MAX_SNIPPETS, SNIPPETS_KEY } from "./snippets";
import { useStore } from "./store";

const snippets = () => useStore.getState().snippets;

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ snippets: [] });
});

describe("snippet store", () => {
  it("adds a command and persists it", () => {
    useStore.getState().saveSnippet("Restart app", "sudo systemctl restart app");
    expect(snippets()).toHaveLength(1);
    expect(snippets()[0]).toMatchObject({
      name: "Restart app",
      command: "sudo systemctl restart app",
    });
    expect(JSON.parse(localStorage.getItem(SNIPPETS_KEY)!)).toHaveLength(1);
  });

  it("replaces the command stored under the same name", () => {
    useStore.getState().saveSnippet("Logs", "tail app.log");
    const id = snippets()[0].id;
    useStore.getState().saveSnippet("Logs", "tail -f app.log");
    expect(snippets()).toHaveLength(1);
    expect(snippets()[0]).toMatchObject({ id, command: "tail -f app.log" });
  });

  it("refuses a nameless or empty command", () => {
    useStore.getState().saveSnippet("   ", "ls");
    useStore.getState().saveSnippet("Name", "   ");
    expect(snippets()).toEqual([]);
  });

  it("deletes and persists the smaller list", () => {
    useStore.getState().saveSnippet("A", "echo a");
    useStore.getState().saveSnippet("B", "echo b");
    useStore.getState().deleteSnippet(snippets()[0].id);
    expect(snippets().map((item) => item.name)).toEqual(["B"]);
    expect(
      JSON.parse(localStorage.getItem(SNIPPETS_KEY)!).map((item: { name: string }) => item.name),
    ).toEqual(["B"]);
  });

  it("stops adding at the list limit", () => {
    for (let index = 0; index < MAX_SNIPPETS + 2; index += 1) {
      useStore.getState().saveSnippet("name " + index, "echo " + index);
    }
    expect(snippets()).toHaveLength(MAX_SNIPPETS);
  });

  it("edits a command in place, name included", () => {
    useStore.getState().saveSnippet("Logs", "tail app.log");
    const id = snippets()[0].id;
    expect(useStore.getState().replaceSnippet(id, "App logs", "tail -f app.log")).toBe(true);
    expect(snippets()[0]).toMatchObject({ id, name: "App logs", command: "tail -f app.log" });
    expect(JSON.parse(localStorage.getItem(SNIPPETS_KEY)!)[0]).toMatchObject({ name: "App logs" });
  });

  it("refuses a rename that collides with another saved command", () => {
    useStore.getState().saveSnippet("A", "echo a");
    useStore.getState().saveSnippet("B", "echo b");
    const second = snippets()[1];
    expect(useStore.getState().replaceSnippet(second.id, "A", "echo bb")).toBe(false);
    expect(snippets()[1]).toMatchObject({ name: "B", command: "echo b" });
  });

  it("refuses an empty name or command and an unknown id", () => {
    useStore.getState().saveSnippet("A", "echo a");
    const id = snippets()[0].id;
    expect(useStore.getState().replaceSnippet(id, "  ", "echo a")).toBe(false);
    expect(useStore.getState().replaceSnippet(id, "A", "   ")).toBe(false);
    expect(useStore.getState().replaceSnippet("missing", "B", "echo b")).toBe(false);
    expect(snippets()).toHaveLength(1);
  });

  it("imports a list by name in one write", () => {
    useStore.getState().saveSnippet("Logs", "tail app.log");
    const landed = useStore.getState().importSnippets([
      { name: "Logs", command: "tail -f app.log" },
      { name: "Deploy", command: "deploy prod" },
      { name: "  ", command: "ignored" },
    ]);
    expect(landed).toBe(2);
    expect(snippets().map((item) => item.name)).toEqual(["Logs", "Deploy"]);
    expect(snippets()[0].command).toBe("tail -f app.log");
    expect(JSON.parse(localStorage.getItem(SNIPPETS_KEY)!)).toHaveLength(2);
  });

  it("stops importing at the list cap", () => {
    for (let index = 0; index < MAX_SNIPPETS; index += 1) {
      useStore.getState().saveSnippet("cmd " + index, "echo " + index);
    }
    const landed = useStore.getState().importSnippets([{ name: "one more", command: "echo 1" }]);
    expect(landed).toBe(0);
    expect(snippets()).toHaveLength(MAX_SNIPPETS);
  });
});
