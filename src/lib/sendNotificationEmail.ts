import { Resend } from "resend";

const resendApiKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.RESEND_FROM ?? "notifications@resend.dev";

export async function sendNotificationEmail(to: string[], subject: string, html: string): Promise<{ ok: boolean; error?: string }> {
  if (!resendApiKey) {
    return { ok: false, error: "RESEND_API_KEY is not set" };
  }
  const resend = new Resend(resendApiKey);
  const uniqueTo = [...new Set(to.map((e) => e.trim()).filter(Boolean))];
  if (uniqueTo.length === 0) {
    return { ok: false, error: "No recipient emails" };
  }
  try {
    const { error } = await resend.emails.send({
      from: fromEmail,
      to: uniqueTo,
      subject,
      html,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
