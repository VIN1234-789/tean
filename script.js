const CONFIG_KEY = "risingstars-supabase-config";
const CURRENCIES = ["USD", "EUR", "GBP", "KES"];
let data = { members: [], events: [], attendance: {}, attendanceRecorded: new Set(), contributions: [] };
let client = null;
let currentUser = null;
let realtimeChannel = null;
let realtimeRefreshTimer = null;
let activePage = "dashboard";
let eventFilter = "upcoming";
let currentModalSubmit = null;
const backdrop = document.getElementById("modal-backdrop");
const form = document.getElementById("modal-form");
const modalBody = document.getElementById("modal-body");

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));
const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
const avatarClass = (name) => `avatar-color-${(String(name || "R").charCodeAt(0) + String(name || "").length) % 6}`;
const localDate = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const dateOffset = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDate(date);
};
const formatDate = (value, options = { month: "short", day: "numeric" }) => {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", options).format(new Date(`${value}T12:00:00`));
};
const sortEvents = (items) => [...items].sort((a, b) => a.date.localeCompare(b.date));
const isPast = (event) => event.date < localDate(new Date());
const attendedCount = (event) => (data.attendance[event.id] || []).length;
const percentage = (event) => data.members.length ? Math.round(attendedCount(event) / data.members.length * 100) : 0;
const recordedEvents = () => sortEvents(data.events.filter((event) => data.attendanceRecorded.has(event.id))).reverse();
const averageAttendance = () => {
  const events = recordedEvents();
  if (!events.length || !data.members.length) return null;
  return Math.round(events.reduce((sum, event) => sum + percentage(event), 0) / events.length);
};
const money = (amount, currency) => new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(amount));
const groupMoney = (items) => {
  const totals = new Map();
  for (const item of items) totals.set(item.currency, (totals.get(item.currency) || 0) + Math.round(Number(item.amount) * 100));
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, cents]) => money(cents / 100, currency)).join(" · ") || money(0, "USD");
};

function showToast(message, isError = false) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.toggle("toast-error", isError);
  toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("visible"), 3600);
}

function readConfig() {
  try {
    const saved = localStorage.getItem(CONFIG_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch (error) {
    console.error("Could not read Supabase configuration:", error);
    return {};
  }
}

function makeClient(url, key) {
  if (!window.supabase?.createClient) throw new Error("Supabase client could not load. Check your internet connection and refresh the page.");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") throw new Error("Use your Supabase project's HTTPS URL.");
  const publicKey = key.trim();
  if (!publicKey) throw new Error("Enter your project's anon / publishable key.");
  if (/^sb_secret_/i.test(publicKey)) throw new Error("Never use a Supabase secret or service-role key in this browser app.");
  const jwtPayload = publicKey.split(".")[1];
  let jwtRole = "";
  if (jwtPayload) {
    try {
      const normalizedPayload = jwtPayload.replace(/-/g, "+").replace(/_/g, "/");
      const paddedPayload = normalizedPayload.padEnd(Math.ceil(normalizedPayload.length / 4) * 4, "=");
      jwtRole = JSON.parse(atob(paddedPayload)).role || "";
    } catch {
      throw new Error("The Supabase anon / publishable key format is invalid.");
    }
  }
  if (jwtRole === "service_role") throw new Error("Never use a Supabase service-role key in this browser app.");
  return window.supabase.createClient(parsed.origin, publicKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
}

function setAuthError(message) {
  const error = document.getElementById("auth-error");
  error.textContent = message;
  error.classList.remove("hidden");
}

function showAuth(message = "") {
  currentUser = null;
  document.getElementById("app-shell").classList.add("hidden");
  document.getElementById("auth-screen").classList.remove("hidden");
  document.getElementById("auth-title").textContent = "Welcome back";
  document.getElementById("auth-subtitle").textContent = "Sign in to your group's secure workspace.";
  document.getElementById("auth-password").value = "";
  const error = document.getElementById("auth-error");
  error.textContent = message;
  error.classList.toggle("hidden", !message);
}

function showApp(session) {
  currentUser = session.user;
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  document.getElementById("profile-email").textContent = currentUser.email || "Signed in";
  const name = currentUser.user_metadata?.full_name || currentUser.email?.split("@")[0] || "Group leader";
  document.getElementById("profile-name").textContent = name;
  document.getElementById("profile-avatar").textContent = initials(name);
  document.getElementById("top-avatar").textContent = initials(name);
}

async function loadCloudData() {
  if (!client || !currentUser) return;
  const [membersResult, eventsResult, attendanceResult, attendanceSessionsResult, contributionsResult] = await Promise.all([
    client.from("members").select("id,name,age,group_name,joined,role").order("name"),
    client.from("events").select("id,title,date,time,location,description").order("date"),
    client.from("attendance").select("event_id,member_id"),
    client.from("attendance_sessions").select("event_id"),
    client.from("contributions").select("id,contributor_name,member_id,event_id,amount,currency,date,method,note").order("date", { ascending: false })
  ]);
  for (const result of [membersResult, eventsResult, attendanceResult, attendanceSessionsResult, contributionsResult]) {
    if (result.error) throw result.error;
  }
  data.members = membersResult.data.map((row) => ({
    id: row.id, name: row.name, age: row.age, group: row.group_name, joined: row.joined, role: row.role
  }));
  data.events = eventsResult.data;
  data.attendance = {};
  for (const row of attendanceResult.data) (data.attendance[row.event_id] ||= []).push(row.member_id);
  data.attendanceRecorded = new Set(attendanceSessionsResult.data.map((row) => row.event_id));
  data.contributions = contributionsResult.data.map((row) => ({
    id: row.id, contributorName: row.contributor_name, memberId: row.member_id,
    eventId: row.event_id, amount: Number(row.amount), currency: row.currency,
    date: row.date, method: row.method, note: row.note
  }));
  renderAll();
}

async function connectWithSession() {
  const config = readConfig();
  if (!config.url || !config.key) {
    showAuth();
    return;
  }
  try {
    client = makeClient(config.url, config.key);
    client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session) {
        currentUser = null;
        showAuth();
      }
    });
    const { data: sessionData, error } = await client.auth.getSession();
    if (error) throw error;
    if (sessionData.session) {
      showApp(sessionData.session);
      try {
        await loadCloudData();
        startSharedSync();
      } catch (loadError) {
        showToast(`Could not load shared records: ${loadError.message}`, true);
      }
    } else {
      showAuth();
    }
  } catch (error) {
    console.error("Could not connect to Supabase:", error);
    showAuth(error.message || "Could not connect to your Supabase project.");
  }
}

