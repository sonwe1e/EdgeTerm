import { searchRegex, type RegexRequest } from "./terminalRegex";

self.onmessage = (event: MessageEvent<RegexRequest>) => {
  self.postMessage(searchRegex(event.data));
};
