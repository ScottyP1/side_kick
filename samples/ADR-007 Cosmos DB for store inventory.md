# ADR-007: Use Cosmos DB for store inventory

**Date:** April 3, 2026 · **Status:** Accepted · **Engagement:** Contoso Retail – Cloud Migration

## Context
Contoso's 600+ stores must keep selling for at least 4 hours without a network connection (SOW v3, section 2.4).
Inventory changes must sync back to HQ within 60 seconds at peak once a store reconnects.

## Options considered
1. **Azure Cosmos DB** with multi-region writes and offline-first sync from the store POS.
2. **PostgreSQL** with a custom replication layer.

## Decision
Use **Cosmos DB** for store inventory. PostgreSQL remains the system of record for finance reporting.

## Consequences
- Multi-region writes support offline-first POS sync without custom replication code.
- Higher per-request cost than Postgres; monitored monthly.
- The SKU sync job (HQ → stores) runs nightly plus on-change pushes.
