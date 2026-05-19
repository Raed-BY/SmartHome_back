import * as nodemailer from 'nodemailer';

const ALERT_RECIPIENT = process.env.ALERT_RECIPIENT ?? 'rrbenyedder@gmail.com';
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // don't spam — one email per 5 min per type

let lastSent: Record<string, number> = {};

function getTransport(): nodemailer.Transporter | null {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
    // Hard timeouts so a Gmail outage cannot hang the backend
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 8000,
  });
}

export async function sendCivilProtectionAlert(
  type: 'GAS' | 'SMOKE' | 'FIRE',
  details: { gasLevel?: number; temperature?: number; location?: string },
): Promise<void> {
  console.log(`[Mailer] Alert triggered for type: ${type}, gasLevel: ${details.gasLevel}`);

  // Per-type cooldown
  const now = Date.now();
  if (lastSent[type] && now - lastSent[type] < ALERT_COOLDOWN_MS) {
    console.log(
      `[Mailer] Cooldown active (sent ${now - lastSent[type]}ms ago, need ${ALERT_COOLDOWN_MS}ms)`,
    );
    return;
  }
  lastSent[type] = now;

  const subject = `🔥 [FIRE EMERGENCY] URGENT — SMOKE DETECTED at Home`;
  const body = [
    '🚨 PLEASE HELP — THE HOUSE IS ON FIRE!!!',
    '',
    `SmartHome system has detected SMOKE hazard.`,
    '',
    `Smoke Level: ${details.gasLevel ?? 'n/a'} ppm`,
    `Temperature: ${details.temperature ?? 'n/a'}°C`,
    `Time: ${new Date().toISOString()}`,
    '',
    '📍 Location / Address:',
    'https://maps.app.goo.gl/oXhBk3j1H8KCB6fk6',
    '',
    '⚠️  EMERGENCY SERVICES DISPATCH REQUIRED',
    'Please dispatch fire department and emergency services immediately.',
    '',
    '— SmartHome automated emergency alert',
  ].join('\n');

  const transport = getTransport();
  if (!transport) {
    console.error(
      `[Mailer] SMTP_USER/SMTP_PASS not configured! Set them in .env file.`,
    );
    console.error(`[Mailer] Would send to ${ALERT_RECIPIENT}:\n${subject}\n${body}`);
    return;
  }

  console.log(`[Mailer] SMTP configured. Sending to ${ALERT_RECIPIENT}...`);
  try {
    const result = await transport.sendMail({
      from: process.env.SMTP_USER,
      to: ALERT_RECIPIENT,
      subject,
      text: body,
    });
    console.log(`[Mailer] ✅ ${type} alert email sent successfully. MessageID: ${result.messageId}`);
  } catch (err) {
    console.error(`[Mailer] ❌ FAILED to send email:`, err);
  }
}
