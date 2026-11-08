"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Download, ShieldCheck } from "lucide-react";

import { LanguageSelector } from "@/components/language-selector";
import { SiteHeader } from "@/components/site-header";
import { publisher } from "@/lib/publisher";

type ActionStep = "form" | "review" | "complete";
export type WithdrawalLanguage = "en" | "fr";

type FormFields = {
  subscriberName: string;
  accountEmail: string;
  password: string;
  contractReference: string;
  acknowledgementEmail: string;
  actionDate: string;
};

type ContractReceipt = {
  format: string;
  action: "withdrawal";
  reference: string;
  submittedAt: string;
  effectiveAt: string | null;
  subscriberName: string;
  acknowledgementEmail: string;
  contractReference: string;
  status: string;
  contractDate?: string;
  refund?: {
    id: string;
    amount: number;
    currency: string;
    status: string;
  } | null;
  effects: string[];
};

type ContractActionResult =
  | { receipt: ContractReceipt; error: null }
  | { receipt: null; error: string };

const emptyFields: FormFields = {
  subscriberName: "",
  accountEmail: "",
  password: "",
  contractReference: "",
  acknowledgementEmail: "",
  actionDate: "",
};

const withdrawalCopies = {
  en: {
    htmlLanguage: "en",
    locale: "en-GB",
    title: "Withdraw from contract here",
    eyebrow: "Online withdrawal",
    description:
      "Exercise your right to withdraw from an eligible Blame contract within the statutory fourteen-day period.",
    dateLabel: "Contract date",
    dateHelp:
      "The Stripe subscription start date is used to verify the statutory period.",
    reviewTitle: "Review your withdrawal",
    confirmation: "Confirm withdrawal",
    continueLabel: "Review and continue",
    deliveryNotice:
      "After confirmation, a timestamped receipt in a durable text format will be provided immediately and downloaded to your device.",
    reviewIntroduction:
      "Check the information before submitting your declaration. You can go back to make changes.",
    editLabel: "Edit",
    processingLabel: "Processing…",
    referenceFallback: "Identified through the verified account",
    durableMedium: "Immediate download of a timestamped receipt",
    completeTitle: "Withdrawal recorded",
    completeDescription:
      "Your receipt has been generated and downloaded. Keep it with your contract documents.",
    downloadLabel: "Download the receipt again",
    pendingLabel: "To be confirmed",
    assistanceBefore: "For technical assistance, write to",
    assistanceAfter:
      "Account closure and data deletion remain available separately from",
    accountClosureLabel: "Data & account closure",
    errorFallback:
      "The request could not be processed. Try again or contact billing@blame.so.",
    fields: {
      subscriber: "Full name or company name",
      account: "Blame account email address",
      password: "Current password",
      passwordHelp:
        "It is used only to verify your identity and is never included in the receipt.",
      reference: "Contract or subscription reference (optional)",
      referenceHelp:
        "For example, a Stripe reference beginning with sub_ or cus_, if shown on your documents.",
      acknowledgement: "Email address to include in the receipt",
    },
    rows: {
      subscriber: "Subscriber",
      account: "Account",
      reference: "Reference",
      acknowledgement: "Receipt",
      contractDate: "Contract date",
      durableMedium: "Durable medium",
      receivedAt: "Received at",
      effectiveAt: "Effective at",
      contract: "Contract",
      status: "Status",
    },
  },
  fr: {
    htmlLanguage: "fr",
    locale: "fr-FR",
    title: "Renoncer au contrat ici",
    eyebrow: "Rétractation en ligne",
    description:
      "Exercez votre droit de rétractation pour un contrat Blame éligible pendant le délai légal de quatorze jours.",
    dateLabel: "Date de conclusion du contrat",
    dateHelp:
      "La date Stripe du début de l'abonnement est utilisée pour vérifier le délai légal.",
    reviewTitle: "Récapitulatif de votre rétractation",
    confirmation: "Confirmer la rétractation",
    continueLabel: "Vérifier et continuer",
    deliveryNotice:
      "Après confirmation, un accusé horodaté conservable au format texte sera immédiatement remis et téléchargé sur votre appareil.",
    reviewIntroduction:
      "Vérifiez les informations avant d'envoyer votre déclaration. Vous pouvez revenir en arrière pour les modifier.",
    editLabel: "Modifier",
    processingLabel: "Traitement en cours…",
    referenceFallback: "Identifiée par le compte vérifié",
    durableMedium: "Téléchargement immédiat d'un justificatif horodaté",
    completeTitle: "Rétractation enregistrée",
    completeDescription:
      "Votre accusé a été généré et téléchargé. Conservez-le avec vos documents contractuels.",
    downloadLabel: "Télécharger à nouveau l'accusé",
    pendingLabel: "À confirmer",
    assistanceBefore: "En cas de difficulté technique, écrivez à",
    assistanceAfter:
      "La fermeture du compte et la suppression des données restent accessibles séparément depuis",
    accountClosureLabel: "Données et fermeture du compte",
    errorFallback:
      "La demande n'a pas pu être traitée. Réessayez ou contactez billing@blame.so.",
    fields: {
      subscriber: "Nom et prénom ou raison sociale",
      account: "Adresse e-mail du compte Blame",
      password: "Mot de passe actuel",
      passwordHelp:
        "Il sert uniquement à vérifier votre identité et n'est jamais inscrit dans le justificatif.",
      reference: "Référence du contrat ou de l'abonnement (facultatif)",
      referenceHelp:
        "Par exemple une référence Stripe commençant par sub_ ou cus_, si elle figure sur vos documents.",
      acknowledgement: "E-mail à faire figurer sur l'accusé",
    },
    rows: {
      subscriber: "Titulaire",
      account: "Compte",
      reference: "Référence",
      acknowledgement: "Accusé",
      contractDate: "Date du contrat",
      durableMedium: "Support durable",
      receivedAt: "Reçue le",
      effectiveAt: "Prise d'effet",
      contract: "Contrat",
      status: "Statut",
    },
  },
} as const;

