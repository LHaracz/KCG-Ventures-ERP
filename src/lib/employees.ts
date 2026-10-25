/**
 * Shared helpers for the employee roster — a name-selection list, not an
 * authentication mechanism. Used by every log form's "Performed by"
 * dropdown, "Mark reviewed", and the release-warnings "Acknowledged by".
 */

export type Employee = {
  id: string;
  full_name: string;
  role_title: string | null;
  active: boolean;
  created_at: string;
};

export async function fetchActiveEmployees(supabase: any): Promise<Employee[]> {
  const { data, error } = await supabase
    .from("employees")
    .select("id, full_name, role_title, active, created_at")
    .eq("active", true)
    .order("full_name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Employee[];
}
