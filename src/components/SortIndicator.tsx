import type { FileSort, SortKey } from "../fileSort";
import { Icon } from "./icons";

/**
 * The arrow a sorted column's caption shows, from the same codicon set as
 * every other icon in the panels; null for an inactive column.
 */
export function SortIndicator({ sort, column }: { sort: FileSort; column: SortKey }) {
  if (sort.key !== column) return null;
  return (
    <>
      {" "}
      <Icon name={sort.direction === "asc" ? "arrow-up" : "arrow-down"} />
    </>
  );
}
