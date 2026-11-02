# ProofStream Dispatch — In-House Registered Electronic Delivery API
**Build prompt for an AI developer agent / engineering lead**
**Document:** PCG-PST-REM-2026-004-v1.0 · **Date:** 2026-11-02 · **Owner:** Pantheon Consulting Group, Inc. (DRM pillar)
**Functional reference (not a template):** openapi.com "Massive REM Delivery API"
**Depends on:** PCG-PST-SEC-2026-003 (Auth0 gateway & five-gate pipeline), ProofStreamAnchor.sol, PCG IPFS vault (Kubo + Pinata)

---

## 0. How to use this document

Section 1 is the planning brief: what the reference product does, where it falls short for us, and the build-vs-buy decision. **Section 2 is the prompt.** Paste everything inside the fenced block into the developer agent (Claude Code, Codex, Cursor, etc.) as its system or task prompt. Sections 3–4 are the phase plan and acceptance gates the operator uses to review the agent's work.

---

## 1. Planning brief

### 1.1 What the reference product actually is

The openapi.com product is a resale wrapper around Italian **PEC** (Posta Elettronica Certificata) mailboxes run by an accredited provider (`@pecmassiva.com`, with custom domains via Namirial). Its surface:

| Capability | Reference implementation |
|---|---|
| Mailbox provisioning | `GET /verifica_pec/{pec}` → `POST /pec` → signed activation form + ID via `PATCH /pec/{id}/attivazione` |
| Send | `POST /send`: sender, recipient(s), subject, HTML body, base64 attachments, **mailbox username/password in the payload** |
| Threads | `POST/PATCH/GET /threads` with `accepted`, `acceptedAt`, `deliveries` |
| Evidence | Receipt *emails* in the inbox: ACCETTAZIONE (acceptance), CONSEGNA (delivery), POSTA CERTIFICATA |
| Volume | 3,500/day default; `/threads` queues overflow to next day, `/send` errors |
| Callbacks | `callback {url, field, method, data}`, with the payload undocumented |
| Price | €99/yr activation, €0.02–€0.05 per message, €60 custom domain |
| Legal basis | AGID (Italian national scheme). No eIDAS QERDS or ETSI evidence format documented |

### 1.2 Why we build instead of buy

1. **Wrong jurisdiction and wrong evidence.** PEC carries legal weight in Italy. Our counterparties are mostly U.S. infringers, platforms, and DMCA designated agents, and PEC means nothing to them. Its evidence is receipt emails, which aren't machine-verifiable, aren't anchorable, and aren't portable into our ProofStream evidentiary lifecycle.
2. **Credential posture conflicts with SEC-2026-003.** The reference API sends mailbox passwords in the request body. Our rule is that a worker never holds a downstream secret.
3. **The evidence chain is our product.** The DRM pillar's mission ends in formal legal dispatch, and that dispatch is the evidence. Outsourcing it puts a third party's receipts at the most important link in our chain.
4. **Cost at scale.** At 50k notices a year the reference costs about €2,000 plus activation. In-house costs a VPS, Workers, and storage (see §1.5), and the marginal cost per message is close to zero.

### 1.3 What in-house can and cannot legally claim (read before building)

- **Qualified status (QERDS) cannot be self-declared.** Under eIDAS (Reg. 910/2014 as amended by Reg. 2024/1183), Art. 43(2) gives a *qualified* ERDS the presumption of data integrity, sending and receipt by the identified parties, and accurate date/time. That status requires a Qualified Trust Service Provider with a conformity assessment and listing on an EU Member State Trusted List. Our build will be a **non-qualified ERDS**. Art. 43(1) still guarantees it can't be denied legal effect or admissibility *solely* because it is electronic or non-qualified. The weight comes from the strength of our evidence.
- **U.S. posture.** No statutory registered-e-delivery scheme exists. Admissibility runs through FRE 901(b)(9) (process or system producing an accurate result), FRE 902(13)/(14) (self-authenticating certified electronic records and data copied from them, by hash), and E-SIGN for signed content. That is the standard this design is built to meet: every event gets a deterministic, signed, timestamped, hash-anchored record, with an audit line binding actor → assurance level → content → transport result.
- **Design consequence.** We build to **ETSI EN 319 522 structure** (the ERDS evidence model) and **ETSI EN 319 521 practices**, so that a later QTSP relay adapter or our own conformity assessment is an *addition*, not a rewrite. The API exposes an `assurance_tier` field: `pcg_standard` now, `qualified_relay` (via a partner QTSP) later.