type WithdrawalCopy = (typeof withdrawalCopies)[WithdrawalLanguage];

export function ConsumerContractActionPage({
  language = "en",
}: {
  language?: WithdrawalLanguage;
}) {
  const copy = withdrawalCopies[language];
  const state = useContractActionState(copy);
  return <ContractActionLayout copy={copy} state={state} />;
}

function useContractActionState(copy: WithdrawalCopy) {
  const [fields, setFields] = useState<FormFields>(emptyFields);
  const [step, setStep] = useState<ActionStep>("form");
  const [receipt, setReceipt] = useState<ContractReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function confirmAction() {
    setError(null);
    setIsSubmitting(true);
    const result = await resolveContractAction(fields, copy);
    setIsSubmitting(false);
    if (result.receipt === null) {
      setError(result.error);
      return;
    }
    setReceipt(result.receipt);
    setStep("complete");
    downloadReceipt(result.receipt, copy);
  }

  return {
    confirmAction,
    error,
    fields,
    isSubmitting,
    receipt,
    setFields,
    setStep,
    step,
  };
}

function ContractActionLayout({
  copy,
  state,
}: {
  copy: WithdrawalCopy;
  state: ReturnType<typeof useContractActionState>;
}) {
  return (
    <main
      lang={copy.htmlLanguage}
      className="min-h-screen overflow-x-clip bg-[#050712] text-white"
    >
      <SiteHeader />
      <section className="relative isolate px-5 pb-24 pt-32 sm:px-8 lg:px-10">
        <PageGlow />
        <div className="mx-auto w-full max-w-3xl">
          <ActionHeader copy={copy} />
          <div className="mt-10 rounded-[2rem] border border-white/12 bg-white/[0.045] p-6 shadow-[0_32px_120px_rgba(0,0,0,0.32)] backdrop-blur-2xl sm:p-9">
            <ContractActionCard copy={copy} state={state} />
          </div>
          <Assistance copy={copy} />
        </div>
      </section>
    </main>
  );
}