async function signOut() {
  if (!client) return;
  const { error } = await client.auth.signOut();
  if (error) {
    showToast(`Could not sign out: ${error.message}`, true);
    return;
  }
  data = { members: [], events: [], attendance: {}, attendanceRecorded: new Set(), contributions: [] };
  showAuth();
}

function stopSharedSync() {
  clearTimeout(realtimeRefreshTimer);
  if (client && realtimeChannel) void client.removeChannel(realtimeChannel);
  realtimeChannel = null;
}

function startSharedSync() {
  stopSharedSync();
  const tables = ["members", "events", "attendance", "attendance_sessions", "contributions"];
  let channel = client.channel("risingstars-community-changes");
  for (const table of tables) {
    channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, () => {
      clearTimeout(realtimeRefreshTimer);
      realtimeRefreshTimer = setTimeout(() => {
        void loadCloudData().catch((error) => {
          console.error("Could not refresh shared records:", error);
          showToast(`Could not refresh shared records: ${error.message}`, true);
        });
      }, 150);
    });
  }
  realtimeChannel = channel.subscribe((status) => {
    const statusText = document.querySelector(".connection-status");
    if (status === "SUBSCRIBED") {
      statusText.innerHTML = "<i></i> Live updates on";
      statusText.classList.remove("sync-warning");
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      statusText.innerHTML = "<i></i> Live sync unavailable";
      statusText.classList.add("sync-warning");
    }
  });
}

function renderAll() {
  document.getElementById("member-nav-count").textContent = data.members.length;
  renderDashboard();
  renderMembers();
  renderEvents();
  renderAttendance();
  renderContributions();
  renderReports();
}

