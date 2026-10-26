/**
 * @file Makes the Teams tab and tab-setup pages follow Teams' own theme instead of the device setting.
 *
 * Teams tells an embedded page its theme ("default" = light, "dark", "contrast") in the context and again whenever
 * the person switches. The portal's colors (globals.css) switch on `data-theme` on `<html>`, so this sets it.
 * Inside a meeting (side panel or meeting stage) the page is always dark: a Teams Store rule for meeting apps.
 *
 * Who may call it: the client pages under src/app/teams, after `app.initialize()` succeeded.
 */

/** The bits of @microsoft/teams-js this needs (typed loosely so the SDK is still imported lazily by the pages). */
type TeamsApp = { registerOnThemeChangeHandler: (handler: (theme: string) => void) => void };
type TeamsContext = { app?: { theme?: string }; page?: { frameContext?: string } };

/** "light" or "dark" for a Teams theme name; meetings are always dark. */
export function themeFor(theme: string | undefined, frameContext?: string): "light" | "dark" {
  if (frameContext === "sidePanel" || frameContext === "meetingStage") return "dark";
  return theme === "dark" || theme === "contrast" ? "dark" : "light";
}

/** Applies Teams' current theme to the page and keeps following it when the person changes it in Teams. */
export function followTeamsTheme(app: TeamsApp, ctx: TeamsContext) {
  const frame = ctx.page?.frameContext;
  const apply = (theme?: string) => document.documentElement.setAttribute("data-theme", themeFor(theme, frame));
  apply(ctx.app?.theme);
  app.registerOnThemeChangeHandler(apply);
}
