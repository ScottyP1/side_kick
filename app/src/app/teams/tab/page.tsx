// The Teams tab / personal app (lib/teams/tab.ts). Client-rendered inside Teams: data loads after Teams single
// sign-on, so it opts out of instant-navigation validation.
export const instant = false;
export const metadata = { title: "Meetings" };
export { default } from "./view";
