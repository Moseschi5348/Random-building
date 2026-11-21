const state = {
    user: null,
    clubs: [],
    activities: [],
    search: ""
};

let toastTimer;

async function api(path, options = {}) {
    const method = options.method || "GET";
    const headers = new Headers({ Accept: "application/json" });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        headers.set("X-CSRF-Token", window.northstarCsrfToken || "");
    }

    const response = await fetch(`/api${path}`, {
        ...options,
        method,
        credentials: "include",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) {
        throw new Error(data?.error || `Request failed (${response.status}).`);
    }
    return data;
}

function showToast(message) {
    const toast = document.querySelector("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3200);
}

function formatDate(value, options) {
    return new Intl.DateTimeFormat(undefined, options).format(new Date(value));
}

function categoryFor(club) {
    const text = `${club.name} ${club.description}`.toLowerCase();
    if (/art|design|music|theatre|creative|paint|photo/.test(text)) return "creative";
    if (/robot|code|stem|science|math|technology|engineering|chess/.test(text)) return "stem";
    return "community";
}

function categoryDetails(category) {
    if (category === "stem") return { name: "STEM", pill: "pill-stem", art: "robotics-art", icon: "⚙" };
    if (category === "creative") return { name: "CREATIVE", pill: "pill-creative", art: "art-art", icon: "✦" };
    return { name: "COMMUNITY", pill: "pill-community", art: "green-art", icon: "◈" };
}

function membershipFor(clubId) {
    return state.user.memberships.find((membership) => membership.club.id === clubId);
}

function setBusy(button, busy) {
    button.disabled = busy;
    if (busy) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
}

function createClubCard(club) {
    const category = categoryFor(club);
    const details = categoryDetails(category);
    const membership = membershipFor(club.id);
    const card = document.createElement("article");
    card.className = "club-card";
    card.dataset.category = category;
    card.dataset.name = `${club.name} ${club.description}`.toLowerCase();

    const art = document.createElement("div");
    art.className = `club-art ${details.art}`;
    const symbol = document.createElement("span");
    symbol.textContent = details.icon;
    const sparkle = document.createElement("span");
    sparkle.className = "art-spark";
    sparkle.textContent = "✦";
    art.append(symbol, sparkle);

    const content = document.createElement("div");
    content.className = "club-card-content";
    const meta = document.createElement("div");
    meta.className = "club-meta";
    const categoryPill = document.createElement("span");
    categoryPill.className = `category-pill ${details.pill}`;
    categoryPill.textContent = details.name;
    const memberCount = document.createElement("span");
    memberCount.className = "member-count";
    memberCount.textContent = `◉ ${club._count.memberships} members`;
    meta.append(categoryPill, memberCount);

    const name = document.createElement("h3");
    name.textContent = club.name;
    const description = document.createElement("p");
    description.textContent = club.description;
    const bottom = document.createElement("div");
    bottom.className = "club-card-bottom";
    const fee = document.createElement("span");
    fee.textContent = club.membershipFeeCents === 0
        ? "Free membership"
        : `${new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(club.membershipFeeCents / 100)} membership`;

    const joinButton = document.createElement("button");
    joinButton.type = "button";
    joinButton.className = "join-button";
    if (membership?.status === "ACTIVE" || membership?.status === "PENDING") {
        joinButton.classList.add("joined");
        joinButton.disabled = true;
        joinButton.textContent = membership.status === "PENDING" ? "Payment pending" : "Joined ✓";
    } else {
        joinButton.textContent = "Join club ＋";
        joinButton.addEventListener("click", () => joinClub(club.id, joinButton));
    }
    bottom.append(fee, joinButton);
    content.append(meta, name, description, bottom);
    card.append(art, content);
    return card;
}

function renderClubs() {
    const grid = document.querySelector("#club-grid");
    grid.replaceChildren();
    if (state.clubs.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "There are no clubs to display.";
        grid.append(empty);
        document.querySelector("#empty-clubs").hidden = true;
        return;
    }
    state.clubs.forEach((club) => grid.append(createClubCard(club)));
    updateClubVisibility();
}

async function joinClub(clubId, button) {
    setBusy(button, true);
    try {
        const result = await api(`/clubs/${encodeURIComponent(clubId)}/join`, { method: "POST" });
        if (result.checkoutUrl) {
            window.location.assign(result.checkoutUrl);
            return;
        }
        await loadDashboard();
        showToast("You joined the club.");
    } catch (error) {
        showToast(error.message || "Could not join this club.");
        setBusy(button, false);
    }
}

function createEventCard(activity, index) {
    const row = document.createElement("div");
    row.className = "event-card";
    const dateBox = document.createElement("div");
    dateBox.className = `event-date${index % 2 ? " date-blue" : ""}`;
    const day = document.createElement("strong");
    day.textContent = formatDate(activity.startsAt, { day: "2-digit" });
    const month = document.createElement("span");
    month.textContent = formatDate(activity.startsAt, { month: "short" }).toUpperCase();
    dateBox.append(day, month);

    const info = document.createElement("div");
    info.className = "event-info";
    const title = document.createElement("strong");
    title.textContent = activity.title;
    const clubName = document.createElement("span");
    clubName.textContent = activity.club.name;
    const time = document.createElement("span");
    time.textContent = formatDate(activity.startsAt, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit"
    });
    info.append(title, clubName, time);

    const registered = state.user.registrations.find((item) => item.activity.id === activity.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "activity-register-button";
    if (registered?.status === "CONFIRMED" || registered?.status === "PENDING") {
        button.disabled = true;
        button.textContent = registered.status === "PENDING" ? "Pending" : "Registered";
    } else {
        button.textContent = "Register";
        button.addEventListener("click", () => registerForActivity(activity.id, button));
    }
    row.append(dateBox, info, button);
    return row;
}

function renderActivities() {
    const upcoming = document.querySelector("#upcoming-list");
    upcoming.replaceChildren();
    const nextActivities = state.activities.slice(0, 2);
    if (nextActivities.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "No upcoming activities.";
        upcoming.append(empty);
    } else {
        nextActivities.forEach((activity, index) => {
            upcoming.append(createEventCard(activity, index));
        });
    }

    const list = document.querySelector("#my-clubs-list");
    list.replaceChildren();
    const activeMemberships = state.user.memberships.filter((item) => item.status !== "CANCELLED");
    const registrations = state.user.registrations.filter((item) =>
        item.status === "CONFIRMED" || item.status === "PENDING"
    );
    document.querySelector("#activity-count").textContent =
        `${activeMemberships.length + registrations.length} active`;

    activeMemberships.forEach((membership) => {
        const row = document.createElement("div");
        row.className = "my-club-row";
        const icon = document.createElement("span");
        icon.className = "mini-club-icon mini-robot";
        icon.textContent = "◈";
        const details = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = membership.club.name;
        const subtitle = document.createElement("span");
        subtitle.textContent = "Club membership";
        details.append(title, subtitle);
        const status = document.createElement("span");
        status.className = "activity-status";
        status.textContent = membership.status === "PENDING" ? "Payment pending" : "Member";
        row.append(icon, details, status);
        list.append(row);
    });

    registrations.forEach((registration) => {
        const row = document.createElement("div");
        row.className = "my-club-row";
        const icon = document.createElement("span");
        icon.className = "mini-club-icon mini-coding";
        icon.textContent = "◷";
        const details = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = registration.activity.title;
        const subtitle = document.createElement("span");
        subtitle.textContent = `${registration.activity.club.name} · ${formatDate(registration.activity.startsAt, {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit"
        })}`;
        details.append(title, subtitle);
        const status = document.createElement("span");
        status.className = "activity-status";
        status.textContent = registration.status === "PENDING" ? "Payment pending" : "Registered";
        row.append(icon, details, status);
        list.append(row);
    });

    if (activeMemberships.length + registrations.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "You have not joined a club or registered for an activity yet.";
        list.append(empty);
    }
}

async function registerForActivity(activityId, button) {
    setBusy(button, true);
    try {
        const result = await api(`/activities/${encodeURIComponent(activityId)}/register`, {
            method: "POST"
        });
        if (result.checkoutUrl) {
            window.location.assign(result.checkoutUrl);
            return;
        }
        await loadDashboard();
        showToast("You are registered for this activity.");
    } catch (error) {
        showToast(error.message || "Could not register for this activity.");
        setBusy(button, false);
    }
}

function renderRewards() {
    const attendanceCount = state.user._count.attendance;
    const badges = state.user.badges;
    const earned = new Set(badges.map((badge) => badge.key));
    const remaining = Math.max(0, 10 - attendanceCount);
    document.querySelector("#next-badge-title").textContent =
        earned.has("PARTICIPATION_10") ? "Participation earned" : "Participation";
    document.querySelector("#next-badge-copy").textContent =
        earned.has("PARTICIPATION_10")
            ? "Keep showing up to earn more rewards."
            : `${remaining} more ${remaining === 1 ? "attendance" : "attendances"} to earn this badge.`;
    document.querySelector("#progress-count").textContent = String(Math.min(attendanceCount, 10));
    document.querySelector("#progress-total").textContent = "/ 10";
    document.querySelector("#reward-progress").setAttribute(
        "aria-label",
        `Participation badge progress: ${Math.min(attendanceCount, 10)} of 10 attendances`
    );

    const labels = {
        PARTICIPATION_10: { name: "Participation", icon: "★", style: "badge-star" },
        PUNCTUALITY_5: { name: "Punctuality", icon: "☀", style: "badge-sun" },
        GOOD_CONDUCT_5: { name: "Good conduct", icon: "♥", style: "badge-heart" }
    };
    const row = document.querySelector("#badges-row");
    row.replaceChildren();
    if (badges.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "Attend activities to earn your first badge.";
        row.append(empty);
        return;
    }
    badges.forEach((badge) => {
        const info = labels[badge.key] || { name: badge.key, icon: "✦", style: "" };
        const item = document.createElement("div");
        item.className = "badge-item";
        const icon = document.createElement("span");
        icon.className = `badge-icon ${info.style}`;
        icon.textContent = info.icon;
        const name = document.createElement("span");
        name.textContent = info.name;
        item.append(icon, name);
        row.append(item);
    });
}

function renderDashboard() {
    document.querySelector("#points-total").textContent = state.user.points.toLocaleString();
    const attendanceCount = state.user._count.attendance;
    document.querySelector("#attendance-count").textContent = String(attendanceCount);
    document.querySelector("#attendance-summary-count").textContent = String(attendanceCount);
    document.querySelector("#club-count").textContent = String(
        state.user.memberships.filter((membership) => membership.status === "ACTIVE").length
    );
    document.querySelector("#badge-count").textContent = String(state.user.badges.length);
    renderClubs();
    renderActivities();
    renderRewards();
}

function updateClubVisibility() {
    const filter = document.querySelector(".filter-tab.active")?.dataset.filter || "all";
    let visibleCount = 0;
    document.querySelectorAll(".club-card").forEach((card) => {
        const matchesFilter = filter === "all" || card.dataset.category === filter;
        const matchesSearch = card.dataset.name.includes(state.search);
        card.hidden = !matchesFilter || !matchesSearch;
        if (!card.hidden) visibleCount += 1;
    });
    document.querySelector("#empty-clubs").hidden = visibleCount > 0;
}

async function loadDashboard() {
    const [user, clubs] = await Promise.all([api("/me"), api("/clubs")]);
    const activitiesByClub = await Promise.all(clubs.map((club) =>
        api(`/clubs/${encodeURIComponent(club.id)}/activities`)
    ));
    state.user = user;
    state.clubs = clubs;
    state.activities = activitiesByClub.flat()
        .map((activity) => ({
            ...activity,
            club: clubs.find((club) => club.id === activity.clubId)
        }))
        .filter((activity) => activity.club && new Date(activity.startsAt) > new Date())
        .sort((left, right) => new Date(left.startsAt) - new Date(right.startsAt));
    renderDashboard();
}

document.querySelectorAll(".filter-tab[data-filter]").forEach((tab) => {
    tab.addEventListener("click", () => {
        document.querySelector(".filter-tab.active")?.classList.remove("active");
        tab.classList.add("active");
        updateClubVisibility();
    });
});

document.querySelector("#club-search").addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    updateClubVisibility();
});

document.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", () => {
        document.querySelector(".nav-link.active")?.classList.remove("active");
        link.classList.add("active");
    });
});

window.addEventListener("northstar:session-ready", () => {
    loadDashboard().catch((error) => {
        showToast(error.message || "Could not load student life data.");
    });
}, { once: true });

const paymentStatus = new URLSearchParams(window.location.search).get("payment");
if (paymentStatus === "success") {
    showToast("Payment submitted. Your registration will update after Stripe confirms it.");
    window.history.replaceState({}, "", window.location.pathname);
} else if (paymentStatus === "cancel") {
    showToast("Payment was cancelled. Your registration remains pending.");
    window.history.replaceState({}, "", window.location.pathname);
}
