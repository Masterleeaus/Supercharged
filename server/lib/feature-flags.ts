// Env-gated module switches. An unset variable gives the default passed by the caller.
// Live production paths use defaultOn = true, so they behave as before when no variable is set.
// New, unfinished modules use defaultOn = false.
// Recognised values: 1/true/yes/on and 0/false/no/off (case-insensitive). Any other value keeps the default.
export function featureEnabled(
  name: string,
  defaultOn: boolean,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return defaultOn;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return defaultOn;
}
