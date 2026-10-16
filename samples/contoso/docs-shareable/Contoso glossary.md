# Contoso project glossary

- **POS**: point of sale, the tills in each store.
- **SKU**: stock keeping unit, one sellable product (size and color count separately).
- **SKU sync job**: the job that sends product and stock changes from HQ to the stores (nightly plus on-change pushes).
- **Wave**: a group of stores moved to Azure on the same night. Wave 1 = 36 stores, wave 2 = 48 (maybe 52).
- **Cutover**: the night a store switches from the legacy POS to the new Azure system.
- **Rollback**: moving a store back to the legacy POS if cutover fails.
- **Offline mode**: the store keeps selling with no network for at least 4 hours (SOW 2.4).
- **Bridge line**: the phone call everyone joins on cutover night.
- **RAID log**: the list of Risks, Assumptions, Issues and Dependencies.
- **CR-02**: change request for the wave 2 extension, $48,000, priced for 48 stores.