function renderDashboard() {
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const name = currentUser?.user_metadata?.full_name || currentUser?.email?.split("@")[0] || "there";
  document.getElementById("welcome-heading").innerHTML = `${greeting}, ${escapeHtml(name)} <span class="wave">✳</span>`;
  document.getElementById("stat-members").textContent = data.members.length;
  document.getElementById("stat-events").textContent = data.events.filter((event) => event.date.slice(0, 7) === localDate(now).slice(0, 7)).length;
  document.getElementById("stat-attendance").innerHTML = averageAttendance() === null ? "—<small>%</small>" : `${averageAttendance()}<small>%</small>`;
  document.getElementById("stat-volunteers").textContent = data.members.filter((member) => member.role === "Volunteer").length;
  document.getElementById("stat-contributions").textContent = groupMoney(data.contributions);

  const upcoming = sortEvents(data.events.filter((event) => !isPast(event))).slice(0, 3);
  document.getElementById("dashboard-events").innerHTML = upcoming.length ? upcoming.map((event) => `
    <article class="upcoming-item">
      <div class="date-tile"><span>${formatDate(event.date, { month: "short" }).toUpperCase()}</span><strong>${formatDate(event.date, { day: "numeric" })}</strong></div>
      <div class="upcoming-copy"><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(event.time || "Time to be confirmed")} <i>·</i> ${escapeHtml(event.location || "Location to be confirmed")}</span></div>
      <button class="more-button" data-action="event-attendance" data-id="${escapeHtml(event.id)}" title="Take attendance" aria-label="Take attendance for ${escapeHtml(event.title)}">···</button>
    </article>`).join("") : `<div class="inline-empty">No upcoming events yet. Add one to bring everyone together.</div>`;

  const recentMembers = [...data.members].sort((a, b) => b.joined.localeCompare(a.joined)).slice(0, 4);
  document.getElementById("dashboard-members").innerHTML = recentMembers.length ? recentMembers.map((member) => `
    <div class="new-member-row"><span class="avatar ${avatarClass(member.name)}">${escapeHtml(initials(member.name))}</span><span class="member-row-copy"><strong>${escapeHtml(member.name)}</strong><small>${escapeHtml(member.group)}</small></span><span class="joined-label">${formatDate(member.joined)}</span></div>`).join("") : `<div class="inline-empty">Your next great connection is one click away.</div>`;
  renderChart();
}

function renderChart() {
  const events = recordedEvents().slice(0, 6).reverse();
  const chart = document.getElementById("attendance-chart");
  if (!events.length) {
    chart.innerHTML = `<div class="inline-empty">Record attendance to see your group’s participation.</div>`;
    document.getElementById("chart-average").textContent = "Average —";
    return;
  }
  chart.innerHTML = `<div class="bar-chart">${events.map((event) => {
    const rate = percentage(event);
    return `<div class="bar-column"><span class="bar-value">${rate}%</span><div class="bar-track"><div class="bar-fill" style="height:${Math.max(rate, 7)}%"></div></div><span class="bar-label">${formatDate(event.date, { month: "short", day: "numeric" })}</span></div>`;
  }).join("")}</div>`;
  document.getElementById("chart-average").textContent = `Average ${averageAttendance()}%`;
}

function renderMembers() {
  const search = document.getElementById("member-search").value.trim().toLowerCase();
  const filter = document.getElementById("group-filter");
  const previous = filter.value;
  const groups = [...new Set(data.members.map((member) => member.group).filter(Boolean))].sort();
  filter.innerHTML = `<option value="">All groups</option>${groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join("")}`;
  if (groups.includes(previous)) filter.value = previous;
  const members = [...data.members].sort((a, b) => a.name.localeCompare(b.name)).filter((member) =>
    `${member.name} ${member.group} ${member.role}`.toLowerCase().includes(search) && (!filter.value || member.group === filter.value)
  );
  document.getElementById("member-result-count").textContent = `${members.length} ${members.length === 1 ? "member" : "members"}`;
  document.getElementById("members-table").innerHTML = members.map((member) => `
    <tr><td><span class="table-member"><span class="avatar ${avatarClass(member.name)}">${escapeHtml(initials(member.name))}</span><span><strong>${escapeHtml(member.name)}</strong><small>${escapeHtml(member.group)}</small></span></span></td>
    <td><span class="group-pill">${escapeHtml(member.group)}</span></td><td>${escapeHtml(member.age)}</td><td>${formatDate(member.joined, { year: "numeric", month: "short", day: "numeric" })}</td>
    <td><span class="role-pill ${member.role === "Volunteer" ? "role-volunteer" : ""}">${escapeHtml(member.role)}</span></td><td><button class="row-menu" data-action="edit-member" data-id="${escapeHtml(member.id)}" aria-label="Edit ${escapeHtml(member.name)}">···</button></td></tr>`).join("");
  document.getElementById("members-empty").classList.toggle("hidden", members.length > 0);
}

