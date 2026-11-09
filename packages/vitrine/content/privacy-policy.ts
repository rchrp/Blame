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

export const privacyEffectiveDate = "13 July 2026";
export const privacyLastUpdated = "9 November 2026";
export const privacyVersion = "1.4";

export const privacyIntroduction = [
  'This Privacy Policy explains how Raphael Charpentier EI, a French individual entrepreneur applying the micro-enterprise regime and operating under the trade name MK Holding ("Blame", "we", "us", or "our"), collects, uses, stores, discloses, and otherwise processes personal data in connection with Blame Desktop, the blame.so website, cloud services, accounts, billing, updates, and support (together, the "Services").',
  "Blame is an agentic software-development environment. Depending on how you use it, the Services may process source code, prompts, files, terminal output, logs, repository metadata, credentials, and other material that contains personal data about you or other people. Some data remains on your device, some is synchronised to Blame cloud services, and some is sent to AI providers, gateways, MCP servers, or other integrations that you choose.",
  "This Policy is a privacy notice, not a request for blanket consent and not a substitute for the terms or privacy notices of third-party services. Please read it together with the Blame Terms of Service and any Data Processing Addendum that applies to your organisation.",
] as const;

export const privacySections = [
  {
    id: "controller-and-contact-details",
    title: "1. Controller and contact details",
    blocks: [
      paragraph(
        `For the processing described in this Policy for which Blame determines the purposes and means, the data controller is Raphael Charpentier EI, operating under the trade name MK Holding, ${publisher.address}, registered with the French National Business Register and the Lyon Trade and Companies Register under SIREN number ${publisher.siren} (R.C.S. Lyon).`,
      ),
      list(
        "Privacy enquiries and rights requests: privacy@blame.so",
        "Security reports: security@blame.so",
        "General support: support@blame.so",
        `Telephone: ${publisher.phone}`,
        `Postal address: ${publisher.address}`,
      ),
      paragraph(
        "Blame has not appointed a Data Protection Officer. The privacy contact above handles data-protection enquiries. Contacting us does not affect your right to contact a competent supervisory authority.",
      ),
    ],
  },
  {
    id: "scope-and-data-protection-roles",
    title: "2. Scope and data-protection roles",
    blocks: [
      paragraph(
        "This Policy applies when you visit the Blame website, download or use Blame Desktop, create or use an Account, purchase or manage a Subscription, contact support, obtain updates, or otherwise interact with the Services. It does not govern a third-party website, AI provider, gateway, MCP server, repository host, package registry, operating-system service, or other integration that has its own privacy practices.",
      ),
      paragraph(
        "Blame acts as controller for Account administration, authentication, subscriptions, billing records, service security, abuse prevention, support, product communications, and Blame's own service-operation and compliance activities.",
      ),
      paragraph(
        "Where a Business User determines the purposes and essential means of processing personal data contained in its repositories, prompts, files, or other Customer Content, and Blame processes that data solely to provide the Services on the Business User's documented instructions, the Business User is the controller and Blame acts as its processor. That processing must be governed by an applicable Data Processing Addendum. Contact legal@blame.so to arrange it before placing personal data under Blame's processor role. Blame remains a controller for its separate Account, billing, security, and legal-compliance processing.",
      ),
      paragraph(
        "A Business User is responsible for giving any required notices, establishing a lawful basis, managing its authorised users, and responding to requests from people whose personal data it places in the Services. If a person contacts us about data for which we act only as processor, we may direct the request to the relevant Business User and assist it as required by law and the applicable Data Processing Addendum.",
      ),
    ],
  },
  {
    id: "data-flow-summary",
    title: "3. What stays local, what reaches Blame, and what goes elsewhere",
    blocks: [
      notice("Data-flow summary", [
        "Opening a repository in Blame does not, by itself, upload a complete copy of that repository to Blame. However, selected code, attached files, prompts, project-initialisation material, agent activity, tool results, command output, errors, and other working content can be stored in Blame cloud services and transmitted to the AI provider, gateway, MCP server, or integration used for a task.",
        "You should treat every provider or integration that you enable as a potential recipient of the data made available to its models, tools, or commands. Review its settings and privacy terms before use.",
      ]),
      list(
        "Local processing includes repositories, worktrees, local commands, virtual machines or containers, unsent drafts, recent project paths, interface preferences, local sessions, local provider or MCP settings, and diagnostic files.",
        "Blame cloud processing includes Account and subscription data, project identifiers and fingerprints, stories and chats, selected code and attachments, comments, project-initialisation records, agent inputs and results, activity and usage records, provider connection details, AI preferences, and non-secret MCP configuration metadata.",
        "Third-party processing can include payment data handled by Stripe, content sent to your selected AI provider or gateway, data exposed to an MCP server, update and download requests, and data processed by infrastructure or communications providers.",
      ),
    ],
  },
  {
    id: "personal-data-categories",
    title: "4. Personal data we process",
    blocks: [
      paragraph(
        "The categories below describe data we may process depending on the features you use. A file, prompt, log, or repository can contain any category of personal data even when Blame does not ask for that data directly.",
      ),
      list(
        "Account and contact data: user identifier, full name, email address, initials, Account creation and update timestamps, organisation or role information you provide, and communications preferences.",
        "Authentication and security data: password hash, access-token hash and metadata, active bearer token stored on the device, token name, abilities, creation, last-use and optional expiry data, login and security events, IP address, request data, and information used to verify a rights or Account request.",
        "Subscription and transaction data: Stripe customer, checkout, subscription and price identifiers, plan and subscription status, billing period, cancellation or withdrawal declarations and status, requested and effective dates, refund status, transaction and contract evidence, invoice-related information, webhook identifiers and timestamps. Stripe, not Blame, directly collects payment-card and payment-method details through Stripe Checkout or the Stripe billing portal.",
        "Device, network, and application data: operating system, architecture, app and runtime versions, device and session identifiers, network request information, update status, download requests, user agent, referrer, timestamps, and technical capabilities used locally to adapt website or download presentation.",
        "Project and repository metadata: project name, a cryptographic fingerprint derived from normalised Git remotes or root commits, absolute local workspace and worktree paths, branch and commit identifiers, base and merge commits, preview URLs, run configurations, detected practices, and project status.",
        "Project-initialisation data: setup scripts, package and framework information, README or instruction content, configuration and sample or development environment files selected by the initialisation process, migration filenames, recent commit messages, generated Docker Compose and preview manifests, repair reasons, errors, and diagnostic results.",
        "Stories, chats, and Customer Content: titles, summaries, descriptions, comments, prompts, messages, selected file paths and line ranges, full selected code, complete file attachments, filenames, MIME types, sizes, extracted text or Markdown, images, and discarded or ownership metadata.",
        "Agent and AI activity: system and user instructions, model requests and responses, reasoning or activity summaries, source and file context, diffs, terminal commands and output, tool calls and results, container or service logs, web or MCP results, errors, final responses, provider and model identifiers, session identifiers, token usage, and estimated cost.",
        "AI connection data: provider and model selection, credential label, authentication method, custom base URL, OAuth provider account identifier and email, access and refresh credentials, API key, credential expiry, reasoning settings, and connection status.",
        "MCP and integration data: server name, enabled status, transport, executable command or credential-free URL synchronised to Blame cloud, plus local arguments, working directories, environment variables, HTTP headers, OAuth tokens, tool inputs, tool results, and connection events.",
        "Local application data: Account token and profile, up to ten recent project records, unsent prompts, selected code and complete draft attachments, model choices, theme, notification and sidebar preferences, window state, Cline session data, local runtime state, and functional interface storage.",
        "Service monitoring data: technical events, metrics and traces that Blame's cloud services record about their own operation, such as request method, route, status and duration, masked database operations, server runtime measurements, and bounded error types.",
        "Diagnostics and support data: local application, renderer, agent, setup, command, model-request, service, container, performance and error logs; crash or stack information; file paths; configuration; support messages; screenshots; attachments; and any issue or diagnostic you choose to submit.",
        "Derived data: repository fingerprints, initials, session summaries, status and usage totals, estimated cost, aggregated service-reliability statistics, and inferences needed to detect fraud, abuse, or security incidents.",
      ),
      notice("Sensitive and third-party personal data", [
        "Blame does not ask you to submit special-category data, government identifiers, health data, biometric data, precise geolocation, private communications, or other highly sensitive personal data in source code, prompts, attachments, or logs. The Services cannot reliably detect every such item. Do not provide it unless it is necessary, lawful, and appropriately protected, and do not place secrets in prompts or files sent to a third party.",
      ]),
    ],
  },
  {
    id: "sources-of-personal-data",
    title: "5. Sources of personal data",
    blocks: [
      list(
        "Directly from you when you register, subscribe, configure the Services, create content, connect a provider or integration, communicate with us, or submit a rights request.",
        "From your device, repositories, workspaces, commands, local runtime, browser or Desktop App when a feature needs that information or you direct the agent to access it.",
        "From an Account owner, employer, client, colleague, repository contributor, or other Business User that authorises your access or submits content containing your data.",
        "From Stripe concerning checkout, payment, subscription, refund, dispute, tax, and fraud status.",
        "From AI providers, gateways, MCP servers, repository hosts, package registries, update infrastructure, and other services you connect or use through Blame.",
        "From service and security operations, including logs, session activity, repository fingerprints, support investigations, and derived usage or risk signals.",
      ),
    ],
  },
  {
    id: "purposes-and-legal-bases",
    title: "6. Why we process data and our legal bases",
    blocks: [
      paragraph(
        "For people in the EEA, United Kingdom, Switzerland, and other jurisdictions that require a legal basis, we rely on the bases below. More than one basis may apply when the purposes are genuinely distinct.",
      ),
      list(
        "Provide and administer the Services: to create and authenticate your Account, synchronise selected content, run requested features, connect providers, preserve work state, supply updates, manage a Subscription, and respond to service requests. Basis: performance of our contract with you or steps requested before entering it.",
        "Process Customer Content for a Business User: to host, transmit, retrieve, organise, or delete data on that customer's documented instructions. Role and basis: Blame acts as processor where applicable; the customer determines the lawful basis.",
        "Bill and maintain transaction records: to create checkout and portal sessions, reconcile subscription status, issue or support invoices and refunds, retain contract evidence, and comply with accounting, tax, consumer, and payment obligations. Basis: contract and legal obligation.",
        "Secure and operate the Services: to authenticate requests, prevent credential misuse, fraud and abuse, troubleshoot failures, protect repositories and infrastructure, maintain availability, investigate incidents, and enforce our terms. Basis: our legitimate interests in providing a secure and reliable service, compliance with legal obligations where applicable, and contract where necessary to deliver the service.",
        "Provide support and communicate about the Services: to answer questions, investigate diagnostics you submit, deliver essential Account, security, billing, legal, and service messages, and manage complaints. Basis: contract, steps requested by you, legal obligation, and our legitimate interests in supporting users and resolving disputes.",
        "Measure and improve the product without training AI models on Customer Content: to fix defects, assess reliability, understand broad feature and runtime performance, control operational cost, and improve workflows using service monitoring data, the issues you choose to report, and feedback. Basis: our legitimate interests in operating and improving a reliable service where the processing is necessary and proportionate. We do not rely on this interest to collect Customer Content, local logs, or reusable credentials, and the Desktop App sends no usage telemetry.",
        "Comply with law and protect legal rights: to respond to valid legal process, sanctions or regulatory obligations, retain required records, establish or defend claims, and assist competent authorities. Basis: legal obligation and our legitimate interests in protecting legal rights.",
        "Send optional marketing or use content for future model training: only if such a feature is introduced and you have given the separate consent required for that specific purpose. Basis: consent. These activities are not currently performed by Blame.",
      ),
      paragraph(
        "Where we rely on legitimate interests, those interests are the security, reliability, improvement, and lawful administration of Blame and the protection of our users. We consider the nature of the data, the context, your reasonable expectations, necessity, and the impact on your rights. You may object as described in Section 20.",
      ),
      paragraph(
        "Where we rely on consent, you may withdraw it at any time through the control presented with the feature or by contacting privacy@blame.so. Withdrawal does not affect earlier lawful processing. We will not treat acceptance of the Terms or continued use after a Policy change as consent to an unrelated optional purpose.",
      ),
    ],
  },
  {
    id: "required-and-optional-data",
    title: "7. When providing data is required",
    blocks: [
      paragraph(
        "An email address, Account credentials, and the core technical records needed to authenticate and secure the Account are required to provide cloud features. Required checkout and billing information is needed to purchase a Subscription. If you do not provide those items, we cannot create the relevant Account, transaction, or paid service.",
      ),
      paragraph(
        "Repositories, prompts, attachments, provider credentials, MCP configuration, diagnostics, and optional profile fields are provided at your choice, but a feature you request may be unable to work without the data it needs. You may use a supported provider connection method or avoid a particular integration. You are not required to submit logs to receive general support, although missing diagnostics may limit our ability to reproduce a problem.",
      ),
    ],
  },
  {
    id: "desktop-and-local-storage",
    title: "8. Desktop and local-device processing",
    blocks: [
      paragraph(
        "Blame Desktop stores data in browser-like application storage, the Electron user-data directory, project and worktree directories, local runtime or virtualisation storage, and Cline data directories. This can include the bearer token and Account profile, recent absolute project paths, unsent drafts with full code and attachments, provider choices, sessions, settings, OAuth credentials, MCP secrets, logs, agent artifacts, and runtime state.",
      ),
      paragraph(
        "Some local credential and session files are protected by operating-system file permissions but are not necessarily encrypted by Blame. Anyone with access to your operating-system account or files may be able to read local data. Secure your device, use full-disk encryption, restrict access to your account, and do not share local application directories.",
      ),
      paragraph(
        "Signing out removes the active Blame cloud session from application storage but does not necessarily delete drafts, logs, repositories, worktrees, Cline sessions, provider settings, MCP configuration, or runtime data. Uninstalling the Desktop App may also leave these files behind. You are responsible for deleting local copies that you no longer need; contact support@blame.so for current operating-system-specific locations and cleanup instructions.",
      ),
    ],
  },
  {
    id: "cloud-and-repository-content",
    title: "9. Cloud processing of project and repository content",
    blocks: [
      paragraph(
        "Blame cloud services store more than Account metadata. Depending on the feature, they can store story and chat content, selected code, complete attachments, comments, project-initialisation content, absolute workspace or worktree paths, Git and preview metadata, agent activities, command or tool results, errors, final responses, summaries, sessions, model details, and usage or cost information.",
      ),
      paragraph(
        "Automatic project initialisation may inspect strategic project material, including README and instruction files, package and configuration files, sample or development environment files, migration filenames, and recent commit messages, and may send relevant material to the selected AI provider. Review those files before initialisation and remove or isolate secrets and unrelated personal data.",
      ),
      paragraph(
        "Deleting an individual story, Quick Chat, or provider credential removes the corresponding active cloud record where the feature provides that action, subject to dependent records, backups, legal holds, and third-party retention. Undoing an eligible message or comment follows the behaviour shown in the interface. Deleting cloud data does not delete copies already sent to an AI provider or MCP server, local data on your device, Git history, or data held by another user or integration.",
      ),
    ],
  },
  {
    id: "ai-providers-and-model-training",
    title: "10. AI providers, gateways, and model training",
    blocks: [
      paragraph(
        "Blame connects to the AI provider, model, OAuth service, or custom OpenAI-compatible gateway that you select. The selected service may receive prompts, source code, attachments, images, project and workspace context, diffs, tool calls, terminal and container output, logs, web or MCP results, provider and model settings, session identifiers, and other content needed to perform the task. Calls may travel directly from your device or through a gateway associated with the selected connection.",
      ),
      paragraph(
        "The provider or gateway may act as your processor, an independent controller, or another legally defined recipient depending on who contracted with it, the connection method, and its terms. Its retention, human-review, training, location, security, and opt-out practices are not set by this Policy. Review the provider's current enterprise or consumer terms and privacy controls before connecting it, especially when using a personal API account or OAuth plan.",
      ),
      notice("No Blame model training", [
        "Blame does not currently use Customer Content, source code, prompts, attachments, outputs, or logs to train or fine-tune Blame or third-party AI models for Blame's own purposes. We will not introduce such use under a general Terms or Privacy Policy acceptance. Any future training programme would apply prospectively, be described before collection, and require a separate, optional, affirmative opt-in where consent is the basis. Declining would not affect already purchased core functionality unless the optional feature itself requires participation.",
        "This commitment does not change a provider's independent practices under the agreement between you and that provider. Choose provider settings that prohibit training when your content requires that protection.",
      ]),
    ],
  },
  {
    id: "mcp-and-other-integrations",
    title: "11. MCP servers and other integrations",
    blocks: [
      paragraph(
        "An enabled MCP server or other integration can receive prompts, identifiers, source code, file content, command or tool inputs, and any context sent through its tools. It may also read from or act on external systems within the permissions you grant. A local executable can access your device with the operating-system permissions of the process that starts it.",
      ),
      paragraph(
        "Blame cloud services synchronise MCP server names, enabled status, transport, executable commands, or credential-free URLs. MCP arguments, working directories, environment variables, secret HTTP headers, and OAuth tokens are intended to remain local. They may nevertheless appear in local configuration, process state, command output, or diagnostic logs. Inspect server definitions, use least-privilege credentials, and remove a server when it is no longer trusted.",
      ),
      paragraph(
        "Third-party integrations process data under their own terms. Blame does not control their onward disclosures, retention, training, security, or response to privacy requests. Disconnecting an integration stops future use through Blame but does not automatically erase data the integration already received.",
      ),
    ],
  },
  {
    id: "payments-and-stripe",
    title: "12. Payments and Stripe",
    blocks: [
      paragraph(
        "Stripe processes checkout, payment-method, billing-portal, refund, dispute, fraud-prevention, tax, and transaction information. Blame sends Stripe your Account email, full name, and Blame user identifier and receives customer, checkout, subscription, price, status, period, cancellation, and webhook information. Blame does not store full payment-card numbers or card security codes.",
      ),
      paragraph(
        "Stripe may act as processor for some payment services and as an independent controller for regulatory, fraud, risk, network, and service-improvement purposes. Its own privacy notice and controls apply. Current information is available at https://stripe.com/privacy and https://stripe.com/legal/privacy-center.",
      ),
    ],
  },
  {
    id: "diagnostics-and-logs",
    title: "13. Diagnostics and logs",
    blocks: [
      paragraph(
        "Blame automatically creates operational logs on your device. These can include application and renderer console output, stack traces, file paths, raw command output, setup and container logs, model-request or prompt material, tool events, performance information, errors, OAuth account metadata, and information contained in your project. These local log files rotate on the device and are not automatically uploaded to Blame. Cloud activity records that form part of content you ask Blame to store remain governed by the other sections of this Policy.",
      ),
      notice("No telemetry from the Desktop App", [
        "The Desktop App and its agent processes do not send usage telemetry, metrics, traces, logs or crash reports to Blame, whether or not you are signed in.",
      ]),
      paragraph(
        "Blame's cloud services monitor their own operation. When you use them, they record technical events, metrics and traces about their requests, network calls, runtime and database operations in Blame's self-hosted observability systems in OVHcloud's Gravelines region. Database statements are masked and request fields are filtered before these signals are stored.",
      ),
      paragraph(
        "Blame processes this service monitoring data on the basis of its legitimate interests in securing, operating, diagnosing and improving a reliable service. It is not used for advertising, cross-service tracking, individual employee-performance monitoring, automated decisions producing legal or similarly significant effects, or AI-model training. You may object to legitimate-interest processing as described in Section 20.",
      ),
      notice(
        "What the Desktop App sends without you choosing the destination",
        [
          "Besides the AI providers, integrations and repositories you choose, the Desktop App contacts the systems below. The Windows installer shows this summary before installing and lets you turn off the first item; Settings > Desktop > Privacy does the same on every platform.",
        ],
        [
          "Update check: each time it starts, the Desktop App asks download.blame.so (hosted by OVHcloud) whether a newer version exists. The request carries your IP address and the app's user agent, and no Account identifier. You can turn it off and still check for updates by hand. On the beta channel, which you choose in Settings, the app reads the list of releases from GitHub (api.github.com and github.com) instead.",
          "Account services: while you are signed in, the Desktop App exchanges the data described in Sections 3 and 4 with api.blame.so. Signing out stops it.",
          "Web search: when an agent searches the web for a task, its search query is sent to api.blame.so, which forwards it through a self-hosted SearXNG instance to public search engines (Brave, Google, Bing, Qwant, DuckDuckGo and Yahoo). The engines receive the query from Blame's servers, not your IP address or Account. A query can repeat words from your prompt or code.",
          "Runtime downloads: on macOS and Windows, installing, updating or repairing Blame's runtime downloads Ubuntu images (cloud-images.ubuntu.com or download.blame.so), Docker (download.docker.com), Node.js (nodejs.org) and container images (ghcr.io). Device previews download Android tools from dl.google.com and iOS tools from github.com when you start them. These requests carry your IP address and no Account identifier.",
          "Speech-to-text: when you use the microphone button, the recording is sent to api.blame.so, which transcribes it through OpenRouter (openrouter.ai) and does not keep the audio.",
        ],
      ),
      notice("Reporting a problem on GitHub", [
        "If a runtime setup, repair or reset operation fails, the Desktop App can offer a Report on GitHub action. If the app's window stops unexpectedly or the app meets an unexpected error, it can offer the same action in a dialog you can close. The action opens a new-issue page on Blame's public GitHub repository in your browser, pre-filled with a title, the app version, operating system and architecture, and the error text shown in the app. Paths in your home folder appear as ~ and the text is limited in length. The report is designed to leave out prompts, code, environment values and tokens.",
        "The Desktop App sends nothing itself. You review and edit the issue on GitHub, and it is published only if you submit it. A submitted issue is public and is processed by GitHub under its own terms and privacy statement. The error text can still contain paths, configuration, command output, project information or other personal or confidential information: remove anything you do not want to publish before submitting. You are not required to report a problem to continue using the Services or obtain general support. Blame will not ask for a password, complete API key or reusable OAuth token in a support request.",
      ]),
    ],
  },
  {
    id: "website-cookies-and-similar-technologies",
    title: "14. Website, cookies, and similar technologies",
    blocks: [
      paragraph(
        "The Blame marketing website does not currently use advertising cookies or first-party behavioural analytics. It uses device capability information locally to recommend a compatible download and adapt rendering quality. Web and download infrastructure may process ordinary request logs such as IP address, timestamp, requested path, status, referrer, and user agent.",
      ),
      paragraph(
        "Blame Desktop uses local storage and a seven-day functional cookie to maintain authentication state, recent projects, drafts, model choices, interface preferences, notifications, theme, and sidebar state. These mechanisms are used to provide features you request and are not used for cross-site advertising. Stripe and any third-party page you open may use cookies under its own notice.",
      ),
      paragraph(
        "If we introduce a non-essential cookie, SDK, tracking pixel, device identifier, or audience-measurement tool, we will provide the required information and consent control before it is stored or accessed. A consent-exempt audience tool will be configured only within the applicable exemption and will still be described as personal-data processing where relevant.",
      ),
    ],
  },
  {
    id: "recipients-and-disclosures",
    title: "15. Who receives personal data",
    blocks: [
      paragraph(
        "We disclose personal data only as needed for the purposes described in this Policy, on your instructions, or as required by law. Recipient categories are:",
      ),
      list(
        "OVH SAS (OVHcloud), 2 rue Kellermann, 59100 Roubaix, France, provides Blame's hosting infrastructure. Blame's primary website, API, database, backup and download infrastructure, and the Customer Content stored in those systems, are hosted in OVHcloud's Gravelines region in France.",
        "OVH SAS provides Blame's domain-name, DNS, network-protection, CDN, support-mailbox, and privacy-mailbox services. These services may use distributed infrastructure under the applicable OVHcloud service terms; Blame does not represent that every DNS, CDN, email, or support operation occurs inside the Gravelines region.",
        "OVHcloud's authorised affiliates and service-specific subprocessors may remotely process hosted personal data where necessary for security, support, or maintenance under OVHcloud's Data Processing Agreement and subprocessor terms available at https://www.ovhcloud.com/fr/terms-and-conditions/contracts/.",
        "Stripe, its affiliates, banks, payment networks, and service providers for checkout, billing, fraud prevention, disputes, refunds, and compliance.",
        "The AI provider, OAuth service, model gateway, or custom endpoint that you select, together with its subprocessors under its terms.",
        "Public web search engines (Brave, Google, Bing, Qwant, DuckDuckGo and Yahoo), which receive agent search queries from Blame's servers, and OpenRouter, which transcribes speech-to-text recordings, as described in Section 13.",
        "GitHub, Canonical, Docker, the Node.js project and Google, which serve the updates, runtime components and device tools that the Desktop App downloads, as described in Section 13.",
        "MCP servers, local commands, repository hosts, package registries, APIs, browser targets, and other integrations that you enable or direct the agent to use.",
        "Professional advisers, auditors, insurers, courts, regulators, law-enforcement bodies, tax authorities, and other public authorities where access is necessary and lawful.",
        "A potential buyer, successor, financing source, or adviser in a genuine restructuring, financing, sale, merger, or transfer of all or part of the business, subject to confidentiality and applicable notice requirements.",
      ),
      paragraph(
        "We require processors selected by Blame to process personal data under written instructions, confidentiality, security, deletion or return, assistance, and subprocessor terms appropriate to their role. The Blame Data Processing Addendum is available at https://blame.so/legal/dpa and the current Subprocessor Register is available at https://blame.so/legal/subprocessors.",
      ),
      notice("No sale or targeted advertising", [
        "Blame does not sell or rent personal data, disclose it for cross-context behavioural advertising, or exchange it for advertising value. Blame does not allow third parties to track people across unrelated websites through Blame for targeted advertising. If this practice changes, we will update this Policy and implement any required opt-out before the change takes effect.",
      ]),
    ],
  },
  {
    id: "international-transfers",
    title: "16. International transfers",
    blocks: [
      paragraph(
        "Blame is established in France. Blame's primary website, API, database, backup and download infrastructure, and the Customer Content stored in those systems, are hosted by OVH SAS in OVHcloud's Gravelines region in France. Domain-name, DNS, CDN, email, security, support, and maintenance operations may use OVHcloud's distributed infrastructure, authorised affiliates, and service-specific subprocessors under the applicable OVHcloud terms.",
      ),
      paragraph(
        "OVHcloud processes hosted personal data on Blame's documented instructions under the OVHcloud Data Processing Agreement, which forms part of the OVHcloud customer contract. That agreement addresses approved subprocessors, remote processing, and the European Commission's Standard Contractual Clauses where they are required. The current OVHcloud Data Processing Agreement and subprocessor documents are available at https://www.ovhcloud.com/fr/terms-and-conditions/contracts/.",
      ),
      paragraph(
        "Stripe, your selected AI provider or gateway, an MCP server, and their subprocessors may process data outside France, the EEA, Switzerland, or the United Kingdom, including in the United States or another country whose laws differ from those where you live.",
      ),
      paragraph(
        "Where Blame makes a restricted transfer subject to the GDPR, we will use an applicable adequacy decision or execute the European Commission's Standard Contractual Clauses, assess the transfer, and apply supplementary safeguards where needed. We rely on the EU-U.S. Data Privacy Framework only for a recipient and data flow that are actually covered by the recipient's current certification. For transfers governed by United Kingdom law, we will use an applicable adequacy regulation, the UK Addendum, International Data Transfer Agreement, or another lawful mechanism.",
      ),
      paragraph(
        "Transfers initiated through a provider, gateway, or MCP server that you independently select may occur under your agreement with that recipient. Review its data locations and transfer mechanism before enabling it. You may request information about safeguards used by Blame, including a copy or summary where disclosure is permitted, by emailing privacy@blame.so.",
      ),
    ],
  },
  {
    id: "retention-and-deletion",
    title: "17. How long we keep data",
    blocks: [
      paragraph(
        "We keep personal data only for the period needed for the relevant purpose, then delete or irreversibly anonymise it unless a longer period is required or permitted by law. The following periods apply to Blame-controlled systems and do not override a third party's retention under its own terms:",
      ),
      list(
        "Account, project, story, chat, attachment, agent, preference, and provider-connection data: while the Account is active or until the relevant item is deleted. Following verified Account closure, access is disabled and deletion from active Blame cloud systems is completed within 30 days, except data retained for the reasons below. A protected receipt lets you check the recorded status after sign-out.",
        "API keys, OAuth credentials, and access tokens held by Blame: until deleted, revoked, replaced, or the Account is closed, then removed from active systems within 30 days. A token may be retained temporarily where needed to investigate misuse or an incident.",
        "Local repositories, worktrees, drafts, sessions, credentials, MCP settings, logs, runtime data, and application storage: until you delete them. Blame cannot remotely erase local copies and uninstalling may not remove them.",
        "Service monitoring events, metrics and traces held in Blame's self-hosted observability systems: up to 14 days from collection. Aggregated statistics may be retained longer only where they no longer identify or can reasonably be linked to an Account, device or person.",
        "Active service, API, authentication, download, and security logs held by Blame or its infrastructure providers: up to 12 months, unless a shorter operational setting applies or a longer period is needed for a documented security incident, legal claim, or legal obligation.",
        "Support correspondence and diagnostics you submit: up to three years after the request is closed. Material needed to establish, exercise, or defend a legal claim may be isolated and retained for the applicable limitation period.",
        "Contracts, order and acceptance evidence, invoices, payment and accounting records: ten years from the relevant transaction, delivery, or end of the contract where French accounting or electronic-contract retention law requires it.",
        "Records of consent, objections, suppression choices, and rights requests: for the duration needed to apply the choice and demonstrate compliance, generally up to five years after the request is closed or the relevant processing ends, unless a different legal limitation period applies.",
        "Backups: deleted data may remain in access-restricted rolling backups for up to 90 days after active deletion and is not restored to active use except for disaster recovery, security, or legal necessity. It is deleted or overwritten on the normal backup cycle, and restored systems must be reconciled against retained closure records before service access is reopened.",
        "Data subject to a valid legal hold, payment dispute, fraud investigation, security incident, or regulatory request: for as long as reasonably necessary for that matter, with access restricted to the purpose requiring retention.",
      ),
      paragraph(
        "When Blame acts as processor, the customer's instructions and Data Processing Addendum govern return and deletion, subject to law. Anonymous statistics that can no longer identify or reasonably be linked to a person may be kept without these personal-data retention limits.",
      ),
    ],
  },
  {
    id: "security",
    title: "18. Security",
    blocks: [
      paragraph(
        "We use technical and organisational measures designed to protect personal data in light of its nature, the risks, the state of the art, and the cost of implementation. Measures may include access controls, password and server-token hashing, transport security, restricted administrative access, dependency and update controls, logging safeguards, backup controls, and incident-response procedures.",
      ),
      paragraph(
        "No system, local device, transmission, AI provider, or integration is completely secure. You are responsible for securing your device, operating-system account, repositories, backups, connected services, and credentials; applying least privilege; reviewing agent actions; and avoiding secrets in prompts, attachments, commands, and logs. Notify security@blame.so promptly if you suspect unauthorised access or credential exposure.",
      ),
      paragraph(
        "If a personal-data breach occurs, we will document and assess it, notify the competent authority within the legally required period where the breach is likely to create a risk, and notify affected people without undue delay where a high risk requires it. We may contact you with protective steps such as revoking a token or rotating credentials.",
      ),
    ],
  },
  {
    id: "your-controls",
    title: "19. Your choices and controls",
    blocks: [
      list(
        "Edit Account details available in the Account interface or ask privacy@blame.so to correct them.",
        "Delete individual stories, Quick Chats, or connected provider credentials where the relevant interface offers deletion, and use available undo actions for eligible messages or comments.",
        "Disconnect an AI provider or MCP server, revoke credentials with the provider, and remove local credential copies that are no longer needed.",
        "Avoid attaching a file or selected code, review project-initialisation files, limit the repositories and permissions exposed to the agent, and choose a provider with suitable privacy terms.",
        "Review and delete local drafts, logs, Cline sessions, runtime data, worktrees, and application storage. Contact support@blame.so for current cleanup locations.",
        "Sign out to remove and revoke the current Blame cloud session. If another token or device may be compromised, contact security@blame.so so that additional Account access can be investigated and revoked.",
        "Use Data and account closure in Blame Desktop for a verified export or Account closure. If you cannot sign in or need a broader privacy request, email privacy@blame.so from the Account email address. Subscription cancellation does not automatically erase Account data.",
        "Withdraw an optional consent through the setting presented with the feature or by contacting privacy@blame.so.",
      ),
      paragraph(
        "Before Account closure, request an export of data you need to retain. The verified in-app procedure provides eligible Blame cloud data in structured JSON; broader legal access requests are ordinarily answered within one month after verification. Dedicated password, API-key, OAuth-token, bearer-token, and other authentication fields are excluded. Free-form projects, prompts, attachments, messages, commands, output, and configuration are exported as provided and may reproduce secrets you supplied. An export may be limited where necessary to protect other people, security, intellectual property, and legal obligations.",
      ),
    ],
  },
  {
    id: "privacy-rights",
    title: "20. Your privacy rights",
    blocks: [
      paragraph(
        "Depending on the law that applies, you may have the right to ask whether we process your personal data and to request access, a copy, correction, deletion, restriction, portability, or information about recipients. You may object to processing based on legitimate interests, object to direct marketing at any time, withdraw consent prospectively, and lodge a complaint with a supervisory authority. French law also allows you to define instructions concerning the retention, erasure, and communication of your personal data after death.",
      ),
      notice("Right to object", [
        "You have the right to object, on grounds relating to your particular situation, to processing based on our legitimate interests. We will stop that processing unless we demonstrate compelling legitimate grounds that override your interests, rights, and freedoms or the processing is needed to establish, exercise, or defend legal claims. Any objection to direct marketing is applied without requiring particular grounds.",
      ]),
      paragraph(
        "Submit a request to privacy@blame.so. Describe the right you wish to exercise and the Account or interaction concerned. You may use an authorised agent where the law permits. We may request proportionate information to verify identity, authority, and the scope of the request, but will not use verification data for an unrelated purpose.",
      ),
      paragraph(
        "We respond without undue delay and ordinarily within one month under the GDPR. We may extend by up to two additional months for a complex or numerous request after explaining the extension within the first month. Requests are normally free, but the law may permit a reasonable fee or refusal for a manifestly unfounded or excessive request. We will explain any lawful exception or inability to act and the available complaint process.",
      ),
      paragraph(
        "A request does not automatically erase local data, Git history, another user's copy, or data held by Stripe, an AI provider, MCP server, or other independent recipient. Contact those parties directly where they control the relevant data. Where Blame is only a processor, the Business User that controls the data is primarily responsible for the request.",
      ),
    ],
  },
  {
    id: "california-and-us-notices",
    title: "21. California and other U.S. privacy notices",
    blocks: [
      paragraph(
        "For California residents, the categories of personal information collected through the online Services, their sources, business purposes, and categories of recipients are described in Sections 4, 5, 6, and 15. We provide the review and correction methods in Sections 19 and 20, explain how material Policy changes are communicated in Section 25, and display the effective date above.",
      ),
      paragraph(
        "Blame does not currently respond differently to a browser's legacy Do Not Track signal because Blame does not use cross-site behavioural advertising or permit third parties to track users across unrelated services through Blame. Where a legally recognised opt-out preference signal such as Global Privacy Control applies, we will process it as required. Because no sale or sharing for targeted advertising currently occurs, such a signal does not change the present experience.",
      ),
      paragraph(
        "Where a U.S. state privacy law applies to Blame, eligible residents may request the rights provided by that law, which may include access, confirmation, correction, deletion, portability, opt-out of sale, targeted advertising or qualifying profiling, restriction of certain sensitive-data uses, non-discrimination, and an appeal. Submit a request or appeal to privacy@blame.so. We do not discriminate against a person for exercising an applicable privacy right.",
      ),
      paragraph(
        "Blame does not use sensitive personal information to infer characteristics about a person or for advertising. Account credentials, private content, and payment-related identifiers are used only to provide, secure, support, and comply with the Services as described in this Policy.",
      ),
    ],
  },
  {
    id: "children",
    title: "22. Children",
    blocks: [
      paragraph(
        "The Services are intended only for people who are at least eighteen years old and have reached the age of legal majority where they live. They are not directed to children, and a parent may not create an Account for a child to use. We do not knowingly collect personal data from a child through an authorised Account.",
      ),
      paragraph(
        "If you believe a child has provided personal data to Blame, contact privacy@blame.so. We will investigate and delete the data where required, while preserving only what lawfully must be retained to protect the child, comply with law, or document the response.",
      ),
    ],
  },
  {
    id: "automated-decision-making",
    title: "23. Automated decision-making",
    blocks: [
      paragraph(
        "Blame's coding agents generate suggestions and can perform technical actions at your direction, but Blame does not use them to make solely automated decisions about you that produce legal or similarly significant effects. Subscription status and technical access may be updated automatically from payment or security events, but you may contact support@blame.so for review of an access or billing issue.",
      ),
      paragraph(
        "Stripe or another service you select may use automated fraud, risk, or abuse systems for its own purposes. Consult that service's notice and contact it about rights relating to its decisions. You must not use Blame to make legally regulated decisions about another person without appropriate assessment, human oversight, notice, and lawful authority.",
      ),
    ],
  },
  {
    id: "communications-and-marketing",
    title: "24. Service communications and marketing",
    blocks: [
      paragraph(
        "We may send essential messages about Account verification, security, billing, subscriptions, legal changes, incidents, support, updates, or service availability. These are service communications rather than marketing, and some cannot be disabled while the relevant Account or Subscription remains active.",
      ),
      paragraph(
        "Blame does not currently operate a marketing newsletter or third-party advertising programme. If optional marketing is introduced, we will provide the required notice and consent or opt-out, identify the sender, and include an unsubscribe method. Unsubscribing from marketing will not stop essential service communications.",
      ),
    ],
  },
  {
    id: "changes-to-this-policy",
    title: "25. Changes to this Policy",
    blocks: [
      paragraph(
        "We may update this Policy to reflect changes in the Services, providers, technology, or law. The current version, effective date, and last-updated date appear at the top. Earlier versions and a summary of material changes will be available on request at privacy@blame.so.",
      ),
      paragraph(
        "We will give advance notice of a material change by email, in the Desktop App, on the website, or through another appropriate channel. Before using personal data for a materially different purpose, we will provide the information required by law and obtain a new consent where consent is required. Continued use alone is not consent to an optional new purpose.",
      ),
    ],
  },
  {
    id: "questions-and-complaints",
    title: "26. Questions and complaints",
    blocks: [
      paragraph(
        `Send privacy questions, complaints, and rights requests to privacy@blame.so or by post to Raphael Charpentier EI / MK Holding, ${publisher.address}. We will acknowledge and investigate a privacy complaint and explain the outcome and any available review route without undue delay.`,
      ),
      paragraph(
        "In France, you may lodge a complaint with the Commission nationale de l'informatique et des libertés (CNIL), 3 Place de Fontenoy, TSA 80715, 75334 Paris Cedex 07, France, at https://www.cnil.fr/en/contact-us or through its online complaint service at https://www.cnil.fr/fr/plaintes. You may instead contact the supervisory authority in the EEA or other jurisdiction where you habitually reside, work, or believe an infringement occurred.",
      ),
      paragraph(
        "At launch, Blame does not specifically target or actively offer the Services to individuals in the United Kingdom. Before beginning a targeted United Kingdom offering, we will reassess the application of United Kingdom data-protection law, update this Policy, and appoint a United Kingdom representative where required. Where United Kingdom law nevertheless gives you a complaint right, you may contact the UK Information Commissioner's Office at https://ico.org.uk/make-a-complaint/data-protection-complaints/.",
      ),
    ],
  },
] satisfies readonly LegalSection[];

const privacyApprovedForPublication = true;

export const privacyReadyForPublication = legalDocumentReadyForPublication(
  privacyApprovedForPublication,
  {
    privacyEffectiveDate,
    privacyIntroduction,
    privacySections,
    privacyVersion,
  },
);
