const perms = {
  calibration: {
    read: { user: ["==", ["$user.id"]] },
    write: { user: ["==", ["$user.id"]] },
  },
  microgreens: {
    read: { user: ["==", ["$user.id"]] },
    write: { user: ["==", ["$user.id"]] },
  },
  yield_entries: {
    read: { user: ["==", ["$user.id"]] },
    write: { user: ["==", ["$user.id"]] },
  },
  inventory_items: {
    read: { user: ["==", ["$user.id"]] },
    write: { user: ["==", ["$user.id"]] },
  },
  inventory_adjustments: {
    read: { user: ["==", ["$user.id"]] },
    write: { user: ["==", ["$user.id"]] },
  },
  products: {
    read: { user: ["==", ["$user.id"]] },
    write: { user: ["==", ["$user.id"]] },
  },
  bom_lines: {
    read: { user: ["==", ["$user.id"]] },
    write: { user: ["==", ["$user.id"]] },
  },
  production_cycles: {
    read: { user: ["==", ["$user.id"]] },
    write: { user: ["==", ["$user.id"]] },
  },
  product_variants: {
    read: { user: ["==", ["$user.id"]] },
    write: { user: ["==", ["$user.id"]] },
  },
  production_targets: {
    read: { user: ["==", ["$user.id"]] },
    write: { user: ["==", ["$user.id"]] },
  },
  production_plan_lines: {
    read: { user: ["==", ["$user.id"]] },
    write: { user: ["==", ["$user.id"]] },
  },
  users: {
    read: ["$authenticated"],
    write: ["$authenticated"],
  },
};

export default perms;

