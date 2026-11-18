/** Choices for leads and activities (shared by the browser and the server). */
export const LEAD_CATEGORIES = [
  { value: "health_food", label: "Health food" },
  { value: "pharmacy", label: "Pharmacy" },
  { value: "grocery", label: "Grocery" },
  { value: "gift", label: "Gift shop" },
  { value: "boutique", label: "Boutique" },
  { value: "gym_wellness", label: "Gym or wellness" },
  { value: "other", label: "Other" },
] as const;
export const ACTIVITY_TYPES = [
  { value: "visit", label: "Visit" },
  { value: "call", label: "Call" },
  { value: "email", label: "Email" },
  { value: "samples", label: "Samples" },
  { value: "other", label: "Other" },
] as const;
export const OUTCOMES = [
  { value: "no_decision_maker", label: "Visited, no decision maker" },
  { value: "spoke_with_buyer", label: "Spoke with buyer" },
  { value: "samples_left", label: "Samples left" },
  { value: "interested", label: "Interested, will follow up" },
  { value: "placing_order", label: "Placing an order" },
  { value: "not_interested", label: "Not interested" },
  { value: "other", label: "Other" },
] as const;
export const DEFAULT_FOLLOW_UP_DAYS = 7;
