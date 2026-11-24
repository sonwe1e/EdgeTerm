import { describe, expect, it } from "vitest";
import { attentionSessions } from "./components/TabStrip";
import type { Tab } from "./store";

/** A tab in `pane` with the given command activity and state. */
const tab = (id: string, pane: string, activity: string, state: string): Tab =>
  ({
    info: { id, name: id },
    paneId: pane,
    commandActivity: activity,
    state,
  }) as unknown as Tab;

describe("attentionSessions", () => {
  const shown = tab("shown", "left", "idle", "connected");
  const finished = tab("finished", "right", "complete", "connected");
  const failed = tab("failed", "right", "idle", "error");
  const quiet = tab("quiet", "right", "idle", "connected");

  it("reports what a pane covers while that pane is zoomed", () => {
    // The other strips are unmounted while one pane is zoomed, so the zoomed
    // strip's list has to carry their attention: without this a background
    // session finishing or ringing the bell looks like nothing happened.
    const ids = attentionSessions([shown, finished, failed, quiet], "shown").map(
      (item) => item.info.id,
    );
    expect(ids).toEqual(["finished", "failed"]);
  });

  it("reports nothing when the scope it was handed holds nothing pending", () => {
    // The caller hands over the pane's own tabs while nothing is zoomed, so
    // a finished command in another pane simply is not in the list.
    const own = attentionSessions([shown, quiet], "shown");
    expect(own).toEqual([]);
  });

  it("never reports the session already on screen", () => {
    const onScreen = tab("shown", "left", "complete", "error");
    expect(attentionSessions([onScreen], "shown")).toEqual([]);
  });
});
