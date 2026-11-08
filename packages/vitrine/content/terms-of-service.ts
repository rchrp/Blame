import type {
  LegalBlock,
  LegalSection,
} from "@/components/legal-document-page";
import { legalDocumentReadyForPublication } from "@/content/legal-publication";
import { publisher } from "@/lib/publisher";

const paragraph = (text: string): LegalBlock => ({ type: "paragraph", text });
const list = (...items: string[]): LegalBlock => ({ type: "list", items });
const notice = (
  title: string,
  paragraphs: readonly string[],
  items?: readonly string[],
): LegalBlock => ({ type: "notice", title, paragraphs, items });

export const termsEffectiveDate = "13 July 2026";
export const termsLastUpdated = "19 July 2026";
export const termsVersion = "1.2";

export const termsIntroduction = [
  `These Terms of Service form a legally binding agreement between you and Raphael Charpentier EI, a French individual entrepreneur applying the micro-enterprise regime and operating under the trade name MK Holding, whose business is domiciled at ${publisher.address}, registered with the French National Business Register and the Lyon Trade and Companies Register under SIREN number ${publisher.siren} (R.C.S. Lyon) ("Blame", "we", "us", or "our"). VAT is not applicable pursuant to Article 293 B of the French General Tax Code. They govern your download, installation, access to, and use of the Blame desktop application, websites, cloud services, APIs, updates, support, and related services.`,
  "Please read these Terms carefully. By creating an account, expressly accepting these Terms, purchasing a Subscription, downloading or installing the Desktop App, or using any part of the Services, you agree to be bound by them. If you do not agree, do not access or use the Services.",
  'If you are a Consumer, mandatory rights under the law of your habitual residence remain unaffected. Provisions expressly addressed to Business Users do not apply to Consumers. If you use the Services for an organisation, you confirm that you have authority to bind that organisation, and "you" includes that organisation.',
] as const;

