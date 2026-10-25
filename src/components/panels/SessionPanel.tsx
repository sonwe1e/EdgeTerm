import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from "react";

import { openSession, toggleSessionConnection } from "../../actions";
import * as api from "../../api";
import { errorText } from "../../errorInfo";
import { importSshConfig } from "../../dataTransfer";
import { t as translateMsg, type Translate } from "../../i18n";
import { ask } from "../../nativeDialog";
import {
  byName,
  childGroups,
  describeLocation,
  effectiveGroupId,
  flattenGroups,
  sectionLabel,
  SESSION_SECTIONS,
} from "../../sessionGroups";
import { tabTitle, useStore } from "../../store";
import {
  colorForSession,
  isSshTransport,
  type SavedCommand,
  type SessionGroup,
  type SessionKind,
  type SessionProfile,
  type SessionState,
} from "../../types";
import { useT } from "../../useT";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { DeleteProfileDialog } from "../DeleteProfileDialog";
import { GroupNameDialog } from "../GroupNameDialog";
import { Icon } from "../icons";
import { PublicKeyLoginDialog } from "../PublicKeyLoginDialog";
import { SshReuseSetting } from "../SshReuseSetting";

export const LOCAL_SHELL_PROFILE: SessionProfile = {
  id: "",
  name: "Local Shell",
  kind: "local",
  color: "#3fb950",
};

/** Tooltip of the power toggle, by the active tab's state. */
const powerTitles = (t: Translate): Record<SessionState, string> => ({
  connected: t("panel.powerDisconnect"),
  connecting: t("panel.powerConnecting"),
  closed: t("panel.powerReconnect"),
  error: t("panel.powerReconnect"),
});

/** Horizontal step per tree level; the kind headings sit at level 0. */
const INDENT = 18;

/** One-line connection target, used for the row tooltip and delete prompt. */
function describeProfile(profile: SessionProfile, jumpHost?: SessionProfile): string {
  const via = jumpHost ? `${translateMsg("session.via")}${jumpHost.name}` : "";
  switch (profile.kind) {
    case "ssh":
      return `${profile.username ?? ""}@${profile.host ?? ""}:${profile.port ?? 22}${via}`;
    case "sftp":
      return `${profile.username ?? ""}@${profile.host ?? ""}:${profile.port ?? 22}${via}`;
    case "telnet":
      return `telnet ${profile.host ?? ""}:${profile.port ?? 23}`;
    case "ftp":
      return `${profile.username || "anonymous"}@${profile.host ?? ""}:${profile.port ?? 21}`;
    case "serial":
      return `${profile.portName ?? ""} @ ${profile.baudRate ?? 115200}`;
    default:
      return profile.shell ?? translateMsg("session.defaultShell");
  }
}

/**
 * Whether a tree node is open. Kind headings start open so every section is
 * visible; groups start closed so a long list of servers folds down to its
 * top-level folders until the user opens one.
 */
function isOpen(open: Record<string, boolean>, key: string): boolean {
  return open[key] ?? key.startsWith("kind:");
}

type Row =
  | {
      type: "group";
      group: SessionGroup;
      depth: number;
      /** Profiles in the group and all of its subgroups. */
      count: number;
      collapsed: boolean;
    }
  | { type: "profile"; profile: SessionProfile; depth: number };

interface KindSection {
  kind: SessionKind;
  label: string;
  count: number;
  collapsed: boolean;
  rows: Row[];
}

/**
 * One visible row of the tree, in on-screen order, for the arrow keys. The
 * kind headings are rows too: they fold and unfold like a group.
 */
type TreeItem =
  | {
      id: string;
      type: "section";
      kind: SessionKind;
      level: number;
      collapsed: boolean;
    }
  | {
      id: string;
      type: "group";
      level: number;
      row: Extract<Row, { type: "group" }>;
    }
  | { id: string; type: "profile"; level: number; profile: SessionProfile };

/** Row ids for aria-activedescendant; a profile name may contain spaces. */
const profileRowId = (profile: SessionProfile): string =>
  `session-row-${encodeURIComponent(profile.id || profile.name)}`;

