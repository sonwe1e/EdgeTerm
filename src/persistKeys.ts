/**
 * Every localStorage key this app persists, in one registry.
 *
 * A preference that is not registered here is invisible to "restore default
 * settings" and to settings export/import — a user who tuned it can never
 * reset or carry it. Registering a key is therefore part of adding a
 * preference, not an afterthought (see docs/engineering-standards.zh-CN.md).
 *
 * This module must stay dependency-free: the store and the panels both
 * import it, and neither may depend on the other for a string constant.
 */

/** Column order of the Filer and dual-pane file lists; see fileSort.ts. */
export const SORT_STORAGE_KEY = "edgeterm.filerSort";

/** The Sender's last repeat interval and count; see senderSchedule.ts. */
export const SENDER_REPEAT_KEY = "edgeterm.senderRepeat";

/** The Sender's last save-picker level; see senderScope.ts. */
export const SENDER_SAVE_LEVEL_KEY = "edgeterm.senderSaveLevel";

/** Applications files were last opened with; see the Filer panel. */
export const FILER_OPEN_WITH_KEY = "edgeterm.filerOpenWith";

/** Concurrency and durability of file transfers; see transferSettings.ts. */
export const TRANSFER_OPTIONS_KEY = "edgeterm.transfer-options";

/**
 * Panel preferences kept outside the app store. Their modules validate and
 * clamp on every load, so reset may simply remove the key and export may
 * carry the raw stored value. The store owns everything else and removes
 * its own keys in `resetSettings`.
 */
export const PANEL_PREFERENCE_KEYS: readonly string[] = [
  SENDER_REPEAT_KEY,
  SENDER_SAVE_LEVEL_KEY,
  FILER_OPEN_WITH_KEY,
  TRANSFER_OPTIONS_KEY,
];
