import * as React from "react"
import { KeyRoundIcon, LoaderCircleIcon } from "lucide-react"
import { AnimatePresence, motion, useAnimate } from "motion/react"
import { toast } from "sonner"

import { BlameLogoMark } from "@/components/brand/blame-logo-mark"
import { GlassPanel } from "@/components/onboarding/stage/glass-panel"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { LegalLink } from "@/components/legal/legal-link"
import { useCloudAuth } from "@/context/cloud-auth"
import { easeOutExpo, springSoft, stepVariants } from "@/lib/motion"

type AuthMode = "login" | "signup" | "forgot" | "verify" | "two-factor"
type AuthFieldProps = {
  description?: string
  id: string
  label: string
  onChange(value: string): void
  required?: boolean
  type?: React.HTMLInputTypeAttribute
  value: string
  minLength?: number
  maxLength?: number
  autoFocus?: boolean
}

// Forms deeper in the flow slide in from the right, going back slides left.
const modeDepth: Record<AuthMode, number> = {
  login: 0,
  signup: 1,
  forgot: 1,
  "two-factor": 1,
  verify: 2,
}

const ShakeContext = React.createContext<() => void>(() => undefined)

export function ConnectScreen() {
  const [mode, setModeState] = React.useState<AuthMode>("login")
  const [direction, setDirection] = React.useState(1)
  const [verificationEmail, setVerificationEmail] = React.useState("")
  const [card, animateCard] = useAnimate<HTMLDivElement>()

  function setMode(next: AuthMode) {
    setDirection(modeDepth[next] >= modeDepth[mode] ? 1 : -1)
    setModeState(next)
  }

  function showVerification(email: string) {
    setVerificationEmail(email.trim())
    setMode("verify")
  }

  const shake = React.useCallback(() => {
    if (!card.current) return
    void animateCard(
      card.current,
      { x: [0, -10, 9, -6, 4, 0] },
      { duration: 0.45, ease: "easeOut" }
    )
  }, [animateCard, card])

  return (
    <section className="relative flex min-h-full flex-col px-7 py-10">
      <div className="absolute top-7 left-7">
        <AppLogo />
      </div>
      <div className="flex flex-1 items-center justify-center">
        <ShakeContext.Provider value={shake}>
          <GlassPanel
            ref={card}
            layout
            transition={{ layout: springSoft }}
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className="w-full max-w-[22rem] overflow-hidden px-6 py-6"
          >
            <AnimatePresence mode="wait" initial={false} custom={direction}>
              <motion.div
                key={mode}
                layout="position"
                custom={direction}
                variants={stepVariants}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                {mode === "login" ? (
                  <LoginForm
                    onModeChange={setMode}
                    onVerificationRequired={showVerification}
                  />
                ) : mode === "signup" ? (
                  <SignupForm
                    onModeChange={setMode}
                    onVerificationRequired={showVerification}
                  />
                ) : mode === "forgot" ? (
                  <ForgotPasswordForm onModeChange={setMode} />
                ) : mode === "verify" ? (
                  <VerificationForm
                    email={verificationEmail}
                    onModeChange={setMode}
                  />
                ) : (
                  <EmailTwoFactorForm onModeChange={setMode} />
                )}
              </motion.div>
            </AnimatePresence>
          </GlassPanel>
        </ShakeContext.Provider>
      </div>
    </section>
  )
}

function AppLogo() {
  return (
    <div className="flex items-center gap-2.5" aria-label="Blame">
      <motion.span
        layoutId="blame-logo-mark"
        className="block size-9"
        transition={{ duration: 0.7, ease: easeOutExpo }}
      >
        <BlameLogoMark className="size-full drop-shadow-[0_6px_16px_rgba(36,64,220,0.35)]" />
      </motion.span>
      <motion.span
        layoutId="blame-logo-word"
        className="font-heading text-xl font-extrabold tracking-tight"
        transition={{ duration: 0.7, ease: easeOutExpo }}
      >
        Blame
      </motion.span>
    </div>
  )
}