### 1.4 Build principles

1. **Notice ≠ content.** The email a recipient receives is a *notification* holding a pickup link, never the payload. Content is handed over through the authenticated pickup portal, and that handover is the strongest event we can prove. This is the ERDS consignment model, and it works with any ordinary recipient mailbox.
2. **Evidence is append-only and self-verifying.** Each lifecycle event is a canonical JSON record that is signed, RFC 3161-timestamped, batched into a Merkle tree, and anchored by root on-chain. A third party verifies it with our public key, the TSA certificate, and the chain. They never need to trust PCG's database.
3. **No PII or content on public IPFS.** Only encrypted bundles or hashes are pinned. Plaintext lives in R2 under envelope encryption.
4. **LLMs are never on the evidence path.** AI may draft, classify, and extract. It never signs, sends without human approval, or writes an evidence record.
5. **Open source first; every paid dependency is flagged with a free alternative.**

### 1.5 Stack decision

| Layer | Choice | Licence / cost | Paid alternative (flagged) |
|---|---|---|---|
| API edge | Cloudflare Worker + **Hono** (TypeScript) | MIT · Workers Paid $5/mo (already held) | — |
| Auth | Existing Auth0 tenant + five-gate pipeline | existing | — |
| Queue | **Cloudflare Queues** | included | Self-host: BullMQ + Redis (MIT) |
| State | **D1** for dispatch/event index; Postgres via Hyperdrive if volume exceeds D1 limits | included / OSS | — |
| Content & bundle store | **R2** (envelope-encrypted) + Kubo pin of encrypted bundles | ~$0.015/GB-mo | — |
| Outbound MTA | **Stalwart Mail Server** (Rust; DKIM, ARC, DMARC, MTA-STS, DANE, DSN) on a VPS with clean IP + PTR | AGPL-3.0 · VPS ~$6–20/mo | Postfix + OpenDKIM (free). SES/Postmark only as overflow, flagged |
| Evidence signing | **JWS/JAdES** (ETSI TS 119 182-1) over RFC 8785 canonical JSON; key in **HSM / YubiKey PIV / cloud KMS** | OSS libs (`jose`, EU **DSS** library LGPL for JAdES/PAdES) | — |
| Timestamping | **Own RFC 3161 TSA** (OpenSSL `ts` or `uts-server`) **plus** an independent second TSA per batch | free | Qualified TSA from a QTSP for `qualified_relay` tier (pennies per stamp) |
| Anchoring | Merkle root → `ProofStreamAnchor.sol` on the existing L2, batched (e.g. hourly) | gas ≈ cents/day | — |
| Human-readable certificate | **PDF/A-3** with embedded JSON evidence + PAdES signature (DSS / pdf-lib) | OSS | — |
| Pickup portal | Next.js/Hono page on the Worker; email OTP, optional WebAuthn | OSS | — |
| AI assist (optional) | **Ollama + local model** for classification/extraction; OpenAI or Claude API for notice drafting | OSS / metered | — |
| Physical fallback (optional) | Manual USPS Certified Mail with scanned receipt ingested as evidence | postage only | Lob / PostGrid API, flagged |

---

## 2. The prompt

