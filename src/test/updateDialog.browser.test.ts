import { createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { UpdateDialog } from "../components/UpdateDialog";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

const locale = vi.hoisted(() => ({ language: "en" as "en" | "zh-CN" }));
vi.mock("../useT", async () => {
  const { translate } = await import("../i18n");
  return {
    useT: () => (key: import("../i18n").MessageKey, params?: Record<string, string | number>) =>
      translate(locale.language, key, params),
  };
});

afterEach(async () => {
  await browserAfterEach();
  document.documentElement.removeAttribute("data-theme");
});

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [760, 1280]) {
    it(`explains manual updates with reachable controls in ${language} at ${width}px`, async () => {
      locale.language = language;
      const theme = width === 760 ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", theme);
      await page.viewport(width, 800);
      const open = vi.fn();
      const close = vi.fn();
      mount(
        h(UpdateDialog, {
          appVersion: "1.2.8",
          state: { phase: "manual" },
          onDismiss: close,
          onOpenDownloads: open,
        }),
      );
      await twoFrames();
      const body = document.querySelector<HTMLElement>(".update-dialog-body")!;
      expect(body.textContent).toContain("sonwe1e/EdgeTerm");
      expect(body.textContent).toContain("1.2.8");
      expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth + 1);
      expect(document.querySelector("progress")).toBeNull();
      const button = page.getByRole("button", {
        name: language === "en" ? "Open This Fork's Releases" : "打开本分支发布页",
        exact: true,
      });
      await page.screenshot({
        path: `../../.tmp/records/history-cleanup/update-${language}-${theme}.png`,
      });
      await userEvent.click(button);
      expect(open).toHaveBeenCalledOnce();
      await userEvent.keyboard("{Escape}");
      expect(close).toHaveBeenCalled();
    });
  }
}
