import {
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  ArrowRightIcon,
} from "lucide-react";

export function DirectionIcon({
  direction,
  label,
}: {
  /** `both` for a relation the ontology marks symmetric — the edge reads the same either way, so an
   * arrowhead on one end would claim a direction the model does not have. */
  direction: "left" | "right" | "both";
  label?: string;
}) {
  const Icon =
    direction === "both"
      ? ArrowLeftRightIcon
      : direction === "right"
        ? ArrowRightIcon
        : ArrowLeftIcon;
  if (label) {
    return (
      <span
        className="direction-icon"
        role="img"
        aria-label={label}
        title={label}
      >
        <Icon />
      </span>
    );
  }
  return (
    <span className="direction-icon" aria-hidden="true">
      <Icon />
    </span>
  );
}
