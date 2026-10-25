import { useStore } from "../store";
import { useT } from "../useT";
export function SshReuseSetting() {
  const enabled = useStore((state) => state.sshAutoReuse);
  const setEnabled = useStore((state) => state.setSshAutoReuse);
  const t = useT();
  return (
    <div className="ssh-reuse-setting">
      <label>
        <input
          type="checkbox"
          aria-label={t("sshReuse.aria")}
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />{" "}
        {t("sshReuse.label")}
      </label>
      <p>{t("sshReuse.hint")}</p>
    </div>
  );
}
