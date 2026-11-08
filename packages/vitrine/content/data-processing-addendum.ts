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

export const dpaEffectiveDate = "18 July 2026";
export const dpaLastUpdated = "18 July 2026";
export const dpaVersion = "1.0";

export const dpaIntroduction = [
  `This Data Processing Addendum ("DPA") forms part of the agreement governing access to the Blame Services between Raphael Charpentier EI, a French individual entrepreneur operating under the trade name MK Holding, ${publisher.address}, registered under SIREN number ${publisher.siren} (R.C.S. Lyon) ("Blame"), and the Business User identified in the applicable Account, order form, quotation, checkout record, or other agreement ("Customer").`,
  "This DPA applies only to Customer Personal Data that Blame processes as a processor on Customer's behalf. It does not govern personal data for which Blame determines its own purposes and means as controller, including Account administration, billing, service security, legal compliance, and the minimised operational telemetry described in the Privacy Policy.",
  "By accepting the Terms of Service or an order that incorporates this DPA, or by using the Services to submit Customer Personal Data for processing by Blame, Customer enters into this DPA on behalf of itself and any Customer Affiliate authorised to use the Services. A signed copy may be requested at legal@blame.so.",
] as const;

export const dpaSections = [
  {
    id: "scope-and-definitions",
    title: "1. Scope and definitions",
    blocks: [
      paragraph(
        "This DPA applies where Customer is a controller of Customer Personal Data and Blame is its processor, and where Customer is itself a processor and Blame is its subprocessor. References to a controller include a processor acting for another controller where the context requires. The processing details are stated in Schedule 1.",
      ),
      list(
        '"Applicable Data Protection Law" means a law applicable to the processing of Customer Personal Data under the agreement, including the GDPR, applicable EEA national data-protection law, the UK GDPR and Data Protection Act 2018, the Swiss Federal Act on Data Protection, and applicable United States state privacy laws.',
        '"Customer Affiliate" means an entity controlling, controlled by, or under common control with Customer that is authorised to use the Services under Customer\'s agreement.',
        '"Customer Personal Data" means personal data contained in Customer Content that Blame processes on Customer\'s documented instructions as processor. It excludes Service Data processed by Blame as controller.',
        '"Data Subject Request" means a request by a person to exercise a right under Applicable Data Protection Law in relation to Customer Personal Data.',
        '"GDPR" means Regulation (EU) 2016/679. "UK GDPR" has the meaning given in the United Kingdom Data Protection Act 2018.',
        '"Personal Data Breach" means a breach of security leading to the accidental or unlawful destruction, loss, alteration, unauthorised disclosure of, or access to Customer Personal Data transmitted, stored, or otherwise processed by Blame.',
        '"Restricted Transfer" means a transfer of Customer Personal Data that requires an adequacy decision, standard contractual clauses, addendum, or another transfer safeguard under Applicable Data Protection Law.',
        '"Services", "Business User", "Customer Content", and "Third-Party Service" have the meanings given in the Terms of Service.',
        '"Service Data" means Account, subscription, billing, security, support-administration, service-usage, and minimised operational-telemetry data for which Blame determines the purposes and means described in the Privacy Policy.',
        '"Subprocessor" means a third party engaged by Blame to process Customer Personal Data on Customer\'s behalf.',
      ),
      paragraph(
        "Terms such as personal data, processing, controller, processor, data subject, and supervisory authority have the meanings given by Applicable Data Protection Law. If a term has different meanings under applicable laws, the meaning providing the relevant person with the required protection applies to that law.",
      ),
    ],
  },
  {
    id: "relationship-to-the-agreement",
    title: "2. Relationship to the agreement",
    blocks: [
      paragraph(
        "This DPA supplements the Terms of Service and any applicable order form. If they conflict concerning the protection or processing of Customer Personal Data, this DPA prevails, followed by an individually signed order form that expressly identifies the provision it replaces, then the Terms of Service. The European Commission Standard Contractual Clauses or a mandatory transfer instrument prevail to the extent they cannot lawfully be modified.",
      ),
      paragraph(
        "This DPA does not reduce a data subject's rights or replace Customer's own legal duties. An obligation applies only to the extent required by Applicable Data Protection Law and relevant to Blame's processing under the agreement.",
      ),
    ],
  },
  {
    id: "roles-and-instructions",
    title: "3. Roles and documented instructions",
    blocks: [
      paragraph(
        "Customer determines the purposes and essential means of processing Customer Personal Data. Blame will process Customer Personal Data only on Customer's documented instructions, including to provide, secure, maintain, support, and terminate the Services; implement Customer's configuration and user actions; transmit data to a Third-Party Service selected or directed by Customer; and comply with this DPA and the agreement.",
      ),
      paragraph(
        "The agreement, this DPA, Customer's use and configuration of the Services, and written support instructions are Customer's complete documented instructions. Customer may give additional reasonable instructions that are consistent with the agreement. If an instruction requires material work or cost outside the Services, the parties will agree scope, fees, and implementation before Blame is required to perform it.",
      ),
      paragraph(
        "Blame will promptly inform Customer if, in Blame's opinion, an instruction infringes Applicable Data Protection Law. Blame may suspend the affected processing while the parties resolve the issue. Blame need not perform an instruction that is unlawful, technically impossible, or materially inconsistent with the agreement.",
      ),
      paragraph(
        "If law requires Blame to process Customer Personal Data other than on Customer's instructions, Blame will inform Customer of that legal requirement before processing unless the law prohibits notice for an important public-interest reason.",
      ),
    ],
  },
  {
    id: "customer-responsibilities",
    title: "4. Customer responsibilities",
    blocks: [
      paragraph(
        "Customer is responsible for the lawfulness, fairness, transparency, accuracy, and proportionality of Customer Personal Data and its instructions. Customer represents that it has all rights, notices, consents, lawful bases, contracts, and authorisations required for Blame to process Customer Personal Data as instructed.",
      ),
      list(
        "Customer will configure access according to least privilege, authorise only appropriate users, protect credentials and endpoints, and promptly revoke access that is no longer required.",
        "Customer will respond to Data Subject Requests and regulatory enquiries as controller, unless Applicable Data Protection Law provides otherwise.",
        "Customer will not instruct Blame to process data in violation of law, third-party rights, the Terms of Service, or documented technical restrictions.",
        "Customer will not submit special-category data, criminal-conviction data, health data, precise geolocation, government identifiers, financial-account credentials, biometric templates, or children's data unless Blame has expressly agreed in writing that the relevant Service supports that processing and the parties have documented the required safeguards.",
        "If Customer is a processor, Customer confirms that its instructions and appointment of Blame are authorised by the relevant controller and will provide that controller with information required by law.",
      ),
    ],
  },
  {
    id: "processor-obligations",
    title: "5. Blame's processor obligations",
    blocks: [
      paragraph(
        "Blame will comply with processor obligations applicable to its processing of Customer Personal Data and will provide the assistance described in this DPA, taking into account the nature of the processing and information available to Blame.",
      ),
      list(
        "Process Customer Personal Data only for the documented purposes and instructions described in this DPA.",
        "Ensure that persons authorised to process Customer Personal Data are subject to an appropriate duty of confidentiality.",
        "Implement and maintain the technical and organisational measures in Schedule 2.",
        "Engage Subprocessors only under Section 11.",
        "Assist Customer with Data Subject Requests, security, breach assessment, impact assessments, and supervisory-authority consultations as described below.",
        "Delete or return Customer Personal Data at the end of the Services in accordance with Section 14.",
        "Make information reasonably necessary to demonstrate compliance available under Section 15.",
        "Not sell Customer Personal Data, use it for targeted advertising, or use Customer Content to train or fine-tune an artificial-intelligence model for Blame or a third party.",
      ),
    ],
  },
  {
    id: "confidentiality-and-personnel",
    title: "6. Confidentiality and authorised personnel",
    blocks: [
      paragraph(
        "Blame will limit access to Customer Personal Data to persons and Subprocessors that need access to provide or secure the Services, comply with law, or perform an obligation under the agreement. Authorised persons will receive access appropriate to their responsibilities and be bound by contractual, statutory, or professional confidentiality obligations that continue after their access ends.",
      ),
      paragraph(
        "Blame is responsible for directing authorised personnel on the confidential handling of Customer Personal Data. Customer acknowledges that, while Blame operates as an individual enterprise, these duties apply to the proprietor and to any future employee or contractor given access.",
      ),
    ],
  },
  {
    id: "security",
    title: "7. Security of processing",
    blocks: [
      paragraph(
        "Blame will maintain technical and organisational measures designed to provide a level of security appropriate to the risk, taking into account the state of the art, implementation cost, nature, scope, context, and purposes of processing, and risks to individuals. Current measures are described in Schedule 2.",
      ),
      paragraph(
        "Blame may update security measures to address technical, operational, or legal developments, provided the update does not materially reduce the overall protection of Customer Personal Data during the applicable subscription. No description of a measure is a warranty that security incidents are impossible.",
      ),
      paragraph(
        "Customer is responsible for security within its control, including its devices, repositories, identity management, credentials, connected AI providers, MCP servers, integrations, user permissions, instructions, local copies, and review of agent actions and outputs.",
      ),
    ],
  },
  {
    id: "personal-data-breaches",
    title: "8. Personal Data Breaches",
    blocks: [
      paragraph(
        "Blame will notify Customer without undue delay after becoming aware of a confirmed Personal Data Breach affecting Customer Personal Data. Blame targets an initial notice within 48 hours after confirmation where feasible, but the timing and content may depend on the nature of the incident and available information. An initial notice may be supplemented in phases.",
      ),
      list(
        "The nature of the Personal Data Breach, including affected data and people where known.",
        "Known or reasonably anticipated consequences.",
        "Measures taken or proposed to contain, investigate, remediate, and mitigate the breach.",
        "A contact point for available follow-up information.",
      ),
      paragraph(
        "Blame will take reasonable steps to contain and remediate the Personal Data Breach and will provide information reasonably available to assist Customer with its notification duties. Customer is responsible for deciding whether to notify a supervisory authority, affected people, clients, or other parties, unless law assigns that duty directly to Blame.",
      ),
      paragraph(
        "A notice is not an admission of fault or liability. Unsuccessful attempts, blocked attacks, events affecting only Blame-controller data, and incidents that do not compromise Customer Personal Data are not Personal Data Breaches under this DPA, although another notification duty may apply under law or the agreement.",
      ),
    ],
  },
  {
    id: "data-subject-requests",
    title: "9. Data Subject Requests",
    blocks: [
      paragraph(
        "Taking into account the nature of the processing, Blame will provide reasonable assistance through available Service functionality and, where necessary, additional measures to help Customer respond to a Data Subject Request. Customer remains responsible for authenticating the requester, determining the response, applying legal exceptions, and communicating with the requester.",
      ),
      paragraph(
        "If Blame receives a request relating to Customer Personal Data for which Customer is responsible, Blame will not independently fulfil it unless authorised by Customer or required by law. Blame will, where reasonably identifiable and legally permitted, direct the requester to Customer or notify Customer without undue delay. Customer will not provide Blame with more requester identity information than reasonably necessary for assistance.",
      ),
    ],
  },
  {
    id: "impact-assessments-and-consultation",
    title: "10. Impact assessments and regulatory assistance",
    blocks: [
      paragraph(
        "Blame will provide information reasonably available about the Services and security measures to assist Customer with a data-protection impact assessment or prior consultation required for Customer's use of the Services. Assistance is limited to processing by Blame and does not include legal advice or assessment of Customer's business, data sources, independent providers, or instructions.",
      ),
      paragraph(
        "If a supervisory authority lawfully requests information about Blame's processing of Customer Personal Data, the parties will cooperate in good faith. Unless prohibited, each party will promptly inform the other of a material regulatory enquiry concerning the other's obligations and will not make an admission on the other's behalf.",
      ),
    ],
  },
  {
    id: "subprocessors",
    title: "11. Subprocessors",
    blocks: [
      paragraph(
        "Customer gives Blame general written authorisation to engage the Subprocessors identified in the Subprocessor Register at https://blame.so/legal/subprocessors. Blame will impose written data-protection obligations on each Subprocessor that provide protection appropriate to the processing and materially equivalent to the obligations required by Applicable Data Protection Law.",
      ),
      paragraph(
        "Blame remains responsible to Customer for a Subprocessor's performance of its data-protection obligations to the extent required by Applicable Data Protection Law. The Subprocessor Register identifies the entity, service, processing function, principal location, and applicable transfer information.",
      ),
      notice("Changes to the register", [
        "Blame will provide at least 30 days' advance notice before authorising a new material Subprocessor to process Customer Personal Data, normally by updating the register and sending notice through the Account or Customer contact email. A shorter period may apply where necessary to address an urgent security, availability, legal, or supplier event; Blame will then give notice as soon as reasonably practicable.",
        "Customer may make a reasonable written objection based on documented data-protection grounds within 15 days after notice. The parties will work in good faith to resolve it. If no reasonable alternative is available and the objection cannot be resolved, Customer may stop using and terminate the affected Service without penalty for future unused periods. This is Customer's sole remedy for a properly notified new Subprocessor, without limiting mandatory rights.",
      ]),
      paragraph(
        "An AI provider, gateway, MCP server, repository host, or other recipient that Customer independently selects, contracts with, configures, or directs Blame to contact is not a Subprocessor engaged by Blame merely because the Services transmit data to it. Customer is responsible for assessing and authorising that recipient. If Blame later selects and contracts with such a provider to process Customer Personal Data on Blame's behalf, Blame will add it to the register before the processing begins.",
      ),
    ],
  },
  {
    id: "international-transfers",
    title: "12. International transfers",
    blocks: [
      paragraph(
        "Blame's primary processing of Customer Personal Data is hosted by OVHcloud in Gravelines, France. Blame will not make a Restricted Transfer except on Customer's instructions or through a Subprocessor identified in the register, and only with a transfer mechanism and supplementary measures required by Applicable Data Protection Law.",
      ),
      paragraph(
        "For a Restricted Transfer from the EEA that is made by Blame to a recipient in a country without an applicable adequacy decision, Blame will use the relevant module of the European Commission Standard Contractual Clauses adopted by Implementing Decision (EU) 2021/914, as amended or replaced, unless another lawful mechanism applies. For a transfer governed by United Kingdom law, the applicable UK Addendum or International Data Transfer Agreement will apply. For Switzerland, references and adaptations required by the Swiss Federal Act on Data Protection apply.",
      ),
      paragraph(
        "Blame will assess transfer risks where required, implement reasonable supplementary safeguards, and make information about the applicable mechanism available to Customer, subject to confidentiality and security restrictions. Customer authorises transfers it initiates to a Third-Party Service under its own relationship with that recipient.",
      ),
    ],
  },
  {
    id: "government-requests",
    title: "13. Government and legal requests",
    blocks: [
      paragraph(
        "Blame will disclose Customer Personal Data to a public authority only where required by applicable law or binding legal process. Unless legally prohibited, Blame will notify Customer before disclosure, direct the authority to Customer where appropriate, and disclose only data reasonably required by the request.",
      ),
      paragraph(
        "Where there are reasonable grounds, Blame will review the validity and scope of a request and may challenge an unlawful or disproportionate request. Blame cannot guarantee that a court or authority will accept a challenge or permit notice.",
      ),
    ],
  },
  {
    id: "return-and-deletion",
    title: "14. Return and deletion",
    blocks: [
      paragraph(
        "During the subscription, Customer may use available export and deletion functionality. Before Account closure or termination, Customer should export Customer Personal Data it needs to retain. Upon Customer's verified instruction or termination of the affected Services, Blame will delete or irreversibly anonymise Customer Personal Data from active cloud systems within 30 days, unless Customer and Blame agree a lawful return method or retention is required by law.",
      ),
      paragraph(
        "Residual copies may remain in access-restricted rolling backups for up to 90 days after active deletion. They will not be restored to active use except for disaster recovery, security, or legal necessity, and a restored system must be reconciled against retained closure records before access is reopened. Data lawfully retained for a legal obligation or claim will be isolated, access-restricted, and processed only for that purpose.",
      ),
      paragraph(
        "Blame will delete Customer Personal Data held by a Subprocessor in accordance with its contract and normal deletion cycle. Deletion by Blame does not delete local copies controlled by Customer or data previously transmitted on Customer's instructions to an independently selected Third-Party Service.",
      ),
    ],
  },
  {
    id: "compliance-information-and-audits",
    title: "15. Compliance information and audits",
    blocks: [
      paragraph(
        "Blame will make information reasonably necessary to demonstrate compliance with this DPA available to Customer. The parties will use a proportionate sequence: current contractual and security documentation, written questions, a remote review, and only if those are insufficient, a more detailed audit.",
      ),
      paragraph(
        "Customer may request one audit in any 12-month period, and an additional audit after a confirmed Personal Data Breach or where a supervisory authority requires it. Audits must be limited to systems and records relevant to Customer Personal Data, occur during normal business hours on reasonable advance notice, avoid disruption and exposure of other customers' data, and be performed by Customer or an independent auditor that is not a competitor and is bound by confidentiality.",
      ),
      paragraph(
        "Customer bears its audit costs and Blame may charge reasonable costs for exceptional assistance outside standard documentation, unless the audit identifies a material breach by Blame. Blame need not disclose another customer's information, security-testing details that would create a material risk, privileged material, trade secrets unrelated to the audit, or information prohibited from disclosure by law or contract. Blame will instead provide a reasonable alternative where possible.",
      ),
    ],
  },
  {
    id: "service-data",
    title: "16. Service Data processed by Blame as controller",
    blocks: [
      paragraph(
        "Blame acts as controller, not processor for Customer, when it determines the purposes and essential means of processing Account contacts, authentication and security records, subscription and billing records, legal-compliance records, support administration, and minimised operational telemetry used to secure, operate, diagnose, and improve the Services. The Privacy Policy at https://blame.so/privacy governs that processing.",
      ),
      paragraph(
        "Blame will not use the controller designation to repurpose Customer Content for advertising, individual employee-performance monitoring, sale, or AI-model training. If data is used both to perform Customer's instruction and for a separate Blame purpose, the parties' respective roles are determined for each processing operation under Applicable Data Protection Law rather than by the label applied in this DPA.",
      ),
    ],
  },
  {
    id: "united-states-privacy-terms",
    title: "17. United States state privacy terms",
    blocks: [
      paragraph(
        "Where an applicable United States state privacy law treats Blame as a processor, service provider, or contractor for Customer Personal Data, Blame will process that data only for the limited and specified business purposes in this DPA and the agreement, and Customer discloses it to Blame only for those purposes.",
      ),
      list(
        "Blame will not sell or share Customer Personal Data for cross-context behavioural advertising or process it for targeted advertising.",
        "Blame will not retain, use, or disclose Customer Personal Data outside the direct business relationship with Customer or for a commercial purpose other than the purposes specified in the agreement, except as permitted by applicable law.",
        "Blame will not combine Customer Personal Data with personal data received from another person or collected from Blame's own interaction with an individual, except where applicable law permits that combination for the specified business purpose.",
        "Blame will provide the same level of privacy protection required of Customer for the delegated processing, notify Customer if it determines it can no longer meet an applicable obligation, and allow Customer to take reasonable and appropriate steps to stop and remediate unauthorised use.",
        "Customer may monitor compliance through the information and audit rights in Section 15 and may give a legally required request concerning Customer Personal Data.",
      ),
    ],
  },
  {
    id: "term-liability-and-law",
    title: "18. Term, liability, and governing law",
    blocks: [
      paragraph(
        "This DPA starts when Customer accepts it or Blame first processes Customer Personal Data as processor, whichever occurs first, and continues until Blame and its Subprocessors have deleted or returned Customer Personal Data as required. Provisions that must survive to protect data or demonstrate compliance continue for as long as necessary.",
      ),
      paragraph(
        "The exclusions and limitations of liability in the agreement apply to this DPA to the maximum extent permitted by law, and liability arising under this DPA is aggregated with liability under the agreement. Nothing limits liability or data-subject rights where limitation is prohibited by Applicable Data Protection Law or an applicable transfer instrument.",
      ),
      paragraph(
        "The governing-law and jurisdiction provisions of the agreement apply to this DPA. A mandatory transfer instrument may specify a different governing law or forum for claims under that instrument, and mandatory rights of data subjects and supervisory authorities are unaffected.",
      ),
    ],
  },
  {
    id: "notices-and-signature",
    title: "19. Notices and signature copies",
    blocks: [
      paragraph(
        "Data-protection notices under this DPA must be sent to legal@blame.so, with a copy to privacy@blame.so. Blame may send notices to the Account owner, privacy contact, or legal contact provided by Customer. Operational support messages alone do not amend this DPA.",
      ),
      paragraph(
        "Electronic acceptance has the same effect as a signature to the extent permitted by law. Customer may request a countersigned copy, identify relevant Customer Affiliates, or provide a dedicated privacy notice address by contacting legal@blame.so. The person making the request must have authority to bind Customer.",
      ),
    ],
  },
  {
    id: "schedule-processing-details",
    title: "Schedule 1 — Details of processing",
    blocks: [
      notice("Subject matter and purpose", [
        "Provision of the Blame SaaS cloud services and Desktop App functionality requested and configured by Customer, including hosting, synchronisation, retrieval, organisation, transmission, agent orchestration, provider and integration connectivity, support, export, and deletion of Customer Content.",
      ]),
      list(
        "Duration: for the term of the Services and the deletion periods in Section 14, unless law requires longer restricted retention.",
        "Nature of processing: collection, receipt, hosting, storage, organisation, structuring, retrieval, consultation, display, transmission, making available to Customer-directed recipients, modification at Customer's request, support access, restriction, export, deletion, and backup rotation.",
        "Frequency: continuous or intermittent according to Customer's use, configuration, instructions, and support requests.",
        "Data subjects: Customer's authorised users, employees, contractors, candidates, clients, suppliers, repository contributors, end users, correspondents, and other people whose personal data Customer includes in repositories, prompts, files, messages, outputs, or related Customer Content.",
        "Personal-data types: identity and contact details; professional and employment data; repository and project metadata; source code and document content; correspondence, prompts, messages and attachments; user-generated content; technical and device data; identifiers; activity records; and any other personal data Customer lawfully submits within the documented scope of the Services.",
        "Special data: not intended or authorised unless Blame expressly agrees in writing to the specific processing and required safeguards.",
        "Customer instructions: the agreement, this DPA, Customer's configuration and use of the Services, user actions within available functionality, and additional lawful written instructions accepted by Blame.",
      ),
    ],
  },
  {
    id: "schedule-security-measures",
    title: "Schedule 2 — Technical and organisational measures",
    blocks: [
      notice("Governance and access", [
        "Access to production systems and Customer Personal Data is restricted to authorised persons and service accounts with a business need. Administrative and application access is separated where practicable, credentials are managed as secrets, and access is removed when no longer required. Authorised persons are bound by confidentiality duties.",
      ]),
      list(
        "Identity and authentication: unique Account identities, password hashing, expiring or revocable access tokens, verification for sensitive export and closure operations, and protected closure-receipt credentials.",
        "Authorisation and isolation: authenticated API access, record-level ownership checks, logical separation between Accounts and projects, least-privilege infrastructure access, and restricted production administration.",
        "Encryption and secrets: TLS for public network transmission; application-level encryption for designated provider and OAuth credentials; hashing for passwords, server tokens, and verification material; encrypted database backup files; and exclusion of reusable secrets from ordinary telemetry fields.",
        "Infrastructure: production hosting in OVHcloud's Gravelines region, network controls, restricted administrative endpoints, container isolation, hardened service configuration, and physical and environmental controls supplied by OVHcloud.",
        "Secure development: version control, peer or automated review where appropriate, dependency and build controls, automated tests, environment separation, migration controls, and remediation of identified vulnerabilities according to risk.",
        "Logging and monitoring: access-restricted service and security records, minimised OpenTelemetry events, metrics and traces, telemetry allowlists and redaction, bounded error categories, operational alerting, and retention controls appropriate to each record type.",
        "Data minimisation: product controls that limit selected repository context; exclusion of prompts, source code, raw commands and output, tool arguments and results, paths, reusable credentials, and free-form errors from automatic operational telemetry; and separate user action before a detailed runtime diagnostic is submitted.",
        "Resilience and recovery: encrypted rolling backups, documented restoration procedures, active deletion and retry jobs, a durable Account-closure ledger designed to prevent restoration of closed Accounts, and reconciliation before restored service access is reopened.",
        "Deletion: verified Account closure, disabling of access, active-cloud deletion within 30 days, backup rotation within 90 days, credential revocation or deletion, and retention restrictions for legal holds and compliance records.",
        "Incident management: procedures to identify, contain, investigate, document, remediate, and notify relevant Personal Data Breaches, with preservation of evidence and post-incident corrective action where appropriate.",
        "Subprocessor management: role assessment, written data-protection terms, security and location review proportionate to risk, change notice, and maintenance of the public Subprocessor Register.",
      ),
    ],
  },
  {
    id: "schedule-subprocessors",
    title: "Schedule 3 — Authorised Subprocessors",
    blocks: [
      paragraph(
        "The current list of authorised Subprocessors, processing functions, locations, and transfer information is maintained at https://blame.so/legal/subprocessors and is incorporated into this DPA. Customer authorises the entries published there on the effective date of this DPA and later entries introduced under Section 11.",
      ),
    ],
  },
] satisfies readonly LegalSection[];

const dpaApprovedForPublication = true;

export const dpaReadyForPublication = legalDocumentReadyForPublication(
  dpaApprovedForPublication,
  {
    dpaEffectiveDate,
    dpaIntroduction,
    dpaSections,
    dpaVersion,
  },
);
