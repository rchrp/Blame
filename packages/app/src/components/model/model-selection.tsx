import * as React from "react"
import {
  type CloudAiModelPreference,
  type SaveAiPreferencesInput,
  useCloudAuth,
} from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import type {
  BlameModel as Model,
  BlameProvider as Provider,
  ModelRecommendation,
  ProviderCredentialSummary,
  ProviderListResponse,
  ReasoningSelection,
} from "@blame/agent-runtime"

const storageKey = "blame.app.drawer-model-selection.v1"

const globalModelSelectionKey = "__global__"

const recentLimit = 5

export const defaultVariant = "default"

export const defaultCredentialLabel = "default"

export const openAICompatibleProviderID = "openai-compatible"

export const allProvidersValue = "all"

const modelStateListeners = new Set<() => void>()

export const popularProviders = [
  "openai-codex",
  "openai",
  "openai-native",
  "anthropic",
  "google",
  "github-copilot",
  "openrouter",
  "vercel",
]

export type ModelKey = {
  providerID: string
  modelID: string
  credentialLabel?: string
}

export type SelectableModel = Omit<Model, "providerID"> & {
  provider: Provider
  credentialLabel?: string
  credentialDisplayName?: string
  latest: boolean
}

export type ModelGroup = {
  provider: Provider
  models: SelectableModel[]
  rank: number
}

type ModelSelectionState = {
  recent: ModelKey[]
  hidden: ModelKey[]
  accounts: Record<string, string>
}

export type RecommendedSelectableModel = ModelRecommendation & {
  model: SelectableModel
}

export type ModelSelection = ReturnType<typeof useModelSelection>

export type ModelPreferenceRole = "alternative" | "agent"

// Keeps the choice somewhere other than the saved preference (one story's
// next turn, for example). Without a choice yet, the saved one shows.
export type ModelSelectionScope = {
  preference?: CloudAiModelPreference | null
  onChange(preference: CloudAiModelPreference): void
}

type ModelSelectionOptions = {
  role?: ModelPreferenceRole
  scope?: ModelSelectionScope
}