function renderEvents() {
  const events = sortEvents(data.events.filter((event) => eventFilter === "past" ? isPast(event) : !isPast(event)));
  document.getElementById("event-result-count").textContent = `${events.length} ${events.length === 1 ? "event" : "events"}`;
  const container = document.getElementById("events-grid");
  container.innerHTML = events.map((event, index) => `
    <article class="event-card">
      <div class="event-card-art art-${index % 4}"><span class="event-art-icon">${["✦", "☼", "✧", "♡"][index % 4]}</span><span class="event-date-badge">${formatDate(event.date, { month: "short", day: "numeric" })}</span><span class="event-tag">${isPast(event) ? "PAST EVENT" : "UPCOMING"}</span></div>
      <div class="event-card-body"><h2>${escapeHtml(event.title)}</h2><p class="event-description">${escapeHtml(event.description || "A moment to spend time together.")}</p>
        <div class="event-meta"><span>◷ &nbsp;${escapeHtml(event.time || "Time to be confirmed")}</span><span>⌖ &nbsp;${escapeHtml(event.location || "Location to be confirmed")}</span></div>
        <div class="event-card-footer"><span class="attendance-mini"><span>♙</span> ${data.attendanceRecorded.has(event.id) ? `${attendedCount(event)} attending` : "Attendance not taken"}</span><button class="event-menu" data-action="event-attendance" data-id="${escapeHtml(event.id)}">${data.attendanceRecorded.has(event.id) ? "Edit attendance" : "Take attendance"} <span>→</span></button></div>
      </div>
    </article>`).join("");
  if (!events.length) container.innerHTML = `<div class="panel no-events"><span>✦</span><h2>Nothing on the calendar just yet</h2><p>Create your first event and give everyone something to look forward to.</p><button class="button button-primary" data-action="add-event">＋ &nbsp; Create an event</button></div>`;
}

function renderAttendance() {
  const events = recordedEvents();
  const average = averageAttendance();
  document.getElementById("attendance-average").innerHTML = average === null ? "—<small>%</small>" : `${average}<small>%</small>`;
  document.getElementById("attendance-records").textContent = events.length;
  const latest = events[0];
  document.getElementById("attendance-latest").textContent = latest ? latest.title : "—";
  document.getElementById("attendance-latest").title = latest ? latest.title : "";
  document.getElementById("attendance-table").innerHTML = events.map((event) => {
    const rate = percentage(event);
    return `<tr><td><strong>${escapeHtml(event.title)}</strong></td><td>${formatDate(event.date, { year: "numeric", month: "short", day: "numeric" })}</td><td>${attendedCount(event)} <span class="muted-cell">/ ${data.members.length} members</span></td><td><div class="progress-cell"><div class="progress-track"><span style="width:${rate}%"></span></div><strong>${rate}%</strong></div></td><td><button class="row-action" data-action="event-attendance" data-id="${escapeHtml(event.id)}">Edit</button></td></tr>`;
  }).join("");
  document.getElementById("attendance-empty").classList.toggle("hidden", events.length > 0);
}

function renderContributions() {
  const thisMonth = localDate(new Date()).slice(0, 7);
  document.getElementById("contribution-total").textContent = groupMoney(data.contributions);
  document.getElementById("contribution-month").textContent = groupMoney(data.contributions.filter((item) => item.date.slice(0, 7) === thisMonth));
  document.getElementById("contribution-count").textContent = data.contributions.length;
  const search = document.getElementById("contribution-search").value.trim().toLowerCase();
  const items = [...data.contributions].sort((a, b) => b.date.localeCompare(a.date)).filter((item) => {
    const member = data.members.find((candidate) => candidate.id === item.memberId);
    const event = data.events.find((candidate) => candidate.id === item.eventId);
    return `${item.contributorName} ${item.method} ${item.note} ${item.currency} ${member?.name || ""} ${event?.title || ""}`.toLowerCase().includes(search);
  });
  document.getElementById("contribution-result-count").textContent = `${items.length} ${items.length === 1 ? "record" : "records"}`;
  document.getElementById("contributions-table").innerHTML = items.map((item) => {
    const event = data.events.find((candidate) => candidate.id === item.eventId);
    const member = data.members.find((candidate) => candidate.id === item.memberId);
    return `<tr><td><span class="table-member"><span class="avatar ${avatarClass(item.contributorName)}">${escapeHtml(initials(item.contributorName))}</span><span><strong>${escapeHtml(item.contributorName)}</strong><small>${escapeHtml(member?.name || "Community supporter")}${item.note ? ` · ${escapeHtml(item.note)}` : ""}</small></span></span></td><td>${formatDate(item.date, { year: "numeric", month: "short", day: "numeric" })}</td><td>${escapeHtml(event?.title || "General support")}</td><td><span class="role-pill">${escapeHtml(item.method)}</span></td><td class="money-cell">${money(item.amount, item.currency)}</td><td><button class="row-menu" data-action="edit-contribution" data-id="${escapeHtml(item.id)}" aria-label="Edit contribution from ${escapeHtml(item.contributorName)}">···</button></td></tr>`;
  }).join("");
  document.getElementById("contributions-empty").classList.toggle("hidden", items.length > 0);
}

