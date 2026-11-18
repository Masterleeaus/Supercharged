# SuperchargedAt.Work pricing proposal

**Status:** proposal for owner decision. This is not a price list. Nothing here is published, and nothing here changes the website.
**Date:** 18 November 2026
**Repo state read:** `main` at 9b42c68, all 486 issues and PRs (192 issues, 294 PRs) listed on 18 November 2026.

## How to read the labels

- **[R]** a fact from this repo. The file or issue is named.
- **[S]** a fact from an outside source. The URL is in the Sources section.
- **[A]** an assumption. Change it if you disagree. Every number built on an assumption is marked.
- **[U]** unknown. The repo and the sources do not give it. Section 7 lists the data needed.

---

## 1. Short answer

- **Recommended model:** a monthly platform fee, an included allowance of AI work credits, metered overage with a hard spend cap, and SMS and phone numbers passed through at a markup. [A]
- **Example small customer:** about A$212 a month ex GST, with about A$45 of direct usage cost. Infrastructure, support and payment fees are not yet known, so this is a contribution figure, not profit. [A] [U]
- **Biggest risk:** the repo does not yet run most of the 172 agent roles end to end. Price what works now, and keep the "runs a whole business on its own" claim out of pricing until the handlers and approval flows are proven. [R]
- **Blockers before any price goes live:** the voice credit rate (owner decision O-05), real token counts per agent run, a hosting cost, and a payment fee figure. [R] [U]
- **Decisions are in section 9.**

---

## 2. What the product does today

### Working or wired in code [R]