function LoginForm({
  onModeChange,
  onVerificationRequired,
}: {
  onModeChange(mode: AuthMode): void
  onVerificationRequired(email: string): void
}) {
  const auth = useCloudAuth()
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const form = useAuthForm()

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={form.submit(async () => {
        const result = await auth.login({ email, password })
        if (result === "two-factor") onModeChange("two-factor")
        if (result === "email-verification") onVerificationRequired(email)
      })}
    >
      <FieldGroup className="onboarding-stagger gap-3.5">
        <FormTitle title="Welcome back" description="Sign in to pick up where your agents left off." />
        <LoginFields
          email={email}
          password={password}
          setEmail={setEmail}
          setPassword={setPassword}
        />
        <AuthErrorToast error={form.error ?? auth.error} />
        <SubmitButton loading={form.loading}>Login</SubmitButton>
        <button
          className="text-sm font-medium text-foreground/70 underline-offset-4 hover:text-foreground hover:underline"
          type="button"
          onClick={() => onModeChange("forgot")}
        >
          Forgot your password?
        </button>
        <AlternativeAuth
          loading={form.loading}
          onPasskey={() => form.run(() => auth.passkeyLogin())}
          onSocial={(provider) => form.run(() => auth.socialLogin(provider))}
        />
        <AuthLegalNotice mode="login" />
        <ModePrompt action="Sign up" onClick={() => onModeChange("signup")}>
          Don&apos;t have an account?
        </ModePrompt>
      </FieldGroup>
    </form>
  )
}

function EmailTwoFactorForm({ onModeChange }: { onModeChange(mode: AuthMode): void }) {
  const auth = useCloudAuth()
  const [code, setCode] = React.useState("")
  const [sent, setSent] = React.useState(false)
  const form = useAuthForm()
  const resend = async () => {
    await auth.resendEmailTwoFactor()
    setSent(true)
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={form.submit(() => auth.verifyEmailTwoFactor(code.trim()))}
    >
      <FieldGroup className="onboarding-stagger gap-3.5">
        <EmailTwoFactorFields code={code} sent={sent} setCode={setCode} />
        <AuthErrorToast error={form.error} />
        <SubmitButton loading={form.loading}>Verify code</SubmitButton>
        <EmailTwoFactorActions
          loading={form.loading}
          onBack={() => onModeChange("login")}
          onResend={() => form.run(resend)}
        />
      </FieldGroup>
    </form>
  )
}

function EmailTwoFactorFields({
  code,
  sent,
  setCode,
}: {
  code: string
  sent: boolean
  setCode(value: string): void
}) {
  return (
    <>
      <FormTitle
        title="Check your email"
        description="Enter the 6-digit sign-in code we sent you."
      />
      <AuthField
        autoFocus
        id="email-two-factor-code"
        label="Sign-in code"
        value={code}
        onChange={setCode}
        minLength={6}
        maxLength={6}
      />
      {sent ? <FieldDescription>A new code was sent.</FieldDescription> : null}
    </>
  )
}

function EmailTwoFactorActions({
  loading,
  onBack,
  onResend,
}: {
  loading: boolean
  onBack(): void
  onResend(): void
}) {
  return (
    <>
      <Button disabled={loading} type="button" variant="link" onClick={onResend}>
        Send a new code
      </Button>
      <ModePrompt action="Back to login" onClick={onBack}>
        Use another account?
      </ModePrompt>
    </>
  )
}

function SignupForm({
  onModeChange,
  onVerificationRequired,
}: {
  onModeChange(mode: AuthMode): void
  onVerificationRequired(email: string): void
}) {
  const auth = useCloudAuth()
  const [fullName, setFullName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [passwordConfirmation, setPasswordConfirmation] = React.useState("")
  const form = useAuthForm()

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={form.submit(async () => {
        if (password !== passwordConfirmation) throw new Error("Passwords do not match.")
        await auth.signup({
          email,
          fullName: fullName.trim() || null,
          password,
          passwordConfirmation,
        })
        onVerificationRequired(email)
      })}
    >
      <FieldGroup className="onboarding-stagger gap-3.5">
        <FormTitle title="Create your account" description="Set up Blame in a couple of minutes." />
        <SignupFields
          email={email}
          fullName={fullName}
          password={password}
          passwordConfirmation={passwordConfirmation}
          setEmail={setEmail}
          setFullName={setFullName}
          setPassword={setPassword}
          setPasswordConfirmation={setPasswordConfirmation}
        />
        <AuthErrorToast error={form.error} />
        <AuthLegalNotice mode="signup" />
        <SubmitButton loading={form.loading}>Create account</SubmitButton>
        <AlternativeAuth
          loading={form.loading}
          onPasskey={() => form.fail("Create an account first, then add a passkey securely.")}
          onSocial={(provider) => form.run(() => auth.socialLogin(provider))}
        />
        <ModePrompt action="Sign in" onClick={() => onModeChange("login")}>
          Already have an account?
        </ModePrompt>
      </FieldGroup>
    </form>
  )
}