export function useModelSelection(options: ModelSelectionOptions = {}) {
  const providerState = useProviderState()
  const role = options.role ?? "agent"
  const [state, setState] = React.useState(() =>
    readModelState(providerState.directory)
  )
  const [optimisticPreference, setOptimisticPreference] =
    React.useState<CloudAiModelPreference>()
  const preferenceSaveQueue = React.useRef<Promise<void>>(Promise.resolve())

  React.useEffect(() => {
    const refreshState = () => setState(readModelState(providerState.directory))
    const handleStorageChange = (event: StorageEvent) => {
      if (event.storageArea === localStorage && event.key === storageKey) {
        refreshState()
      }
    }

    refreshState()
    modelStateListeners.add(refreshState)
    window.addEventListener("storage", handleStorageChange)

    return () => {
      modelStateListeners.delete(refreshState)
      window.removeEventListener("storage", handleStorageChange)
    }
  }, [providerState.directory])

  const scope = options.scope
  const persistedPreference =
    scope?.preference ?? modelPreference(providerState.aiPreferences, role)
  const preference = scope
    ? persistedPreference
    : (optimisticPreference ?? persistedPreference)
  const savePreference = (nextPreference: CloudAiModelPreference) => {
    if (scope) {
      scope.onChange(nextPreference)
      return Promise.resolve()
    }
    setOptimisticPreference(nextPreference)
    const request = preferenceSaveQueue.current.then(() =>
      saveRolePreference(providerState, role, nextPreference)
    )
    preferenceSaveQueue.current = request.catch(() => undefined)
    return request.finally(() => {
      setOptimisticPreference((current) =>
        sameModelPreference(current, nextPreference) ? undefined : current
      )
    })
  }
  const accountLabels = React.useMemo(
    () => selectedAccountLabels(state, preference),
    [preference, state]
  )
  const models = React.useMemo(
    () => getModels(providerState.providers, accountLabels),
    [providerState.providers, accountLabels]
  )
  const visibleModels = React.useMemo(
    () => models.filter((model) => modelVisible(state, model)),
    [models, state]
  )
  const currentModel =
    (scope
      ? modelForPreference(visibleModels, preference)?.model
      : findModel(visibleModels, preferenceModelKey(preference))) ??
    getDefaultModel(visibleModels, providerState.providers)
  const currentVariant = getCurrentVariant(
    currentModel,
    preference?.reasoningEffort
  )

  return {
    agent: providerState.agent,
    aiPreferences: providerState.aiPreferences,
    apiConnection: providerState.apiConnection,
    loading: providerState.loading,
    allProviderGroups: groupModels(models),
    allProviders: providerState.providers?.all ?? [],
    connectedProviders: connectedProviders(providerState.providers),
    credentials: providerState.providers?.credentials ?? [],
    connectedProviderIDs: getConnectedProviderIDs(providerState.providers),
    currentModel,
    currentVariant,
    directory: providerState.directory,
    emptyMessage: getEmptyMessage(providerState),
    providerGroups: groupModels(visibleModels),
    models: visibleModels,
    recommendations: providerState.providers?.recommendations,
    refreshProviders: providerState.refresh,
    serverReady: providerState.serverReady,
    variantOptions: getVariantOptions(currentModel),
    role,
    saveAiPreferences: providerState.saveAiPreferences,
    setModel: (model: SelectableModel) => {
      setModelState(providerState.directory, setState, {
        ...state,
        accounts: model.credentialLabel
          ? { ...state.accounts, [model.provider.id]: model.credentialLabel }
          : state.accounts,
        recent: pushRecent(state.recent, model),
        hidden: state.hidden.filter(
          (item) => !sameCatalogModelKey(item, modelKey(model))
        ),
      })
      return savePreference(
        modelPreferenceInput(model, preference?.reasoningEffort)
      )
    },
    accountsForProvider: (providerID: string) =>
      providerAccounts(providerState.providers, providerID),
    selectedAccountLabel: (providerID: string) =>
      selectedAccountLabel(providerState.providers, accountLabels, providerID),
    setAccount: async (providerID: string, label: string) => {
      const nextAccounts = { ...accountLabels, [providerID]: label }
      const nextModels = getModels(providerState.providers, nextAccounts)
      const target = accountTargetModel(nextModels, currentModel, providerID)
      setModelState(providerState.directory, setState, {
        ...state,
        accounts: nextAccounts,
      })
      if (target) {
        await savePreference(
          modelPreferenceInput(target, preference?.reasoningEffort)
        )
      }
    },
    recommendedModels: (providerID: string) =>
      recommendedModels(providerState.providers, visibleModels, providerID),
    modelVisible: (model: SelectableModel) => modelVisible(state, model),
    providerVisible: (providerID: string) =>
      models
        .filter((model) => model.provider.id === providerID)
        .every((model) => modelVisible(state, model)),
    setModelVisible: (model: SelectableModel, visible: boolean) =>
      setModelState(providerState.directory, setState, {
        ...state,
        hidden: setHiddenModel(state.hidden, model, visible),
      }),
    setProviderVisible: (providerID: string, visible: boolean) =>
      setModelState(providerState.directory, setState, {
        ...state,
        hidden: setHiddenProvider(state.hidden, models, providerID, visible),
      }),
    setVariant: (variant: string | undefined) =>
      savePreference({
        providerId: currentModel?.provider.id ?? "",
        modelId: currentModel?.id ?? "",
        credentialLabel: currentModel?.credentialLabel ?? null,
        reasoningEffort: reasoningEffortValue(variant),
      }),
  }
}

const ModelProviderContext = React.createContext<
  ReturnType<typeof useLocalProviderState> | undefined
>(undefined)

export function ModelProviderScope({
  children,
}: {
  children: React.ReactNode
}) {
  const state = useLocalProviderState()
  return (
    <ModelProviderContext.Provider value={state}>
      {children}
    </ModelProviderContext.Provider>
  )
}

