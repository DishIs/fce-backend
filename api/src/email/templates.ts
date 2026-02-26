// api/src/email-templates.ts
// Shared premium email templates — consistent with magic link style.

const BRAND_LOGO = 'https://www.freecustom.email/favicon.ico';
const APP_URL    = process.env.APP_URL || 'https://www.freecustom.email';

function layout(content: string, whyReason: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:48px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #e5e5e5;border-radius:8px;">

          <!-- Logo -->
          <tr>
            <td style="padding:32px 40px 24px;border-bottom:1px solid #f0f0f0;">
              <img src="${BRAND_LOGO}" width="24" height="24" alt="" style="vertical-align:middle;margin-right:8px;">
              <span style="font-size:14px;font-weight:600;color:#111;vertical-align:middle;">FreeCustom.Email</span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">${content}</td>
          </tr>

          <!-- Why am I receiving this -->
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #f0f0f0;background:#fafafa;border-radius:0 0 8px 8px;">
              <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:0.6px;">Why am I receiving this?</p>
              <p style="margin:0;font-size:12px;color:#bbb;line-height:1.7;">
                ${whyReason} This email was sent by
                <a href="${APP_URL}" style="color:#bbb;text-decoration:underline;">FreeCustom.Email</a>.
                If you think you received this by mistake, reply and we'll look into it.
              </p>
              <p style="margin:12px 0 0;font-size:12px;color:#ccc;">© 2026 FreeCustom.Email</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function pill(text: string, color: string, bg: string): string {
  return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;color:${color};background:${bg};">${text}</span>`;
}

function statBox(value: string, label: string): string {
  return `<td style="text-align:center;padding:16px 20px;background:#f9f9f9;border-radius:6px;">
    <p style="margin:0;font-size:22px;font-weight:700;color:#111;">${value}</p>
    <p style="margin:4px 0 0;font-size:12px;color:#888;">${label}</p>
  </td>`;
}

function ctaButton(url: string, text: string, style: 'dark' | 'outline' = 'dark'): string {
  if (style === 'outline') {
    return `<a href="${url}" style="display:inline-block;border:1.5px solid #111;color:#111;padding:10px 26px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500;">${text}</a>`;
  }
  return `<a href="${url}" style="display:inline-block;background:#111;color:#fff;padding:11px 28px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500;">${text}</a>`;
}

export interface CancellationEmailData {
  periodEnd:     string;
  emailCount:    number;
  storageUsedMB: number;
  inboxCount:    number;
}

export function getCancellationEmailHtml(data: CancellationEmailData): string {
  const { periodEnd, emailCount, storageUsedMB, inboxCount } = data;

  const endDate = new Date(periodEnd).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const storageLabel = storageUsedMB >= 1000
    ? `${(storageUsedMB / 1024).toFixed(1)} GB`
    : `${storageUsedMB.toFixed(0)} MB`;

  const lossItems = [
    'Your stored emails will be reduced to the <strong>20 most recent</strong> — older ones will be removed',
    'Emails will expire after <strong>24 hours</strong> instead of being kept forever',
    'Custom domain email routing will stop working',
    'OTP and verification link detection will be hidden',
  ].map(i => `<tr>
    <td style="padding:5px 0;font-size:13px;color:#92400e;vertical-align:top;width:16px;">·</td>
    <td style="padding:5px 0;font-size:13px;color:#92400e;line-height:1.5;">${i}</td>
  </tr>`).join('');

  const content = `
    <p style="margin:0 0 4px;font-size:20px;font-weight:600;color:#111;">Your subscription has been cancelled</p>
    <p style="margin:0 0 28px;font-size:14px;color:#666;line-height:1.6;">
      We're sorry to see you go. Your Pro access remains active until
      <strong style="color:#111;">${endDate}</strong>, after which your account will revert to the free plan.
    </p>

    <div style="background:#fff8ed;border:1px solid #fde68a;border-radius:6px;padding:20px 24px;margin-bottom:24px;">
      <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#92400e;">What changes on ${endDate}</p>
      <table width="100%" cellpadding="0" cellspacing="0">${lossItems}</table>
    </div>

    <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#555;">Your current usage</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        ${statBox(emailCount.toLocaleString(), 'Emails stored')}
        <td width="8"></td>
        ${statBox(storageLabel, 'Storage used')}
        <td width="8"></td>
        ${statBox(String(inboxCount), inboxCount === 1 ? 'Inbox' : 'Inboxes')}
      </tr>
    </table>

    <p style="margin:28px 0 24px;font-size:14px;color:#444;line-height:1.6;">
      Changed your mind? Resubscribe any time before ${endDate} and keep everything as it is.
    </p>

    ${ctaButton(`${APP_URL}/pricing`, 'Keep my Pro plan')}
    &nbsp;&nbsp;
    ${ctaButton(`${APP_URL}/dashboard`, 'Go to dashboard', 'outline')}

    <p style="margin:32px 0 0;font-size:12px;color:#999;line-height:1.6;">
      If you have feedback on why you cancelled, we'd love to hear it — just reply to this email.
    </p>`;

  return layout(content, "You're receiving this because you cancelled your Pro subscription on FreeCustom.Email.");
}

export function getDowngradeCompleteEmailHtml(): string {
  const freeFeatures = [
    'Unlimited inboxes (1 active at a time)',
    'Emails kept for 24 hours',
    'Instant email delivery',
    'QR code sharing',
  ].map(f => `<tr>
    <td style="padding:4px 0;font-size:13px;color:#444;vertical-align:top;width:18px;">✓</td>
    <td style="padding:4px 0;font-size:13px;color:#444;">${f}</td>
  </tr>`).join('');

  const content = `
    <p style="margin:0 0 4px;font-size:20px;font-weight:600;color:#111;">Your account has been downgraded</p>
    <p style="margin:0 0 28px;font-size:14px;color:#666;line-height:1.6;">
      Your Pro subscription has ended and your account is now on the free plan.
      Your most recent 20 emails have been preserved.
    </p>

    <div style="background:#f9f9f9;border-radius:6px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#555;">What you still get on the free plan</p>
      <table width="100%" cellpadding="0" cellspacing="0">${freeFeatures}</table>
    </div>

    ${ctaButton(`${APP_URL}/pricing`, 'Upgrade to Pro again')}

    <p style="margin:32px 0 0;font-size:12px;color:#999;line-height:1.6;">
      Questions? Just reply to this email and we'll help.
    </p>`;

  return layout(content, "You're receiving this because your Pro subscription period ended and your account was downgraded to free.");
}

export function getDomainWarningEmailHtml(domain: string, txtOk: boolean, mxOk: boolean): string {
  const issues: string[] = [];
  if (!txtOk) issues.push('TXT verification record is missing or incorrect');
  if (!mxOk)  issues.push('MX record is not pointing to <code style="font-family:monospace;background:#f5f5f5;padding:1px 5px;border-radius:3px;font-size:12px;">mx.freecustom.email</code>');

  const issueRows = issues.map(i => `<tr>
    <td style="padding:5px 0;font-size:13px;color:#92400e;vertical-align:top;width:16px;">·</td>
    <td style="padding:5px 0;font-size:13px;color:#92400e;line-height:1.5;">${i}</td>
  </tr>`).join('');

  const content = `
    <p style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111;">DNS issue detected</p>
    <p style="margin:0 0 20px;">${pill('Action required', '#92400e', '#fef3c7')}&nbsp;&nbsp;<span style="font-size:13px;color:#888;">Domain: <strong style="color:#111;">${domain}</strong></span></p>
    <p style="margin:0 0 28px;font-size:14px;color:#666;line-height:1.6;">
      We ran a routine DNS check on your custom domain and found a problem.
      <strong style="color:#111;">No action has been taken yet</strong> — your domain is still active.
      If the issue isn't resolved before our next check, the domain will be automatically de-verified
      and stop receiving emails.
    </p>

    <div style="background:#fff8ed;border:1px solid #fde68a;border-radius:6px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#92400e;">Issue(s) found</p>
      <table width="100%" cellpadding="0" cellspacing="0">${issueRows}</table>
    </div>

    ${ctaButton(`${APP_URL}/dashboard/domains`, 'Fix DNS settings →')}

    <p style="margin:32px 0 0;font-size:12px;color:#999;line-height:1.6;">
      DNS propagation can take up to 48 hours. If your records look correct, check back soon.<br>
      Reply to this email if you need help with your DNS setup.
    </p>`;

  return layout(content, "You're receiving this because you have a verified custom domain on your FreeCustom.Email Pro account and we run periodic DNS health checks.");
}

export function getDomainRevocationEmailHtml(domain: string, txtOk: boolean, mxOk: boolean): string {
  const issues: string[] = [];
  if (!txtOk) issues.push('TXT verification record was missing or incorrect');
  if (!mxOk)  issues.push('MX record was not pointing to <code style="font-family:monospace;background:#fef2f2;padding:1px 5px;border-radius:3px;font-size:12px;">mx.freecustom.email</code>');

  const issueRows = issues.map(i => `<tr>
    <td style="padding:5px 0;font-size:13px;color:#991b1b;vertical-align:top;width:16px;">·</td>
    <td style="padding:5px 0;font-size:13px;color:#991b1b;line-height:1.5;">${i}</td>
  </tr>`).join('');

  const content = `
    <p style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111;">Custom domain de-verified</p>
    <p style="margin:0 0 20px;">${pill('Email delivery stopped', '#991b1b', '#fee2e2')}&nbsp;&nbsp;<span style="font-size:13px;color:#888;">Domain: <strong style="color:#111;">${domain}</strong></span></p>
    <p style="margin:0 0 28px;font-size:14px;color:#666;line-height:1.6;">
      After multiple failed DNS checks, <strong style="color:#111;">${domain}</strong> has been
      de-verified and will <strong style="color:#111;">no longer receive emails</strong> through FreeCustom.Email.
    </p>

    <div style="background:#fff5f5;border:1px solid #fecaca;border-radius:6px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#991b1b;">DNS issue(s) that caused this</p>
      <table width="100%" cellpadding="0" cellspacing="0">${issueRows}</table>
    </div>

    <p style="margin:0 0 24px;font-size:14px;color:#444;line-height:1.6;">
      Once you've corrected your DNS records, you can re-verify your domain instantly from the dashboard.
    </p>

    ${ctaButton(`${APP_URL}/dashboard/domains`, 'Re-verify my domain →')}

    <p style="margin:32px 0 0;font-size:12px;color:#999;line-height:1.6;">
      If you believe this is a mistake or need help, just reply to this email.
    </p>`;

  return layout(content, "You're receiving this because you have a verified custom domain on your FreeCustom.Email Pro account and we run periodic DNS health checks.");
}