function ForgotPasswordForm({ onModeChange }: { onModeChange(mode: AuthMode): void }) {
  const auth = useCloudAuth()
  const [email, setEmail] = React.useState("")
  const [sent, setSent] = React.useState(false)
  const form = useAuthForm()
  return (
    <form className="flex flex-col gap-6" onSubmit={form.submit(async () => {
      await auth.requestPasswordReset(email)
      setSent(true)
    })}>
      <FieldGroup className="onboarding-stagger gap-3.5">
        <FormTitle title="Reset your password" description="We’ll email a secure link if an account exists for this address." />
        {sent ? (
          <FieldDescription className="rounded-md border border-emerald-600/20 bg-emerald-500/10 p-3 text-emerald-800">
            Check your inbox. The reset link expires in 30 minutes.
          </FieldDescription>
        ) : <AuthField autoFocus id="reset-email" label="Email" type="email" value={email} onChange={setEmail} />}
        <AuthErrorToast error={form.error} />
        {!sent ? <SubmitButton loading={form.loading}>Send reset link</SubmitButton> : null}
        <ModePrompt action="Back to login" onClick={() => onModeChange("login")}>Remembered your password?</ModePrompt>
      </FieldGroup>
    </form>
  )
}

function VerificationForm({
  email,
  onModeChange,
}: {
  email: string
  onModeChange(mode: AuthMode): void
}) {
  const auth = useCloudAuth()
  const [sent, setSent] = React.useState(false)
  const form = useAuthForm()
  return (
    <form className="flex flex-col gap-6" onSubmit={form.submit(async () => {
      await auth.resendVerification(email)
      setSent(true)
    })}>
      <FieldGroup className="onboarding-stagger gap-3.5">
        <FormTitle title="Verify your email" description={`Open the verification link sent to ${email}.`} />
        {sent ? <FieldDescription>A fresh verification link was sent.</FieldDescription> : null}
        <AuthErrorToast error={form.error ?? auth.error} />
        <SubmitButton loading={form.loading}>Resend verification email</SubmitButton>
        <ModePrompt action="Back to login" onClick={() => onModeChange("login")}>Already verified?</ModePrompt>
      </FieldGroup>
    </form>
  )
}

function AuthLegalNotice({ mode }: { mode: AuthMode }) {
  return (
    <FieldDescription className="px-2 text-center text-xs leading-5 text-foreground/60">
      {mode === "signup"
        ? "By creating an account, you agree to the "
        : "Blame is provided under our "}
      <LegalLink page="terms">Terms of Service</LegalLink>
      {mode === "signup"
        ? " and acknowledge the "
        : ". Learn how we handle personal data in our "}
      <LegalLink page="privacy">Privacy Policy</LegalLink>.
    </FieldDescription>
  )
}

function LoginFields({
  email,
  password,
  setEmail,
  setPassword,
}: {
  email: string
  password: string
  setEmail(value: string): void
  setPassword(value: string): void
}) {
  return (
    <>
      <AuthField
        autoFocus
        id="login-email"
        label="Email"
        type="email"
        value={email}
        onChange={setEmail}
      />
      <AuthField
        id="login-password"
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
      />
    </>
  )
}

