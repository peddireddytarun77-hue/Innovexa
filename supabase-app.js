const $ = id => document.getElementById(id);
const { url, publishableKey } = window.GYMGRID_SUPABASE_CONFIG || {};
[
  "gym_members", "gym_plans", "gym_memberships", "gym_payments",
  "gymmate_membership_manager_v2"
].forEach(key => localStorage.removeItem(key));
const supabaseClient = window.supabase && url && publishableKey
  ? window.supabase.createClient(url, publishableKey, {
    auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true }
  })
  : null;

const state = {
  members: [], plans: [], memberships: [], statuses: [], renewals: [], payments: [],
  defaultStartDate: todayString()
};
let selectedDuration = "all";
let selectedStatus = "active";

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function todayString() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addMonthsToDate(dateText, months) {
  const date = new Date(`${dateText}T12:00:00`);
  const originalDay = date.getDate();
  date.setMonth(date.getMonth() + Number(months));
  if (date.getDate() < originalDay) date.setDate(0);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function money(value) {
  return "₹" + Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function showEmpty(tbody, columns, message) {
  tbody.innerHTML = `<tr><td class="empty" colspan="${columns}">${escapeHTML(message)}</td></tr>`;
}

function setLoginError(message) {
  $("loginError").textContent = message;
}

function backendErrorMessage(error) {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("gym administrator access required")) {
    return "This Supabase user is not an admin yet. Add its Auth user ID to public.gym_admins, then sign in again.";
  }
  if (error?.code === "PGRST202" || message.includes("create_member_with_membership")) {
    return "Supabase cannot find the enrollment function. Run the latest supabase.sql in SQL Editor.";
  }
  if (error?.code === "42501" || error?.status === 403) {
    return "Supabase denied this request. Check the gym_admins entry and rerun the latest RLS policies.";
  }
  if (message.includes("failed to fetch") || message.includes("network")) {
    return "Cannot reach Supabase. Check the project URL, internet connection, and allowed origins.";
  }
  return `Supabase request failed${error?.code ? ` (${error.code})` : ""}. Check that the latest supabase.sql was run.`;
}

async function loadTable(table, query) {
  const { data, error } = await query;
  if (error) throw error;
  state[table] = data || [];
}

async function loadData() {
  await Promise.all([
    loadTable("plans", supabaseClient.from("plans").select("*").eq("is_active", true).order("duration_months")),
    loadTable("members", supabaseClient.from("members").select("*").is("archived_at", null).order("created_at", { ascending: false })),
    loadTable("memberships", supabaseClient.from("memberships")
      .select("id,member_id,plan_id,starts_on,ends_on,created_at,plans(name,duration_months,price),members(full_name,phone)")
      .order("starts_on", { ascending: false })),
    loadTable("statuses", supabaseClient.from("membership_status").select("*")),
    loadTable("renewals", supabaseClient.from("renewals")
      .select("id,member_id,plan_id,renewed_on,starts_on,ends_on,plans(name),members(full_name)")
      .order("renewed_on", { ascending: false })),
    loadTable("payments", supabaseClient.from("payments")
      .select("id,member_id,plan_id,amount,payment_method,payment_type,paid_on,plans(name),members(full_name)")
      .order("paid_on", { ascending: false }))
  ]);
  refreshViews();
}

function latestMembership(memberId) {
  return state.memberships
    .filter(item => item.member_id === memberId)
    .sort((a, b) => b.starts_on.localeCompare(a.starts_on) || b.created_at.localeCompare(a.created_at))[0] || null;
}

function renderPlans() {
  const tbody = $("planTable");
  if (!state.plans.length) return showEmpty(tbody, 4, "No plans found. Run supabase.sql to add the starter plans.");
  tbody.innerHTML = state.plans.map(plan => `
    <tr><td>${plan.duration_months} month${plan.duration_months === 1 ? "" : "s"}</td>
    <td>${escapeHTML(plan.name)}</td><td class="plan-price">${money(plan.price)}</td>
    <td>${money(plan.discount)} off</td></tr>`).join("");
}

function renderMembers() {
  const query = $("memberSearch").value.trim().toLowerCase();
  const filtered = state.members.filter(member => {
    const membership = latestMembership(member.id);
    const planName = membership?.plans?.name || "";
    return [member.full_name, member.phone, planName].some(value => String(value || "").toLowerCase().includes(query));
  });
  const tbody = $("memberTable");
  if (!filtered.length) return showEmpty(tbody, 8, state.members.length ? "No matching members found." : "No members added yet.");
  tbody.innerHTML = filtered.map(member => {
    const membership = latestMembership(member.id);
    return `<tr><td>${escapeHTML(member.id)}</td><td>${escapeHTML(member.full_name)}</td>
      <td>${escapeHTML(membership?.plans?.name || "No plan")}</td>
      <td>${membership ? `${membership.plans.duration_months} month${membership.plans.duration_months === 1 ? "" : "s"}` : "-"}</td>
      <td>${membership?.starts_on || "-"}</td><td>${membership?.ends_on || "-"}</td>
      <td>${escapeHTML(member.phone)}</td><td><button class="btn danger small" data-archive-member="${escapeHTML(member.id)}">Archive</button></td></tr>`;
  }).join("");
}

function renderMemberships() {
  const rows = state.memberships.filter(item => selectedDuration === "all" || String(item.plans.duration_months) === selectedDuration);
  const tbody = $("membershipTable");
  if (!rows.length) return showEmpty(tbody, 7, "No memberships in this duration yet.");
  const statuses = new Map(state.statuses.map(item => [item.membership_id, item.status]));
  tbody.innerHTML = rows.map(item => `
    <tr><td>${escapeHTML(item.id)}</td><td>${escapeHTML(item.member_id)}</td>
    <td>${escapeHTML(item.members?.full_name || "Archived")}</td><td>${escapeHTML(item.plans.name)}</td>
    <td>${item.plans.duration_months} month${item.plans.duration_months === 1 ? "" : "s"}</td>
    <td>${item.starts_on}</td><td>${item.ends_on}</td>
    <td><span class="status ${(statuses.get(item.id) || "upcoming").toLowerCase()}">${escapeHTML(statuses.get(item.id) || "Upcoming")}</span></td></tr>`).join("");
}

function renderStatus() {
  const latest = state.statuses.filter(item => item.is_latest && item.status.toLowerCase() === selectedStatus);
  const grouped = state.plans.map(plan => ({
    plan,
    count: latest.filter(item => item.plan_id === plan.id).length
  }));
  $("statusHeading").textContent = selectedStatus === "active" ? "Active memberships" : "Completely expired memberships";
  $("statusCounts").innerHTML = grouped.map(({ plan, count }) => `
    <div class="count-button"><span>${plan.duration_months} month${plan.duration_months === 1 ? "" : "s"} · ${escapeHTML(plan.name)}</span><strong>${count}</strong></div>`).join("");
}

function renderRenewals() {
  const tbody = $("renewalTable");
  if (!state.renewals.length) return showEmpty(tbody, 5, "No renewals recorded yet.");
  tbody.innerHTML = state.renewals.map(item => `
    <tr><td>${escapeHTML(item.members?.full_name || "Archived")}</td><td>${escapeHTML(item.plans?.name || "- ")}</td>
    <td>${item.renewed_on}</td><td>${item.starts_on}</td><td>${item.ends_on}</td></tr>`).join("");
}

function renderPayments() {
  const tbody = $("paymentTable");
  if (!state.payments.length) return showEmpty(tbody, 6, "No payments recorded yet.");
  tbody.innerHTML = state.payments.map(payment => `
    <tr><td>${escapeHTML(payment.members?.full_name || "Archived")}</td><td>${escapeHTML(payment.plans?.name || "-")}</td>
    <td class="plan-price">${money(payment.amount)}</td><td>${payment.paid_on.slice(0, 10)}</td>
    <td>${escapeHTML(payment.payment_method)}</td><td>${escapeHTML(payment.payment_type)}</td></tr>`).join("");
}

function fillPlanSelect(select) {
  select.innerHTML = state.plans.map(plan =>
    `<option value="${escapeHTML(plan.id)}">${plan.duration_months} month${plan.duration_months === 1 ? "" : "s"} - ${escapeHTML(plan.name)} (${money(plan.price)})</option>`
  ).join("") || '<option value="">Add plans in Supabase first</option>';
}

function renderDropdowns() {
  fillPlanSelect($("memberPlan"));
  fillPlanSelect($("renewPlan"));
  const options = state.members.map(member =>
    `<option value="${escapeHTML(member.id)}">${escapeHTML(member.full_name)} - ${escapeHTML(member.phone)}</option>`
  ).join("");
  $("renewMember").innerHTML = options || '<option value="">Add a member first</option>';
  updateMemberDates();
  updateRenewalDates();
}

function updateMemberDates() {
  const plan = state.plans.find(item => item.id === $("memberPlan").value);
  $("memberDuration").value = plan ? `${plan.duration_months} month${plan.duration_months === 1 ? "" : "s"}` : "";
  if (!$("memberStartDate").value) $("memberStartDate").value = state.defaultStartDate;
  $("memberEndDate").value = plan ? addMonthsToDate($("memberStartDate").value, plan.duration_months) : "";
}

function updateRenewalDates() {
  const memberId = $("renewMember").value;
  const plan = state.plans.find(item => item.id === $("renewPlan").value);
  const renewalDate = $("renewDate").value || todayString();
  const latestEnd = state.memberships.filter(item => item.member_id === memberId)
    .map(item => item.ends_on).sort().at(-1);
  const startsOn = latestEnd && latestEnd >= renewalDate ? latestEnd : renewalDate;
  $("renewStartDate").value = startsOn;
  $("renewEndDate").value = plan ? addMonthsToDate(startsOn, plan.duration_months) : "";
}

function refreshViews() {
  $("totalMembers").textContent = state.members.length;
  $("totalPlans").textContent = state.plans.length;
  const latest = state.statuses.filter(item => item.is_latest);
  $("activeMemberships").textContent = latest.filter(item => item.status === "Active").length;
  $("expiredMemberships").textContent = latest.filter(item => item.status === "Expired").length;
  $("defaultStartDate").value = state.defaultStartDate;
  renderPlans();
  renderMembers();
  renderMemberships();
  renderStatus();
  renderDropdowns();
  renderRenewals();
  renderPayments();
}

function goToSection(sectionId) {
  document.querySelectorAll(".content-section").forEach(section => section.classList.toggle("active", section.id === sectionId));
  document.querySelectorAll(".nav-btn[data-section]").forEach(button => button.classList.toggle("active", button.dataset.section === sectionId));
  const titles = { home: "Dashboard", members: "Add Members", plans: "Plans", duration: "Memberships", expiry: "Status", renewal: "Renewal", payments: "Payments" };
  $("pageTitle").textContent = titles[sectionId] || "Dashboard";
}

async function showApp() {
  $("loginPage").classList.add("hidden");
  $("app").classList.remove("hidden");
  goToSection("home");
  try {
    await loadData();
  } catch (error) {
    alert(backendErrorMessage(error));
  }
}

async function withCheckout(button, operation) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Processing payment...";
  try {
    await new Promise(resolve => window.setTimeout(resolve, 5000));
    await operation();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!supabaseClient) {
    setLoginError("Supabase configuration could not be loaded.");
    return;
  }
  setLoginError("");
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: $("username").value.trim(),
      password: $("password").value
    });
    if (error) throw error;
    $("loginForm").reset();
    await showApp();
  } catch {
    setLoginError("Sign-in failed. Check your email and password.");
  }
});

