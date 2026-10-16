# Wave 2 cutover runbook (v0.3)

**Engagement:** Contoso Retail – Cloud Migration · **Version:** 0.3 · **Published:** October 3, 2026 · **Author:** Maria Chen

## Summary
- **Stores:** 48 (wave 2)
- **Cutover date:** Wednesday, November 5, 2026, 10 p.m. local time
- **Order of steps:** price tables → SKU sync → open the tills (changed after wave 1)

## Steps (per store)
1. 9:30 p.m.: confirm the store is closed and the last sale is synced.
2. 10:00 p.m.: switch POS to the new Azure endpoint.
3. Load price tables; check 10 random prices against HQ.
4. Run the SKU sync for that store; confirm item count matches HQ.
5. Test a card payment on each till.
6. Store manager signs the checklist below.

## Rollback
Rollback plan to follow (owner to be confirmed).

## Store manager checklist
- [ ] All tills show the new login screen
- [ ] A test sale and a test refund work
- [ ] Prices on 10 shelf labels match the tills
- [ ] Offline mode light is green
- [ ] Call the bridge line before opening
