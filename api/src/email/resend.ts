// api/src/email/resend.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Thin wrapper around the Resend SDK.
//  Replaces nodemailer entirely — zero SMTP config, just an API key.
//
//  From addresses used across the codebase:
//    billing@freecustom.email   — subscription / payment events
//    api@freecustom.email       — developer API events (quota, plan changes)
//    domains@freecustom.email   — domain verification / revocation
//    noreply@freecustom.email   — generic / one-off emails
//
//  Usage:
//    import { sendEmail } from './email/resend';
//    await sendEmail({ to, subject, html, from: 'billing' });
// ─────────────────────────────────────────────────────────────────────────────
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// ── Sender identities ─────────────────────────────────────────────────────────
export const FROM = {
  billing: '"FreeCustom.Email" <billing@freecustom.email>',
  api:     '"FreeCustom.Email for Developers" <api@freecustom.email>',
  domains: '"FreeCustom.Email" <domains@freecustom.email>',
  noreply: '"FreeCustom.Email" <noreply@freecustom.email>',
} as const;

export type SenderKey = keyof typeof FROM;

export interface SendEmailOptions {
  to:      string | string[];
  subject: string;
  html:    string;
  from?:   SenderKey | string; // SenderKey resolves to a full address; raw strings passed through
  replyTo?: string;
}

export interface SendEmailResult {
  id?:    string;
  error?: string;
}

/**
 * Send a transactional email via Resend.
 * Never throws — returns { error } on failure so callers can decide whether to log/retry.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[resend] RESEND_API_KEY not set — email skipped:', opts.subject);
    return { error: 'RESEND_API_KEY not configured' };
  }

  // Resolve sender
  const fromAddress =
    opts.from && opts.from in FROM
      ? FROM[opts.from as SenderKey]
      : (opts.from ?? FROM.noreply);

  try {
    const { data, error } = await resend.emails.send({
      from:     fromAddress,
      to:       Array.isArray(opts.to) ? opts.to : [opts.to],
      subject:  opts.subject,
      html:     opts.html,
      ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
    });

    if (error) {
      console.error('[resend] Send failed:', error);
      return { error: error.message };
    }

    return { id: data?.id };
  } catch (err: any) {
    console.error('[resend] Unexpected error:', err?.message ?? err);
    return { error: err?.message ?? 'Unknown error' };
  }
}