function ContractActionCard({
  copy,
  state,
}: {
  copy: WithdrawalCopy;
  state: ReturnType<typeof useContractActionState>;
}) {
  if (state.step === "form") {
    return <FormActionCard copy={copy} state={state} />;
  }
  if (state.step === "review") {
    return <ReviewActionCard copy={copy} state={state} />;
  }
  return state.receipt ? (
    <ActionComplete copy={copy} receipt={state.receipt} />
  ) : null;
}

type ActionCardProps = {
  copy: WithdrawalCopy;
  state: ReturnType<typeof useContractActionState>;
};

function FormActionCard({ copy, state }: ActionCardProps) {
  return (
    <ActionForm
      copy={copy}
      fields={state.fields}
      onChange={state.setFields}
      onReview={() => state.setStep("review")}
    />
  );
}

function ReviewActionCard({ copy, state }: ActionCardProps) {
  return (
    <ActionReview
      copy={copy}
      error={state.error}
      fields={state.fields}
      isSubmitting={state.isSubmitting}
      onBack={() => state.setStep("form")}
      onConfirm={state.confirmAction}
    />
  );
}

function PageGlow() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_5%,rgba(179,172,243,0.16),transparent_35%),linear-gradient(180deg,#070a17_0%,#050712_85%)]" />
  );
}

function ActionHeader({ copy }: { copy: WithdrawalCopy }) {
  return (
    <header>
      <p className="inline-flex rounded-full border border-[#b3acf3]/30 bg-[#b3acf3]/10 px-3.5 py-1 text-sm text-[#dedaff]">
        {copy.eyebrow}
      </p>
      <h1 className="mt-4 text-balance text-[clamp(3rem,8vw,5.8rem)] font-semibold leading-[0.92] tracking-[-0.065em]">
        {copy.title}
      </h1>
      <p className="mt-7 max-w-2xl text-base leading-8 text-white/66 sm:text-lg">
        {copy.description}
      </p>
      <LanguageSelector
        englishHref="/withdraw"
        frenchHref="/fr/retractation"
        language={copy.htmlLanguage}
      />
    </header>
  );
}

type ActionFormProps = {
  copy: WithdrawalCopy;
  fields: FormFields;
  onChange: (fields: FormFields) => void;
  onReview: () => void;
};

function ActionForm({ copy, fields, onChange, onReview }: ActionFormProps) {
  function update(name: keyof FormFields, value: string) {
    onChange({ ...fields, [name]: value });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onReview();
      }}
      className="space-y-6"
    >
      <IdentityFields copy={copy} fields={fields} update={update} />
      <DateField copy={copy} fields={fields} update={update} />
      <DeliveryNotice copy={copy} />
      <button className={primaryButtonClassName} type="submit">
        {copy.continueLabel}
      </button>
    </form>
  );
}

function IdentityFields({
  copy,
  fields,
  update,
}: {
  copy: WithdrawalCopy;
  fields: FormFields;
  update: (name: keyof FormFields, value: string) => void;
}) {
  return (
    <>
      {identityFieldDefinitions(copy).map((definition) => (
        <TextField
          key={definition.name}
          {...definition}
          value={fields[definition.name]}
          onChange={update}
        />
      ))}
    </>
  );
}

function DateField({
  copy,
  fields,
  update,
}: {
  copy: WithdrawalCopy;
  fields: FormFields;
  update: (name: keyof FormFields, value: string) => void;
}) {
  return (
    <TextField
      label={copy.dateLabel}
      name="actionDate"
      type="date"
      value={fields.actionDate}
      onChange={update}
      help={copy.dateHelp}
    />
  );
}

