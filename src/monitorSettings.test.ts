import { beforeEach,expect,it } from "vitest";
import { readMonitorSettings,saveMonitorSettings } from "./monitorSettings";
beforeEach(()=>localStorage.clear());
it("preserves legitimate fields and rejects damaged intervals",()=>{
  expect(readMonitorSettings()).toEqual({enabled:true,intervalSeconds:2});
  localStorage.setItem("edgeterm.resource-monitor",'{"enabled":false,"intervalSeconds":999,"unknown":1}');
  expect(readMonitorSettings()).toEqual({enabled:false,intervalSeconds:2});
  saveMonitorSettings({enabled:true,intervalSeconds:30});expect(readMonitorSettings().intervalSeconds).toBe(30);
  localStorage.setItem("edgeterm.resource-monitor","{broken");expect(readMonitorSettings().intervalSeconds).toBe(2);
});
