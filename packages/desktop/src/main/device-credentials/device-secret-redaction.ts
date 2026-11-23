// The secrets of the credentials kept on this computer, as the main process
// has seen them, so that no log line carries one. Values shorter than a real
// key are not worth masking: they would blank unrelated text.

const secrets = new Set<string>();
const minimumLength = 8;

export function rememberDeviceSecret(value: unknown) {
  if (typeof value === "string" && value.length >= minimumLength)
    secrets.add(value);
}

export function deviceSecrets() {
  return [...secrets];
}
