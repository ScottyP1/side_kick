# Owner Console guide

For the **Sidekick operator** (whoever runs Sidekick as a service), not for client users. The console lives at `/owner` and has its own sign-in, separate from every client account.

## First sign-in
The first owner account can only be created **on the machine running Sidekick** (open `http://localhost:3000/owner`). After that, sign in at `/owner/login`. Owner sessions last 12 hours.

## Pages
| Page | Shows |
|---|---|
| **Overview** | AI spend (today, this month, projected), number of clients, error rate, response time, spend per day and per client, latest errors |
| **Clients** | Every client organization: users, workspaces, meetings, documents, monthly spend, errors. **Add a client** creates the organization and its Org Owner with a one-time password (shown once). **Pause / Resume** turns a client's access off or on |
| **Performance & errors** | Typical and slowest response times, error rates and prompt-cache savings per feature and model; failed AI requests; processing health per client; **App errors**: every unexpected problem with the **reference code** the person saw, so you can look up a code a client sends you |
| **Releases & switches** | Running version and commit, models in use, **kill switches**, operator log |

## Kill switches
Each switch pauses one AI feature **for every client at once**: answering questions, meeting notes, knowledge map, or document uploads. Use it during an incident or a cost spike. Clients see a friendly "paused by the Sidekick team" message, and Sidekick stops answering in Teams for that feature. Every flip is recorded in the operator log.

## Pausing a client
A paused organization can't use the portal or any feature, and Sidekick stops answering in its Teams channels. Its data is kept and comes back as it was on **Resume**.

## What owners can't do
Owners see usage, health and counts, but the console has no way to sign in as a client user or read a client's documents.