- **Workforce runtime.** The module status table lists 151 modules as wired into the runtime. "Wired" means imported at runtime. It does not mean the module works in production. (`docs/WORKFORCE_MODULES.md`)
- **Spend and run limits.** A budget ledger can refuse a tool call, a token use, a run, or a company's daily spend once a limit is reached. Limits default to null until an admin sets them. (`server/workforce/runtime/budgets.ts`, `pg-budgets.ts`, `server/modules/approvals/company-policy.ts`)
- **Approvals.** Money moves, customer sends and record deletes need owner approval under the auto and predictive tiers. (`server/workforce/runtime/tier-permissions.ts`)
- **Outbound queue.** Outbound messages go through provider senders with idempotent retries (PR 288, merged). A single pre-send compliance gate covers inbox and campaign sends (PR 297, merged).
- **Role catalogue.** 172 role files exist in `server/workforce/catalogue/roles/` (not counting the example file). The capability registry dated 3 November counted 125 files, so it is out of date.
- **Connector code.** SDK, registry, credential vault, sync engine, connector admin, Twilio SMS, Jobber and ServiceM8, and calendar connectors are merged (PRs 370, 411, 418, 414, 416, 430). The epic says these are library code that no app route imports yet. (Epic #365)
- **Starter packs and setup wizard.** Code merged (PRs 438 and 444). The issues (#362, #363) are still open.

### Not working, not mounted, or not proven [R]

- **Tool handlers.** The 3 November registry found 101 declared tool IDs and no handler for them outside the role files. One real handler has merged since (PR 462, `agreements.renewal_draft`). The main tracking issue, #364, is still open.
- **Campaigns.** Fail closed. The COMMS flags are a NO-GO for production. (`STATUS.md`, `docs/records/COMMS-FLAGS-GO-LIVE-REVIEW.md`)
- **Channel webhooks.** SMS, email, Meta, Telegram and WhatsApp inbound files have no importers, so they are not mounted. (`STATUS.md`)
- **Chatbot.** Its tables come from a draft migration that is not promoted. (`STATUS.md`, #318)
- **Voice.** The voice-call service refuses to start until an owner chooses a call provider, a credit ledger and a credential source. The voice credit rate is open (O-05). (`HANDOFF.md`, `docs/working/owner-decisions.md` item B12)
- **Tenancy.** Moving to a shared company_id schema is still open (#51, #250 to #254). Two-company isolation tests are not in place.
- **Central sign-in.** Behind a flag, and the adapter is still open for verification. (#53, #193, #194)
- **Autonomy.** The repo's own tier rules keep money, customer sends and deletes behind owner approval. That is a safety rule, and it limits how far "runs a business on its own" can be claimed. (`tier-permissions.ts`)

### Planned only [R]

- **Paid hosted services.** The AI Assistant and the Agent Team are to be separately subscribed hosted services inside one WordPress plugin. The repo says not to sell a second "Pro" plugin tier. (#325, #329, #333, #334)
- **Lead sources, marketing and review campaigns.** #358, #360, #361, #336 (open).
- **Voice receptionist and missed-call recovery.** #325, #330, #333 (open).
- **Connector production wiring and the VoltAgent workstreams.** #349 to #359, #375 to #392 (open).

### Pricing that already exists in the repo [R]

- **Inherited plan seeds.** `server/seed-plans.ts` lists a free plan and a Pro plan at US$49 a month with 500 credits. `server/seed-credit-packages.ts` lists 100 credits for US$9.99 and other bundles. These come from an older product lineage and have no recorded owner decision. Do not treat them as the price.
- **Call credit settings.** Two settings exist: `credits_per_minute` (default 1 credit per minute, `seed-global-settings.ts`) and `credit_price_per_minute` (admin default 0.1, `settings-routes.ts`). Their relationship is not documented. Resolve it before any call billing.

---

## 3. Cost drivers

### AI usage per agent run

- **Known [S]:** Claude Haiku 5.5 is listed at US$0.10 per million input tokens and US$0.50 per million output tokens. Claude Sonnet 5.5 is listed at US$2 and US$10. Batch use is listed at half price, and cache reads at about one tenth of input price. The price table is from a third-party aggregator, not Anthropic's own page, which could not be fetched. Check it before using it.
- **Known [R]:** the repo does not calculate cost from tokens. Each caller passes spend into the ledger (`run.ts` `recordTokens`).
- **Unknown [U]:** tokens per run, runs per customer per month, and the share of runs on each model.

### SMS and messaging

- **Known [S]:** Twilio's Australian outbound SMS is listed at US$0.0515 per segment. Inbound is US$0.0075. A mobile number is US$8.25 a month. A failed message adds US$0.001. The page shows a dollar sign and does not name the currency, so confirm it.
- **Known [R]:** campaign events accept a cost in cents, but nothing in the repo sets that cost. (`server/modules/comms/campaign-analytics.ts`)
- **Unknown [U]:** segments per message from real traffic, and carrier fees beyond the listed rate.

### Voice

- **Unknown [U].** The per-minute cost of the provider is not in the repo. The owner's voice credit rate (O-05) is open.

### Storage

- **Unknown [U].** Recordings, transcripts and logs need a per-GB price and a volume estimate. Retention is proposed, not decided: run data 365 days, tool calls 180 days, budget usage 13 months. (`docs/RETENTION_PROPOSAL.md`)

### Hosting, database and workers

- **Unknown [U].** The target is one shared PostgreSQL database. No hosting bill is in the repo.

### Payment processing

- **Unknown [U].** The repo has Stripe code, but no fee figure. Use the Stripe statement for the real rate.

### Partner platforms

- **Unknown [U].** Field-service partners and Google calendar may charge API or marketplace fees. Read their terms before pricing an integration into a plan.

### Support and onboarding

- **Unknown [U].** Hours per customer are not recorded.

### GST

- **Known [S]:** GST is 10% on most goods and services sold in Australia. A business must register once its GST turnover reaches A$75,000. Below that, registration is optional. Non-residents selling digital products to Australian consumers must register at the same threshold.
- **Open question:** how GST applies to invoices from offshore suppliers such as the model and SMS providers, and what input credits the business can claim. Ask an accountant. This proposal does not settle it.

---

## 4. Comparable products

Sources are at the end. Most list prices are in US dollars. Australian dollar prices were not confirmed for any of them.

- **HubSpot Starter** [S]: about US$10 per seat a month when billed monthly and US$7 when billed annually. Includes 500 AI credits a month, with overage available if enabled.
- **ServiceM8** [S]: plans at US$0, US$29, US$79, US$149 and US$349 a month. SMS is free on paid plans, and the free plan charges 10 cents per SMS. An AI add-on (Office Agent Pro) is US$39 a month. The page is in US dollars.
- **Jobber** [S]: an AI receptionist add-on at $29 a month (currency not stated), per a Jobber help article quoted by a third-party guide. Core is listed at $49 a month and Connect at $149 for the smallest team, currency not stated. These figures come from third-party write-ups, not Jobber's own pricing page, so verify them there.
- **GoHighLevel** [S]: third-party guide lists agency plans at US$97, US$297 and US$497 a month. AI tools draw on a usage wallet. No per-SMS or per-minute rate is published in that guide. The official pricing page could not be fetched.
- **Lindy** [S]: the official docs say base plans cost US$0.01 per credit. Credits are used only while the agent works. When credits run out, credit-using actions pause and the user is told. Top-up credits carry over. Plan prices are not on the docs page.
- **Hatch** [S]: priced per location as a platform fee plus usage, with no published figures. Pricing is by quote.

What this means: the market has two patterns. Per-seat or per-plan pricing with an included AI allowance (HubSpot, ServiceM8), and metered credits with a pause at zero (Lindy). Field-service tools price by plan and charge small add-ons for AI. Quote-based AI receptionists price by location and usage.

---

## 5. Three pricing models

Assumptions used in the worked examples:

- **A1.** Exchange rate 1 US$ = A$1.50. [A]
- **A2.** Platform fee A$149 a month ex GST, for one company, the inbox, approvals and up to five active roles. [A]
- **A3.** Included allowance 1,000 credits a month. One credit equals US$0.01 of model cost at list price. [A]
- **A4.** Overage is charged at twice list cost, which is US$0.02 per credit. [A]
- **A5.** One agent run is 30,000 input tokens and 3,000 output tokens. [A]
- **A6.** Haiku is the default model. Sonnet is used only when a customer opts in. [A]
- **A7.** SMS sells at A$0.12 per outbound segment. A phone number sells at A$15 a month. [A]
- **A8.** Small customer: 300 runs, 400 outbound segments, 1 number. Heavy customer: 3,000 runs, 2,000 outbound segments, 1 number. [A]
- **A9.** Excluded from every example: hosting, support, payment fees, inbound SMS, voice, and any batch or cache discount. The AI cost shown is therefore an upper bound. [A]

Per-run cost at the A5 token counts: about US$0.0045 on Haiku, and US$0.09 on Sonnet. [A on token count, S on prices]

Per-customer direct cost, before the items excluded in A9:

- Small customer on Haiku: AI US$1.35, SMS US$20.60, number US$8.25. Total US$30.20, or A$45.30.
- Heavy customer on Haiku: AI US$13.50, SMS US$103.00, number US$8.25. Total US$124.75, or A$187.13.
- Heavy customer on Sonnet: AI US$270.00, SMS US$103.00, number US$8.25. Total US$381.25, or A$571.88.

The model choice moves the AI cost about 20 times. That is the main reason for routing and caps.

### Model A: flat tiers with caps

- **Shape:** three plans, each with a fixed price and fixed limits on runs and segments. Example: A$149, A$349 and A$699 a month.
- **Suits:** owners who want a fixed bill and do not want to think about usage.
- **Margin logic:** margin holds only while usage stays inside the caps. The caps set the worst case.
- **Risk:** a customer who switches to Sonnet can cut margin sharply. On the A$699 plan, a heavy customer on Sonnet with 2,000 segments costs about A$572 in direct usage, leaving about A$127 (18%) before infrastructure and support. Caps that stop work mid-month also frustrate customers.
- **Worked example:** the small customer fits the A$149 plan with about A$104 left (70%) after direct cost.

### Model B (recommended): platform fee, included credits, metered overage, pass-through messaging

- **Shape:** the platform fee (A2), an included credit allowance (A3), overage at twice list cost (A4), and SMS and numbers at a per-unit price (A7). A hard spend cap per company, and a pause at zero, as Lindy does.
- **Suits:** most service businesses. Their use varies a lot month to month, and the cost they cause varies with it.
- **Margin logic:** each unit of usage is priced above its cost. Included credits cover ordinary use. Overage and messages carry the markup.
- **Risk:** a customer can get a large bill from one heavy month. The mitigations are the hard cap, alerts at 50% and 80% of the cap, and a clear credit definition. The repo's budget ledger already refuses work at a company's daily spend limit, so the cap can be built. The spend figure it uses is set by callers, so it is only as good as the token counts recorded.
- **Worked examples:**
  - Small customer: A$149 platform, 400 segments at A$0.12 (A$48), number A$15. Total A$212 ex GST (A$233.20 with GST). The AI use of 135 credits sits inside the allowance, so there is no AI overage. Direct cost is A$45.30 (SMS A$30.90, number A$12.38, AI A$2.03). Contribution A$166.70, about 79% of revenue.
  - Heavy customer on Haiku: A$149 platform, 2,000 segments at A$0.12 (A$240), number A$15, and 350 credits over the allowance at US$0.02 (A$10.50). Total A$414.50. Direct cost A$187.13 (SMS A$154.50, number A$12.38, AI A$20.25). Contribution A$227.37, about 55%.
  - Heavy customer on Sonnet: the same platform, messaging and number charges, plus 26,000 credits over the allowance at US$0.02 (A$780). Total A$1,184. Direct cost A$571.88. Contribution A$612.12, about 52%. The margin is healthy, but the customer's bill is high enough to drive churn. This is why routing to Haiku by default matters.

### Model C: per active agent role

- **Shape:** a monthly fee for each role that is switched on. Example: A$29 a role, with the same messaging pass-through and overage as Model B.
- **Suits:** owners who think in terms of hiring staff.
- **Margin logic:** predictable per-role revenue. Usage still needs pass-through, or heavy users lose money.
- **Risk:** roles are catalogue entries, and most tools have no handler yet (#364). Charging per role before a role does real work invites refunds and complaints. A customer can also turn roles off to cut price, which shrinks the product. Roles are not what drives cost; usage is.
- **Worked example:** small customer on 5 roles pays A$145 for roles, A$48 for SMS, A$15 for the number, so A$208 ex GST, with direct cost A$45.30. Heavy customer on 10 roles pays A$290 for roles, A$240 for SMS, A$15 for the number and A$10.50 overage, so A$555.50, with direct cost A$187.13.

---

## 6. Recommendation

**Choose Model B.**

Reasons:

1. Its costs move with usage, and so does its price. Flat tiers and per-role prices leave the owner carrying the cost of heavy use.
2. The repo already has the hard parts it needs: a per-run and per-company spend ledger, approval gates, and per-company limits. What is missing is a real spend figure from each call. (`budgets.ts`, `pg-budgets.ts`)
3. It matches the market pattern of an included allowance with metered overage, and the pause at zero is an easy promise to explain.
4. It does not require the 172 roles to be finished before selling. It can start with the inbox, approvals, messaging and the few handlers that are real.

**Launch conditions (proposed):**

- No public price until the token count per run has been measured on real runs.
- No voice pricing until O-05 is decided and a call provider is wired.
- Sell only the wired features. Describe the rest as "coming", not as working.
- Keep customer approval for money, sends and deletes, which the repo already enforces.

---

## 7. Data needed before a final price

1. **Tokens per run.** Log input and output tokens for at least 20 real runs of each of the first five roles.
2. **Segments per message.** Count real outbound SMS segments for one month from a pilot company.
3. **Voice cost.** The provider's per-minute rate, and the owner's credit rate (O-05).
4. **Hosting bill.** One month of the production-like setup: database, workers, storage, bandwidth.
5. **Storage volume.** Average recording and transcript size per call and per month.
6. **Payment fee.** The effective Stripe rate on AUD card payments.
7. **Partner terms.** Fees or limits from Jobber, ServiceM8 and Google calendar APIs.
8. **Support hours.** Hours per customer in the first 90 days.
9. **FX policy.** The rate to use, and how often to review it.
10. **Offshore GST.** An accountant's view on input credits for overseas suppliers.

---

## 8. Risks

- **Overpromising autonomy.** The product's own rules keep sensitive actions behind owner approval. Pricing a "fully autonomous" product would contradict those rules and the README's readiness warnings. [R]
- **Selling unfinished features.** Most tools have no handler, and channels, campaigns and voice are not mounted or are fail-closed. [R]
- **Model cost drift.** A single change of default model can change AI cost by about twenty times. Routing and caps need to be enforced in code, not only in documents.
- **Bill shock.** Heavy months can produce bills the customer did not expect. Alerts and caps are needed before the first paying customer.
- **Currency.** Most comparable prices and all cost prices are in US dollars. Prices in AUD move with the exchange rate.
- **Single-plugin boundary.** The repo's direction is one WordPress plugin with paid hosted services. A pricing structure with a separate "Pro" plugin conflicts with that. [R]
- **Inherited seed prices.** The old US$49 Pro plan and credit packs could be mistaken for current prices. Remove or relabel them before any launch. [R]

---

## 9. Decisions the owner must make

1. Choose the model: A, B or C. Recommended: B.
2. Confirm the currency for customer prices: AUD only, or AUD with USD shown too.
3. Confirm the exchange rate for pricing: 1 US$ = A$1.50 is an assumption.
4. Set the platform fee for Model B: A$149 a month ex GST is an assumption.
5. Set the included credit allowance: 1,000 credits is an assumption.
6. Confirm the credit definition: 1 credit = US$0.01 of list model cost.
7. Set the overage multiple: twice list cost is an assumption.
8. Set the outbound SMS price per segment: A$0.12 is an assumption.
9. Set the phone number price: A$15 a month is an assumption.
10. Decide inbound SMS pricing, since it is excluded from the examples.
11. Decide the voice credit rate (O-05). Voice cannot be priced until this is set.
12. Confirm Haiku as the default model, with Sonnet only on customer opt-in.
13. Set the default hard spend cap per company per day, and whether the cap pauses work or asks first.
14. Decide whether to offer a free tier or a trial, and its length.
15. Decide whether to launch before the 101 tool handlers are finished, or only with the handlers that work.
16. Decide whether prices are shown ex GST, incl GST, or both, and whether the business registers for GST now.
17. Decide who gets the offshore GST answer from an accountant, and by when.
18. Supply the data in section 7, items 1 to 6, before any public price.

---

## Sources

- HubSpot Starter plan: https://www.hubspot.com/products/crm/starter (fetched 18 November 2026; the page lists the standard price as US$20 per seat, with a discounted rate for new customers)
- ServiceM8 pricing: https://www.servicem8.com/pricing (fetched 18 November 2026; US dollars)
- Lindy pricing docs: https://www.lindy.ai/docs/pricing.md (fetched 18 November 2026)
- Hatch pricing: https://www.usehatchapp.com/pricing (fetched 18 November 2026)
- Jobber pricing, third-party write-up: https://www.activepieces.com/blog/jobber-pricing-2026-plans-add-ons-and-total-cost (dated 5 November 2026 in the article; cites AppForeman and the Jobber Help Center)
- GoHighLevel pricing, third-party guide: https://ghlexperts.com/gohighlevel-plans-pricing (undated; the official page could not be fetched)
- Twilio Australia SMS pricing: https://www.twilio.com/en-us/sms/pricing/au (listed as current as of November 2026; currency not stated on the page)
- Claude API prices, third-party aggregator: https://benchlm.ai/anthropic/api-pricing (synced 17 November 2026; Anthropic's own pricing page could not be fetched)
- ATO, GST rate, threshold and non-resident digital supplies: https://www.ato.gov.au/businesses-and-organisations/international-tax-for-business/gst-for-non-resident-businesses/how-australian-gst-works
- Business.gov.au, GST registration: https://business.gov.au/registrations/register-for-taxes/register-for-goods-and-services-tax-gst

Repo references are in the text. Issue numbers refer to Masterleeaus/Supercharged.