function renderReports() {
  document.getElementById("report-members").textContent = data.members.length;
  document.getElementById("report-events").textContent = data.events.length;
  document.getElementById("report-attendance").innerHTML = averageAttendance() === null ? "—<small>%</small>" : `${averageAttendance()}<small>%</small>`;
  const groups = [...new Set(data.members.map((member) => member.group).filter(Boolean))].sort();
  document.getElementById("report-groups").textContent = groups.length;
  document.getElementById("group-report").innerHTML = groups.length ? groups.map((group) => {
    const count = data.members.filter((member) => member.group === group).length;
    const rate = data.members.length ? Math.round(count / data.members.length * 100) : 0;
    return `<div class="group-report-row"><span class="group-report-name">${escapeHtml(group)}</span><div class="progress-track"><span style="width:${rate}%"></span></div><strong>${count}</strong><small>${rate}%</small></div>`;
  }).join("") : `<div class="inline-empty">Add members to see your community groups here.</div>`;
}

function setPage(page) {
  activePage = page;
  document.querySelectorAll(".page-section").forEach((section) => section.classList.toggle("active", section.id === `page-${page}`));
  document.querySelectorAll(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
  const label = document.querySelector(`.nav-link[data-page="${page}"]`);
  document.getElementById("crumb-page").textContent = label ? label.textContent.trim().replace(/\s+\d+$/, "") : "Overview";
  document.getElementById("sidebar").classList.remove("sidebar-open");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showModal({ title, eyebrow = "LET’S GET STARTED", fields, submitText = "Save changes", onSubmit, deleteAction = null }) {
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-eyebrow").textContent = eyebrow;
  document.getElementById("modal-submit").textContent = submitText;
  modalBody.innerHTML = fields;
  const deleteButton = document.getElementById("modal-delete");
  deleteButton.classList.toggle("hidden", !deleteAction);
  deleteButton.onclick = deleteAction;
  currentModalSubmit = onSubmit;
  backdrop.classList.remove("hidden");
  document.body.classList.add("modal-open");
  const firstInput = modalBody.querySelector("input, select, textarea");
  if (firstInput) setTimeout(() => firstInput.focus(), 50);
}

function closeModal() {
  backdrop.classList.add("hidden");
  document.body.classList.remove("modal-open");
  currentModalSubmit = null;
  form.reset();
  document.getElementById("modal-submit").disabled = false;
}

async function finishWrite(successMessage) {
  await loadCloudData();
  closeModal();
  showToast(successMessage);
}

function openMemberModal(member = null) {
  const editing = Boolean(member);
  showModal({
    title: editing ? "Update member" : "Welcome a new star",
    eyebrow: editing ? "KEEP THEIR DETAILS UP TO DATE" : "THERE’S ALWAYS ROOM FOR ONE MORE",
    submitText: editing ? "Save changes" : "Add member",
    fields: `
      <label class="field-label">Full name<input name="name" type="text" placeholder="e.g. Sam Rivera" value="${escapeHtml(member?.name || "")}" required maxlength="80"></label>
      <div class="field-row"><label class="field-label">Age<input name="age" type="number" min="8" max="25" placeholder="Age" value="${escapeHtml(member?.age || "")}" required></label>
      <label class="field-label">Group<input name="group" type="text" list="group-options" placeholder="e.g. Creative Crew" value="${escapeHtml(member?.group || "")}" required maxlength="50"><datalist id="group-options">${[...new Set(data.members.map((item) => item.group))].map((group) => `<option value="${escapeHtml(group)}"></option>`).join("")}</datalist></label></div>
      <div class="field-row"><label class="field-label">Role<select name="role"><option ${member?.role !== "Volunteer" ? "selected" : ""}>Member</option><option ${member?.role === "Volunteer" ? "selected" : ""}>Volunteer</option></select></label>
      <label class="field-label">Date joined<input name="joined" type="date" value="${escapeHtml(member?.joined || localDate(new Date()))}" required></label></div>`,
    onSubmit: async (values) => {
      const payload = { name: values.get("name").trim(), age: Number(values.get("age")), group_name: values.get("group").trim(), role: values.get("role"), joined: values.get("joined") };
      const result = editing
        ? await client.from("members").update(payload).eq("id", member.id)
        : await client.from("members").insert(payload);
      if (result.error) throw result.error;
      await finishWrite(editing ? "Member details updated." : "A new star joined your community!");
    }
  });
}

function openEventModal() {
  showModal({
    title: "Plan something wonderful",
    eyebrow: "GIVE EVERYONE SOMETHING TO LOOK FORWARD TO",
    submitText: "Create event",
    fields: `
      <label class="field-label">Event name<input name="title" type="text" placeholder="e.g. Friday Night Hangout" required maxlength="100"></label>
      <div class="field-row"><label class="field-label">Date<input name="date" type="date" value="${dateOffset(1)}" required></label><label class="field-label">Start time<input name="time" type="time" value="18:00" required></label></div>
      <label class="field-label">Location<input name="location" type="text" placeholder="Where will you meet?" required maxlength="100"></label>
      <label class="field-label">A few details <span class="optional-label">OPTIONAL</span><textarea name="description" rows="3" placeholder="What should everyone know?"></textarea></label>`,
    onSubmit: async (values) => {
      const [hours, minutes] = values.get("time").split(":").map(Number);
      const date = new Date();
      date.setHours(hours, minutes);
      const payload = {
        title: values.get("title").trim(), date: values.get("date"),
        time: new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(date),
        location: values.get("location").trim(), description: values.get("description").trim()
      };
      const { error } = await client.from("events").insert(payload);
      if (error) throw error;
      await finishWrite("Your event is on the calendar!");
    }
  });
}

function openAttendanceModal(event) {
  if (!event) return;
  const checked = new Set(data.attendance[event.id] || []);
  const members = [...data.members].sort((a, b) => a.name.localeCompare(b.name));
  showModal({
    title: "Who made it?",
    eyebrow: `${event.title.toUpperCase()} · ${formatDate(event.date, { month: "short", day: "numeric" }).toUpperCase()}`,
    submitText: "Save attendance",
    fields: `<div class="attendance-form-top"><span>Select everyone who attended.</span><button type="button" class="select-all-button" id="select-all-members">${checked.size === members.length ? "Clear all" : "Select all"}</button></div>
      <div class="attendance-check-list">${members.map((member) => `<label class="attendance-check"><input type="checkbox" name="attendees" value="${escapeHtml(member.id)}" ${checked.has(member.id) ? "checked" : ""}><span class="avatar ${avatarClass(member.name)}">${escapeHtml(initials(member.name))}</span><span><strong>${escapeHtml(member.name)}</strong><small>${escapeHtml(member.group)}</small></span><span class="custom-check">✓</span></label>`).join("")}</div>
      ${members.length ? "" : `<div class="inline-empty">Add members before recording attendance.</div>`}`,
    onSubmit: async (values) => {
      const { error } = await client.rpc("replace_event_attendance", {
        p_event_id: event.id, p_member_ids: values.getAll("attendees")
      });
      if (error) throw error;
      await finishWrite(`Attendance saved for ${event.title}.`);
    }
  });
  document.getElementById("select-all-members").addEventListener("click", () => {
    const checkboxes = [...modalBody.querySelectorAll('input[name="attendees"]')];
    const shouldCheck = checkboxes.some((checkbox) => !checkbox.checked);
    checkboxes.forEach((checkbox) => { checkbox.checked = shouldCheck; });
    document.getElementById("select-all-members").textContent = shouldCheck ? "Clear all" : "Select all";
  });
}

function beginAttendance() {
  const events = sortEvents(data.events);
  if (!events.length) return showToast("Create an event before recording attendance.", true);
  showModal({
    title: "Choose an event",
    eyebrow: "LET’S CELEBRATE WHO SHOWED UP",
    submitText: "Continue",
    fields: `<label class="field-label">Event<select name="eventId" required>${events.map((event) => `<option value="${escapeHtml(event.id)}">${escapeHtml(event.title)} · ${formatDate(event.date, { month: "short", day: "numeric" })}</option>`).join("")}</select></label>`,
    onSubmit: async (values) => {
      const event = data.events.find((item) => item.id === values.get("eventId"));
      closeModal();
      openAttendanceModal(event);
    }
  });
}

function openContributionModal(contribution = null) {
  const editing = Boolean(contribution);
  const memberOptions = data.members.map((member) => `<option value="${escapeHtml(member.id)}" ${contribution?.memberId === member.id ? "selected" : ""}>${escapeHtml(member.name)}</option>`).join("");
  const eventOptions = data.events.map((event) => `<option value="${escapeHtml(event.id)}" ${contribution?.eventId === event.id ? "selected" : ""}>${escapeHtml(event.title)}</option>`).join("");
  showModal({
    title: editing ? "Update contribution" : "Record a contribution",
    eyebrow: "PRIVATE BOOKKEEPING · NO PAYMENTS PROCESSED",
    submitText: editing ? "Save changes" : "Save contribution",
    fields: `
      <label class="field-label">Contributor name<input name="contributorName" type="text" placeholder="Name or organization" value="${escapeHtml(contribution?.contributorName || "")}" required maxlength="100"></label>
      <div class="field-row"><label class="field-label">Amount<input name="amount" type="number" min="0.01" max="9999999999" step="0.01" placeholder="0.00" value="${escapeHtml(contribution?.amount ?? "")}" required></label>
      <label class="field-label">Currency<select name="currency" required>${CURRENCIES.map((currency) => `<option ${contribution?.currency === currency || (!contribution && currency === "USD") ? "selected" : ""}>${currency}</option>`).join("")}</select></label></div>
      <div class="field-row"><label class="field-label">Date received<input name="date" type="date" value="${escapeHtml(contribution?.date || localDate(new Date()))}" required></label>
      <label class="field-label">Method<select name="method" required>${["Cash", "Bank transfer", "Mobile payment", "In kind", "Other"].map((method) => `<option ${contribution?.method === method || (!contribution && method === "Cash") ? "selected" : ""}>${method}</option>`).join("")}</select></label></div>
      <div class="field-row"><label class="field-label">Link to member <span class="optional-label">OPTIONAL</span><select name="memberId"><option value="">Not linked</option>${memberOptions}</select></label>
      <label class="field-label">For an event <span class="optional-label">OPTIONAL</span><select name="eventId"><option value="">General support</option>${eventOptions}</select></label></div>
      <label class="field-label">Note <span class="optional-label">OPTIONAL · NO SENSITIVE PAYMENT DETAILS</span><input name="note" type="text" placeholder="Short bookkeeping note" value="${escapeHtml(contribution?.note || "")}" maxlength="250"></label>`,
    deleteAction: editing ? async () => {
      try {
        if (!window.confirm(`Delete the contribution record from ${contribution.contributorName}?`)) return;
        const { error } = await client.from("contributions").delete().eq("id", contribution.id);
        if (error) throw error;
        await finishWrite("Contribution record deleted.");
      } catch (error) {
        console.error("Could not delete contribution:", error);
        showToast(`Could not delete contribution: ${error.message || "Check your connection and try again."}`, true);
      }
    } : null,
    onSubmit: async (values) => {
      const payload = {
        contributor_name: values.get("contributorName").trim(),
        amount: Number(values.get("amount")),
        currency: values.get("currency"),
        date: values.get("date"),
        method: values.get("method"),
        member_id: values.get("memberId") || null,
        event_id: values.get("eventId") || null,
        note: values.get("note").trim()
      };
      const result = editing
        ? await client.from("contributions").update(payload).eq("id", contribution.id)
        : await client.from("contributions").insert(payload);
      if (result.error) throw result.error;
      await finishWrite(editing ? "Contribution updated." : "Contribution recorded.");
    }
  });
}

function exportMembers() {
  const rows = [["Name", "Age", "Group", "Role", "Date joined"], ...data.members.map((member) => [member.name, member.age, member.group, member.role, member.joined])];
  downloadCsv(rows, "risingstars-members.csv");
}

function exportContributions() {
  const rows = [["Contributor", "Amount", "Currency", "Date", "Method", "Member", "Event", "Note"], ...data.contributions.map((item) => [
    item.contributorName, item.amount, item.currency, item.date, item.method,
    data.members.find((member) => member.id === item.memberId)?.name || "",
    data.events.find((event) => event.id === item.eventId)?.title || "", item.note
  ])];
  downloadCsv(rows, "risingstars-contributions.csv");
}

function downloadCsv(rows, filename) {
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

document.getElementById("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.getElementById("auth-submit");
  const errorBox = document.getElementById("auth-error");
  errorBox.classList.add("hidden");
  button.disabled = true;
  button.textContent = "Connecting…";
  try {
    const url = document.getElementById("supabase-url").value.trim();
    const key = document.getElementById("supabase-key").value.trim();
    client = makeClient(url, key);
    const { error: configError } = (() => {
      try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify({ url, key }));
        return { error: null };
      } catch (error) {
        return { error };
      }
    })();
    if (configError) throw new Error(`Could not save this browser's project settings: ${configError.message}`);
    const { data: authData, error } = await client.auth.signInWithPassword({
      email: document.getElementById("auth-email").value.trim(),
      password: document.getElementById("auth-password").value
    });
    if (error) throw error;
    client.auth.onAuthStateChange((authEvent, session) => {
      if (authEvent === "SIGNED_OUT" || !session) {
        setTimeout(stopSharedSync, 0);
        currentUser = null;
        showAuth();
      }
    });
    showApp(authData.session);
    await loadCloudData();
    startSharedSync();
  } catch (error) {
    console.error("Sign-in failed:", error);
    setAuthError(error.message || "Could not sign in. Check your project details and account.");
  } finally {
    button.disabled = false;
    button.textContent = "Connect & sign in";
  }
});