type TextFieldProps = {
  label: string;
  name: keyof FormFields;
  value: string;
  onChange: (name: keyof FormFields, value: string) => void;
  type?: string;
  autoComplete?: string;
  help?: string;
};

function identityFieldDefinitions(
  copy: WithdrawalCopy,
): readonly Omit<TextFieldProps, "value" | "onChange">[] {
  const fields = copy.fields;
  return [
    fieldDefinition(fields.subscriber, "subscriberName", "text", "name"),
    fieldDefinition(fields.account, "accountEmail", "email", "username"),
    fieldDefinition(
      fields.password,
      "password",
      "password",
      "current-password",
      fields.passwordHelp,
    ),
    fieldDefinition(
      fields.reference,
      "contractReference",
      "text",
      undefined,
      fields.referenceHelp,
    ),
    fieldDefinition(
      fields.acknowledgement,
      "acknowledgementEmail",
      "email",
      "email",
    ),
  ];
}

function fieldDefinition(
  label: string,
  name: keyof FormFields,
  type: string,
  autoComplete?: string,
  help?: string,
) {
  return { autoComplete, help, label, name, type };
}

function TextField(props: TextFieldProps) {
  return (
    <label className="block">
      <span className="text-sm font-semibold text-white/82">{props.label}</span>
      <input
        required={props.name !== "contractReference"}
        name={props.name}
        type={props.type ?? "text"}
        value={props.value}
        autoComplete={props.autoComplete}
        onChange={(event) => props.onChange(props.name, event.target.value)}
        className="mt-2.5 h-12 w-full rounded-xl border border-white/12 bg-[#080b17] px-4 text-base text-white outline-none transition placeholder:text-white/24 focus:border-[#b3acf3]/55 focus:ring-2 focus:ring-[#b3acf3]/15"
      />
      {props.help ? (
        <span className="mt-2 block text-xs leading-5 text-white/42">
          {props.help}
        </span>
      ) : null}
    </label>
  );
}

function DeliveryNotice({ copy }: { copy: WithdrawalCopy }) {
  return (
    <aside className="flex gap-3 rounded-2xl border border-[#b3acf3]/20 bg-[#b3acf3]/[0.07] p-4 text-sm leading-6 text-white/64">
      <ShieldCheck className="mt-0.5 size-5 shrink-0 text-[#dedaff]" />
      <p>{copy.deliveryNotice}</p>
    </aside>
  );
}

type ActionReviewProps = {
  copy: WithdrawalCopy;
  error: string | null;
  fields: FormFields;
  isSubmitting: boolean;
  onBack: () => void;
  onConfirm: () => void;
};

function ActionReview(props: ActionReviewProps) {
  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-[-0.035em]">
        {props.copy.reviewTitle}
      </h2>
      <p className="mt-3 text-sm leading-7 text-white/54">
        {props.copy.reviewIntroduction}
      </p>
      <ReviewDetails copy={props.copy} fields={props.fields} />
      {props.error ? <ErrorNotice message={props.error} /> : null}
      <ReviewActions {...props} />
    </div>
  );
}

function ReviewActions(props: ActionReviewProps) {
  return (
    <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row">
      <button
        className={secondaryButtonClassName}
        type="button"
        onClick={props.onBack}
      >
        <ArrowLeft className="size-4" /> {props.copy.editLabel}
      </button>
      <button
        className={primaryButtonClassName}
        type="button"
        disabled={props.isSubmitting}
        onClick={props.onConfirm}
      >
        {props.isSubmitting
          ? props.copy.processingLabel
          : props.copy.confirmation}
      </button>
    </div>
  );
}