function useProviderState() {
  const shared = React.useContext(ModelProviderContext)
  const local = useLocalProviderState(!shared)
  return shared ?? local
}

function useLocalProviderState(enabled = true) {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const directory = globalModelSelectionKey
  const [providers, setProviders] = React.useState<ProviderListResponse>()
  const [loading, setLoading] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const agent = platform.agent

  const refresh = React.useCallback(() => {
    if (!agent || auth.status !== "authenticated") {
      setProviders(undefined)
      return Promise.resolve()
    }

    setLoading(true)
    setFailed(false)
    return agent.providers
      .list(auth.apiConnection)
      .then((response) => {
        setProviders(normalizeProviderList(response))
      })
      .catch((error) => {
        console.error("[renderer] providers:list failed", error)
        setFailed(true)
      })
      .finally(() => {
        setLoading(false)
      })
  }, [agent, auth.apiConnection, auth.status])

  React.useEffect(() => {
    if (!enabled) return
    const timeout = window.setTimeout(() => {
      void refresh().then(() => undefined)
    })
    return () => window.clearTimeout(timeout)
  }, [enabled, refresh])

  return {
    apiConnection: auth.apiConnection,
    directory,
    failed,
    loading,
    providers,
    refresh,
    aiPreferences:
      auth.status === "authenticated" ? auth.aiPreferences : undefined,
    saveAiPreferences:
      auth.status === "authenticated" ? auth.saveAiPreferences : undefined,
    agent,
    serverReady: !!agent,
  }
}

function normalizeProviderList(input: ProviderListResponse | undefined) {
  if (!input) return undefined
  return {
    ...input,
    all: input.all.map((provider) => ({
      ...provider,
      models: Object.fromEntries(
        Object.entries(provider.models).filter(
          ([, model]) => model.status !== "deprecated"
        )
      ),
    })),
  }
}

function modelPreference(
  preferences:
    | {
        alternativeModel: CloudAiModelPreference
        agentModel: CloudAiModelPreference
      }
    | null
    | undefined,
  role: ModelPreferenceRole
) {
  if (!preferences) return undefined
  return role === "alternative"
    ? preferences.alternativeModel
    : preferences.agentModel
}

function preferenceModelKey(
  preference: CloudAiModelPreference | undefined
): ModelKey | undefined {
  if (!preference) return undefined
  return {
    providerID: preference.providerId,
    modelID: preference.modelId,
    credentialLabel: preference.credentialLabel ?? undefined,
  }
}

function modelPreferenceInput(
  model: SelectableModel,
  reasoningEffort: string | null | undefined
): CloudAiModelPreference {
  return {
    providerId: model.provider.id,
    modelId: model.id,
    credentialLabel: model.credentialLabel ?? null,
    reasoningEffort: supportedReasoningEffort(model, reasoningEffort),
  }
}

function sameModelPreference(
  left: CloudAiModelPreference | undefined,
  right: CloudAiModelPreference
) {
  return (
    left?.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.credentialLabel === right.credentialLabel &&
    left.reasoningEffort === right.reasoningEffort
  )
}

function supportedReasoningEffort(
  model: SelectableModel,
  value: string | null | undefined
) {
  const effort = reasoningEffortValue(value)
  return effort && model.variants?.[effort] ? effort : null
}

function reasoningEffortValue(value: string | null | undefined) {
  return value && isReasoningEffort(value) ? value : null
}

async function saveRolePreference(
  providerState: {
    aiPreferences?: SaveAiPreferencesInput | null
    saveAiPreferences?: (input: SaveAiPreferencesInput) => Promise<void>
  },
  role: ModelPreferenceRole,
  preference: CloudAiModelPreference
) {
  if (!providerState.saveAiPreferences || !preference.providerId) return
  const current = providerState.aiPreferences
  if (!current) return
  await providerState.saveAiPreferences({
    alternativeModel:
      role === "alternative" ? preference : current.alternativeModel,
    agentModel: role === "agent" ? preference : current.agentModel,
  })
}

