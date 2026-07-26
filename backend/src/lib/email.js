/**
 * Envío de mail con adjunto (usado para mandar facturas por mail). Soporta
 * dos vías:
 *
 * 1) Resend (API HTTP, https://resend.com): si la sucursal tiene una API key
 *    cargada, se usa esta vía. Es la recomendada para hostings gratuitos:
 *    desde el 26/9/2025 Render bloquea el tráfico saliente a los puertos de
 *    SMTP (25, 465, 587) en el free tier de sus "web services", así que el
 *    envío por SMTP directamente no funciona ahí sin pasar a un plan pago.
 *    Al ser una API HTTPS (puerto 443), no choca con ese bloqueo.
 * 2) SMTP tradicional (nodemailer): se sigue soportando para quienes alojan
 *    la app en otro lado (o en un plan pago de Render) y prefieren usar su
 *    propio servidor de correo.
 *
 * Si no hay ninguna de las dos configuradas, lanza un error explicando qué
 * falta (lo mismo que antes).
 */
async function sendMailWithAttachment({ branch, to, subject, text, attachmentFilename, attachmentBuffer }) {
  if (branch?.resend_api_key) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${branch.resend_api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: branch.smtp_from || "onboarding@resend.dev",
        to: [to],
        subject,
        text,
        attachments: [
          {
            filename: attachmentFilename,
            content: attachmentBuffer.toString("base64"),
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`No se pudo enviar el mail vía Resend (${res.status}): ${body || "sin detalle"}`);
    }
    return { provider: "resend" };
  }

  if (branch?.smtp_host && branch?.smtp_user && branch?.smtp_pass) {
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host: branch.smtp_host,
      port: branch.smtp_port || 587,
      secure: Number(branch.smtp_port) === 465,
      auth: { user: branch.smtp_user, pass: branch.smtp_pass },
    });
    await transporter.sendMail({
      from: branch.smtp_from || branch.smtp_user,
      to,
      subject,
      text,
      attachments: [{ filename: attachmentFilename, content: attachmentBuffer }],
    });
    return { provider: "smtp" };
  }

  throw Object.assign(
    new Error(
      "El envío de facturas por mail no está configurado. Completá una API key de Resend (recomendado si la app está en el plan gratuito de Render, que bloquea SMTP) o los datos de SMTP en Administración → Parámetros."
    ),
    { status: 400 }
  );
}

module.exports = { sendMailWithAttachment };
