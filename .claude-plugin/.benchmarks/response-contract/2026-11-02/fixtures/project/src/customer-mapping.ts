export interface CustomerSource {
  displayName: string;
  email: string;
  locale: string;
  interval: "monthly" | "yearly" | "trial";
  vatId?: string;
  timezone?: string;
}

export const CUSTOMER_FIELD_TARGETS = {
  displayName: "displayName",
  email: "contactEmail",
  locale: "locale",
  interval: "billingCycle",
  vatId: null,
  timezone: null,
} as const;

export function billingCycle(interval: CustomerSource["interval"]): "M" | "Y" | undefined {
  if (interval === "monthly") return "M";
  if (interval === "yearly") return "Y";
  return undefined;
}

export function buildCustomerPayload(source: CustomerSource) {
  const cycle = billingCycle(source.interval);
  return {
    displayName: source.displayName.trim(),
    contactEmail: source.email.trim().toLowerCase(),
    locale: source.locale.replaceAll("_", "-"),
    ...(cycle === undefined ? {} : { billingCycle: cycle }),
  };
}
