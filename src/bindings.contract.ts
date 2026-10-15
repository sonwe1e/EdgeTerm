// Compile-only negative controls for the generated Rust contract. Never imported by the app.
import type { BackspaceKey, FileComparison, SessionProfile_Deserialize } from "./bindings";
import { commands } from "./bindings";
export function checkGeneratedContract() {
  const good: SessionProfile_Deserialize = { name: "fixture", kind: "ssh", backspace: "controlH" };
  // @ts-expect-error unknown key behavior is normalized on import, not a public input value
  const badKey: BackspaceKey = "future-key";
  // @ts-expect-error Rust port is a JSON number
  const badPort: SessionProfile_Deserialize = { name: "fixture", kind: "ssh", port: "22" };
  // @ts-expect-error comparison status comes from a Rust enum
  const badStatus: FileComparison["status"] = "success";
  // @ts-expect-error generated command argument requires requestId as a string
  void commands.compareFiles("session", 123, "local", "remote");
  return { good, badKey, badPort, badStatus };
}
