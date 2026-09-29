import { useSyncExternalStore } from "react";
import { resolveTheme, type Theme, type ThemePref } from "./prefs";

const query = matchMedia("(prefers-color-scheme: dark)");
const subscribe = (cb: () => void) => {
  query.addEventListener("change", cb);
  return () => query.removeEventListener("change", cb);
};

export function useResolvedTheme(pref: ThemePref): Theme {
  const systemDark = useSyncExternalStore(subscribe, () => query.matches);
  return resolveTheme(pref, systemDark);
}
