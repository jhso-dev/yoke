/**
 * The header checkbox of a selectable table: three states from two numbers.
 *
 * `indeterminate` is a DOM property and not an attribute, so React cannot set it in JSX — the
 * component assigns it through a ref. Keeping the arithmetic here means the rule is testable
 * without a DOM, which is the only reason it is not inline.
 */
export function headerCheckState(
  total: number,
  chosen: number,
): { checked: boolean; indeterminate: boolean } {
  // An empty table is unchecked, never indeterminate: 0 of 0 would otherwise read as "all", and
  // clicking it would be a no-op that looks like a broken control.
  const checked = total > 0 && chosen === total;
  return { checked, indeterminate: chosen > 0 && chosen < total };
}
