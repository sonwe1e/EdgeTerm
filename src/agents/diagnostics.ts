import { readText, writeText } from "../editor/textFile";
import type { TextFile } from "../editor/editorTypes";
import { errorText } from "../errorInfo";
import type { Installation } from "./api";

export interface PiConfig {
  path: string;
  scope: "global" | "project";
  file: TextFile | null;
  exit: string | null;
  error: string | null;
}
export async function piConfigs(
  id: string | null,
  installation: Installation,
  directory: string,
): Promise<PiConfig[]> {
  const paths = [
    {
      path: `${installation.configRoot.replace(/[\\/]$/, "")}/settings.json`,
      scope: "global" as const,
    },
    ...(directory
      ? [
          {
            path: `${directory.replace(/[\\/]$/, "")}/.pi/settings.json`,
            scope: "project" as const,
          },
        ]
      : []),
  ];
  return Promise.all(
    paths.map(async ({ path, scope }) => {
      try {
        const file = await readText(id, path);
        const value: unknown = JSON.parse(file.content);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Invalid Pi settings object");
        const setting = (value as Record<string, unknown>).fullscreenExitOutput;
        return {
          path,
          scope,
          file,
          exit: typeof setting === "string" ? setting : null,
          error: null,
        };
      } catch (error) {
        return { path, scope, file: null, exit: null, error: errorText(error) };
      }
    }),
  );
}
/** Preserve all other settings; the editor's hash check protects the read/write boundary. */
export async function usePiResumeHint(id: string | null, config: PiConfig) {
  if (!config.file) throw new Error("Read the existing configuration before changing it");
  const data: Record<string, unknown> = JSON.parse(config.file.content);
  data.fullscreenExitOutput = "resume-hint";
  const result = await writeText(id, {
    path: config.path,
    content: `${JSON.stringify(data, null, 2)}\n`,
    expectedHash: config.file.hash,
    eol: config.file.eol,
    bom: config.file.bom,
    encoding: config.file.encoding,
  });
  if (result.uncertain)
    throw new Error(result.note || "Configuration write is uncertain; reload before retrying");
}
