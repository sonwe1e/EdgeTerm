// Seed a fresh, isolated OpenCode 2.x server without running a model.
// See scripts/README.md for the disposable data and process prerequisites.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const server = new URL(process.env.EDGETERM_OPENCODE_SERVER || "");
const project = process.env.EDGETERM_OPENCODE_PROJECT;
const password = process.env.OPENCODE_PASSWORD;
const output = process.argv[2];
assert.ok(
  project && password && output,
  "pass the isolated project, server password, and a new fixture file",
);
assert.equal(server.protocol, "http:");
assert.equal(server.hostname, "127.0.0.1", "use a disposable loopback server");
assert.equal(server.username + server.password, "", "do not put credentials in the URL");
const insideTmp = (path) => {
  const part = relative(resolve(".tmp"), resolve(path));
  return part && !part.startsWith("..") && !isAbsolute(part);
};
assert.ok(insideTmp(project) && insideTmp(output), "test project and output must be inside .tmp");
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
const request = async (path, body) => {
  const response = await fetch(new URL(path, server), {
    method: body ? "POST" : "GET",
    headers: { authorization: auth, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, `OpenCode test server returned ${response.status} for ${path}`);
  return response.json();
};
const existing = await request("/api/session?limit=1");
assert.ok(
  Array.isArray(existing.data) && existing.data.length === 0,
  "test server must start with no sessions",
);
const location = { directory: resolve(project) };
const created = await request("/api/session", {
  title: "EdgeTerm performance fixture template",
  location,
});
const exported = await request(`/api/experimental/session/${created.data.id}/export`);
assert.deepEqual(exported.data.messages, []);

const id = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const fixtures = {};
for (const [name, count] of [
  ["short", 8],
  ["long", 240],
]) {
  const messages = [];
  for (let index = 1; index <= count; index++) {
    const createdAt = 1793100000000 + 2000 * index;
    messages.push({
      id: id("msg"),
      type: "user",
      time: { created: createdAt },
      text: `Fixture question ${index}. Review the example and explain the next steps.`,
    });
    messages.push({
      id: id("msg"),
      type: "assistant",
      time: { created: createdAt + 1000, completed: createdAt + 1500 },
      agent: "build",
      model: { id: "fixture", providerID: "fixture" },
      finish: "stop",
      content: [
        {
          type: "text",
          text: [
            `## Example response ${index}`,
            "",
            "This locally generated message simulates a normal coding conversation with paragraphs and a short code sample.",
            "",
            "- Check the input and preserve existing behavior.",
            "- Keep the output concise and verify the result.",
            `- Consider edge cases for message ${index}.`,
            "",
            "    function sample(value) {",
            `      return value + ${index};`,
            "    }",
            "",
            "The above is test text only; no model was called.",
          ].join("\n"),
        },
      ],
    });
  }
  const info = { ...exported.data.info, id: id("ses"), title: `Synthetic ${name} conversation` };
  const imported = await request("/api/experimental/session/import", { info, messages, location });
  fixtures[name] = { id: imported.data.id, messages: messages.length };
}
await writeFile(output, `${JSON.stringify(fixtures, null, 2)}\n`, { flag: "wx" });
console.log(
  JSON.stringify({
    messages: Object.fromEntries(
      Object.entries(fixtures).map(([name, value]) => [name, value.messages]),
    ),
  }),
);
