// LucroCerto — webhook de assinaturas Mercado Pago
// Segredos: MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy com Verify JWT desativado: o Mercado Pago não envia JWT do Supabase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function validSignature(req: Request, secret: string, dataId: string) {
  const signature = req.headers.get("x-signature") || "";
  const requestId = req.headers.get("x-request-id") || "";
  const parts = Object.fromEntries(
    signature.split(",").map((part) => {
      const [key, ...value] = part.trim().split("=");
      return [key, value.join("=")];
    }),
  );
  const ts = parts.ts;
  const received = parts.v1;
  if (!ts || !received || !requestId || !dataId) return false;

  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest));
  const expected = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return safeEqual(expected, received);
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") return json(200, { ok: true, service: "lucrocerto-webhook" });
  if (req.method !== "POST") return json(405, { error: "Método não permitido." });

  try {
    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    const dataId = url.searchParams.get("data.id") || body?.data?.id?.toString() || "";
    const type = url.searchParams.get("type") || body?.type || "";
    if (!dataId) return json(200, { received: true, ignored: "sem data.id" });

    const mpToken = Deno.env.get("MP_ACCESS_TOKEN");
    const webhookSecret = Deno.env.get("MP_WEBHOOK_SECRET");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!mpToken || !webhookSecret || !supabaseUrl || !serviceKey) {
      console.error("Webhook secrets incompletos.");
      return json(500, { error: "Configuração incompleta." });
    }

    if (!(await validSignature(req, webhookSecret, dataId))) {
      return json(401, { error: "Assinatura inválida." });
    }

    let preapprovalId = dataId;
    if (type === "subscription_authorized_payment") {
      const invoiceResponse = await fetch(
        `https://api.mercadopago.com/authorized_payments/${encodeURIComponent(dataId)}`,
        { headers: { Authorization: `Bearer ${mpToken}` } },
      );
      if (!invoiceResponse.ok) {
        console.error("Falha ao consultar fatura:", invoiceResponse.status);
        return json(500, { error: "Não foi possível consultar a fatura." });
      }
      const invoice = await invoiceResponse.json();
      preapprovalId = invoice.preapproval_id || invoice.subscription_id || "";
      if (!preapprovalId) return json(200, { received: true, ignored: "fatura sem assinatura" });
    } else if (type !== "subscription_preapproval" && type !== "subscription") {
      return json(200, { received: true, ignored: type || "evento não tratado" });
    }

    const subscriptionResponse = await fetch(
      `https://api.mercadopago.com/preapproval/${encodeURIComponent(preapprovalId)}`,
      { headers: { Authorization: `Bearer ${mpToken}` } },
    );
    if (!subscriptionResponse.ok) {
      console.error("Falha ao consultar assinatura:", subscriptionResponse.status);
      return json(500, { error: "Não foi possível consultar a assinatura." });
    }

    const subscription = await subscriptionResponse.json();
    const userId = subscription.external_reference;
    if (!userId) return json(200, { received: true, ignored: "assinatura sem external_reference" });

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await supabase.from("assinaturas").upsert({
      user_id: userId,
      mercado_pago_id: subscription.id,
      status: subscription.status || "pending",
      valor: subscription.auto_recurring?.transaction_amount ?? 19.90,
      email: subscription.payer_email || null,
      atualizado_em: new Date().toISOString(),
    }, { onConflict: "mercado_pago_id" });

    if (error) {
      console.error("Falha ao salvar assinatura:", error);
      return json(500, { error: "Não foi possível atualizar o cadastro." });
    }

    return json(200, { received: true });
  } catch (error) {
    console.error("mercado-pago-webhook:", error);
    return json(500, { error: "Erro interno." });
  }
});
