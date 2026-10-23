/**
 * The icons on the Connectors page (app/(app)/connectors/view.tsx), one per tool, drawn white on the tool's colour.
 *
 * - GitHub, Jira and Confluence use their real logos (simple-icons, CC0; each company's brand rules allow showing
 *   the logo to say "connects to").
 * - Microsoft 365 tools, ServiceNow and Salesforce use plain icons that say what the tool is (Lucide, ISC licence):
 *   their official logos are only licensed through the companies' partner programs or a request form, so swap
 *   them in here once that permission exists (see docs/PROGRESS.md).
 *
 * Who may use it: client components only. Plain SVG, no data.
 */
import type { ReactNode } from "react";

/** Real logo: a filled 24×24 path. */
const logo = (d: string) => <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d={d} /></svg>;

/** Plain icon: Lucide line art on a 24×24 grid. */
const line = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

/** Icon for each connector, by the name shown on its tile. A tool with no entry falls back to its letters. */
export const CONNECTOR_ICONS: Record<string, ReactNode> = {
  "Document upload": line(<><path d="M12 3v12"/> <path d="m17 8-5-5-5 5"/> <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></>),
  "Teams transcripts": line(<><rect width="18" height="14" x="3" y="5" rx="2" ry="2"/> <path d="M7 15h4M15 15h2M7 11h2M13 11h4"/></>),
  "Teams chats and channels": line(<><path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/> <path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1"/></>),
  "Outlook": line(<><path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/> <rect x="2" y="4" width="20" height="16" rx="2"/></>),
  "SharePoint": line(<><path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/> <path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/> <path d="M3 5a2 2 0 0 0 2 2h3"/> <path d="M3 3v13a2 2 0 0 0 2 2h3"/></>),
  "OneDrive": line(<><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></>),
  "Planner": line(<><path d="M13 5h8"/> <path d="M13 12h8"/> <path d="M13 19h8"/> <path d="m3 17 2 2 4-4"/> <path d="m3 7 2 2 4-4"/></>),
  "Azure DevOps": line(<><path d="M5 3v14"/> <path d="M12 3v8"/> <path d="M19 3v18"/></>),
  "ServiceNow": line(<><circle cx="12" cy="12" r="10"/> <path d="m4.93 4.93 4.24 4.24"/> <path d="m14.83 9.17 4.24-4.24"/> <path d="m14.83 14.83 4.24 4.24"/> <path d="m9.17 14.83-4.24 4.24"/> <circle cx="12" cy="12" r="4"/></>),
  "Salesforce": line(<><path d="m11 17 2 2a1 1 0 1 0 3-3"/> <path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/> <path d="m21 3 1 11h-2"/> <path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/> <path d="M3 4h8"/></>),
  "GitHub": logo("M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"),
  "Jira": logo("M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z"),
  "Confluence": logo("M.87 18.257c-.248.382-.53.875-.763 1.245a.764.764 0 0 0 .255 1.04l4.965 3.054a.764.764 0 0 0 1.058-.26c.199-.332.454-.763.733-1.221 1.967-3.247 3.945-2.853 7.508-1.146l4.957 2.337a.764.764 0 0 0 1.028-.382l2.364-5.346a.764.764 0 0 0-.382-1 599.851 599.851 0 0 1-4.965-2.361C10.911 10.97 5.224 11.185.87 18.257zM23.131 5.743c.249-.405.531-.875.764-1.25a.764.764 0 0 0-.256-1.034L18.675.404a.764.764 0 0 0-1.058.26c-.195.335-.451.763-.734 1.225-1.966 3.246-3.945 2.85-7.508 1.146L4.437.694a.764.764 0 0 0-1.027.382L1.046 6.422a.764.764 0 0 0 .382 1c1.039.49 3.105 1.467 4.965 2.361 6.698 3.246 12.392 3.029 16.738-4.04z"),
};