$("logoutBtn").addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  $("app").classList.add("hidden");
  $("loginPage").classList.remove("hidden");
  $("loginForm").reset();
  setLoginError("");
});

document.querySelectorAll(".nav-btn[data-section]").forEach(button =>
  button.addEventListener("click", () => goToSection(button.dataset.section))
);
document.querySelectorAll("[data-open-section]").forEach(button =>
  button.addEventListener("click", () => goToSection(button.dataset.openSection))
);

$("memberPlan").addEventListener("change", updateMemberDates);
$("memberStartDate").addEventListener("change", updateMemberDates);
$("memberForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.submitter;
  try {
    await withCheckout(button, async () => {
      const { error } = await supabaseClient.rpc("create_member_with_membership", {
        p_full_name: $("memberName").value.trim(),
        p_phone: $("memberPhone").value.trim(),
        p_plan_id: $("memberPlan").value,
        p_starts_on: $("memberStartDate").value,
        p_payment_method: $("memberPaymentMethod").value
      });
      if (error) throw error;
    });
  } catch (error) {
    alert(backendErrorMessage(error));
    return;
  }
  event.target.reset();
  $("memberStartDate").value = state.defaultStartDate;
  try {
    await loadData();
  } catch (error) {
    alert(`Member was saved, but the page could not refresh. ${backendErrorMessage(error)}`);
    return;
  }
  alert("Payment successful. Member, membership, and payment records are saved.");
});

