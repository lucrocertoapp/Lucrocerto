// LucroCerto — criação de assinatura mensal via Mercado Pago
// Deploy como Supabase Edge Function: criar-assinatura
// Segredos necessários: MP_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_ANON_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://lucrocertoapp.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const json = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method !== "POST") return json(405, { error: "Método não permitido." });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json(401, { error: "Faça login para continuar." });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const mpToken = Deno.env.get("MP_ACCESS_TOKEN");
    if (!supabaseUrl || !anonKey || !mpToken) {
      return json(500, { error: "Configuração do servidor incompleta." });
    }

    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user?.id || !user.email) {
      return json(401, { error: "Sessão inválida. Entre novamente." });
    }

    const payload = {
      reason: "LucroCerto — Plano mensal",
      auto_recurring: {
        frequency: 1,
        frequency_type: "months",
        transaction_amount: 19.90,
        currency_id: "BRL",
      },
      back_url: "https://lucrocertoapp.github.io/Lucrocerto/?assinatura=retorno",
      notification_url: "https://minfgjlxijacbhkydtkm.supabase.co/functions/v1/mercado-pago-webhook",
      payer_email: user.email,
      external_reference: user.id,
      status: "pending",
    };

    const mpResponse = await fetch("https://api.mercadopago.com/preapproval", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${mpToken}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(payload),
    });

    const mpData = await mpResponse.json().catch(() => ({}));
    if (!mpResponse.ok) {
      console.error("Mercado Pago subscription error:", mpResponse.status, mpData);
      return json(502, { error: "Não foi possível criar a assinatura. Tente novamente." });
    }

    const checkoutUrl = mpData.init_point || mpData.sandbox_init_point;
    if (!checkoutUrl || !mpData.id) {
      console.error("Mercado Pago response missing checkout URL or id:", mpData);
      return json(502, { error: "O Mercado Pago não retornou o link de pagamento." });
    }

    return json(200, { id: mpData.id, init_point: checkoutUrl });
  } catch (error) {
    console.error("criar-assinatura:", error);
    return json(500, { error: "Erro interno ao preparar a assinatura." });
  }
});
