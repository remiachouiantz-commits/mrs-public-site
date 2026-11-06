// Public browser flow. The anon key identifies the Supabase project; the
// service-role key and all deletion privileges remain inside the Edge Function.
const status = document.getElementById("status");
const emailForm = document.getElementById("email-form");
const deleteForm = document.getElementById("delete-form");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const config = window.MRS_DELETE_ACCOUNT_CONFIG;
let signedInEmail = "";
let accessToken = null;
let busy = false;

function show(message, kind = "") {
  status.textContent = message;
  status.className = `status ${kind}`;
}

function validConfig(value) {
  if (!value || typeof value.supabaseAnonKey !== "string" ||
      value.supabaseAnonKey.length < 20 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.supportEmail || "")) return false;
  try {
    const url = new URL(value.supabaseUrl);
    const ref = url.hostname.split(".")[0];
    const claims = JSON.parse(atob(value.supabaseAnonKey.split(".")[1]
      .replace(/-/g, "+").replace(/_/g, "/")));
    return url.protocol === "https:" && url.pathname === "/" &&
      !url.search && !url.hash &&
      /^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) &&
      claims.role === "anon" && claims.ref === ref;
  } catch { return false; }
}

async function postJson(path, body, token = null) {
  const response = await fetch(`${config.supabaseUrl}${path}`, {
    method: "POST",
    mode: "cors",
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: {
      "content-type": "application/json",
      apikey: config.supabaseAnonKey,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

function deletionError(code) {
  if (code === "owned_clubs_require_transfer")
    return "La propriété de votre Club doit être transférée à un administrateur actif. Contactez le support MRS pour organiser ce transfert.";
  if (code === "active_ride_session_requires_stop")
    return "Une session de roulage est active. Terminez-la dans l’application avant de réessayer.";
  if (code === "recent_reauthentication_required" || code === "invalid_session" ||
      code === "authentication_required")
    return "La session n’est plus valide, ou le compte a déjà été supprimé. Vérifiez si vous pouvez encore vous connecter avant de réessayer.";
  if (["undated_ride_requires_review", "platform_role_requires_review",
       "documented_legal_hold_requires_review", "route_library_deletion_contract_requires_review",
       "good_sections_deletion_contract_requires_review"].includes(code))
    return "Une vérification de vos données ou de votre rôle est nécessaire. Contactez le support MRS.";
  return "La suppression n’a pas été confirmée. Réessayez ou contactez le support MRS.";
}

if (!validConfig(config)) {
  show("Ce formulaire n’est pas encore disponible. Contactez le support MRS.", "error");
} else {
  const supportLink = document.createElement("a");
  supportLink.href = `mailto:${config.supportEmail}?subject=Suppression%20compte%20MRS`;
  supportLink.textContent = config.supportEmail;
  document.getElementById("support-contact").replaceChildren(supportLink);
  document.getElementById("sign-in").disabled = false;
  show("Saisissez l’adresse email déclarée pour votre compte MRS et votre mot de passe.");

  function resetAuthentication() {
    signedInEmail = "";
    accessToken = null;
    deleteForm.hidden = true;
    emailInput.readOnly = false;
  }
  emailInput.addEventListener("input", resetAuthentication);
  passwordInput.addEventListener("input", resetAuthentication);

  emailForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const button = document.getElementById("sign-in");
    button.disabled = true;
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    resetAuthentication();
    emailInput.readOnly = true;
    passwordInput.readOnly = true;
    show("Connexion en cours…");
    try {
      const result = await postJson("/auth/v1/token?grant_type=password", { email, password });
      if (result.status === 429) {
        show("Trop de tentatives. Attendez avant de réessayer.", "error");
        return;
      }
      const userEmail = result.data?.user?.email?.toLowerCase();
      if (result.status !== 200 || !result.data?.access_token || !result.data?.user?.id ||
          userEmail !== email) {
        show("Adresse email ou mot de passe incorrect.", "error");
        return;
      }
      accessToken = result.data.access_token;
      signedInEmail = userEmail;
      emailInput.readOnly = true;
      document.getElementById("signed-in-email").textContent = userEmail;
      deleteForm.hidden = false;
      show("Compte connecté. Lisez le récapitulatif avant de confirmer.");
    } catch {
      show("Service indisponible. Réessayez plus tard ou contactez le support.", "error");
    } finally {
      passwordInput.value = "";
      passwordInput.readOnly = false;
      if (!accessToken) emailInput.readOnly = false;
      busy = false;
      button.disabled = false;
    }
  });

  deleteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !accessToken || !signedInEmail) return;
    if (!document.getElementById("understood").checked ||
        document.getElementById("confirmation").value.trim() !== "SUPPRIMER") {
      show("Cochez la confirmation et saisissez exactement SUPPRIMER.", "error");
      return;
    }
    if (!window.confirm("Supprimer définitivement votre compte MRS et les données associées ?")) return;
    busy = true;
    const button = document.getElementById("delete-account");
    button.disabled = true;
    show("Demande de suppression en cours…");
    try {
      const result = await postJson("/functions/v1/delete-account",
        { confirmation: "DELETE MY MRS ACCOUNT" }, accessToken);
      if (result.status === 200 && result.data?.ok === true) {
        resetAuthentication();
        emailInput.value = "";
        document.getElementById("confirmation").value = "";
        document.getElementById("understood").checked = false;
        emailForm.hidden = true;
        deleteForm.hidden = true;
        show(`Votre compte a été supprimé.${result.data.requestId ? ` Référence : ${result.data.requestId}.` : ""}`, "success");
        return;
      }
      if (result.status === 202 && result.data?.pending === true) {
        show(`La suppression est en cours, mais sa fin n’est pas confirmée. Contactez le support ou réessayez si votre session est encore valide.${result.data.requestId ? ` Référence : ${result.data.requestId}.` : ""}`, "error");
        return;
      }
      if (result.status === 401) {
        resetAuthentication();
      }
      show(deletionError(result.data?.error), "error");
    } catch {
      show("Réponse indisponible. La demande peut avoir abouti : vérifiez l’état du compte avant de réessayer ou contactez le support.", "error");
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
}