function getModels(
  providers: ProviderListResponse | undefined,
  accountLabels: Record<string, string>
) {
  const connected = getConnectedProviderIDs(providers)
  return (
    providers?.all
      .filter((provider) => connected.has(provider.id))
      .flatMap((provider) =>
        getProviderModels(
          provider,
          providers.credentials,
          accountLabels[provider.id]
        ).map((model) => selectableModel(provider, model))
      ) ?? []
  )
}

function getProviderModels(
  provider: Provider,
  credentials: ProviderCredentialSummary[],
  accountLabel: string | undefined
) {
  const credential = selectedProviderCredential(
    credentials,
    provider.id,
    accountLabel
  )
  if (provider.id === openAICompatibleProviderID && credential) {
    return openAICompatibleModels(provider, credential)
  }
  return Object.values(provider.models).map((model) =>
    credential ? credentialModel(model, credential) : model
  )
}

function selectedProviderCredential(
  credentials: ProviderCredentialSummary[],
  providerID: string,
  accountLabel: string | undefined
) {
  const accounts = credentials.filter(
    (credential) => credential.providerId === providerID
  )
  return (
    accounts.find((credential) => credential.label === accountLabel) ??
    accounts[0]
  )
}

function selectableModel(
  provider: Provider,
  model: Model & {
    credentialLabel?: string
    credentialDisplayName?: string
  }
) {
  return {
    ...model,
    name: model.name.replace("(latest)", "").trim(),
    provider,
    latest: model.name.includes("(latest)"),
  }
}

function credentialModel(model: Model, credential: ProviderCredentialSummary) {
  return {
    ...model,
    credentialLabel: credential.label,
    credentialDisplayName: credentialLabel(credential),
  }
}

function openAICompatibleModels(
  provider: Provider,
  credential: ProviderCredentialSummary
) {
  const fallback = provider.models.custom ?? Object.values(provider.models)[0]
  const modelIds = credential.modelIds?.length
    ? credential.modelIds
    : [
        credential.label === defaultCredentialLabel
          ? "custom"
          : credential.label,
      ]
  return modelIds.map((modelId) => ({
    ...fallback,
    id: modelId,
    name: modelId,
    credentialLabel: credential.label,
    credentialDisplayName: credentialLabel(credential),
  }))
}

export function credentialLabel(credential: ProviderCredentialSummary) {
  if (credential.label !== defaultCredentialLabel) return credential.label
  return credential.accountId ?? defaultCredentialLabel
}

function selectedAccountLabels(
  state: ModelSelectionState,
  preference: CloudAiModelPreference | undefined
) {
  const labels = { ...state.accounts }
  if (preference?.credentialLabel) {
    labels[preference.providerId] ??= preference.credentialLabel
  }
  return labels
}

function selectedAccountLabel(
  providers: ProviderListResponse | undefined,
  accountLabels: Record<string, string>,
  providerID: string
) {
  const accounts = providerAccounts(providers, providerID)
  return (
    accounts.find((account) => account.label === accountLabels[providerID])
      ?.label ??
    accounts[0]?.label ??
    defaultCredentialLabel
  )
}

function providerAccounts(
  providers: ProviderListResponse | undefined,
  providerID: string
) {
  return (providers?.credentials ?? []).filter(
    (credential) => credential.providerId === providerID
  )
}

function accountTargetModel(
  models: SelectableModel[],
  currentModel: SelectableModel | undefined,
  providerID: string
) {
  const providerModels = models.filter(
    (model) => model.provider.id === providerID
  )
  return (
    providerModels.find((model) => model.id === currentModel?.id) ??
    providerModels[0]
  )
}

function getConnectedProviderIDs(providers: ProviderListResponse | undefined) {
  const connected = new Set(providers?.connected ?? [])
  for (const credential of providers?.credentials ?? []) {
    connected.add(credential.providerId)
  }
  return connected
}

function connectedProviders(providers: ProviderListResponse | undefined) {
  const connected = getConnectedProviderIDs(providers)
  return (providers?.all ?? []).filter((provider) => connected.has(provider.id))
}

