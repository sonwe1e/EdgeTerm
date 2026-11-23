import { describe, expect, it } from "vitest";

import { expandTemplate, templateNames } from "./snippets";

describe("parameterised commands", () => {
  it("lists the parameters once each, in the order they appear", () => {
    expect(templateNames("deploy {{env}} with {{tag}} ({env})")).toEqual(["env", "tag"]);
    expect(templateNames("ls -la")).toEqual([]);
  });

  it("fills the values in", () => {
    expect(expandTemplate("deploy {{env}} with {{tag}}", { env: "prod", tag: "v1" })).toBe(
      "deploy prod with v1",
    );
  });

  it("keeps the placeholder visible when a value is missing", () => {
    expect(expandTemplate("deploy {{env}}", {})).toBe("deploy {{env}}");
    expect(expandTemplate("deploy {{env}}", { env: "" })).toBe("deploy {{env}}");
  });

  it("leaves other braces and unterminated text alone", () => {
    expect(expandTemplate("awk '{print $1}' {{file}}", { file: "log" })).toBe(
      "awk '{print $1}' log",
    );
    expect(expandTemplate("echo $HOME {{unclosed", {})).toBe("echo $HOME {{unclosed");
    expect(templateNames("find . -name '{{name'")).toEqual([]);
  });

  it("trims the name inside the braces", () => {
    expect(templateNames("ssh {{ host }}")).toEqual(["host"]);
    expect(expandTemplate("ssh {{ host }}", { host: "box" })).toBe("ssh box");
  });
});
