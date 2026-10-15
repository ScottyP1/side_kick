# Contoso Retail – target architecture (overview)

- **Store POS** runs a local cache and keeps selling offline for at least 4 hours.
- **Azure Cosmos DB** (multi-region writes) holds store inventory; chosen in ADR-007 (April 3, 2026).
- **Azure Database for PostgreSQL** remains the system of record for finance reporting.
- **SKU sync job** (Azure Functions) pushes product and stock changes HQ → stores nightly and on change.
- **Store API** (Azure App Service) receives sales from stores; slow around 2 a.m. while backups run.
- **Monitoring**: Azure Monitor alerts page the on-call engineer.

Card readers and the PCI assessment are owned by Contoso security (out of scope, SOW).
