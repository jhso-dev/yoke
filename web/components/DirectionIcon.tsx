import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";

export function DirectionIcon({
  direction,
  label,
}: {
  direction: "left" | "right";
  label?: string;
}) {
  const Icon = direction === "right" ? ArrowRightIcon : ArrowLeftIcon;
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