const groupRowId = (group: SessionGroup): string => `session-group-${encodeURIComponent(group.id)}`;

const sectionRowId = (kind: SessionKind): string => `session-kind-${kind}`;

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

type GroupDialogState =
  | { mode: "create"; kind: SessionKind; parentId: string | null }
  | { mode: "rename"; group: SessionGroup };

interface Props {
  onEditProfile: (profile: SessionProfile) => void;
  onNewSession: () => void;
}

export function SessionPanel({ onEditProfile, onNewSession }: Props) {
  const t = useT();
  const profiles = useStore((s) => s.profiles);
  const groups = useStore((s) => s.groups);
  const tabs = useStore((s) => s.tabs);
  const removeProfile = useStore((s) => s.removeProfile);
  const duplicateProfile = useStore((s) => s.duplicateProfile);
  const moveProfileToGroup = useStore((s) => s.moveProfileToGroup);
  const upsertGroup = useStore((s) => s.upsertGroup);
  const removeGroup = useStore((s) => s.removeGroup);
  const setStatus = useStore((s) => s.setStatus);
  // The header's power toggle acts on the active tab, like Session →
  // Disconnect / Reconnect Session.
  const activeTab = useStore((s) => s.tabs.find((tab) => tab.info.id === s.activeId));

  const [filter, setFilter] = useState("");
  /**
   * Explicit open / closed state of the tree, keyed `kind:<kind>` for
   * headings and `group:<id>` for groups. Anything not in here is at its
   * default — see `isOpen`.
   */
  const [open, setOpen] = useState<Record<string, boolean>>({});
  /**
   * Profile awaiting the user's answer in the delete-confirmation dialog,
   * with how many Sender commands are scoped to it alone (they go with it,
   * and the dialog says so).
   */
  const [pendingDelete, setPendingDelete] = useState<{
    profile: SessionProfile;
    scopedCommands: number;
  } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [groupDialog, setGroupDialog] = useState<GroupDialogState | null>(null);
  /**
   * Session whose public-key login is being set up in the dialog, with the
   * live tab the install and the check run against.
   */
  const [keySetup, setKeySetup] = useState<{
    profile: SessionProfile;
    sessionId: string;
  } | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);

  const filtering = filter.trim().length > 0;

  const sections = useMemo<KindSection[]>(() => {
    const needle = filter.trim().toLowerCase();
    // The built-in row follows the interface language; a tab opened from it
    // takes this name with it, so the strip and the tree agree.
    const localShell = { ...LOCAL_SHELL_PROFILE, name: t("panel.localShell") };
    const visible = [localShell, ...profiles].filter(
      (p) => !needle || p.name.toLowerCase().includes(needle),
    );

    return SESSION_SECTIONS.map((section) => {
      const byGroup = new Map<string | null, SessionProfile[]>();
      for (const profile of visible) {
        if (!section.kinds.includes(profile.kind)) continue;
        const groupId = effectiveGroupId(groups, profile);
        byGroup.set(groupId, [...(byGroup.get(groupId) ?? []), profile]);
      }
      for (const members of byGroup.values()) members.sort(byName);

      // Folders first, then the profiles at that level, both A→Z — the shape
      // of a file tree. While filtering, empty groups are dropped and
      // collapse state is ignored so every match is on screen.
      const walk = (parentId: string | null, depth: number): { rows: Row[]; count: number } => {
        const rows: Row[] = [];
        let count = 0;
        for (const group of childGroups(groups, section.kind, parentId)) {
          const sub = walk(group.id, depth + 1);
          if (needle && sub.count === 0) continue;
          const isCollapsed = !needle && !isOpen(open, `group:${group.id}`);
          rows.push({
            type: "group",
            group,
            depth,
            count: sub.count,
            collapsed: isCollapsed,
          });
          if (!isCollapsed) rows.push(...sub.rows);
          count += sub.count;
        }
        for (const profile of byGroup.get(parentId) ?? []) {
          rows.push({ type: "profile", profile, depth });
          count++;
        }
        return { rows, count };
      };

      const { rows, count } = walk(null, 1);
      return {
        kind: section.kind,
        label: sectionLabel(section.kind, t),
        count,
        collapsed: !needle && !isOpen(open, `kind:${section.kind}`),
        rows,
      };
    });
  }, [profiles, groups, filter, open, t]);

  /** Every visible row, in on-screen order, for the tree's arrow keys. */
  const treeItems = useMemo<TreeItem[]>(() => {
    const items: TreeItem[] = [];
    for (const section of sections) {
      items.push({
        id: sectionRowId(section.kind),
        type: "section",
        kind: section.kind,
        level: 1,
        collapsed: section.collapsed,
      });
      if (section.collapsed) continue;
      for (const row of section.rows) {
        items.push(
          row.type === "group"
            ? {
                id: groupRowId(row.group),
                type: "group",
                level: row.depth + 1,
                row,
              }
            : {
                id: profileRowId(row.profile),
                type: "profile",
                level: row.depth + 1,
                profile: row.profile,
              },
        );
      }
    }
    return items;
  }, [sections]);

  /**
   * The row the keyboard acts on. This is not a selection — the tree has no
   * selection model — so it is announced through aria-activedescendant and
   * the list itself is the single Tab stop.
   */
  const [activeId, setActiveId] = useState<string | null>(null);
  // A click marks a row active and then focuses the list, whose focus
  // handler must not read the state update still in flight.
  const activeIdRef = useRef<string | null>(null);
  const setActive = (id: string | null) => {
    activeIdRef.current = id;
    setActiveId(id);
  };
  const activeIndex = activeId === null ? -1 : treeItems.findIndex((item) => item.id === activeId);
  const currentIndex =
    activeIndex >= 0 ? activeIndex : activeId !== null && treeItems.length > 0 ? 0 : -1;
  const currentItem = currentIndex >= 0 ? treeItems[currentIndex] : undefined;
  const currentId = currentItem?.id ?? null;

  // Filtering or folding can hide the active row; the first row takes over.
  useEffect(() => {
    if (activeId !== null && activeIndex < 0) {
      const first = treeItems[0]?.id ?? null;
      activeIdRef.current = first;
      setActiveId(first);
    }
  }, [activeId, activeIndex, treeItems]);

  // Walking past the fold with the keyboard brings the row into view.
  useEffect(() => {
    if (currentId) {
      document.getElementById(currentId)?.scrollIntoView({ block: "nearest" });
    }
  }, [currentId]);

  /** Points the keyboard model at a row and keeps the tree focused. */
  const markActive = (id: string, target: HTMLElement) => {
    setActive(id);
    target.closest<HTMLElement>(".panel-body")?.focus({ preventScroll: true });
  };

  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keys pressed on a row's own button belong to that button.
    if (event.target !== event.currentTarget) return;
    if (treeItems.length === 0) return;
    const item = currentItem;
    const index = currentIndex;
    const moveTo = (next: number) => {
      const target = treeItems[next];
      if (target) setActive(target.id);
    };
    // The menu key — and Shift+F10, which every platform reports as F10 with
    // Shift held — opens what a right-click would, so a keyboard user reaches
    // the same row entries (edit, duplicate, move, delete). The rows answer a
    // real contextmenu event through their own handler, so one is dispatched
    // on the active row, anchored at its centre; the same approach as the
    // Filer panel's list. With the tree non-empty the active row always
    // exists (see `currentIndex`), so the anchor is always a row.
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      event.stopPropagation();
      const target = document.getElementById(currentId ?? "");
      const rect = target?.getBoundingClientRect();
      target?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect ? rect.left + rect.width / 2 : 0,
          clientY: rect ? rect.top + rect.height / 2 : 0,
        }),
      );
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveTo(index < 0 ? 0 : Math.min(treeItems.length - 1, index + 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        moveTo(index < 0 ? 0 : Math.max(0, index - 1));
        return;
      case "Home":
        event.preventDefault();
        moveTo(0);
        return;
      case "End":
        event.preventDefault();
        moveTo(treeItems.length - 1);
        return;
      case "ArrowRight": {
        event.preventDefault();
        if (!item || index < 0) return;
        const next = treeItems[index + 1];
        if (item.type === "section" && item.collapsed) {
          toggle(`kind:${item.kind}`);
        } else if (item.type === "group" && item.row.collapsed) {
          toggle(`group:${item.row.group.id}`);
        } else if (next && next.level > item.level) {
          moveTo(index + 1);
        }
        return;
      }
      case "ArrowLeft": {
        event.preventDefault();
        if (!item || index < 0) return;
        if (item.type === "section" && !item.collapsed) {
          toggle(`kind:${item.kind}`);
          return;
        }
        if (item.type === "group" && !item.row.collapsed) {
          toggle(`group:${item.row.group.id}`);
          return;
        }
        for (let cursor = index - 1; cursor >= 0; cursor--) {
          const candidate = treeItems[cursor];
          if (candidate && candidate.level < item.level) {
            moveTo(cursor);
            return;
          }
        }
        return;
      }
      case "Enter":
      case " ": {
        event.preventDefault();
        if (!item) return;
        if (item.type === "profile") void openSession(item.profile);
        else if (item.type === "group") toggle(`group:${item.row.group.id}`);
        else toggle(`kind:${item.kind}`);
        return;
      }
    }
  };

  const toggle = (key: string) => setOpen((prev) => ({ ...prev, [key]: !isOpen(prev, key) }));

  const openMenu = (event: MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const report = (what: string, error: unknown) => setStatus(`${what}: ${errorText(error)}`);

  const listSenderCommands = () => api.listSenderCommands().catch((): SavedCommand[] => []);

  /** Opens the delete dialog, counting the Sender commands that go with it. */
  const askDeleteProfile = async (profile: SessionProfile) => {
    const commands = await listSenderCommands();
    const scopedCommands = commands.filter(
      (command) => command.scope.type === "profile" && command.scope.id === profile.id,
    ).length;
    setPendingDelete({ profile, scopedCommands });
  };

  const confirmDeleteGroup = async (group: SessionGroup) => {
    const inSubtree = (groupId: string | null) => {
      let cursor = groupId;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        if (cursor === group.id) return true;
        seen.add(cursor);
        cursor = groups.find((g) => g.id === cursor)?.parentId ?? null;
      }
      return false;
    };
    const insideProfiles = profiles.filter((p) => inSubtree(effectiveGroupId(groups, p)));
    const insideIds = new Set(insideProfiles.map((p) => p.id));
    // Everything scoped to the subtree goes with it: commands of the groups
    // and commands of the sessions in them.
    const scopedCommands = (await listSenderCommands()).filter(
      (command) =>
        (command.scope.type === "group" && inSubtree(command.scope.id)) ||
        (command.scope.type === "profile" && insideIds.has(command.scope.id)),
    ).length;
    const sessions =
      insideProfiles.length === 1
        ? t("panel.oneSession")
        : t("panel.manySessions", { count: insideProfiles.length });
    const commands =
      scopedCommands === 1
        ? t("panel.oneSavedCommand")
        : t("panel.manySavedCommands", { count: scopedCommands });
    const contents = [insideProfiles.length > 0 && sessions, scopedCommands > 0 && commands].filter(
      (part): part is string => typeof part === "string",
    );
    const consequence =
      contents.length === 0
        ? t("panel.groupEmpty")
        : t("panel.groupDeleteConsequence", {
            contents: contents.join(" and "),
          });
    const confirmed = await ask(t("panel.deleteGroupPrompt", { name: group.name, consequence }), {
      title: t("panel.deleteGroupTitle"),
      kind: "warning",
      okLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
    });
    if (!confirmed) return;
    try {
      await removeGroup(group.id);
      setStatus(t("panel.groupDeleted", { name: group.name }));
    } catch (error) {
      report(t("panel.failedDeleteGroup"), error);
    }
  };

  const kindMenu = (kind: SessionKind): MenuItem[] => [
    {
      label: t("panel.newGroup"),
      icon: "new-folder",
      action: () => setGroupDialog({ mode: "create", kind, parentId: null }),
    },
    // The hosts people already `ssh` to, in bulk.
    ...(kind === "ssh"
      ? [
          "separator" as const,
          {
            label: t("menu.importOpenSshConfig"),
            icon: "server-environment" as const,
            action: () => void importSshConfig(),
          },
        ]
      : []),
  ];

  const groupMenu = (group: SessionGroup): MenuItem[] => [
    {
      label: t("panel.newSubgroup"),
      icon: "new-folder",
      action: () =>
        setGroupDialog({
          mode: "create",
          kind: group.kind,
          parentId: group.id,
        }),
    },
    "separator",
    {
      label: t("panel.renameGroup"),
      icon: "rename",
      action: () => setGroupDialog({ mode: "rename", group }),
    },
    {
      label: t("panel.deleteGroup"),
      icon: "trash",
      danger: true,
      action: () => void confirmDeleteGroup(group),
    },
  ];

  const profileMenu = (profile: SessionProfile): MenuItem[] => {
    const connect: MenuItem = {
      label: t("panel.connect"),
      icon: "plug",
      action: () => void openSession(profile),
    };
    // The built-in Local Shell is not a saved profile: nothing to edit or move.
    if (!profile.id) return [connect];

    // Key setup runs against the profile's own live session — the install
    // rides that connection and the check opens a fresh one beside it — so
    // the entry waits until such a session is up.
    const live = tabs.find(
      (tab) =>
        tab.profile.id === profile.id && tab.state === "connected" && isSshTransport(tab.info.kind),
    );
    const keyLogin: MenuItem = {
      label: t("panel.setUpKeyLogin"),
      icon: "key",
      disabled: !live,
      action: () => {
        if (live) setKeySetup({ profile, sessionId: live.info.id });
      },
    };

    const current = effectiveGroupId(groups, profile);
    const move = (groupId: string | null) => () =>
      moveProfileToGroup(profile.id, groupId).catch((error) =>
        report(t("panel.failedMoveSession"), error),
      );
    const choices: MenuItem[] = [
      {
        label: t("session.noGroup", { section: sectionLabel(profile.kind, t) }),
        checked: current === null,
        mark: "radio",
        action: move(null),
      },
    ];
    const nodes = flattenGroups(groups, profile.kind);
    if (nodes.length > 0) {
      choices.push("separator");
      for (const { group, depth } of nodes) {
        choices.push({
          label: group.name,
          indent: depth,
          checked: current === group.id,
          mark: "radio",
          action: move(group.id),
        });
      }
    } else {
      choices.push({ label: t("panel.noGroupsYet"), disabled: true });
    }

    return [
      connect,
      // A key login only exists for the SSH transports; the entry stays
      // visible but waits, so it is discoverable before connecting.
      ...(isSshTransport(profile.kind) ? [keyLogin] : []),
      {
        label: t("panel.editEllipsis"),
        icon: "edit",
        action: () => onEditProfile(profile),
      },
      {
        label: t("panel.duplicate"),
        icon: "copy",
        // Most copies differ from the original in the host or the name, so
        // the copy opens in the editor straight away.
        action: () =>
          void duplicateProfile(profile.id).then(onEditProfile, (error) =>
            report(t("panel.failedDuplicateSession"), error),
          ),
      },
      { label: t("panel.moveToGroup"), icon: "move", children: choices },
      "separator",
      {
        label: t("panel.deleteEllipsis"),
        icon: "trash",
        danger: true,
        action: () => void askDeleteProfile(profile),
      },
    ];
  };

  const renderProfile = (profile: SessionProfile, depth: number) => {
    const id = profileRowId(profile);
    return (
      <div
        key={profile.id || profile.name}
        id={id}
        role="treeitem"
        aria-level={depth + 1}
        // Not a selection model: the row is never "selected", but a treeitem
        // without aria-selected reads as selectable to some screen readers.
        aria-selected={false}
        className={`row${currentId === id ? " is-active" : ""}`}
        style={{ paddingLeft: 6 + INDENT * depth }}
        onMouseDown={(event) => {
          if (event.button === 0) markActive(id, event.currentTarget);
        }}
        onDoubleClick={() => void openSession(profile)}
        onContextMenu={(event) => openMenu(event, profileMenu(profile))}
        title={describeProfile(
          profile,
          profiles.find((p) => p.id && p.id === profile.jumpProfileId),
        )}
      >
        <span
          className="row-dot"
          style={{
            background: profile.color ?? colorForSession(profile.id || profile.name),
          }}
        />
        <span className="row-label">{profile.name}</span>
        {/* SSH and Telnet share a section; the rarer protocol is marked. */}
        {profile.kind === "telnet" && <span className="row-meta">telnet</span>}
        {profile.id && (
          <>
            {/* Mouse affordances beside a keyboard-driven tree: the press
                must not pull focus off the list, the way the Sender's send
                button keeps it (a keyboard activation still focuses the
                button), and the buttons stay out of the Tab order — the
                tree is the single stop, and ContextMenu / Shift+F10 reach
                these actions through the row menu. */}
            <button
              className="panel-action"
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                onEditProfile(profile);
              }}
              title={t("panel.edit")}
              aria-label={t("panel.edit")}
            >
              <Icon name="edit" />
            </button>
            <button
              className="panel-action"
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                void askDeleteProfile(profile);
              }}
              title={t("common.delete")}
              aria-label={t("common.delete")}
            >
              <Icon name="close" />
            </button>
          </>
        )}
      </div>
    );
  };

  const renderGroup = (row: Extract<Row, { type: "group" }>) => {
    const id = groupRowId(row.group);
    return (
      // Location breadcrumb doubles as the hint that a menu exists here.
      <div
        key={`group:${row.group.id}`}
        id={id}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={!row.collapsed}
        className={`row is-group${currentId === id ? " is-active" : ""}`}
        style={{ paddingLeft: 6 + INDENT * row.depth }}
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          markActive(id, event.currentTarget);
          toggle(`group:${row.group.id}`);
        }}
        onContextMenu={(event) => openMenu(event, groupMenu(row.group))}
        title={`${describeLocation(
          groups,
          row.group.kind,
          row.group.id,
          t,
        )} · ${t("panel.rightClickOptions")}`}
      >
        <span className={`row-caret${row.collapsed ? "" : " is-open"}`}>
          <Icon name="chevron-right" />
        </span>
        <Icon name={row.collapsed ? "folder" : "folder-opened"} className="row-folder" />
        <span className="row-label">{row.group.name}</span>
        <span className="row-meta">{row.count}</span>
      </div>
    );
  };

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-header">
        <div className="panel-title is-session">
          <Icon name="server" />
          {t("panel.sessions")}
        </div>
        <button
          className={`panel-action panel-power${
            activeTab?.state === "connected" ? " is-connected" : ""
          }${activeTab?.state === "connecting" ? " is-connecting" : ""}`}
          // A connect in flight is cancellable (see `disconnectSession`), so
          // the most visible switch stays live: only a missing active tab
          // leaves nothing to act on. The connecting state is told apart by
          // the pulsing `is-connecting` style and the "cancel connection"
          // title, not by a dead button.
          disabled={!activeTab}
          onClick={() => {
            if (activeTab) toggleSessionConnection(activeTab.info.id);
          }}
          title={
            activeTab
              ? `${powerTitles(t)[activeTab.state]} · ${tabTitle(activeTab)}`
              : t("panel.noActiveSession")
          }
          aria-label={activeTab ? powerTitles(t)[activeTab.state] : t("panel.powerDisconnect")}
        >
          {/* Power symbol: an open ring with a bar through the gap. */}
          <Icon name="plug" />
        </button>
        <button
          className="panel-action"
          onClick={onNewSession}
          title={t("panel.newSession")}
          aria-label={t("panel.newSession")}
        >
          <Icon name="add" />
        </button>
      </div>

      <div className="panel-filter">
        <span className="panel-filter-icon" aria-hidden="true">
          <Icon name="search" />
        </span>
        <input
          value={filter}
          placeholder={t("panel.filterSessions")}
          aria-label={t("panel.filterSessions")}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      <details className="ssh-connection-options">
        <summary>{t("panel.sshConnections")}</summary>
        <SshReuseSetting />
      </details>
      <div
        className="panel-body"
        role="tree"
        aria-label={t("panel.sessionTree")}
        aria-activedescendant={currentId ?? undefined}
        tabIndex={0}
        onFocus={(event) => {
          if (event.target === event.currentTarget && activeIdRef.current === null) {
            setActive(treeItems[0]?.id ?? null);
          }
        }}
        onKeyDown={onTreeKeyDown}
      >
        {sections.map((section) => {
          const id = sectionRowId(section.kind);
          return (
            <div key={section.kind}>
              <div
                id={id}
                role="treeitem"
                aria-level={1}
                aria-expanded={!section.collapsed}
                className={`row is-section${currentId === id ? " is-active" : ""}`}
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  markActive(id, event.currentTarget);
                  toggle(`kind:${section.kind}`);
                }}
                onContextMenu={(event) => openMenu(event, kindMenu(section.kind))}
                title={t("panel.rightClickAddGroup")}
              >
                <span className={`row-caret${section.collapsed ? "" : " is-open"}`}>
                  <Icon name="chevron-right" />
                </span>
                <span className="row-label">{sectionLabel(section.kind, t)}</span>
                <span className="row-meta">{section.count}</span>
              </div>

              {!section.collapsed &&
                section.rows.map((row) =>
                  row.type === "group" ? renderGroup(row) : renderProfile(row.profile, row.depth),
                )}
            </div>
          );
        })}
        {filtering && sections.every((section) => section.count === 0) && (
          <div className="panel-empty">
            <span>{t("panel.noMatches", { filter: filter.trim() })}</span>
            {/* The filter is the reason the list is empty, so the way out of
                it belongs here rather than only in the field. */}
            <button type="button" className="panel-empty-action" onClick={() => setFilter("")}>
              {t("panel.clearFilter")}
            </button>
          </div>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}

      {groupDialog &&
        (groupDialog.mode === "create" ? (
          <GroupNameDialog
            title={groupDialog.parentId ? t("panel.newSubgroup") : t("panel.newGroup")}
            location={describeLocation(groups, groupDialog.kind, groupDialog.parentId, t)}
            submitLabel={t("panel.create")}
            onSubmit={async (name) => {
              const saved = await upsertGroup({
                id: "",
                name,
                kind: groupDialog.kind,
                parentId: groupDialog.parentId,
              });
              // A new group is empty, so make sure its parents are open.
              setOpen((prev) => ({
                ...prev,
                [`kind:${saved.kind}`]: true,
                ...(saved.parentId ? { [`group:${saved.parentId}`]: true } : {}),
              }));
              setGroupDialog(null);
            }}
            onCancel={() => setGroupDialog(null)}
          />
        ) : (
          <GroupNameDialog
            title={t("panel.renameGroup")}
            location={describeLocation(
              groups,
              groupDialog.group.kind,
              groupDialog.group.parentId,
              t,
            )}
            initialName={groupDialog.group.name}
            submitLabel={t("panel.rename")}
            onSubmit={async (name) => {
              await upsertGroup({ ...groupDialog.group, name });
              setGroupDialog(null);
            }}
            onCancel={() => setGroupDialog(null)}
          />
        ))}

      {pendingDelete && (
        <DeleteProfileDialog
          profile={pendingDelete.profile}
          target={describeProfile(pendingDelete.profile)}
          scopedCommands={pendingDelete.scopedCommands}
          onConfirm={() => {
            // Dismiss first so a second Enter cannot re-enter removeProfile
            // while the backend delete is still in flight.
            setPendingDelete(null);
            void removeProfile(pendingDelete.profile.id);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {keySetup && (
        <PublicKeyLoginDialog
          profile={keySetup.profile}
          sessionId={keySetup.sessionId}
          onConfigured={(login) => {
            // The backend saved the new login; the live tab keeps a profile
            // copy of its own, and a reconnect has to dial with the key, not
            // the login the tab was opened with.
            const store = useStore.getState();
            const tab = store.tabs.find((item) => item.info.id === keySetup.sessionId);
            if (tab) {
              store.updateTabProfile(keySetup.sessionId, {
                ...tab.profile,
                auth: "publicKey",
                privateKeyPath: login.privateKeyPath,
                passphrase: login.passphrase,
              });
            }
            void store.loadProfiles();
          }}
          onClose={() => setKeySetup(null)}
        />
      )}
    </div>
  );
}
