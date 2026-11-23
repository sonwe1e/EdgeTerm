import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  registerSnippetOpener,
  registerSnippetRunner,
  registerSnippetSaver,
  sendSnippet,
} from "../snippetActions";
import { expandTemplate, templateNames, type Snippet } from "../snippets";
import { useStore } from "../store";
import { getController } from "../terminalRegistry";
import { useT } from "../useT";
import { GroupNameDialog } from "./GroupNameDialog";
import { SnippetArgsDialog } from "./SnippetArgsDialog";
import { SnippetsDialog } from "./SnippetsDialog";

/**
 * Everything the saved-command surfaces need: one way to run a snippet from any
 * entry point, the "save the last command" prompt, and the dialogs themselves.
 * App holds none of this: the feature is self-contained and can be moved or
 * tested without touching the window shell.
 */
export interface SnippetRunner {
  openSnippets: () => void;
  runSnippet: (snippet: Snippet) => void;
  saveLastCommandAsSnippet: () => void;
  /** Render once: every dialog this feature owns. */
  surfaces: ReactNode;
}

export function useSnippetRunner(): SnippetRunner {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [nameFor, setNameFor] = useState<string | null>(null);
  const [argsFor, setArgsFor] = useState<{ snippet: Snippet; names: string[] } | null>(null);
  // Per command, the values it was last run with. In memory only: an answer
  // belongs to this sitting, not to the saved command.
  const lastValues = useRef(new Map<string, Record<string, string>>());

  // Straight to the shell for a plain line; through the prompt for a template.
  const runSnippet = useCallback((snippet: Snippet) => {
    const names = templateNames(snippet.command);
    if (names.length === 0) {
      sendSnippet(snippet);
      return;
    }
    setArgsFor({ snippet, names });
  }, []);

  const saveLastCommandAsSnippet = useCallback(() => {
    const state = useStore.getState();
    const controller = state.activeId ? getController(state.activeId) : null;
    const command = controller?.lastCommandText() ?? "";
    if (!command.trim()) {
      state.setStatus(t("snippets.noCommandToSave"));
      return;
    }
    setNameFor(command);
  }, [t]);

  // Other surfaces run snippets through this one, so their text still lands on
  // the same send path (and asks for parameters the same way).
  useEffect(() => {
    registerSnippetRunner(runSnippet);
    registerSnippetSaver(saveLastCommandAsSnippet);
    registerSnippetOpener(() => setOpen(true));
    return () => {
      registerSnippetRunner(null);
      registerSnippetSaver(null);
      registerSnippetOpener(null);
    };
  }, [runSnippet, saveLastCommandAsSnippet]);

  const surfaces = (
    <>
      {open && <SnippetsDialog onClose={() => setOpen(false)} onRun={runSnippet} />}

      {argsFor && (
        <SnippetArgsDialog
          snippet={argsFor.snippet}
          names={argsFor.names}
          initial={lastValues.current.get(argsFor.snippet.id)}
          onSubmit={(values) => {
            lastValues.current.set(argsFor.snippet.id, values);
            // The prompt already showed the command; this is the same line with
            // the placeholders filled in.
            sendSnippet({
              ...argsFor.snippet,
              command: expandTemplate(argsFor.snippet.command, values),
            });
            setArgsFor(null);
          }}
          onCancel={() => setArgsFor(null)}
        />
      )}

      {nameFor !== null && (
        <GroupNameDialog
          title={t("snippets.saveTitle")}
          location=""
          label={t("snippets.nameLabel")}
          hint={t("snippets.saveHint", { command: nameFor })}
          submitLabel={t("snippets.saveButton")}
          onSubmit={async (name) => {
            useStore.getState().saveSnippet(name, nameFor);
            setNameFor(null);
            useStore.getState().setStatus(t("snippets.saved", { name }));
          }}
          onCancel={() => setNameFor(null)}
        />
      )}
    </>
  );

  return { openSnippets: () => setOpen(true), runSnippet, saveLastCommandAsSnippet, surfaces };
}