function SignupFields({
  email,
  fullName,
  password,
  passwordConfirmation,
  setEmail,
  setFullName,
  setPassword,
  setPasswordConfirmation,
}: {
  email: string
  fullName: string
  password: string
  passwordConfirmation: string
  setEmail(value: string): void
  setFullName(value: string): void
  setPassword(value: string): void
  setPasswordConfirmation(value: string): void
}) {
  return (
    <>
      <FullNameField value={fullName} onChange={setFullName} />
      <SignupEmailField value={email} onChange={setEmail} />
      <SignupPasswordField value={password} onChange={setPassword} />
      <PasswordConfirmationField
        value={passwordConfirmation}
        onChange={setPasswordConfirmation}
      />
    </>
  )
}

function FullNameField({
  onChange,
  value,
}: {
  onChange(value: string): void
  value: string
}) {
  return (
    <AuthField
      autoFocus
      id="signup-name"
      label="Full Name"
      value={value}
      onChange={onChange}
    />
  )
}

function SignupEmailField({
  onChange,
  value,
}: {
  onChange(value: string): void
  value: string
}) {
  return (
    <AuthField
      id="signup-email"
      label="Email"
      type="email"
      value={value}
      onChange={onChange}
    />
  )
}

function SignupPasswordField({
  onChange,
  value,
}: {
  onChange(value: string): void
  value: string
}) {
  return (
    <AuthField
      id="signup-password"
      label="Password"
      type="password"
      value={value}
      onChange={onChange}
      description="12 to 128 characters. A passphrase works best."
      minLength={12}
      maxLength={128}
    />
  )
}

function PasswordConfirmationField({
  onChange,
  value,
}: {
  onChange(value: string): void
  value: string
}) {
  return (
    <AuthField
      id="signup-password-confirmation"
      label="Confirm password"
      type="password"
      value={value}
      onChange={onChange}
    />
  )
}

function FormTitle({
  description,
  title,
}: {
  description: string
  title: string
}) {
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <h2 className="font-heading text-2xl font-bold tracking-tight">{title}</h2>
      {description ? (
        <p className="text-sm text-balance text-foreground/70">{description}</p>
      ) : null}
    </div>
  )
}

function AuthField({
  description,
  id,
  label,
  onChange,
  required = true,
  type = "text",
  value,
  minLength,
  maxLength,
  autoFocus,
}: AuthFieldProps) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        autoFocus={autoFocus}
        className="h-9 bg-background/80 transition-[box-shadow,background-color,border-color] duration-200 focus-visible:border-primary/60 focus-visible:bg-background focus-visible:ring-primary/20"
        id={id}
        minLength={minLength}
        maxLength={maxLength}
        required={required}
        type={type}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {description ? (
        <FieldDescription className="text-foreground/70">
          {description}
        </FieldDescription>
      ) : null}
    </Field>
  )
}

function AuthErrorToast({ error }: { error: string | undefined }) {
  const shake = React.useContext(ShakeContext)

  React.useEffect(() => {
    if (!error) return
    toast.error(error, { position: "bottom-right" })
    shake()
  }, [error, shake])

  return null
}

function SubmitButton({
  children,
  loading,
}: {
  children: React.ReactNode
  loading: boolean
}) {
  return (
    <Field>
      <Button
        type="submit"
        disabled={loading}
        className="relative h-9 shadow-[0_10px_24px_-10px_var(--primary)] transition-[transform,box-shadow] duration-200 hover:-translate-y-px hover:shadow-[0_14px_28px_-10px_var(--primary)] active:translate-y-0 active:scale-[0.99]"
      >
        <AnimatePresence initial={false} mode="popLayout">
          {loading ? (
            <motion.span
              key="loading"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
            >
              <LoaderCircleIcon className="animate-spin" />
            </motion.span>
          ) : null}
        </AnimatePresence>
        <motion.span layout="position">{children}</motion.span>
        <Kbd className="absolute right-2.5 bg-primary-foreground/15 text-primary-foreground/80">
          ↵
        </Kbd>
      </Button>
    </Field>
  )
}