function ReviewDetails({
  copy,
  fields,
}: {
  copy: WithdrawalCopy;
  fields: FormFields;
}) {
  const rows = [
    [copy.rows.subscriber, fields.subscriberName],
    [copy.rows.account, fields.accountEmail],
    [copy.rows.reference, fields.contractReference || copy.referenceFallback],
    [copy.rows.acknowledgement, fields.acknowledgementEmail],
    [copy.rows.contractDate, fields.actionDate],
    [copy.rows.durableMedium, copy.durableMedium],
  ];
  return (
    <dl className="mt-7 divide-y divide-white/8 overflow-hidden rounded-2xl border border-white/10">
      {rows.map(([label, value]) => (
        <ReviewRow key={label} label={label} value={value} />
      ))}
    </dl>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 px-4 py-4 sm:grid-cols-[11rem_1fr] sm:px-5">
      <dt className="text-sm text-white/42">{label}</dt>
      <dd className="break-words text-sm font-medium text-white/78">{value}</dd>
    </div>
  );
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="mt-6 rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-100"
    >
      {message}
    </p>
  );
}

function ActionComplete({
  copy,
  receipt,
}: {
  copy: WithdrawalCopy;
  receipt: ContractReceipt;
}) {
  return (
    <div>
      <CheckCircle2 className="size-11 text-emerald-300" />
      <h2 className="mt-5 text-3xl font-semibold tracking-[-0.045em]">
        {copy.completeTitle}
      </h2>
      <p className="mt-4 text-base leading-7 text-white/62">
        {copy.completeDescription}
      </p>
      <ReceiptDetails copy={copy} receipt={receipt} />
      <button
        type="button"
        onClick={() => downloadReceipt(receipt, copy)}
        className={`${primaryButtonClassName} mt-7`}
      >
        <Download className="size-4" /> {copy.downloadLabel}
      </button>
    </div>
  );
}

