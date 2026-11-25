import * as api from "./api";

/**
 * How a forward reads back to the reader: `host:port`, bracketing an IPv6
 * literal; port 0 reads as "automatic". These two rules were copied verbatim
 * into SessionDialog, SshConfigImportDialog and ForwardCenter - the bracketing
 * rule and the "a dynamic forward names no target" rule lived in three places,
 * so a fourth forward surface would have copied them a fourth time.
 */
export const endpoint = (host: string, port: number, auto: string) =>
  `${host.includes(":") ? `[${host}]` : host}:${port || auto}`;

/** One forward as `listen → target`; a dynamic (SOCKS5) forward names no target. */
export const forwardRoute = (spec: api.PortForwardSpec, auto: string) => {
  const listen = endpoint(spec.listenHost, spec.listenPort, auto);
  if (spec.direction === "dynamic") return listen;
  const host = spec.targetHost ?? "";
  return `${listen} → ${host ? endpoint(host, spec.targetPort ?? 0, auto) : ""}`;
};
