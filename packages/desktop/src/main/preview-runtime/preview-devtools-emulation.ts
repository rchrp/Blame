// What emulate changes on the agent's page, as agent-browser settings. They
// add up: each call changes only what it names. The service keeps what they
// leave set, to put it back after a reconnection.

export type EmulationState = {
  colorScheme?: "dark" | "light";
  device?: string;
  geolocation?: { latitude: number; longitude: number };
  offline?: boolean;
  viewport?: { height: number; width: number };
};

type EmulationInput = Partial<Record<keyof EmulationState, unknown>>;

type EmulationContext = {
  cli(args: string[]): Promise<Record<string, unknown>>;
  // The page's size before emulation, for viewport: null.
  viewport: { height: number; width: number };
};

export function emulationInput(input: Record<string, unknown>) {
  const value: EmulationInput = {};
  if (input.colorScheme !== undefined)
    value.colorScheme = oneOf(
      input.colorScheme,
      ["auto", "dark", "light"],
      "auto",
    );
  if (input.viewport !== undefined) value.viewport = input.viewport;
  if (input.device !== undefined) value.device = required(input, "device");
  if (input.offline !== undefined) value.offline = input.offline === true;
  if (input.geolocation !== undefined) value.geolocation = input.geolocation;
  if (!Object.keys(value).length)
    throw new Error("emulate needs a setting to change.");
  return value;
}

// Applies the settings one by one.
export async function applyEmulation(
  value: EmulationInput,
  context: EmulationContext,
) {
  const applied: string[] = [];
  if (value.device !== undefined) {
    await context.cli(["set", "device", String(value.device)]);
    applied.push(`device ${value.device}`);
  }
  if (value.viewport !== undefined) {
    const size =
      value.viewport === null ? context.viewport : dimensions(value.viewport);
    await context.cli([
      "set",
      "viewport",
      String(size.width),
      String(size.height),
    ]);
    applied.push(`viewport ${size.width}×${size.height}`);
  }
  if (value.colorScheme !== undefined) {
    await context.cli([
      "set",
      "media",
      value.colorScheme === "auto"
        ? "no-preference"
        : String(value.colorScheme),
    ]);
    applied.push(`${value.colorScheme} color scheme`);
  }
  if (value.offline !== undefined) {
    await context.cli(["set", "offline", value.offline ? "on" : "off"]);
    applied.push(value.offline ? "offline" : "online");
  }
  if (value.geolocation !== undefined) {
    const { latitude, longitude } = coordinates(value.geolocation);
    await context.cli(["set", "geo", String(latitude), String(longitude)]);
    applied.push(`geolocation ${latitude}, ${longitude}`);
  }
  return `Emulating ${applied.join(", ")}.`;
}

// What the settings leave in place, to restore after a reconnection.
export function emulationState(
  current: EmulationState,
  value: EmulationInput,
): EmulationState {
  const next: EmulationState = { ...current };
  if (value.device !== undefined) {
    next.device = String(value.device);
    // A device sets its own size.
    delete next.viewport;
  }
  if (value.viewport !== undefined) {
    if (value.viewport === null) delete next.viewport;
    else next.viewport = dimensions(value.viewport);
  }
  if (value.colorScheme === "auto") delete next.colorScheme;
  else if (value.colorScheme === "dark" || value.colorScheme === "light")
    next.colorScheme = value.colorScheme;
  if (value.offline !== undefined) next.offline = value.offline === true;
  if (value.geolocation !== undefined)
    next.geolocation = coordinates(value.geolocation);
  return next;
}

function dimensions(value: unknown) {
  const size = value as { height?: unknown; width?: unknown } | null;
  const width = Number(size?.width);
  const height = Number(size?.height);
  if (!(width >= 200 && width <= 4_096 && height >= 200 && height <= 4_096))
    throw new Error("viewport width and height must be between 200 and 4096.");
  return { height: Math.round(height), width: Math.round(width) };
}

function coordinates(value: unknown) {
  const point = value as { latitude?: unknown; longitude?: unknown } | null;
  const latitude = Number(point?.latitude);
  const longitude = Number(point?.longitude);
  if (!(Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180))
    throw new Error("geolocation needs a latitude and a longitude.");
  return { latitude, longitude };
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
) {
  return values.includes(value as T) ? (value as T) : fallback;
}

function required(input: Record<string, unknown>, name: string) {
  const value = input[name];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required.`);
  return value;
}