document.querySelectorAll(".nav-link").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
document.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]");
  if (action) {
    try {
      if (action.dataset.action === "add-member") openMemberModal();
      if (action.dataset.action === "add-event") openEventModal();
      if (action.dataset.action === "add-contribution") openContributionModal();
      if (action.dataset.action === "record-attendance") beginAttendance();
      if (action.dataset.action === "event-attendance") openAttendanceModal(data.events.find((item) => item.id === action.dataset.id));
      if (action.dataset.action === "edit-member") {
        const member = data.members.find((item) => item.id === action.dataset.id);
        if (member) openMemberModal(member);
      }
      if (action.dataset.action === "edit-contribution") {
        const contribution = data.contributions.find((item) => item.id === action.dataset.id);
        if (contribution) openContributionModal(contribution);
      }
    } catch (error) {
      console.error("Could not open action:", error);
      showToast(error.message || "Something went wrong.", true);
    }
  }
  const pageLink = event.target.closest("[data-page-link]");
  if (pageLink) setPage(pageLink.dataset.pageLink);
});

document.querySelectorAll("[data-event-filter]").forEach((button) => button.addEventListener("click", () => {
  eventFilter = button.dataset.eventFilter;
  document.querySelectorAll("[data-event-filter]").forEach((tab) => tab.classList.toggle("selected", tab === button));
  renderEvents();
}));
document.getElementById("member-search").addEventListener("input", renderMembers);
document.getElementById("group-filter").addEventListener("change", renderMembers);
document.getElementById("contribution-search").addEventListener("input", renderContributions);
document.getElementById("export-report").addEventListener("click", exportMembers);
document.getElementById("export-contributions").addEventListener("click", exportContributions);
document.getElementById("profile-button").addEventListener("click", () => void signOut());
document.getElementById("top-avatar").addEventListener("click", () => void signOut());
document.getElementById("refresh-data").addEventListener("click", async () => {
  try {
    await loadCloudData();
    if (!realtimeChannel) startSharedSync();
    showToast("Shared records refreshed.");
  } catch (error) {
    showToast(`Could not refresh records: ${error.message}`, true);
  }
});
document.getElementById("modal-close").addEventListener("click", () => closeModal());
document.getElementById("modal-cancel").addEventListener("click", () => closeModal());
backdrop.addEventListener("click", (event) => { if (event.target === backdrop) closeModal(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !backdrop.classList.contains("hidden")) closeModal(); });
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity() || !currentModalSubmit) return;
  const button = document.getElementById("modal-submit");
  button.disabled = true;
  try {
    await currentModalSubmit(new FormData(form));
  } catch (error) {
    console.error("Could not save record:", error);
    showToast(`Could not save: ${error.message || "Check your connection and try again."}`, true);
  } finally {
    button.disabled = false;
  }
});
document.getElementById("mobile-menu").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("sidebar-open"));
document.getElementById("today-label").textContent = new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric" }).format(new Date());
const savedConfig = readConfig();
document.getElementById("supabase-url").value = savedConfig.url || "";
document.getElementById("supabase-key").value = savedConfig.key || "";
connectWithSession();