```text
ROLE
Act as Lead Platform Engineer and Evidentiary Systems Architect for Pantheon Consulting
Group, Inc. (PCG), a Wyoming C-Corporation. You are building "ProofStream Dispatch": an
in-house registered electronic delivery API that sends formal notices (copyright
infringement notices, DMCA §512(c)(3) notices, demand and pre-suit correspondence, bond
program investor notices) at volume and produces court-grade, independently verifiable
evidence of submission, transmission, notification, and content handover.

CONTEXT
- ProofStream (proofstreamapp.com) is PCG's content-provenance and attestation platform.
  Dispatch is the final stage of its pipeline: detection → verification → entity tracing →
  formal legal dispatch → evidentiary lifecycle.
- A functional reference exists (an Italian PEC resale API). Do NOT replicate its design.
  It puts mailbox passwords in request bodies, returns evidence only as receipt emails, and
  documents no callback payloads. You are building something stricter.
- Existing infrastructure you MUST integrate with, not reinvent:
  • Auth0 tenant pantheon-platform.us.auth0.com, API identifier
    https://mcp.pantheonconsultinggroup.net/pst, RS256, RBAC on. Five-gate authorization
    pipeline: scope → role → AAL (NIST SP 800-63B-4) → document binding → rate limit,
    then vault resolve → proxy → audit emit. Workers never possess downstream secrets.
  • Auth0 Token Vault for bearer provider secrets.
  • Signing keys live in HSM / YubiKey PIV / KMS, never in a vault the gateway can read.
  • ProofStreamAnchor.sol (keccak256 anchoring), Alchemy RPC with per-worker JWT.
  • Kubo IPFS node (admin API :5001 never exposed) + Pinata, behind a Cloudflare Tunnel
    with an Access service token.
  • Cloudflare account "Proofstreamapp" (Workers, D1, R2, Queues).
- Before writing code, inspect the existing repository (proofstream-web and any service
  folders), report its structure, and propose where services/dispatch lives. Do not
  restructure existing code without approval.

LEGAL DESIGN TARGET (encode in the architecture, do not overclaim in UI or docs)
- This is a NON-QUALIFIED electronic registered delivery service under eIDAS Art. 43(1).
  Never label output "qualified", "QERDS", "certified by AgID", or equivalent.
- Model the event lifecycle and evidence structure on ETSI EN 319 522 (parts 1–2) and
  operational practice on ETSI EN 319 521. Download the normative standards from ETSI
  (free) and map event codes from the text itself. Do not invent event names from memory.
  Record the standard version used in every evidence record.
- U.S. target: FRE 901(b)(9) process integrity and FRE 902(13)/(14) hash-certified
  records. Every evidence record must be reproducible by a third party from public
  material: our public signing certificate, TSA certificates, and the anchor transaction.
- Expose `assurance_tier` on every dispatch: "pcg_standard" now. Reserve
  "qualified_relay" for a future adapter that forwards through a partner QTSP. Build the
  adapter interface now, ship it stubbed.

CORE MODEL — notification + pickup
1. Sender submits a dispatch (content + recipients + metadata).
2. Dispatch validates, encrypts content (per-dispatch DEK, wrapped by KMS KEK), stores it
   in R2, computes SHA-256 of every content part, and emits SUBMISSION_ACCEPTED or
   SUBMISSION_REJECTED evidence.
3. The MTA sends the recipient a NOTIFICATION email: sender identity, subject, content
   hash, expiry, and a single-use pickup link. The notification carries no payload
   content. Emit evidence for relay acceptance, DSN delivery or failure (RFC 3464
   parsing), and bounce.
4. The recipient opens the pickup portal, authenticates (email OTP minimum; WebAuthn
   optional; configurable ID-proofing hook), sees the content hash, and chooses ACCEPT or
   REJECT. On accept, content is decrypted and handed over. Emit CONTENT_HANDOVER with
   the authenticated identity, IP, user agent, auth method, and timestamps. On reject or
   expiry, emit the matching rejection or non-retrieval event.
5. Optional per-dispatch flag `inline_copy=true` also attaches the content to the
   notification for counterparties who require it (e.g. DMCA agents). Record that choice
   in evidence.
6. Email opens and tracking pixels are NOT evidence. Do not build them.

EVIDENCE PIPELINE (append-only, never edited, never deleted before retention end)
- Each event → JSON record: evidence_id (ULID), dispatch_id, recipient_id, event_code,
  etsi_mapping, standard_version, occurred_at (UTC, ms), actor (Auth0 sub + aal +
  auth_time OR recipient auth descriptor), content_digests[], transport details (MTA
  queue id, remote MX, SMTP response, DSN status), prev_evidence_hash (per-dispatch hash
  chain), assurance_tier.
- Canonicalize with RFC 8785 (JCS) → SHA-256 → sign as JWS/JAdES with the evidence
  signing key (HSM/KMS, ES256 or EdDSA; cert chain published at a stable URL) →
  RFC 3161 timestamp from our TSA.
- Every N minutes (configurable, default 60): build a Merkle tree over new evidence
  hashes, timestamp the root with a SECOND, independent TSA, and anchor the root through
  ProofStreamAnchor.sol using the existing pst:anchor path. Store each leaf's inclusion
  proof.
- Throughput rule: hardware tokens are slow. Sign each record with the KMS/HSM evidence
  key. The YubiKey-held AAL3 attestation key signs only batch roots via the existing
  pst:attest flow. Do not route per-message signing through a YubiKey.
- Evidence bundle per dispatch: ZIP containing all records, signatures, TSA tokens,
  Merkle proofs, the anchor tx reference, the certificate chain, and a PDF/A-3
  "Certificate of Dispatch" (human-readable, with the JSON embedded, PAdES-signed). Pin
  the encrypted bundle to Kubo/Pinata and store its CID in the dispatch record.
- Ship an offline verifier (CLI + a POST /v1/verify endpoint + a static verify page) that
  takes a bundle and checks signatures, TSA tokens, hash chain, Merkle inclusion, and
  on-chain anchor. It must run with no PCG backend dependency except public chain RPC.

API SURFACE (REST, JSON, OpenAPI 3.1 spec is a deliverable; version prefix /v1)
- POST   /v1/dispatches                 single dispatch, 1..n recipients, Idempotency-Key required
- POST   /v1/batches                    bulk: JSON array or CSV upload + template id; returns batch id
- GET    /v1/batches/{id}               progress counts by state
- GET    /v1/dispatches/{id}            state + per-recipient lifecycle
- GET    /v1/dispatches/{id}/evidence   evidence records (JSON)
- GET    /v1/dispatches/{id}/bundle     signed evidence bundle (ZIP) + CID
- POST   /v1/verify                     verify an uploaded bundle or evidence record
- GET    /v1/inbox                      inbound replies to notifications, threaded to dispatch
- POST   /v1/templates  · GET/PUT/DELETE /v1/templates/{id}   Handlebars/MJML, versioned and hashed
- POST   /v1/sender-domains             register domain; returns DKIM, SPF, DMARC, MTA-STS records
- POST   /v1/sender-domains/{id}/verify
- POST   /v1/webhooks · GET/DELETE /v1/webhooks/{id}
- GET    /v1/quota                      daily/monthly usage per tenant and sender domain
- Pickup portal (public, token-gated): GET /p/{token}, POST /p/{token}/auth,
  POST /p/{token}/accept, POST /p/{token}/reject
- Error envelope: { "error": { "code", "message", "request_id", "details" } }. Never
  return secrets, stack traces, or internal hostnames.

AUTHORIZATION — extend the existing pipeline, do not fork it
- New scopes with AAL floors: pst:dispatch:read (AAL1), pst:dispatch:send (AAL2),
  pst:dispatch:batch (AAL2 + per-batch human approval token), pst:dispatch:admin (AAL3,
  freshness ≤ 900 s) for sender-domain, key, and webhook changes.
- Gate 4 document binding: a dispatch may reference a ProofStream CID only if the pin
  belongs to the same principal, using the existing CID_PRINCIPAL_MISMATCH and
  DIGEST_MISMATCH checks.
- Gate 8 audit line on every call, in the existing format, plus dispatch_id and
  evidence_id.
- MTA credentials, webhook signing secrets, and KMS handles resolve through Token Vault
  or bindings only. Nothing in request bodies.

DELIVERABILITY & VOLUME
- Outbound MTA: Stalwart Mail Server on a VPS with a dedicated IP, PTR, DKIM (2048-bit
  RSA + Ed25519 dual-sign), SPF, DMARC p=quarantine→reject, MTA-STS, TLS-RPT. Residential
  IPs and Cloudflare Workers cannot originate SMTP on port 25. Document this in the README.
- Per-receiving-domain throttling and warm-up schedule. Per-tenant daily caps (default
  3,500/day, configurable). Over-cap batches queue to the next window with evidence of
  deferral. Single sends over cap return 429 with retry-after. No silent drops.
- Exponential retry with jitter up to 72 h. DSN and bounce parsing feed evidence and
  suppression. Hard bounces are suppressed per tenant.
- List-Unsubscribe is NOT added to legal notices. Document why.

WEBHOOKS
- Follow the Standard Webhooks spec (webhook-id, webhook-timestamp, webhook-signature,
  HMAC-SHA256, per-endpoint secret). At-least-once delivery, exponential retry 24 h,
  dead-letter queue, replay endpoint.
- Events: dispatch.submitted, recipient.notified, recipient.notification_failed,
  recipient.handover, recipient.rejected, recipient.expired, batch.completed,
  evidence.anchored. Payloads carry evidence_id so subscribers can fetch the signed
  record. The webhook itself is not evidence.

DATA MODEL (D1, migrations as files)
tenants, sender_domains, templates(versioned, content_hash), dispatches,
dispatch_recipients, content_parts(digest, r2_key, wrapped_dek), evidence_records
(append-only, unique per evidence_id, hash-chain column), merkle_batches(root, tsa_token,
anchor_tx, chain_id), inclusion_proofs, pickup_tokens(hashed, single-use, expiry),
webhooks, webhook_deliveries, suppressions, quotas, audit_log.
Enforce append-only at the application layer AND with triggers that reject UPDATE and
DELETE on evidence_records.

AI ASSIST LAYER (optional module, off by default, never on the evidence path)
- notice drafting: given a ProofStream detection record (work metadata, ISRC/UPC,
  infringing URL, rights-holder data), draft a notice from approved templates. Provider:
  OpenAI or Claude API behind an interface, with a local Ollama model as the fallback.
- inbound classification: label replies (acknowledgement, counter-notice, dispute,
  takedown confirmation, auto-reply, bounce) and extract deadlines.
- entity tracing: extract a designated agent or abuse contact from WHOIS/RDAP, the U.S.
  Copyright Office DMCA agent directory, and platform pages. Return candidates with
  source citations. Never auto-select.
- Every AI output requires explicit operator approval before a dispatch is created.
  Store the prompt, model id, and output hash in the audit log.

SECURITY
- Content encrypted at rest (AES-256-GCM, per-dispatch DEK, KEK in KMS). Pickup tokens
  ≥ 128-bit, stored hashed, single-use, expiring (default 14 days, configurable).
- Rate limit pickup auth attempts. Lock out a token after 5 failures.
- Separate keys and separate rotation for: evidence signing, TSA, webhook HMAC, DKIM,
  content KEK, AAL3 attestation. Publish signing and TSA certs plus a key-history log so
  old bundles stay verifiable after rotation.
- Retention: evidence 10 years minimum (configurable per matter). Content per tenant
  policy. Crypto-shred content by destroying the DEK, never the evidence.
- Threat-model the system (STRIDE) and include the model as a deliverable.

TESTING
- Unit tests for canonicalization, signing, the hash chain, and Merkle proofs, using
  known-answer vectors.
- Integration: local MTA (Mailpit) + mock MX returning 2xx/4xx/5xx and DSNs. Assert
  every path yields the correct evidence sequence.
- Verifier tests: tamper one byte of content, record, signature, TSA token, or proof.
  The verifier must fail with a specific reason each time.
- Load: 10,000-recipient batch on testnet anchoring. Report throughput, queue lag, and
  cost.
- Chaos: kill the MTA mid-batch, KMS unavailable, TSA unavailable. The system must
  pause and resume without losing events or double-sending (idempotency).

DELIVERABLES
1. Architecture document with a sequence diagram per lifecycle path and the
   on-chain/off-chain boundary statement.
2. OpenAPI 3.1 spec (+ generated TypeScript client).
3. services/dispatch Worker source (Hono), queue consumers, D1 migrations.
4. MTA deployment (Stalwart config, DNS records, warm-up runbook, Docker/compose).
5. Evidence library (canonicalize, sign, timestamp, merkle, bundle, PDF/A-3 certificate)
   published as an internal package.
6. Offline verifier CLI + static verify page.
7. Pickup portal.
8. QTSP relay adapter interface (stubbed) + a provider-selection memo.
9. Test suites and a CI pipeline.
10. Runbooks: key rotation, MTA IP reputation incident, TSA outage, evidence export for
    litigation (FRE 902(14) certification template for the custodian to sign).
11. Cost sheet compared to the reference (€0.02–€0.05/message + €99/yr).

WORKING RULES
- Work in the phases given. Stop at the end of each phase with a summary, open
  questions, and test results. Don't start the next phase until approved.
- Any paid service you introduce must be named in the phase summary with an open-source
  alternative and a cost estimate.
- Never commit secrets. Never log content plaintext, pickup tokens, OTPs, or resolved
  credentials.
- When a standard or legal requirement is unclear, cite the clause you relied on and flag
  it. Never fill a gap from memory.
```

