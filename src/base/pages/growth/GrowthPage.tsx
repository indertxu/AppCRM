/**
 * BASE · Growth = Enterprise's Marketing page, as it is (2026-11-18).
 * The page itself lives in ./campaigns/MarketingHub.tsx (a copy of Enterprise's pages/contacts/ContactExport.tsx
 * MarketingPage, with its Workflows, Forms, Audiences and Calendar): Overview · E-mail · Social · Calendar ·
 * Audiences · Forms, and Workflows from the Overview. The old Growth previews (Ads, Website, Customers,
 * Follow-ups, the AI studio) are gone.
 */
import { MarketingPage } from "./campaigns/MarketingHub";

export default function GrowthPage() {
  return <MarketingPage />;
}
