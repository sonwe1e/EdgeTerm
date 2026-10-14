import { useStore } from "../store";
export function SshReuseSetting() {
  const enabled = useStore((state) => state.sshAutoReuse);
  const setEnabled = useStore((state) => state.setSshAutoReuse);
  return <div className="ssh-reuse-setting">
    <label><input type="checkbox" aria-label="Automatically reuse authenticated SSH connections" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Reuse authenticated SSH connections</label>
    <p>New SSH and SFTP tabs with the same connection and authentication settings share a connection. Turn off to log in separately. Existing tabs and Duplicate SSH Channel keep their current connections.</p>
  </div>;
}
