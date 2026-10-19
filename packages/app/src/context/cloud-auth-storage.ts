import type { CloudSession, CloudUser } from "./cloud-auth"

const storageKey = "blame.app.cloud-session.v1"

export function readCloudSession(
  storage: Pick<Storage, "getItem"> = localStorage
) {
  try {
    return cloudSession(JSON.parse(storage.getItem(storageKey) ?? ""))
  } catch {
    return undefined
  }
}

export function writeCloudSession(
  session: CloudSession,
  storage: Pick<Storage, "setItem"> = localStorage
) {
  storage.setItem(storageKey, JSON.stringify(session))
}

export function removeCloudSession(
  storage: Pick<Storage, "removeItem"> = localStorage
) {
  storage.removeItem(storageKey)
}

export function cloudSession(value: unknown): CloudSession | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.token !== "string") return undefined
  const user = cloudUser(value.user)
  if (!user) return undefined
  return { token: value.token, user }
}

function cloudUser(value: unknown): CloudUser | undefined {
  if (!isRecord(value)) return undefined
  const id = stringIdentifier(value.id)
  if (!id) return undefined
  if (typeof value.email !== "string") return undefined
  if (typeof value.initials !== "string") return undefined

  return {
    id,
    email: value.email,
    initials: value.initials,
    fullName: nullableString(value.fullName),
    ...(typeof value.image === "string" && value.image
      ? { image: value.image }
      : {}),
    createdAt: optionalString(value.createdAt),
    updatedAt: optionalString(value.updatedAt),
  }
}

function stringIdentifier(value: unknown) {
  if (typeof value === "string" && value.length > 0) return value
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value)
  }
  return undefined
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}
