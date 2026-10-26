# Sidekick guides

Plain-language guides for the people who use Sidekick. Start with **Concepts** if you're new.

| Guide | For | What's in it |
|---|---|---|
| [Concepts](concepts.md) | Everyone | The words Sidekick uses (workspace, sources, gaps, client guests, ...) and how it keeps client data apart |
| [Admin guide](admin-guide.md) | Org Owners and Org Admins | Signing up, plan and billing (test mode), plan limits and the monthly AI allowance, the usage export, setting up the organization, people, workspaces, documents, meetings, Teams channels, audit and usage |
| [Sidekick in Teams](teams-guide.md) | Everyone in Teams | Asking questions, meeting notes, action-item cards, commands, what Sidekick can and can't see |
| [Meetings and automatic notes](meetings.md) | Everyone | Automatic notes after Teams meetings, which group a meeting goes to, adding a past or outside meeting, the notes chat, Save to knowledge, the Sidekick tab in Teams |
| [Connect your tools](connect-devops-jira.md) | Org Owners, Org Admins and Team Leads | Connecting Azure DevOps, Jira, GitHub, Confluence, SharePoint or OneDrive (read-only), linking projects, repositories, spaces, libraries and folders to groups, what Sidekick reads, health, unlinking and disconnecting |
| [Install Sidekick as an app](install-app.md) | Everyone | Installing the portal with its own window and icon on a computer, iPhone or Android, and what that does and doesn't store |
| [Owner Console](owner-guide.md) | The Sidekick operator | The business view (MRR, margin, trials, payments, limits, health), every client's spend and health, onboarding clients, plans, limits and AI credit, the sign-up switch, kill switches |

All guides except the Owner Console guide are also published as the website's **help center** (`/docs`, searchable). After editing one, run `npm --prefix app run help:sync` so the app's copy matches (a test checks). Wrap developer-only lines in `<!-- help-center:skip -->` … `<!-- /help-center:skip -->` to keep them off the website. The Owner Console guide is never published.

For developers: [ARCHITECTURE.md](../ARCHITECTURE.md) explains how the code fits together, and [PROGRESS.md](../PROGRESS.md) has current status and next steps.
