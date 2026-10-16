import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../../api";
import type { Translate } from "../../i18n";
import {
  loadSaveLevel,
  scopeChain,
  scopeKey,
  scopeLabel,
  storeSaveLevel,
  type ScopeLevel,
} from "../../senderScope";
import { firstLine } from "../../senderUnits";
import { byName } from "../../sessionGroups";
import type { Tab } from "../../store";
import { useStore } from "../../store";
import { type CommandScope, type LineEnding, type SavedCommand } from "../../types";
import {
  CommandContextMenu,
  COMMANDS_PER_PAGE,
  Editing,
  MAX_SAVED_COMMANDS,
  SavePicker,
} from "./senderShared";

interface Options {
  t: Translate;
  activeTab: Tab | undefined;
  text: string;
  tagName: string;
  ending: LineEnding;
  setTagName: Dispatch<SetStateAction<string>>;
  setEnding: Dispatch<SetStateAction<LineEnding>>;
  compact: boolean;
  onExpandedChange: (expanded: boolean) => void;
  closeMore: () => void;
  setText: Dispatch<SetStateAction<string>>;
}

export function useSenderLibrary({
  t,
  activeTab,
  text,
  tagName,
  ending,
  setTagName,
  setEnding,
  compact,
  onExpandedChange,
  closeMore,
  setText,
}: Options) {
  const profiles = useStore((s) => s.profiles);
  const groups = useStore((s) => s.groups);
  const setStatus = useStore((s) => s.setStatus);
  const libraryVersion = useStore((s) => s.senderLibraryVersion);
  const [savedCommands, setSavedCommands] = useState<SavedCommand[]>([]);
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<CommandContextMenu | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [page, setPage] = useState(1);
  const [commandsLoading, setCommandsLoading] = useState(true);
  const [libraryBusy, setLibraryBusy] = useState(false);
  // Save / Update open a picker for the scope; the last choice's level is
  // preselected in it.
  const [savePicker, setSavePicker] = useState<SavePicker | null>(null);
  const [saveLevel, setSaveLevel] = useState<ScopeLevel>(loadSaveLevel);
  const libraryPreferencesRevision = useStore((s) => s.panelPreferencesRevision);
  useEffect(() => setSaveLevel(loadSaveLevel()), [libraryPreferencesRevision]);
  const saveButtonRef = useRef<HTMLButtonElement>(null);

  // Loads the library on mount and again after it changed outside this
  // panel (a data import, a deleted profile or group); an edit in progress
  // would then update stale contents, so it is dropped.
  useEffect(() => {
    let cancelled = false;
    setCommandsLoading(true);
    void api
      .listSenderCommands()
      .then((commands) => {
        if (cancelled) return;
        setSavedCommands(commands);
        setEditing(null);
      })
      .catch((error) => {
        if (!cancelled) setStatus(t("sender.loadFailed", { error: String(error) }));
      })
      .finally(() => {
        if (!cancelled) setCommandsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setStatus, libraryVersion, t]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const closeSavePicker = useCallback(() => setSavePicker(null), []);

  const chain = useMemo(
    () => scopeChain(activeTab, profiles, groups),
    [activeTab, profiles, groups],
  );
  const labelOf = (scope: CommandScope) => scopeLabel(scope, profiles, groups, t);

  // Commands the active tab sees, in one alphabetical list regardless of
  // scope; the tooltip names each tag's scope.
  const visibleCommands = useMemo(() => {
    const keys = new Set(chain.map(scopeKey));
    return savedCommands.filter((command) => keys.has(scopeKey(command.scope))).sort(byName);
  }, [chain, savedCommands]);

  const pageCount = Math.max(1, Math.ceil(visibleCommands.length / COMMANDS_PER_PAGE));
  // Switching tabs can shrink the list under the current page.
  const currentPage = Math.min(page, pageCount);
  const pageCommands = visibleCommands.slice(
    (currentPage - 1) * COMMANDS_PER_PAGE,
    currentPage * COMMANDS_PER_PAGE,
  );

  /**
   * Save and Update both go through the picker: it checks the input first
   * so an empty command is reported instead of asking where to file it.
   */
  const openSavePicker = () => {
    if (commandsLoading || libraryBusy) return;
    if (text.length === 0) {
      setStatus(editing ? t("sender.enterBeforeUpdate") : t("sender.enterBeforeSave"));
      return;
    }
    if (!editing && savedCommands.length >= MAX_SAVED_COMMANDS) {
      setStatus(t("sender.limitReached", { max: MAX_SAVED_COMMANDS }));
      return;
    }
    const rect = saveButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setSavePicker({ x: rect.right, y: rect.bottom + 2 });
  };

  const pickSaveScope = (scope: CommandScope) => {
    setSaveLevel(scope.type);
    storeSaveLevel(scope.type);
    if (editing) void updateCommand(scope);
    else void saveCommand(scope);
  };

  const saveCommand = async (scope: CommandScope) => {
    if (commandsLoading || libraryBusy) return;
    if (text.length === 0) {
      setStatus(t("sender.enterBeforeSave"));
      return;
    }
    if (savedCommands.length >= MAX_SAVED_COMMANDS) {
      setStatus(t("sender.limitReached", { max: MAX_SAVED_COMMANDS }));
      return;
    }

    const newCommand: SavedCommand = {
      id: "",
      name: tagName.trim() || firstLine(text),
      text,
      ending,
      scope,
    };
    const nextLength = savedCommands.length + 1;
    setLibraryBusy(true);
    try {
      const saved = await api.saveSenderCommand(newCommand);
      setSavedCommands((current) => [...current, saved]);
      setSelectedCommandId(saved.id);
      setTagName("");
      setStatus(
        t("sender.savedCommand", {
          n: nextLength,
          max: MAX_SAVED_COMMANDS,
          scope: labelOf(saved.scope),
        }),
      );
    } catch (error) {
      setStatus(t("sender.saveFailed", { error: String(error) }));
    } finally {
      setLibraryBusy(false);
    }
  };

  const replaceSaved = (saved: SavedCommand) =>
    setSavedCommands((current) =>
      current.map((candidate) => (candidate.id === saved.id ? saved : candidate)),
    );

  /** Saves `command` with `patch` applied, keeping an open edit in step. */
  const updateSaved = async (
    command: SavedCommand,
    patch: Partial<Pick<SavedCommand, "ending" | "scope">>,
  ) => {
    if (libraryBusy) return;
    setLibraryBusy(true);
    try {
      const saved = await api.saveSenderCommand({ ...command, ...patch });
      replaceSaved(saved);
      setEditing((current) =>
        current?.command.id === saved.id ? { ...current, command: saved } : current,
      );
      if (editing?.command.id === saved.id) setEnding(saved.ending);
    } catch (error) {
      setStatus(t("sender.updateFailed", { error: String(error) }));
    } finally {
      setLibraryBusy(false);
    }
  };

  /** Loads a saved tag into the inputs; Save becomes Update until done. */
  const beginEdit = (command: SavedCommand) => {
    if (libraryBusy) return;
    if (compact) onExpandedChange(true);
    closeMore();
    // The first Edit remembers whatever was typed; switching tags mid-edit
    // keeps that original draft so Cancel still restores it.
    const draft = editing?.draft ?? { text, tagName, ending };
    setEditing({ command, draft });
    setSelectedCommandId(command.id);
    setText(command.text);
    setTagName(
      command.name === command.text || command.name === firstLine(command.text) ? "" : command.name,
    );
    setEnding(command.ending);
  };

  const cancelEdit = () => {
    if (!editing) return;
    const { draft } = editing;
    setEditing(null);
    setText(draft.text);
    setTagName(draft.tagName);
    setEnding(draft.ending);
  };

  const updateCommand = async (scope: CommandScope) => {
    if (!editing || libraryBusy) return;
    if (text.length === 0) {
      setStatus(t("sender.enterBeforeUpdate"));
      return;
    }
    setLibraryBusy(true);
    try {
      const saved = await api.saveSenderCommand({
        ...editing.command,
        name: tagName.trim() || firstLine(text),
        text,
        ending,
        scope,
      });
      replaceSaved(saved);
      setSelectedCommandId(saved.id);
      setEditing(null);
      setTagName("");
      setStatus(t("sender.updated", { scope: labelOf(saved.scope) }));
    } catch (error) {
      setStatus(t("sender.updateFailed", { error: String(error) }));
    } finally {
      setLibraryBusy(false);
    }
  };

  const removeCommand = async (id: string) => {
    if (libraryBusy) return;
    setLibraryBusy(true);
    try {
      await api.deleteSenderCommand(id);
      setSavedCommands((current) => current.filter((command) => command.id !== id));
      if (selectedCommandId === id) setSelectedCommandId(null);
      if (contextMenu?.commandId === id) setContextMenu(null);
      if (editing?.command.id === id) cancelEdit();
    } catch (error) {
      setStatus(t("sender.deleteFailed", { error: String(error) }));
    } finally {
      setLibraryBusy(false);
    }
  };

  const emptyMessage = commandsLoading
    ? t("sender.loadingCommands")
    : savedCommands.length === 0
      ? t("sender.saveToAdd")
      : t("sender.noneApply");

  return {
    setStatus,
    visibleCommands,
    labelOf,
    emptyMessage,
    setSelectedCommandId,
    setContextMenu,
    editing,
    closeSavePicker,
    cancelEdit,
    openSavePicker,
    saveButtonRef,
    libraryBusy,
    savePicker,
    commandsLoading,
    savedCommands,
    chain,
    saveLevel,
    pickSaveScope,
    pageCount,
    currentPage,
    setPage,
    pageCommands,
    selectedCommandId,
    contextMenu,
    beginEdit,
    updateSaved,
    removeCommand,
    closeContextMenu,
  };
}