export const termsSections = [
  {
    id: "contracting-party-and-scope",
    title: "1. Contracting party and scope",
    blocks: [
      paragraph(
        `Blame is the provider and licensor of the Services. Legal enquiries may be sent to legal@blame.so and support enquiries to support@blame.so. Our business telephone number is ${publisher.phone}.`,
      ),
      paragraph(
        "These Terms apply to individual accounts and to any paid or unpaid plan, early-access programme, trial, preview, or beta that refers to them. An order page, checkout page, accepted quotation, or order form may contain plan-specific terms. If there is a conflict, an individually signed order form prevails, followed by the checkout or order terms, these Terms, and incorporated policies, in that order.",
      ),
      paragraph(
        "The Privacy Policy at https://blame.so/privacy, Refund Policy at https://blame.so/refund-policy, any applicable Data Processing Addendum at https://blame.so/legal/dpa, and any plan-specific or supplemental terms expressly presented to you are incorporated by reference in their respective scope.",
      ),
    ],
  },
  {
    id: "definitions",
    title: "2. Definitions",
    blocks: [
      list(
        '"Account" means the account through which you access the Services.',
        '"AI Provider" means a third-party provider of artificial-intelligence models or related services that you connect to Blame, including through an API key or OAuth.',
        '"Business User" means a person or entity using the Services wholly or mainly for a trade, business, craft, or profession.',
        '"Consumer" means a natural person acting for purposes outside that person’s trade, business, craft, or profession.',
        '"Desktop App" means the Blame desktop software and any updates we provide for macOS, Windows, or Linux.',
        '"Output" means code, text, plans, analyses, suggestions, diffs, commands, or other material generated through the Services in response to User Content or instructions.',
        '"Services" means the Desktop App, Blame websites, account and billing services, cloud-synchronisation features, APIs, agent orchestration, updates, and support.',
        '"Subscription" means a paid right to use the Services for the subscription period shown at checkout.',
        '"Third-Party Service" means an AI Provider, MCP server, payment processor, repository host, package registry, authentication provider, website, API, software package, or other product or service not controlled by Blame.',
        '"User Content" means code, repositories, files, prompts, messages, tickets, user stories, comments, project metadata, credentials, configuration, feedback submitted through a feedback feature, and other content you or your authorised users provide to or make accessible through the Services. Feedback governed by Section 15 is excluded from User Content for licensing purposes.',
      ),
    ],
  },
  {
    id: "eligibility-and-acceptance",
    title: "3. Eligibility, authority, and acceptance",
    blocks: [
      paragraph(
        "You must be at least eighteen years old, have reached the age of legal majority where you live, and have legal capacity to enter into this agreement. The Services are not directed to children or offered for use by a parent on behalf of a minor.",
      ),
      paragraph(
        "You may use the Services only if doing so is lawful where you are located and you are not prohibited from receiving them under applicable trade, export-control, or sanctions laws. You must provide accurate, current, and complete registration and billing information.",
      ),
      paragraph(
        "The website may be accessible worldwide, but paid Services are offered only in territories enabled at checkout. We may decline new registrations or purchases where we cannot meet applicable legal, tax, payment, sanctions, language, or support requirements. This does not reduce rights already acquired under an existing Consumer contract.",
      ),
      paragraph(
        "If you accept these Terms for a company, client, employer, public authority, or other organisation, you represent that you have authority to do so. If you lack that authority, you must not use the Services on its behalf.",
      ),
      paragraph(
        "After the contract is concluded, we will provide you on a durable medium with confirmation of the contract, the version of these Terms you accepted, the order and price information, and any legally required consent or acknowledgement. We retain the essential record of each paid electronic contract for ten years and make it accessible on request by emailing legal@blame.so. The archived record includes the applicable Terms version, plan, price, acceptance evidence, and legally required confirmations.",
      ),
    ],
  },
  {
    id: "service-description",
    title: "4. What Blame provides",
    blocks: [
      paragraph(
        "Blame is an agentic development environment. It can help organise backlogs and coding practices, communicate with AI Providers, create or manage Git worktrees and branches, read and modify files, install dependencies, execute commands, start local development services, display previews and diffs, create commits, and assist with merges when directed.",
      ),
      paragraph(
        "Code execution ordinarily occurs on your device or in a local virtualised or containerised runtime. Blame cloud services may synchronise account details, project identifiers, repository fingerprints, backlog items, user stories, comments, prompts, source selections, file attachments, workspace paths, agent inputs and outputs, activity records, model preferences, non-secret MCP endpoint and configuration metadata, provider connection metadata, and billing status. Source code or file content may also be transmitted to an AI Provider, MCP server, or other Third-Party Service when you select, configure, or instruct the Services to use it.",
      ),
      paragraph(
        "Blame is a tool that acts on your instructions and configuration. It is not your employee, contractor, fiduciary, legal adviser, security auditor, or substitute for professional engineering review. Unless an order form expressly says otherwise, the Services do not include managed development, guaranteed outcomes, or a service-level agreement.",
      ),
      paragraph(
        "Current functionality, compatibility, interoperability, and technical requirements are described at https://blame.so/system-requirements. Before purchase or installation, review the supported operating-system versions and architectures, required storage and memory, virtualisation or WSL requirements, Git and development dependencies, permissions, network access, and AI Provider requirements. Features may be unavailable or degraded in an unsupported or incompatible environment, subject to mandatory conformity rights.",
      ),
    ],
  },
  {
    id: "accounts",
    title: "5. Accounts and account security",
    blocks: [
      paragraph(
        "Each standard Subscription is licensed to one named developer unless the applicable order says otherwise. You must not share Account credentials, allow concurrent use by unauthorised persons, sell or transfer an Account, or misrepresent the identity of an Account user. The named developer may activate and use the Desktop App on up to three devices under that Subscription, provided the devices are controlled by that developer. A device may be replaced after the old device is deactivated. Local virtual machines and containers created by Blame on an activated device do not count as separate devices.",
      ),
      paragraph(
        "You are responsible for maintaining the confidentiality of passwords, access tokens, API keys, OAuth credentials, recovery methods, and devices associated with your Account. You must use reasonable security safeguards and notify us promptly at security@blame.so if you suspect unauthorised access, loss of credentials, or a security incident affecting the Services.",
      ),
      paragraph(
        "You are responsible for activity carried out through your Account to the extent permitted by law, except activity caused by our breach of these Terms or failure to use legally required care. We may require identity or authority verification before restoring access, changing sensitive details, or responding to an account request.",
      ),
    ],
  },
  {
    id: "subscriptions-and-payment",
    title: "6. Subscriptions, prices, payment, and taxes",
    blocks: [
      paragraph(
        "Paid access requires an active Subscription. Available plans, billing periods, included features, total price, applicable taxes, and any minimum commitment are shown before purchase. The current public offer may include monthly and annual billing, but the checkout information accepted by you controls for that purchase.",
      ),
      paragraph(
        "Payments are processed by Stripe or another payment processor identified at checkout. You authorise us and the processor to charge the selected payment method for the initial period, renewals, applicable taxes, and any other amounts expressly accepted by you. The processor’s own terms and privacy notice apply to its processing activities.",
      ),
      paragraph(
        "Prices displayed to Consumers are the total prices payable at checkout. Blame does not currently add French VAT where the exemption under Article 293 B of the French General Tax Code applies. If Blame becomes required to collect VAT, sales tax, or a similar indirect tax in your jurisdiction, the applicable amount will be identified before you place the order and will apply only to the relevant purchase or a future renewal after legally required notice. Business Users must provide valid billing and tax information and remain responsible for any reverse-charge, withholding, or similar obligation that the law places on them.",
      ),
      paragraph(
        "AI Provider usage, third-party or user-procured cloud infrastructure, paid MCP servers, repository hosting, network access, and other user-selected Third-Party Services are not included in the Blame Subscription unless expressly stated. Blame-hosted cloud features identified as included in your selected plan are covered by the Subscription price. You are responsible for the separate accounts, charges, quotas, and billing disputes associated with services you procure.",
      ),
      paragraph(
        "If a payment is declined, reversed, disputed, overdue, or cannot be collected, we may retry it and suspend paid features after any notice or grace period required by law. You remain responsible for properly due amounts. We will not charge undisclosed fees.",
      ),
      notice("French business payment terms, if applicable", [
        "If Blame invoices a Business User outside the immediate online checkout process, payment is due within thirty days of the invoice date. Late-payment interest accrues automatically from the day after the due date at the European Central Bank refinancing rate in force on 1 January or 1 July, as applicable, plus ten percentage points, and never below the mandatory minimum rate, without a reminder. The statutory EUR 40 fixed recovery indemnity and any additional documented recovery costs recoverable by law also apply. No discount applies for early payment unless the invoice states otherwise.",
      ]),
    ],
  },
  {
    id: "renewal-cancellation-refunds",
    title: "7. Renewal, cancellation, and refunds",
    blocks: [
      paragraph(
        "Unless checkout states that a plan is non-renewing, each Subscription automatically renews for successive periods equal to the selected billing period until cancelled. We will provide any renewal reminder required by applicable law. You may cancel through the Stripe Customer Portal opened by the Billing link under Consumer rights on blame.so, or by contacting billing@blame.so. We will send a durable confirmation stating the date on which cancellation takes effect and its consequences.",
      ),
      paragraph(
        "For Consumers in France, the Billing link provides free, direct, easy, and permanent access to the Stripe Customer Portal, including when the Subscription was originally concluded through another channel. Contacting support is an additional option and does not replace that facility. The French-language contract reproduces the statutory provisions required by Article L. 215-4 of the French Consumer Code at https://blame.so/fr/conditions-generales-de-service#renouvellement.",
      ),
      paragraph(
        "Cancellation stops future renewal and ordinarily takes effect at the end of the paid billing period. You retain access until then unless you request earlier account closure, a refund requires earlier termination, or we are legally entitled to suspend or terminate access. Cancellation does not itself delete the Account or local files.",
      ),
      paragraph(
        "Cancelling Blame does not cancel an AI Provider, MCP server, hosting, repository, or other Third-Party Service. You must cancel those services directly with their providers to stop any separate charges.",
      ),
      paragraph(
        "Except where these Terms, the checkout, or mandatory law provides otherwise, fees already paid are non-refundable and we do not provide credits for a partially used billing period. This does not limit statutory withdrawal rights, legal-conformity remedies, refunds for amounts charged in error, or any express commercial refund promise presented at purchase.",
      ),
      paragraph(
        "We may change a recurring price by giving reasonable prior notice and, for Consumers, at least the notice required by applicable law before the change applies to a renewal. If you do not agree, you may cancel before the new price takes effect. A price change does not apply retroactively.",
      ),
    ],
  },
  {
    id: "consumer-withdrawal",
    title: "8. Consumer right of withdrawal",
    blocks: [
      notice("Notice for EEA and United Kingdom Consumers", [
        `If you are a Consumer in the European Economic Area or the United Kingdom and purchase at a distance, you generally have fourteen days from conclusion of the contract to withdraw without giving a reason. To exercise that right, send an unambiguous statement to Raphael Charpentier EI, ${publisher.address}, or withdrawal@blame.so. Consumers in France may also use the direct and permanently available electronic withdrawal function at https://blame.so/withdraw. You may use the model form in Schedule 2, but it is not mandatory.`,
        "If you ask us to begin the digital service during the withdrawal period and then exercise a valid withdrawal right, Blame will not deduct a proportional charge for the part supplied before withdrawal. Any loss of a withdrawal right for digital content supplied without a tangible medium applies only after the separate prior express consent and acknowledgement required by law. Acceptance of these Terms alone is not treated as that separate consent.",
        "We will acknowledge an electronic withdrawal request on a durable medium without undue delay. Where withdrawal is valid, we will reimburse all amounts due without undue delay and no later than fourteen days after receiving your notice, using the original payment method unless you expressly agree otherwise. No fee will be charged for the reimbursement.",
      ]),
      paragraph(
        "Consumers outside those territories may have similar cancellation rights under local law. Nothing in these Terms restricts them. Contact support@blame.so for assistance.",
      ),
    ],
  },
  {
    id: "software-license",
    title: "9. Software licence",
    blocks: [
      paragraph(
        "Subject to these Terms and payment of applicable fees, Blame grants you a limited, personal, non-exclusive, non-transferable, and non-sublicensable licence during the applicable Subscription or authorised access period to install and use the Desktop App in object-code form for software-development activities that you are authorised to perform for yourself, your employer, or your clients. The licence may end before that period expires only as provided in Section 20 or mandatory law.",
      ),
      paragraph(
        "You may make a reasonable backup copy where permitted by law. You may not copy, distribute, rent, lease, sell, sublicense, make available as a hosted service, remove proprietary notices from, circumvent technical restrictions in, or create derivative works of the Desktop App, except to the extent an applicable open-source licence or mandatory law expressly permits it.",
      ),
      paragraph(
        "You may not reverse engineer, decompile, or disassemble the Desktop App except to the limited extent that mandatory law permits and only after requesting information from us where the law requires that step. Rights not expressly granted are reserved.",
      ),
      paragraph(
        "Components distributed under open-source or other third-party licences are governed by those licences to the extent they conflict with this Section. Nothing in these Terms restricts rights granted to you under those licences. The restrictions in this Section apply only to Blame proprietary software and material. Applicable notices are provided at https://blame.so/legal/third-party-notices.",
      ),
    ],
  },
  {
    id: "local-access-and-agent-actions",
    title: "10. Local access and agent actions",
    blocks: [
      paragraph(
        "The Desktop App and agents may receive extensive access to repositories, files, terminals, Git configuration, local development services, containers, virtual machines, network connections, and credentials that you make available. Depending on your settings and approvals, they may read, create, modify, move, or delete files; copy environment files; install or update software and packages; execute scripts and commands; start or stop services; create branches or worktrees; commit code; resolve conflicts; and merge changes.",
      ),
      paragraph(
        "You authorise only the actions you initiate, approve, or configure for automatic execution. An approval control reduces risk but cannot guarantee that an action is safe or has only the expected effects. Before granting access or approval, you must understand the proposed scope and have permission to act on every affected repository, device, account, system, and dataset.",
      ),
      list(
        "Maintain current, tested backups and version-control history independent of Blame.",
        "Review commands, diffs, dependency changes, generated files, database operations, commits, and merges before relying on or deploying them.",
        "Use isolated environments and least-privilege credentials, especially for production, regulated, confidential, or security-sensitive systems.",
        "Do not expose production secrets or personal data unless necessary, lawful, and protected by appropriate safeguards and agreements.",
        "Stop an agent or revoke access if its behaviour is unexpected. Some already-started external requests or system operations may not be reversible.",
      ),
      paragraph(
        "Blame is not a backup, disaster-recovery, source-control hosting, or production-change-management service. You remain responsible for validating and authorising changes and for the security, integrity, legality, deployment, and operation of your software and systems.",
      ),
      paragraph(
        "Runtime setup and project operations may download or install operating-system images, virtualisation or container tools, language runtimes, package managers, development dependencies, browser tooling, file-conversion utilities, and other third-party components. These operations may use substantial network bandwidth, storage, memory, CPU, and battery. You are responsible for reviewing the applicable licences and ensuring that the device and network are suitable.",
      ),
    ],
  },
  {
    id: "third-party-services",
    title: "11. AI Providers, MCP servers, and Third-Party Services",
    blocks: [
      paragraph(
        "The Services interoperate with Third-Party Services. Some are selected or configured by you; others may be bundled with, downloaded by, or used to operate the Services. Their terms, acceptable-use rules, privacy practices, availability, security, data-location choices, retention, intellectual-property rules, and charges may be controlled by their providers. For a service or account you select or procure, you must maintain the required rights, accounts, licences, and consents. Blame remains responsible for having the rights needed to distribute components that Blame bundles or directs the Desktop App to download as an included part of the Services.",
      ),
      paragraph(
        "When you connect an AI Provider, Blame may store encrypted API keys or OAuth credentials in its cloud service and deliver resolved credentials to the Desktop App for authorised requests. Credentials or local copies may also remain in application or runtime configuration until you remove or reset the relevant local data. Prompts, source-code excerpts, files, tool results, metadata, or other User Content needed for a request may be sent to the AI Provider and any gateway or intermediary used by the selected connection. Those parties may process the material under their agreements with you. Blame does not control or pay their usage charges.",
      ),
      paragraph(
        "MCP servers may be remote services or local commands. They may receive User Content, access external accounts, execute tools, or modify local resources according to their capabilities. Headers, environment variables, OAuth tokens, and other secret MCP configuration may be stored locally and may remain until you delete or reset the relevant configuration. You are responsible for reviewing each server, its operator, requested permissions, transport security, configuration, headers, environment variables, and outputs before enabling it.",
      ),
      paragraph(
        "Listing or supporting an integration does not imply sponsorship, endorsement, partnership, or affiliation. We may disable an integration where reasonably necessary for security, legal compliance, provider requirements, or service integrity. We are not responsible for a user-selected Third-Party Service, but we remain responsible for obligations that applicable law does not allow us to exclude, including our own integration work and included components where the law makes us responsible for them.",
      ),
    ],
  },
  {
    id: "user-content",
    title: "12. User Content and permissions",
    blocks: [
      paragraph(
        "As between you and Blame, you retain ownership of User Content. You grant Blame a worldwide, non-exclusive, limited licence to host, copy, transmit, process, display, and otherwise use User Content only as reasonably necessary to provide, maintain, secure, troubleshoot, and support the Services; comply with law; and enforce these Terms. This licence lasts only for as long as those purposes require, subject to lawful retention and backup cycles.",
      ),
      paragraph(
        "You represent that you have all rights, permissions, notices, and lawful bases needed for Blame and the Third-Party Services you select to process User Content as instructed. You must not submit content that infringes intellectual-property, privacy, confidentiality, publicity, contractual, or other rights, or that you are prohibited from disclosing.",
      ),
      paragraph(
        "If you use the Services to process personal data on behalf of a business, you are responsible for determining your role and complying with applicable data-protection law. Where Blame acts as your processor, the Data Processing Addendum at https://blame.so/legal/dpa is incorporated into the agreement and applies to that processing. The current Subprocessor Register is available at https://blame.so/legal/subprocessors. You must not use the Services for special-category, highly sensitive, health, financial-account, government-identifier, or children’s data unless the applicable documentation expressly supports that use and legally required safeguards are in place.",
      ),
      notice("AI training policy", [
        "As of the effective date, Blame does not use User Content or Output to train or fine-tune an artificial-intelligence model. Blame will not introduce such use merely through an update to these Terms. Any future use will require separate clear prior notice and the user’s optional affirmative consent, will apply only prospectively, and may be withdrawn at any time. Refusing or withdrawing that consent will not restrict the core paid Services.",
        "An AI Provider or gateway selected by you may use or retain submitted material under its own agreement and privacy practices. Review those terms and provider controls before connecting the service. Blame cannot change or waive a third party’s policy on your behalf.",
      ]),
    ],
  },
  {
    id: "output",
    title: "13. Output and your responsibility to review it",
    blocks: [
      paragraph(
        "As between you and Blame, and to the extent permitted by applicable law, you may use Output created for you. For the entire legal term of the relevant rights and throughout the world, Blame assigns to you any transferable intellectual-property rights that Blame may obtain in that Output, including the rights to reproduce, represent, display, adapt, translate, modify, distribute, communicate, and make it available in any medium and for any lawful purpose. The assignment excludes the Services, Blame technology, documentation, templates, pre-existing material, third-party material, and open-source components. No right is transferred where Blame does not own it, the law does not recognise it, or it is inalienable, including an inalienable moral right.",
      ),
      paragraph(
        "Output may be inaccurate, incomplete, insecure, obsolete, non-functional, harmful, biased, or similar or identical to material generated for others. It may contain third-party or open-source material subject to separate licences, attribution duties, copyleft terms, patent risks, or other restrictions. Blame does not conduct comprehensive originality, security, licence, or infringement clearance for Output.",
      ),
      list(
        "Review, test, scan, and validate Output before committing, merging, publishing, deploying, or relying on it.",
        "Verify factual, legal, security, accessibility, privacy, performance, compatibility, and licensing requirements using qualified human review.",
        "Maintain appropriate tests, code review, dependency review, secret scanning, vulnerability management, and deployment controls.",
        "Do not represent unreviewed Output as human-reviewed or fit for a regulated, high-risk, or safety-critical purpose.",
      ),
      paragraph(
        "You are responsible for decisions made and actions taken using Output. Any provider-specific rights or restrictions for model output remain governed by your agreement with the relevant AI Provider.",
      ),
      paragraph(
        "The Services present model-generated interactions as agent responses and may identify the selected AI Provider or model. You must not remove or conceal an AI disclosure in a misleading way and must comply with any applicable duties to label, mark, document, or disclose AI-generated or manipulated content when you distribute, publish, or deploy Output.",
      ),
    ],
  },
  {
    id: "acceptable-use",
    title: "14. Acceptable use",
    blocks: [
      paragraph("You must not use or attempt to use the Services to:"),
      list(
        "violate law, sanctions, export controls, court orders, or the rights of any person;",
        "access, scan, test, disrupt, damage, overload, or control a device, account, network, repository, model, or system without valid authorisation;",
        "create, deliver, conceal, or facilitate malware, ransomware, credential theft, destructive code, unauthorised surveillance, fraud, phishing, spam, or circumvention of security controls;",
        "upload or transmit unlawful, infringing, deceptive, defamatory, abusive, exploitative, or privacy-invasive material;",
        "extract data, scrape, benchmark, probe, or use automated means against the hosted Services in a way that bypasses documented interfaces or reasonable rate limits, except for good-faith security research authorised in writing;",
        "circumvent payment, licence, authentication, access, safety, or usage controls, or conceal the origin of requests;",
        "resell, sublicense, time-share, or provide the Services to third parties as a service bureau unless an order expressly permits it;",
        "use the Services or Output as the sole basis for decisions that determine a person’s legal rights, access to essential services, employment, credit, insurance, housing, medical care, or physical safety;",
        "interfere with other users, introduce material that can damage the Services, or help another person do anything prohibited by these Terms.",
      ),
      paragraph(
        "You may conduct security testing of your own code and systems, or systems you are authorised to test, provided it is lawful and does not target or endanger Blame infrastructure or other users. Contact security@blame.so before testing Blame-hosted infrastructure.",
      ),
    ],
  },
  {
    id: "intellectual-property",
    title: "15. Blame intellectual property and feedback",
    blocks: [
      paragraph(
        "Blame and its licensors own the Services, proprietary software, interfaces, visual designs, documentation, orchestration logic supplied by us, trademarks, domains, and all related intellectual-property rights. Third-party models and components remain owned by their respective rights holders. Except for the limited licence in Section 9, these Terms transfer no right in Blame proprietary material to you.",
      ),
      paragraph(
        "If you voluntarily provide a suggestion, idea, evaluation, bug report, or other feedback about Blame outside material that you identify as confidential, you retain ownership and grant us, for the entire legal term of the relevant rights and throughout the world, a non-exclusive, transferable, sublicensable, royalty-free licence to reproduce, represent, display, adapt, translate, modify, distribute, communicate, make available, and incorporate that feedback in any medium to evaluate, operate, secure, support, document, market, improve, or develop the Services and related products. Nothing in this licence transfers or waives an inalienable moral right. We will not publicly identify you as the source without permission.",
      ),
      paragraph(
        '"Blame" and associated logos are our trademarks or trade names. You may not use them in a way that implies endorsement, partnership, or affiliation without prior written permission. Fair descriptive use and rights that cannot legally be restricted remain unaffected.',
      ),
    ],
  },
  {
    id: "privacy-security-confidentiality",
    title: "16. Privacy, security, and confidentiality",
    blocks: [
      paragraph(
        "Our processing of personal data is described in the Privacy Policy at https://blame.so/privacy. The Privacy Policy identifies the controller, purposes, legal bases, categories of data, recipients, international transfers, retention, rights, complaint authority, and contact details applicable to the Services.",
      ),
      paragraph(
        "We use reasonable technical and organisational safeguards appropriate to the nature of the Services and information we process. No system, encryption method, credential store, local runtime, network transmission, or third-party integration is completely secure. You are responsible for securing your endpoints, repositories, local environment, backups, provider accounts, and MCP configuration.",
      ),
      paragraph(
        "Each party will protect the other party’s non-public information disclosed in connection with the Services using at least reasonable care, use it only to perform or exercise rights under the agreement, and disclose it only to personnel and providers who need it and are bound by appropriate duties. These duties do not apply to information that is public without breach, already lawfully known, independently developed, or lawfully received without restriction.",
      ),
      paragraph(
        "A party may disclose confidential information where law or valid legal process requires it, after giving advance notice where legally permitted and reasonable assistance at the other party’s expense. Trade-secret duties continue for as long as the information remains a trade secret; other confidentiality duties continue for five years after the later of disclosure or termination. Duties concerning personal data continue for as long as applicable law requires.",
      ),
      notice("Diagnostics and telemetry", [
        "Blame creates diagnostic logs locally on your device and in project or worktree .blame directories. These logs may include technical configuration, operating-system and runtime information, provider and model identifiers, session identifiers, token and estimated-cost data, tool names, command or process output, file paths, prompt hashes and lengths, OAuth account metadata, and error details. Local logs are not automatically transmitted to Blame.",
        "When you are signed in, Blame automatically sends minimised operational events, metrics and traces to Blame to measure reliability, operation outcomes and durations, broad feature performance, usage and cost trends, capacity and recurring technical failures. This telemetry is designed to exclude prompts, source code, file content and paths, repository URLs, commands and output, tool arguments and results, reusable credentials, free-form error messages and stack traces. The Privacy Policy describes the exact categories, purposes, retention and legal basis.",
        "If a runtime setup, repair or reset operation fails, Blame sends the detailed failure information only if you select the Send diagnostic action. You should review the displayed information and not submit it if it contains secrets or unrelated personal or confidential information. Blame does not sell telemetry data or use it for targeted advertising, individual employee-performance monitoring or AI-model training.",
      ]),
    ],
  },
  {
    id: "availability-support-backups",
    title: "17. Availability, support, and backups",
    blocks: [
      paragraph(
        "We aim to keep the hosted Services available and to correct material faults, but maintenance, security events, internet failures, Third-Party Services, local-system conditions, and events outside reasonable control may cause interruption. No uptime, response-time, recovery-time, or support commitment applies unless stated in an order form or required by Consumer law.",
      ),
      paragraph(
        "Support requests may be submitted at any time to support@blame.so and are ordinarily reviewed from 09:00 to 18:00 Europe/Paris time, Monday through Friday, excluding French public holidays. These hours are not a guaranteed response or resolution time. Support may require logs, diagnostic information, reproduction steps, or temporary access that you choose to provide. You must remove secrets and unrelated personal or confidential information before sending diagnostic material unless we specifically agree on a secure method.",
      ),
      paragraph(
        "Cloud synchronisation is not a complete repository backup, and local runtime data may be deleted during cleanup, repair, reset, reinstallation, or removal of worktrees or containers. You must maintain independent backups of repositories, databases, environment files, credentials, prompts, important account data, and Output.",
      ),
    ],
  },
  {
    id: "updates-and-service-changes",
    title: "18. Updates and changes to the Services",
    blocks: [
      paragraph(
        "The Desktop App may check for updates automatically. Downloads or installation may require your action unless an automatic security or maintenance update mechanism is disclosed. You should install updates within a reasonable time, particularly security and compatibility updates. We are not responsible for a fault caused solely by failure to install an update after clear notice and adequate installation instructions, to the extent the law permits.",
      ),
      paragraph(
        "We may modify the Services to improve functionality or performance, address security or abuse, comply with law or provider requirements, adapt to technical changes, replace discontinued integrations, or maintain compatibility. We will not materially reduce the core paid functionality during a current fixed billing period without a valid reason and reasonable notice, except where urgent security or legal action is required.",
      ),
      notice("Additional protection for Consumers", [
        "Where Consumer law governs a modification that is not necessary to maintain conformity, we will make it only where the contract permits it for a valid reason, without additional cost, and after clear advance notice on a durable medium. The notice will state the nature and date of the change and any right to reject the change or terminate. If the change negatively affects access or use more than minimally, the Consumer may terminate without charge within the period provided by law unless we allow the unmodified conforming version to remain available without extra cost.",
      ]),
      paragraph(
        "We may discontinue a non-essential feature or the Services as a whole on reasonable notice. If we discontinue a paid Service before the end of a prepaid period for reasons not caused by you, we will provide a pro-rata refund for the unavailable remainder, unless a replacement of materially equivalent value is accepted or mandatory law provides a different remedy.",
      ),
    ],
  },
  {
    id: "early-access",
    title: "19. Early access, beta, and preview features",
    blocks: [
      paragraph(
        "A specific feature identified as alpha, beta, experimental, preview, evaluation, or pre-release may be incomplete, unstable, changed substantially, or withdrawn. It may have errors, weaker documentation, limited support, or a higher risk of data loss and must not be used for production or safety-critical work unless we expressly approve that use in writing. A general marketing description of Blame as early access does not by itself classify the entire paid product as a preview feature or prohibit ordinary production use.",
      ),
      paragraph(
        "For Business Users, preview features are provided as available and without a service-level commitment. Consumers retain all mandatory rights, and a paid feature cannot be labelled beta merely to avoid a statutory obligation. We will identify any material limitations that a Consumer would reasonably need to know before purchase.",
      ),
    ],
  },
  {
    id: "suspension-and-termination",
    title: "20. Suspension, termination, and data after termination",
    blocks: [
      paragraph(
        "You may stop using the Services at any time and may request Account closure at https://blame.so/account/privacy or by emailing privacy@blame.so from the Account email address. We may take proportionate steps to verify identity and protect the Account before acting. Subscription cancellation is governed by Section 7 and does not automatically erase data. Local repositories, worktrees, files, and credentials remain under your control and must be removed by you where desired.",
      ),
      paragraph(
        "We may restrict or suspend access where reasonably necessary to prevent a security incident or material harm, comply with law or a binding request, address non-payment, protect the Services or third parties, or investigate a credible material breach. Where practicable and lawful, we will explain the reason, limit the suspension to what is necessary, and give you a reasonable opportunity to cure or appeal.",
      ),
      paragraph(
        "Either party may terminate for a material breach that is not cured within fifteen days after written notice, unless the breach cannot be cured or urgent termination is legally justified. We may terminate immediately for serious unlawful or abusive conduct, fraud, unauthorised access, repeated infringement, or a threat to security. Consumer contracts may be terminated only on grounds and through procedures permitted by mandatory law.",
      ),
      paragraph(
        "Before closure, you should use the verified in-app procedure to export data you wish to retain, or contact privacy@blame.so for a broader eligible request. The in-app export provides structured JSON, and broader requests are ordinarily answered within the legally applicable period after identity verification. Dedicated password, API-key, OAuth-token, bearer-token, and other authentication fields are excluded. Free-form projects, prompts, attachments, messages, commands, output, and configuration are exported as provided and may reproduce secrets you supplied. Where applicable law requires it, we will make eligible non-personal content provided or created by a Consumer available free of charge, subject only to statutory exceptions.",
      ),
      paragraph(
        "After a verified closure request, we will disable Account access and ordinarily delete or irreversibly anonymise active cloud User Content within thirty days. We provide a closure receipt with a request identifier and a protected status-check credential. Residual backup copies expire through scheduled rotation within ninety days after active deletion. We may retain contract, invoice, payment, security, fraud-prevention, dispute, and compliance records for the periods required or permitted by law in access-restricted archives, as further described in the Privacy Policy.",
      ),
      paragraph(
        "When the software licence ends, you must stop using and uninstall the proprietary Desktop App unless a surviving right or mandatory law permits continued use. Termination does not transfer ownership of or require deletion of your local repositories, source code, or Output, but you remain responsible for removing local credentials, runtime configuration, logs, containers, worktrees, and other Blame-managed data that you no longer want to retain.",
      ),
      paragraph(
        "Terms that by nature should continue after termination survive, including accrued payment duties, ownership, confidentiality, disclaimers, liability limits, indemnities, dispute terms, and general provisions. Termination does not affect rights or remedies accrued beforehand.",
      ),
    ],
  },
  {
    id: "consumer-guarantees",
    title: "21. Consumer guarantees and remedies",
    blocks: [
      paragraph(
        "If you are a Consumer, we will provide the Services with the quality, functionality, compatibility, continuity, security, support, instructions, and updates required by the contract and mandatory law. Any description, compatibility requirement, limitation, or special purpose accepted by us forms part of the contract as the law provides.",
      ),
      paragraph(
        "If a digital service is not supplied or is not in conformity, you may be entitled to have it supplied or brought into conformity without charge and without undue delay, or to receive a price reduction, suspend payment, terminate, obtain a refund, recover eligible content, or claim damages as applicable. Contact support@blame.so with the Account email, affected feature, dates, environment, and a description of the issue. We may request reasonable cooperation to diagnose compatibility, provided that method is technically available and least intrusive.",
      ),
      paragraph(
        "Nothing in these Terms excludes or limits a statutory guarantee, remedy, product-liability rule, right to updates, right to data, or other Consumer protection that cannot lawfully be excluded. The notice in Schedule 1 applies where French Consumer law governs.",
      ),
    ],
  },
  {
    id: "business-warranties",
    title: "22. Warranties and disclaimers for Business Users",
    blocks: [
      notice("This Section applies only to Business Users", [
        'To the maximum extent permitted by law, the Services, Output, preview features, and documentation are provided "as is" and "as available". Blame disclaims implied warranties and conditions of merchantability, satisfactory quality, fitness for a particular purpose, non-infringement, title, accuracy, uninterrupted availability, and results arising from course of dealing or usage of trade.',
        "Blame does not warrant that the Services or Output will be error-free, secure, complete, unique, compliant with your requirements, compatible with every environment, or free from vulnerable, infringing, or harmful material. No statement outside an authorised written order form creates a warranty.",
      ]),
      paragraph(
        "The disclaimers do not apply to an express warranty in an order form or to liability that cannot legally be excluded, including fraud or fraudulent misrepresentation. They allocate risks reflected in the price and the nature of AI-assisted development tools.",
      ),
    ],
  },
  {
    id: "liability",
    title: "23. Liability",
    blocks: [
      notice("Liability to Consumers", [
        "Nothing in these Terms limits liability or remedies where doing so is prohibited by law. We are responsible for foreseeable loss caused by our breach of these Terms or failure to use legally required care. We are not responsible for loss that was not foreseeable when the contract was made, that results from your unlawful or unauthorised use, or that is a business loss suffered by a Consumer. A loss is foreseeable if it was an obvious consequence or both parties knew it might occur.",
      ]),
      notice("Liability to Business Users", [
        "To the maximum extent permitted by law, neither party is liable for indirect, incidental, special, exemplary, or consequential loss, or for loss of profit, revenue, anticipated savings, goodwill, business opportunity, or data, even if advised that it was possible. Blame is not liable for costs of substitute services, Third-Party Services, AI Provider charges, or damage caused by User Content, your configuration, your approvals, or use of Output without appropriate review.",
        "Except for excluded liabilities below, Blame’s total aggregate liability arising out of or related to the Services and these Terms, whether in contract, tort, statute, misrepresentation, restitution, or otherwise, will not exceed the greater of EUR 100 and the fees paid or payable by you to Blame for the Services during the twelve months immediately before the first event giving rise to liability.",
      ]),
      paragraph(
        "No exclusion or cap applies to fraud, fraudulent misrepresentation, wilful misconduct, gross negligence where it cannot be limited, death or personal injury caused by negligence, breach of confidentiality or data-protection liability to the extent it cannot be limited, your payment obligations, your infringement or misuse of our intellectual property, or any other liability that law prohibits a party from excluding or limiting. No exclusion or cap applies to the extent it would deprive an essential contractual obligation of its substance or create a prohibited significant imbalance.",
      ),
      paragraph(
        "Each party must take reasonable steps to mitigate loss. Multiple claims arising from the same or related facts count as one event for the Business User cap. Any special liability allocation in a signed order form controls for that order.",
      ),
    ],
  },
  {
    id: "business-indemnity",
    title: "24. Indemnity for Business Users",
    blocks: [
      notice("This Section applies only to Business Users", [
        "You will defend, indemnify, and hold harmless Blame and its officers, employees, and contractors from third-party claims, damages, judgments, settlements, penalties, and reasonable legal fees arising from User Content, your unlawful or unauthorised use of the Services, your breach of Sections 10 through 14, or your infringement of a third party’s rights.",
        "This duty does not apply to the extent a claim was caused by Blame’s breach, negligence, wilful misconduct, or modification of User Content contrary to your instructions. We must promptly notify you, give you reasonable control of the defence and settlement, and cooperate at your expense. You may not settle in a way that admits fault by or imposes an obligation on Blame without our written consent, not to be unreasonably withheld.",
      ]),
    ],
  },
  {
    id: "changes-to-terms",
    title: "25. Changes to these Terms",
    blocks: [
      paragraph(
        "We may publish a new version of these Terms for legal or regulatory changes, security, new or changed features, clarity, or to prevent abuse. Each version will show a unique version identifier and effective date. A change does not apply retroactively to a dispute or event that arose before it became effective.",
      ),
      notice("Consumers", [
        "A change to a current Consumer contract applies only where mandatory law allows it. A change to the digital service during the current term is governed by Section 18. Other material contractual changes will ordinarily be proposed for the next renewal after clear advance notice on a durable medium and express acceptance where required. Silence or continued use does not constitute acceptance where the law requires an affirmative act. If you reject a proposed change, you may cancel before it takes effect, and any statutory termination or refund right remains available.",
      ]),
      notice("Business Users", [
        "For a material change, we will provide reasonable advance notice by email, in-app notice, or another durable medium associated with the Account. If the change is materially detrimental and you do not agree, you may cancel before it takes effect. Continued use after a valid effective date constitutes acceptance only where the law permits that method.",
      ]),
      paragraph(
        "We may make an immediate change only to the extent necessary to comply with law, respond to an urgent security threat, or prevent material abuse. We will explain it as soon as reasonably possible unless legally prohibited, and mandatory Consumer rights remain unaffected.",
      ),
    ],
  },
  {
    id: "trade-controls",
    title: "26. Export controls and sanctions",
    blocks: [
      paragraph(
        "You must comply with applicable export-control, import, trade, and sanctions laws. You represent that you are not a prohibited or restricted person and will not make the Services available in an embargoed territory or for a prohibited end use. You must not use the Services to develop or support weapons, unlawful surveillance, or other restricted activities in violation of law.",
      ),
      paragraph(
        "We may restrict access where reasonably necessary to comply with those laws. We will not rely on this Section to discriminate unlawfully or deny mandatory Consumer remedies.",
      ),
    ],
  },
  {
    id: "notices",
    title: "27. Notices and contact",
    blocks: [
      paragraph(
        `Operational messages may be sent in the Desktop App or to the Account email. Formal legal notices to Blame must be sent to legal@blame.so and Raphael Charpentier EI, ${publisher.address}, unless mandatory law permits another method. A notice to you may be sent to the Account email or another postal address you have provided to us.`,
      ),
      paragraph(
        "Email notice is treated as received on the next business day after sending unless the sender receives a delivery failure. Postal notice is treated as received according to applicable law. This Section does not govern service of court proceedings where special rules apply.",
      ),
      list(
        "General support and Consumer complaints: support@blame.so",
        "Billing and cancellation: billing@blame.so",
        "Withdrawal: withdrawal@blame.so",
        "Privacy and data protection: privacy@blame.so",
        "Security reports: security@blame.so",
        "Legal notices: legal@blame.so",
      ),
    ],
  },
  {
    id: "governing-law-disputes",
    title: "28. Governing law and disputes",
    blocks: [
      paragraph(
        "Before starting formal proceedings, please send a written description of the dispute and requested resolution to legal@blame.so. Each party will try in good faith for thirty days to resolve it, unless urgent relief, a limitation period, or a mandatory right requires earlier action.",
      ),
      notice("Consumers", [
        "These Terms are governed by the laws of France, but that choice does not deprive a Consumer of mandatory protection under the law of the country where the Consumer habitually resides. A Consumer may bring proceedings in any court available under mandatory jurisdiction rules, including the courts of the Consumer’s habitual residence where applicable.",
        "After first submitting a written complaint to us, a French Consumer may refer an unresolved dispute free of charge, in accordance with its rules and approved scope, to CM2C — Centre de la Médiation de la Consommation de Conciliateurs de Justice, 49 rue de Ponthieu, 75008 Paris, France, https://www.cm2c.net. CM2C is designated for eligible disputes concerning online and distance sales. Other Consumers may use any alternative dispute-resolution body made available by mandatory local law. Mediation is voluntary unless the law states otherwise and does not remove the right to go to court.",
      ]),
      notice("Business Users", [
        "These Terms and any non-contractual obligations arising from them are governed by the laws of France, without regard to conflict-of-law rules. Subject to mandatory jurisdiction rules, the courts having jurisdiction over Lyon, France, have exclusive jurisdiction, except that either party may seek urgent injunctive relief in any competent court. An exclusive territorial-jurisdiction clause applies only if every contracting party acted as a merchant and the clause was made very apparent when the agreement was accepted; otherwise, the ordinarily competent courts retain jurisdiction.",
      ]),
    ],
  },
  {
    id: "general",
    title: "29. General terms",
    blocks: [
      paragraph(
        "Neither party is liable for delay or failure only to the extent performance is prevented by an event beyond its control that could not reasonably have been foreseen when the contract was concluded and whose effects could not be avoided by appropriate measures. A supplier or third-party infrastructure failure qualifies only if those conditions are met. The affected party must notify the other without undue delay, mitigate the effects, and resume performance when possible. A temporary event suspends the affected obligation unless the resulting delay justifies termination; a permanent event may end the affected obligation as provided by law. This does not excuse payment already due or restrict mandatory Consumer rights.",
      ),
      paragraph(
        "You may not assign or transfer these Terms or an Account without our written consent, except a Business User may assign the agreement with its entire business in a merger, reorganisation, or asset sale if the assignee is not our direct competitor and assumes the obligations in writing. We may assign the agreement as part of a merger, reorganisation, financing, or sale of the relevant business, provided a Consumer’s rights are not reduced.",
      ),
      paragraph(
        "The parties are independent contractors. These Terms do not create employment, agency, partnership, joint venture, fiduciary duty, franchise, or an exclusive relationship. No person other than the parties has a right to enforce them, except an indemnified person under Section 24 where applicable.",
      ),
      paragraph(
        "If a provision is unlawful or unenforceable, it will be enforced to the maximum lawful extent or removed, and the remainder continues. A failure or delay to enforce a right is not a waiver. A waiver must be in writing and applies only to the stated instance.",
      ),
      paragraph(
        'These Terms and incorporated documents are the entire agreement about the Services and replace prior discussions or statements on that subject, without excluding liability for fraud, mandatory pre-contract information, an accepted product description or special purpose, or a public statement that applicable law makes binding. Headings are for convenience. "Including" means "including without limitation". An electronic record and acceptance have the same effect as paper and signature to the extent permitted by law.',
      ),
      paragraph(
        "The English version controls for Business Users and users outside France to the extent permitted by law. For Consumers in France, the French version and legally required pre-contract information provided in French control. No language clause deprives a user of a mandatory right to receive contractual information in another language.",
      ),
    ],
  },
  {
    id: "french-consumer-notice",
    title: "Schedule 1 — French statutory conformity notice",
    blocks: [
      notice(
        "For Consumers covered by French law",
        [
          "The following is an English rendering of the statutory notice for continuous digital content and digital services. The prescribed French wording, adapted to the monthly and annual contractual supply periods, appears in the clearly identified statutory box at https://blame.so/fr/conditions-generales-de-service#garanties-legales.",
          "The Consumer is entitled to implementation of the legal conformity guarantee if a lack of conformity appears at any time during the active Subscription. During that period, the Consumer is required to establish only the existence of the lack of conformity and not the date on which it appeared.",
          "The legal conformity guarantee includes the obligation to provide all updates necessary to maintain conformity throughout the active Subscription.",
          "The legal conformity guarantee entitles the Consumer to have the digital content or digital service brought into conformity without undue delay after the request, free of charge, and without major inconvenience.",
        ],
        [
          "The professional refuses to bring the digital content or digital service into conformity.",
          "Conformity is delayed without justification.",
          "Conformity cannot be achieved without imposing costs on the Consumer.",
          "Bringing the content or service into conformity causes major inconvenience to the Consumer.",
          "The lack of conformity persists despite an unsuccessful attempt to bring the content or service into conformity.",
        ],
      ),
      paragraph(
        "In those circumstances, the Consumer may obtain a price reduction while keeping the digital content or digital service, or may terminate the contract and obtain a full refund in exchange for ceasing to use it. The Consumer is also entitled to an immediate price reduction or termination where the lack of conformity is sufficiently serious. For a minor lack of conformity, termination is available only where the contract does not require payment.",
      ),
      paragraph(
        "Any period during which the digital content or digital service is unavailable so that it can be brought into conformity suspends the remaining guarantee period until the conforming content or service is supplied again. These rights arise under Articles L. 224-25-1 to L. 224-25-31 of the French Consumer Code.",
      ),
      paragraph(
        "A professional who in bad faith obstructs implementation of the legal conformity guarantee may incur a civil fine of up to EUR 300,000, which may be increased to 10% of average annual turnover under Article L. 242-18-1 of the French Consumer Code.",
      ),
      paragraph(
        "The Consumer also benefits from the legal guarantee against hidden defects under Articles 1641 to 1649 of the French Civil Code for two years from discovery of the defect. This gives a right to a price reduction if the digital content or digital service is retained, or a full refund in exchange for ceasing to use it.",
      ),
    ],
  },
  {
    id: "withdrawal-form",
    title: "Schedule 2 — Model withdrawal form",
    blocks: [
      paragraph(
        "Complete and return this form only if you wish to withdraw from the contract. You may instead send any other clear statement that identifies the contract and your decision.",
      ),
      notice("Model form", [
        `To: Raphael Charpentier EI, operating under the trade name MK Holding, ${publisher.address}, withdrawal@blame.so.`,
        "I/We hereby give notice that I/We withdraw from my/our contract for the supply of the following digital service: ____________________.",
        "Ordered on / contract concluded on: ____________________.",
        "Consumer name: ____________________.",
        "Consumer address: ____________________.",
        "Email address associated with the Account: ____________________.",
        "Consumer signature, only if this form is submitted on paper: ____________________.",
        "Date: ____________________.",
      ]),
    ],
  },
] satisfies readonly LegalSection[];

const termsApprovedForPublication = true;

export const termsReadyForPublication = legalDocumentReadyForPublication(
  termsApprovedForPublication,
  {
    termsEffectiveDate,
    termsIntroduction,
    termsSections,
    termsVersion,
  },
);
