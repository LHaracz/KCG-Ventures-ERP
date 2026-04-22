type SupabaseErrorLike = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

type MutationContext = {
  table: string;
  operation: "insert" | "update" | "delete" | "select";
  userId?: string | null;
  payload?: Record<string, unknown>;
  match?: Record<string, unknown>;
};

function formatPairs(values: Record<string, unknown> | undefined): string {
  if (!values) return "none";
  const keys = Object.keys(values);
  if (!keys.length) return "none";
  return keys
    .map((key) => `${key}=${String(values[key])}`)
    .join(", ");
}

export function formatSupabaseMutationError(
  context: MutationContext,
  error: SupabaseErrorLike | null | undefined,
): string {
  const pieces = [
    `Write failed: ${context.table}.${context.operation}`,
    `user=${context.userId ?? "unknown"}`,
    `payloadKeys=${Object.keys(context.payload ?? {}).join(",") || "none"}`,
    `match=${formatPairs(context.match)}`,
  ];
  if (error?.code) pieces.push(`code=${error.code}`);
  if (error?.message) pieces.push(`message=${error.message}`);
  if (error?.details) pieces.push(`details=${error.details}`);
  if (error?.hint) pieces.push(`hint=${error.hint}`);
  return pieces.join(" | ");
}

export function logSupabaseMutationError(
  context: MutationContext,
  error: SupabaseErrorLike | null | undefined,
): string {
  const message = formatSupabaseMutationError(context, error);
  console.error(message, {
    context: {
      ...context,
      payloadKeys: Object.keys(context.payload ?? {}),
    },
    error,
  });
  return message;
}
