// The name a new provider connection starts with, so nobody has to invent
// one before pasting a key: the provider's name and the first number its
// connections do not use yet ("OpenAI 1", then "OpenAI 2"). It stays
// editable.
export function defaultConnectionLabel(
  providerName: string,
  existingLabels: Iterable<string>
) {
  const taken = new Set(
    [...existingLabels].map((label) => label.trim().toLowerCase())
  )
  for (let number = 1; ; number++) {
    const label = `${providerName} ${number}`
    if (!taken.has(label.toLowerCase())) return label
  }
}
