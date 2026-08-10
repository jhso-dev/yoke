"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "../lib/i18n";

type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "yoke.theme";
const THEMES = ["system", "light", "dark"] as const;

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === "light") return <SunIcon />;
  if (theme === "dark") return <MoonIcon />;
  return <MonitorIcon />;
}

function chooseTheme(v: string | null): Theme {
  return v === "light" || v === "dark" ? v : "system";
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", dark);
}

export function ThemeSwitch() {
  const t = useT();
  const [theme, setThemeState] = useState<Theme>("system");
  const labels = {
    system: t.theme.system,
    light: t.theme.light,
    dark: t.theme.dark,
  };

  useEffect(() => {
    const stored = chooseTheme(localStorage.getItem(STORAGE_KEY));
    setThemeState(stored);
    applyTheme(stored);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (chooseTheme(localStorage.getItem(STORAGE_KEY)) === "system")
        applyTheme("system");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const setTheme = (next: Theme) => {
    setThemeState(next);
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  };

  return (
    <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
      {/* `aria-labelledby`, not `aria-label`: an aria-label REPLACES the subtree for name
          computation, so the sr-only current value was computed away and the control announced
          "theme, combobox" — a switch that says nothing about which theme is on. Pointing at a
          hidden label instead keeps both the name and the value. */}
      <span id="theme-switch-label" className="sr-only">
        {t.theme.label}
      </span>
      <SelectTrigger
        aria-labelledby="theme-switch-label"
        title={labels[theme]}
        size="sm"
        className="w-8 justify-center px-0 [&>svg:last-child]:hidden"
      >
        <ThemeIcon theme={theme} />
        <span className="sr-only">
          <SelectValue />
        </span>
      </SelectTrigger>
      {/* `position="popper"` because `align` is ignored in the default item-aligned mode — the menu
          asked to sit at the trigger's right edge and silently did not. */}
      <SelectContent position="popper" align="end">
        {THEMES.map((name) => (
          <SelectItem key={name} value={name}>
            <ThemeIcon theme={name} />
            <span>{labels[name]}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