function AlternativeAuth({ loading, onPasskey, onSocial }: {
  loading: boolean
  onPasskey(): void
  onSocial(provider: "github" | "google" | "microsoft"): void
}) {
  return (
    <>
      <AuthSeparator>Or continue with</AuthSeparator>
      <Field className="grid grid-cols-4 gap-2">
        <AltAuthButton label="Continue with GitHub" disabled={loading} onClick={() => onSocial("github")}>
          <GitHubIcon />
        </AltAuthButton>
        <AltAuthButton label="Continue with Google" disabled={loading} onClick={() => onSocial("google")}>
          <GoogleIcon />
        </AltAuthButton>
        <AltAuthButton label="Continue with Microsoft" disabled={loading} onClick={() => onSocial("microsoft")}>
          <MicrosoftIcon />
        </AltAuthButton>
        <AltAuthButton label="Sign in with a passkey" disabled={loading} onClick={onPasskey}>
          <KeyRoundIcon />
        </AltAuthButton>
      </Field>
    </>
  )
}

function AltAuthButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode
  disabled: boolean
  label: string
  onClick(): void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className="h-9 bg-background/60 transition-[transform,background-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-background hover:shadow-md"
          disabled={disabled}
          variant="outline"
          type="button"
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function AuthSeparator({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-sm text-foreground/70">
      <span className="h-px flex-1 bg-foreground/20" />
      <span className="shrink-0">{children}</span>
      <span className="h-px flex-1 bg-foreground/20" />
    </div>
  )
}

function ModePrompt({
  action,
  children,
  onClick,
}: {
  action: string
  children: React.ReactNode
  onClick(): void
}) {
  return (
    <Field>
      <FieldDescription className="px-6 text-center text-foreground/70">
        {children}{" "}
        <Button
          className="h-auto p-0"
          variant="link"
          type="button"
          onClick={onClick}
        >
          {action}
        </Button>
      </FieldDescription>
    </Field>
  )
}

function GitHubIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
      <path
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
        fill="currentColor"
      />
    </svg>
  )
}

function GoogleIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">
      <path
        d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.482h4.844a4.14 4.14 0 0 1-1.797 2.716v2.258h2.909c1.702-1.566 2.684-3.874 2.684-6.615"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.468-.806 5.956-2.18l-2.909-2.258c-.806.54-1.835.859-3.047.859-2.344 0-4.328-1.585-5.037-3.715H.956v2.332A9 9 0 0 0 9 18"
        fill="#34A853"
      />
      <path
        d="M3.963 10.706A5.4 5.4 0 0 1 3.682 9c0-.592.102-1.168.281-1.706V4.962H.956A9 9 0 0 0 0 9c0 1.45.347 2.824.956 4.038z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.579c1.321 0 2.507.454 3.44 1.346l2.582-2.582C13.463.892 11.43 0 9 0A9 9 0 0 0 .956 4.962l3.007 2.332C4.672 5.164 6.656 3.579 9 3.579"
        fill="#EA4335"
      />
    </svg>
  )
}

function MicrosoftIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21">
      <path d="M1 1h9v9H1z" fill="#F25022" />
      <path d="M11 1h9v9h-9z" fill="#7FBA00" />
      <path d="M1 11h9v9H1z" fill="#00A4EF" />
      <path d="M11 11h9v9h-9z" fill="#FFB900" />
    </svg>
  )
}

function useAuthForm() {
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string>()

  return {
    error,
    fail: setError,
    loading,
    run(handler: () => Promise<void>) {
      setError(undefined)
      setLoading(true)
      void handler()
        .catch((error) =>
          setError(error instanceof Error ? friendlyAuthError(error.message) : "Request failed")
        )
        .finally(() => setLoading(false))
    },
    submit:
      (handler: () => Promise<void>) =>
      (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        setError(undefined)
        setLoading(true)
        void handler()
          .catch((error) =>
            setError(error instanceof Error ? friendlyAuthError(error.message) : "Request failed")
          )
          .finally(() => setLoading(false))
      },
  }
}

function friendlyAuthError(message: string) {
  const normalized = message.toLowerCase()
  if (normalized.includes("email not verified")) return "Verify your email before signing in. You can request a new link below."
  if (normalized.includes("invalid email or password") || normalized.includes("invalid password")) return "The email or password is incorrect."
  if (normalized.includes("too many")) return "Too many attempts. Wait a minute, then try again."
  if (normalized.includes("account not linked")) return "This email already has an account. Sign in first, then link this provider from settings."
  return message
}