function recommendedModels(
  providers: ProviderListResponse | undefined,
  models: SelectableModel[],
  providerID: string
) {
  const recommendations =
    providerID === allProvidersValue
      ? providers?.recommendations.all
      : providers?.recommendations.byProvider[providerID]
  return (recommendations ?? [])
    .map((recommendation) => ({
      ...recommendation,
      model: models.find(
        (model) =>
          model.provider.id === recommendation.providerId &&
          model.id === recommendation.modelId
      ),
    }))
    .filter(
      (
        recommendation
      ): recommendation is ModelRecommendation & { model: SelectableModel } =>
        recommendation.model !== undefined
    )
}

function groupModels(models: SelectableModel[]) {
  return Array.from(groupModelsByProvider(models).entries())
    .map(([providerID, items]) => getProviderGroup(providerID, items))
    .sort(
      (a, b) =>
        a.rank - b.rank || a.provider.name.localeCompare(b.provider.name)
    )
}

function modelVisible(state: ModelSelectionState, model: SelectableModel) {
  return !state.hidden.some((item) =>
    sameCatalogModelKey(item, modelKey(model))
  )
}

function setHiddenModel(
  hidden: ModelKey[],
  model: SelectableModel,
  visible: boolean
) {
  if (!visible) {
    return [...hidden, modelKey(model)].filter(uniqueCatalogModelKey)
  }
  return hidden.filter((item) => !sameCatalogModelKey(item, modelKey(model)))
}

function setHiddenProvider(
  hidden: ModelKey[],
  models: SelectableModel[],
  providerID: string,
  visible: boolean
) {
  if (visible) return hidden.filter((item) => item.providerID !== providerID)
  return [
    ...hidden,
    ...models.filter((model) => model.provider.id === providerID).map(modelKey),
  ].filter(uniqueCatalogModelKey)
}

function uniqueCatalogModelKey(
  value: ModelKey,
  index: number,
  list: ModelKey[]
) {
  return list.findIndex((item) => sameCatalogModelKey(item, value)) === index
}

function groupModelsByProvider(models: SelectableModel[]) {
  return models.reduce((groups, model) => {
    groups.set(model.provider.id, [
      ...(groups.get(model.provider.id) ?? []),
      model,
    ])
    return groups
  }, new Map<string, SelectableModel[]>())
}

function getProviderGroup(providerID: string, items: SelectableModel[]) {
  return {
    provider: items[0].provider,
    models: [...items].sort((a, b) => a.name.localeCompare(b.name)),
    rank: getProviderRank(providerID),
  }
}

function getDefaultModel(
  models: SelectableModel[],
  providers: ProviderListResponse | undefined
) {
  if (!providers) return models[0]

  const configured = providers.connected
    .map((providerID) => getDefaultModelKey(providers, providerID))
    .map((key) => findModel(models, key))
    .find(Boolean)

  return configured ?? models[0]
}

function getDefaultModelKey(
  providers: ProviderListResponse,
  providerID: string
) {
  return {
    providerID,
    modelID: providers.default[providerID],
  }
}

function getCurrentVariant(
  model: SelectableModel | undefined,
  variant: string | null | undefined
) {
  if (!variant) return undefined
  if (!isReasoningEffort(variant)) return undefined
  if (!model?.variants || !(variant in model.variants)) return undefined
  return variant
}

function getVariantOptions(model: SelectableModel | undefined) {
  return [defaultVariant, ...Object.keys(model?.variants ?? {})]
}

export function getVariantLabel(variant: string) {
  if (variant === defaultVariant) return "Default"
  if (variant === "xhigh") return "X High"
  return variant.charAt(0).toUpperCase() + variant.slice(1)
}

function isReasoningEffort(value: string): value is ReasoningSelection {
  return (
    value === "none" ||
    value === "enabled" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  )
}

function getEmptyMessage(input: {
  directory: string | undefined
  failed: boolean
  loading: boolean
  serverReady: boolean
}) {
  if (!input.serverReady) return "Sidecar unavailable"
  if (input.loading) return "Loading models"
  if (input.failed) return "Unable to load models"
  return "No models found"
}

