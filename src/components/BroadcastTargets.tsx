import { isFileSession } from "../types";
import { broadcastTargets } from "../broadcast";
import { tabTitle, useStore } from "../store";
import { useT } from "../useT";
import { StatusPopover } from "./StatusPopover";
import { Icon } from "./icons";

/**
 * Which connected shells receive synchronized input. The mode turns itself off
 * when the last included shell is unchecked (see `setBroadcastPeer`), so this
 * popover can never leave a live indicator with nothing to write to.
 */
export function BroadcastTargets({ onClose }: { onClose: () => void }) {
  const t = useT();
  const tabs = useStore((s) => s.tabs);
  const sourceId = useStore((s) => s.activeId);
  const excluded = useStore((s) => s.broadcastExcluded);
  const excludedGroups = useStore((s) => s.broadcastExcludedGroups);
  const groups = useStore((s) => s.groups);
  const setPeer = useStore((s) => s.setBroadcastPeer);
  const setGroup = useStore((s) => s.setBroadcastGroup);
  const targets = broadcastTargets(tabs, sourceId, excluded, excludedGroups);
  const peers = tabs.filter(
    (tab) => tab.info.id !== sourceId && tab.state === "connected" && !isFileSession(tab.info.kind),
  );
  // Only groups that actually hold a target are offered: an empty group would
  // be a switch with nothing behind it.
  const peerGroups = groups.filter((group) =>
    peers.some((tab) => tab.profile?.groupId === group.id),
  );

  return (
    <StatusPopover
      className="broadcast-popover"
      label={t("broadcast.targets")}
      title={t("broadcast.targets")}
      closeLabel={t("common.close")}
      onClose={onClose}
    >
      <p className="broadcast-hint">{t("broadcast.targetsHint")}</p>
      {peerGroups.length > 0 && (
        <ul className="broadcast-list broadcast-groups">
          {peerGroups.map((group) => {
            const included = !excludedGroups.includes(group.id);
            return (
              <li key={group.id}>
                <label className="broadcast-peer">
                  <input
                    type="checkbox"
                    checked={included}
                    onChange={(event) => setGroup(group.id, event.target.checked)}
                  />
                  <span className="broadcast-peer-name">
                    {t("broadcast.group", { name: group.name })}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <ul className="broadcast-list">
        {peers.map((tab) => {
          const included = !excluded.includes(tab.info.id);
          return (
            <li key={tab.info.id}>
              <label className="broadcast-peer">
                <input
                  type="checkbox"
                  checked={included}
                  onChange={(event) => setPeer(tab.info.id, event.target.checked)}
                />
                <span className="broadcast-peer-name">{tabTitle(tab)}</span>
                <span className="broadcast-peer-address">{tab.info.address}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {peers.length === 0 && <p className="broadcast-hint">{t("broadcast.noPeers")}</p>}
      <p className="broadcast-count">
        <Icon name="broadcast" />
        {t("broadcast.on", { count: targets.length })}
      </p>
    </StatusPopover>
  );
}