---

## 3. Phase plan

| Phase | Scope | Exit gate |
|---|---|---|
| **P0 Spec** | Repo inspection, ETSI event mapping, threat model, OpenAPI draft, D1 schema | Operator approves the event map and the API spec |
| **P1 Evidence core** | Canonicalize/sign/timestamp library, hash chain, verifier CLI | Tamper tests all fail correctly; known-answer vectors pass |
| **P2 Send path** | `/v1/dispatches`, Queues, Stalwart MTA, DSN parsing, notification email | Single dispatch to a test inbox yields the full evidence sequence |
| **P3 Pickup portal** | Token issue, OTP auth, accept/reject, handover evidence | Handover evidence binds the authenticated identity + content hash |
| **P4 Bulk + webhooks** | `/v1/batches`, templates, quotas, throttling, Standard Webhooks | 10k testnet batch, zero lost or duplicated events |
| **P5 Anchoring + bundle** | Merkle batching, second TSA, ProofStreamAnchor root, PDF/A-3 certificate, IPFS pin | Verifier passes a bundle with backend offline |
| **P6 AI assist** | Drafting, inbound classification, entity tracing, HITL approval | No dispatch is possible without the approval record |
| **P7 Qualified relay (later)** | QTSP partner adapter, or own conformity assessment | Separate decision record |

## 4. Open decisions for the operator

1. **Mainnet anchor chain.** Use the same L2 as the bond program, or a separate, cheaper one for high-frequency evidence roots?
2. **Recipient identity strength at pickup.** Email OTP only, or an ID-proofing hook for high-stakes notices (pre-suit, default notices)?
3. **Inline copy default for DMCA agents.** Many designated agents won't click pickup links. Should `inline_copy` default to true for the `dmca_512` notice type?
4. **VPS host and IP** for the MTA (needs a clean IP, PTR control, and port 25 open).
5. **QTSP partner shortlist** for the `qualified_relay` tier, needed only if EU counterparties become material.