// The offered model and reasoning a choice points to. A choice saved without
// its account (from an earlier run) matches the model on any account.
export function modelForPreference(
  models: SelectableModel[],
  preference: CloudAiModelPreference | null | undefined
) {
  if (!preference) return undefined
  const model =
    findModel(models, preferenceModelKey(preference)) ??
    models.find((item) =>
      sameCatalogModelKey(modelKey(item), {
        providerID: preference.providerId,
        modelID: preference.modelId,
      })
    )
  if (!model) return undefined
  return { model, variant: getCurrentVariant(model, preference.reasoningEffort) }
}

function findModel(models: SelectableModel[], key: ModelKey | undefined) {
  return models.find((model) => key && sameModelKey(modelKey(model), key))
}

export function isModelSelected(
  current: SelectableModel | undefined,
  model: SelectableModel
) {
  return Boolean(current && sameModelKey(modelKey(current), modelKey(model)))
}

function pushRecent(recent: ModelKey[], model: SelectableModel) {
  const key = modelKey(model)
  return [key, ...recent.filter((item) => !sameModelKey(item, key))].slice(
    0,
    recentLimit
  )
}

function modelKey(model: SelectableModel): ModelKey {
  return {
    providerID: model.provider.id,
    modelID: model.id,
    credentialLabel: model.credentialLabel,
  }
}

function sameModelKey(left: ModelKey, right: ModelKey) {
  return (
    left.providerID === right.providerID &&
    left.modelID === right.modelID &&
    (left.credentialLabel ?? defaultCredentialLabel) ===
      (right.credentialLabel ?? defaultCredentialLabel)
  )
}

function sameCatalogModelKey(left: ModelKey, right: ModelKey) {
  return left.providerID === right.providerID && left.modelID === right.modelID
}

function readModelState(directory: string | undefined): ModelSelectionState {
  if (!directory) return { recent: [], hidden: [], accounts: {} }

  const parsed = readStoredStates()
  return isModelState(parsed[directory])
    ? {
        ...parsed[directory],
        hidden: parsed[directory].hidden ?? [],
        accounts: parsed[directory].accounts ?? {},
      }
    : { recent: [], hidden: [], accounts: {} }
}

function writeState(directory: string | undefined, state: ModelSelectionState) {
  if (!directory) return

  const parsed = readStoredStates()
  localStorage.setItem(
    storageKey,
    JSON.stringify({ ...parsed, [directory]: state })
  )
}

function setModelState(
  directory: string | undefined,
  setState: (state: ModelSelectionState) => void,
  state: ModelSelectionState
) {
  writeState(directory, state)
  setState(readModelState(directory))
  notifyModelStateListeners()
}

function notifyModelStateListeners() {
  for (const listener of modelStateListeners) listener()
}

function readStoredStates(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "{}")
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function isModelState(value: unknown): value is ModelSelectionState {
  if (!value || typeof value !== "object") return false
  if (!("recent" in value) || !Array.isArray(value.recent)) return false
  if ("hidden" in value && !Array.isArray(value.hidden)) return false
  if (
    "accounts" in value &&
    (!value.accounts ||
      typeof value.accounts !== "object" ||
      !Object.values(value.accounts).every((item) => typeof item === "string"))
  )
    return false
  const state = value as {
    recent: unknown[]
    hidden?: unknown[]
    accounts?: Record<string, string>
  }
  return (
    state.recent.every(isModelKey) && (state.hidden ?? []).every(isModelKey)
  )
}

function isModelKey(value: unknown): value is ModelKey {
  if (!value || typeof value !== "object") return false
  if (!("providerID" in value) || typeof value.providerID !== "string")
    return false
  if (!("modelID" in value) || typeof value.modelID !== "string") return false
  return (
    !("credentialLabel" in value) ||
    value.credentialLabel === undefined ||
    typeof value.credentialLabel === "string"
  )
}

function getProviderRank(providerID: string) {
  const index = popularProviders.indexOf(providerID)
  return index === -1 ? popularProviders.length : index
}