function ReceiptDetails({
  copy,
  receipt,
}: {
  copy: WithdrawalCopy;
  receipt: ContractReceipt;
}) {
  return (
    <dl className="mt-7 divide-y divide-white/8 overflow-hidden rounded-2xl border border-white/10">
      {receiptRows(copy, receipt).map(([label, value]) => (
        <div
          key={label}
          className="grid gap-1 px-4 py-4 sm:grid-cols-[9rem_1fr] sm:px-5"
        >
          <dt className="text-sm text-white/42">{label}</dt>
          <dd className="break-all text-sm font-medium text-white/78">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function receiptRows(copy: WithdrawalCopy, receipt: ContractReceipt) {
  const effectiveAt = receipt.effectiveAt
    ? formatDateTime(receipt.effectiveAt, copy.locale)
    : copy.pendingLabel;
  return [
    [copy.rows.reference, receipt.reference],
    [copy.rows.receivedAt, formatDateTime(receipt.submittedAt, copy.locale)],
    [copy.rows.effectiveAt, effectiveAt],
    [copy.rows.contract, receipt.contractReference],
    [copy.rows.status, receipt.status],
  ];
}

function Assistance({ copy }: { copy: WithdrawalCopy }) {
  return (
    <p className="mt-8 text-sm leading-7 text-white/44">
      {copy.assistanceBefore}{" "}
      <a
        className="text-[#dedaff] underline underline-offset-4"
        href="mailto:billing@blame.so"
      >
        billing@blame.so
      </a>
      . {copy.assistanceAfter}{" "}
      <Link
        className="text-[#dedaff] underline underline-offset-4"
        href="/account/privacy"
      >
        {copy.accountClosureLabel}
      </Link>
      .
    </p>
  );
}

async function submitContractAction(fields: FormFields) {
  const response = await fetch(`${apiBaseUrl()}/consumer-contract/withdrawal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody(fields)),
  });
  const body = (await response.json()) as
    | ContractReceipt
    | { message?: string };
  if (!response.ok)
    throw new Error("message" in body ? body.message : undefined);
  return body as ContractReceipt;
}

async function resolveContractAction(
  fields: FormFields,
  copy: WithdrawalCopy,
): Promise<ContractActionResult> {
  try {
    return {
      receipt: await submitContractAction(fields),
      error: null,
    };
  } catch (error) {
    return { receipt: null, error: readSubmissionError(error, copy) };
  }
}

function requestBody(fields: FormFields) {
  return {
    subscriberName: fields.subscriberName,
    accountEmail: fields.accountEmail,
    password: fields.password,
    contractReference: fields.contractReference || undefined,
    acknowledgementEmail: fields.acknowledgementEmail,
    deliveryMethod: "download",
    contractDate: fields.actionDate,
    confirmation: "confirmer-la-retractation",
  };
}

function apiBaseUrl() {
  return (
    process.env.NEXT_PUBLIC_BLAME_API_URL ?? "https://api.blame.so/api/v1"
  ).replace(/\/$/, "");
}

function downloadReceipt(receipt: ContractReceipt, copy: WithdrawalCopy) {
  const blob = new Blob([receiptText(receipt, copy.htmlLanguage)], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `blame-${receipt.action}-${receipt.reference}.txt`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function receiptText(receipt: ContractReceipt, language: WithdrawalLanguage) {
  if (language === "fr") return frenchReceiptText(receipt);
  return englishReceiptText(receipt);
}

function englishReceiptText(receipt: ContractReceipt) {
  const refund = refundText(receipt, "No separate Stripe refund recorded");
  return [
    "BLAME — DURABLE-MEDIUM RECEIPT",
    `Action: ${receipt.action}`,
    `Reference: ${receipt.reference}`,
    "Declaration: withdrawal from the contract",
    `Subscriber: ${receipt.subscriberName}`,
    `Receipt email: ${receipt.acknowledgementEmail}`,
    `Contract reference: ${receipt.contractReference}`,
    `Submitted at: ${receipt.submittedAt}`,
    `Effective at: ${receipt.effectiveAt ?? "to be confirmed"}`,
    `Status: ${receipt.status}`,
    `Refund: ${refund}`,
    `Effects: ${receipt.effects.join("; ")}`,
    `Issuer: Raphael Charpentier EI — MK Holding, ${publisher.address}`,
    "Contact: billing@blame.so",
  ].join("\n");
}

function frenchReceiptText(receipt: ContractReceipt) {
  const refund = refundText(
    receipt,
    "Aucun remboursement Stripe distinct enregistré",
  );
  return [
    "BLAME — ACCUSÉ SUR SUPPORT DURABLE",
    `Action : ${receipt.action}`,
    `Référence : ${receipt.reference}`,
    "Contenu de la déclaration : rétractation du contrat",
    `Titulaire : ${receipt.subscriberName}`,
    `E-mail d'accusé : ${receipt.acknowledgementEmail}`,
    `Référence du contrat : ${receipt.contractReference}`,
    `Date et heure d'envoi : ${receipt.submittedAt}`,
    `Date d'effet : ${receipt.effectiveAt ?? "à confirmer"}`,
    `Statut : ${receipt.status}`,
    `Remboursement : ${refund}`,
    `Effets : ${receipt.effects.join("; ")}`,
    `Émetteur : Raphael Charpentier EI — MK Holding, ${publisher.address}`,
    "Contact : billing@blame.so",
  ].join("\n");
}

function refundText(receipt: ContractReceipt, emptyLabel: string) {
  const refund = receipt.refund
    ? `${receipt.refund.amount / 100} ${receipt.refund.currency.toUpperCase()} (${receipt.refund.status})`
    : emptyLabel;
  return refund;
}

function readSubmissionError(error: unknown, copy?: WithdrawalCopy) {
  if (error instanceof Error && error.message) return error.message;
  return copy?.errorFallback ?? withdrawalCopies.en.errorFallback;
}

function formatDateTime(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "long",
    timeZone: "Europe/Paris",
  }).format(new Date(value));
}

const primaryButtonClassName =
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-white px-6 text-sm font-semibold text-[#080b17] transition hover:bg-[#dedaff] disabled:cursor-wait disabled:opacity-60";
const secondaryButtonClassName =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-white/14 bg-white/[0.05] px-6 text-sm font-semibold text-white transition hover:bg-white/[0.1]";
