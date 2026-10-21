# Accounts: what each one is for

One page so it's clear which account does what. **No secrets here**: passwords live in Cody's password
manager, keys in `app/.env.local` (Mac, git-ignored) and as Azure Container App secrets. The live
address isn't written here either: get it with
`az containerapp show -g sidekick-rg -n sidekick-app --query properties.configuration.ingress.fqdn -o tsv`.

## Production (keep)
| Account | Used for | Where details live |
|---|---|---|
| **Azure** subscription (signed in as the Sidekick Labs admin; resource group `sidekick-rg`) | Hosts live Sidekick: Container App, Postgres, Azure AI Search, registry, Azure Bot, Log Analytics + uptime alerts, budgets/freeze, `sidekick-deployer` identity for GitHub deploys | `docs/HOSTING.md`, `docs/RUNBOOKS.md` |
| **GitHub** `ScottyP1/side_kick` (private) | Code, pull requests, tests on every PR, **automatic deploy on every merge to `main`**; GitGuardian (secret scanning) and CodeRabbit (reviews) apps | `.github/workflows/`, HOSTING → Automatic deploys |
| **Anthropic Console** | The Claude API key and its bill (pay per use, one account for all customers) | To do: a production and a testing workspace, and a monthly spend limit |
| **Microsoft Entra directory "Sidekick Labs"** | Where Azure, the Teams bot identity (`Sidekick Bot`) and Microsoft sign-in live. Keep it as Sidekick's own company directory even if the Microsoft 365 trial is cancelled | `docs/TEAMS-MULTITENANT.md`, RUNBOOKS → Trial end |
| **Sidekick Owner Console** (operator) | Cody's business view: all clients, plans, usage, errors, switches (support inbox coming) | `docs/guide/owner-guide.md`. Live account not created yet: see the owner guide (one-time `SIDEKICK_SETUP_CODE`) |
| **Sidekick portal** (Cody's Org Owner account) | Using Sidekick like a customer | `docs/guide/admin-guide.md` |
| Personal email | Portal sign-in, budget and alert emails | (not written here) |

## Testing only (can be dropped any time)
| Account / thing | Used for |
|---|---|
| **Microsoft 365 Business Basic trial** in Sidekick Labs (ends **Nov 14, 2026**) | Teams testing: team "Contoso Migration (test)", chat "Wave 2 cutover", test users Jojo Boom and User2 |
| Dev tunnel `sidekick` | Testing a local copy from real Teams |
| Local copies (`sidekick-preview`, `e2e-a`…`e2e-d` in `.claude/launch.json`) and their test logins | Testing on the Mac with throwaway data |
| `samples/` (made-up Contoso engagement) | Demo and test data |

## Later, for launch
| Account | Used for |
|---|---|
| Domain registrar (e.g. `sidekick.ai`) | Website at the domain, portal at `app.` |
| Stripe | Real payments (today: test-mode checkout) |
| Microsoft Partner Center | Publisher verification and the Teams Store listing |

## Day to day after launch
Cody works in two places: the **Owner Console** (the business) and his own **portal**. Azure, GitHub and
Anthropic run in the background: open them for bills, rare checks or a runbook.
