import { expect, it } from "vitest";
import { opensFilter } from "./filterKey";

const event = (
  key: string,
  extra: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {},
) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...extra,
});

it("claims a bare slash", () => {
  expect(opensFilter(event("/"))).toBe(true);
  expect(opensFilter(event("/", { ctrlKey: true }))).toBe(false);
  expect(opensFilter(event("/", { metaKey: true }))).toBe(false);
  expect(opensFilter(event("/", { altKey: true }))).toBe(false);
});

it("leaves every other key alone", () => {
  expect(opensFilter(event("?"))).toBe(false);
  expect(opensFilter(event("a"))).toBe(false);
  expect(opensFilter(event("ArrowDown"))).toBe(false);
  expect(opensFilter(event("Escape"))).toBe(false);
});
