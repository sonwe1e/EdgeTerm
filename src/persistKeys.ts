/**
 * Panel preference keys shared with the settings import/export/reset paths.
 *
 * A preference that is not registered here is invisible to "restore default
 * settings" and to settings export/import — a user who tuned it can never
 * reset or carry it. Registering a key is therefore part of adding a
 * preference, not an afterthought (see docs/engineering-standards.zh-CN.md).
 * The app store still declares and handles its own existing keys.
 *
 * This module must stay dependency-free: the store and the panels both
 * import it, and neither may depend on the other for a string constant.
 */

/** Column order of the Filer and dual-pane file lists; see fileSort.ts. */
export const SORT_STORAGE_KEY = "edgeterm.filerSort";

/** Dock widths and the Sender's expanded state; see panelSizing.ts. */
export const PANEL_SIZING_KEY = "edgeterm.panelSizing";

/** The Sender's last repeat interval and count; see senderSchedule.ts. */
export const SENDER_REPEAT_KEY = "edgeterm.senderRepeat";

/** The Sender's last save-picker level; see senderScope.ts. */
export const SENDER_SAVE_LEVEL_KEY = "edgeterm.senderSaveLevel";

/** Applications files were last opened with; see the Filer panel. */
export const FILER_OPEN_WITH_KEY = "edgeterm.filerOpenWith";

/** Dragged widths of the Filer's columns; see filerColumns.ts. */
export const FILER_COLUMNS_KEY = "edgeterm.filerColumns";

/** Whether the Filer shows its size column; see filerColumns.ts. */
export const FILER_SIZE_VISIBLE_KEY = "edgeterm.filerSizeVisible";

/** Workbench view, last project, experiment memory and open files. */
export const WORKBENCH_VIEW_KEY = "edgeterm.workbench.view";
export const WORKBENCH_LAST_PROJECT_KEY = "edgeterm.workbench.lastWorkspace";
export const WORKBENCH_EXPERIMENTS_KEY = "edgeterm.workbench.experiments";
export const WORKBENCH_OPEN_FILES_KEY = "edgeterm.workbench.openFiles";

/** Concurrency and durability of file transfers; see transferSettings.ts. */
export const TRANSFER_OPTIONS_KEY = "edgeterm.transfer-options";
export const RESOURCE_MONITOR_KEY = "edgeterm.resource-monitor";

/**
 * Panel preferences kept outside the app store. Their modules validate and
 * clamp on every load, so reset may simply remove the key and export may
 * carry the raw stored value. The store owns everything else and removes
 * its own keys in `resetSettings`.
 */
export const PANEL_PREFERENCE_KEYS: readonly string[] = [
  PANEL_SIZING_KEY,
  SENDER_REPEAT_KEY,
  SENDER_SAVE_LEVEL_KEY,
  FILER_OPEN_WITH_KEY,
  FILER_COLUMNS_KEY,
  FILER_SIZE_VISIBLE_KEY,
  TRANSFER_OPTIONS_KEY,
  RESOURCE_MONITOR_KEY,
  WORKBENCH_VIEW_KEY,
  WORKBENCH_LAST_PROJECT_KEY,
  WORKBENCH_EXPERIMENTS_KEY,
  WORKBENCH_OPEN_FILES_KEY,
];