$("memberSearch").addEventListener("input", renderMembers);
$("memberTable").addEventListener("click", async event => {
  const button = event.target.closest("[data-archive-member]");
  if (!button || !confirm("Archive this member? Their membership and payment history will be retained.")) return;
  const { error } = await supabaseClient.from("members")
    .update({ archived_at: new Date().toISOString() }).eq("id", button.dataset.archiveMember);
  if (error) return alert("Could not archive this member.");
  await loadData();
});

$("saveDefaultDate").addEventListener("click", () => {
  if (!$("defaultStartDate").value) return;
  state.defaultStartDate = $("defaultStartDate").value;
  $("memberStartDate").value = state.defaultStartDate;
  updateMemberDates();
});

$("durationFilters").addEventListener("click", event => {
  const button = event.target.closest("[data-months]");
  if (!button) return;
  selectedDuration = button.dataset.months;
  $("durationFilters").querySelectorAll("button").forEach(item => item.classList.toggle("active", item === button));
  renderMemberships();
});

$("statusFilters").addEventListener("click", event => {
  const button = event.target.closest("[data-status]");
  if (!button) return;
  selectedStatus = button.dataset.status;
  $("statusFilters").querySelectorAll("button").forEach(item => item.classList.toggle("active", item === button));
  renderStatus();
});

["renewMember", "renewPlan", "renewDate"].forEach(id => $(id).addEventListener("change", updateRenewalDates));
$("renewalForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.submitter;
  try {
    await withCheckout(button, async () => {
      const { error } = await supabaseClient.rpc("renew_membership", {
        p_member_id: $("renewMember").value,
        p_plan_id: $("renewPlan").value,
        p_renewed_on: $("renewDate").value,
        p_payment_method: $("renewPaymentMethod").value
      });
      if (error) throw error;
    });
  } catch (error) {
    alert(backendErrorMessage(error));
    return;
  }
  $("renewDate").value = todayString();
  updateRenewalDates();
  try {
    await loadData();
  } catch (error) {
    alert(`Renewal was saved, but the page could not refresh. ${backendErrorMessage(error)}`);
    return;
  }
  alert("Payment successful. Renewal, membership, and payment records are saved.");
});

$("memberStartDate").value = state.defaultStartDate;
$("renewDate").value = todayString();
if (!supabaseClient) {
  setLoginError("Supabase configuration could not be loaded.");
} else {
  supabaseClient.auth.getSession().then(({ data, error }) => {
    if (error) setLoginError("Could not restore the Supabase session. Sign in again.");
    else if (data.session) showApp();
  });
}