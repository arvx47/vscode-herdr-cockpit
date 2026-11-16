// Short numbers for the sidebar: durations ("45s", "1h 20m", "3d") and counts ("1.2M", "34k"). Shared by the
// extension, the webview (webview/sidebar) and tests. No imports, so the webview bundle can use it.

/** Hours and minutes from whole minutes, days past a day: "24m", "1h 20m", "2d 23h" (or "2d" with `daysOnly`). */
function hm(m: number, daysOnly: boolean): string {
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    if (m % 60) {
      return `${h}h ${m % 60}m`;
    }
    return `${h}h`;
  }
  const d = Math.floor(h / 24);
  if (daysOnly || !(h % 24)) {
    return `${d}d`;
  }
  return `${d}d ${h % 24}h`;
}

/** How long ago: seconds under a minute, then minutes, hours and minutes, days. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  return hm(Math.floor(s / 60), true);
}

/** Time left, to the minute (rounded up) under a day: "24m", "1h 20m", "2d 23h". */
export function left(ms: number): string {
  return hm(Math.max(0, Math.ceil(ms / 60000)), false);
}

/** 1.2M, 34k, 512. */
export function shortCount(n: number): string {
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(1)}M`;
  }
  if (n >= 1e3) {
    return `${Math.round(n / 1e3)}k`;
  }
  return `${n}`;
}

/** Wait this many milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
