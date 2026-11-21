const clubDetails = {
    robotics: { name: "Robotics Club", icon: "🤖", iconClass: "mini-robot", next: "Next meetup · Wed, Mar 17" },
    art: { name: "Art & Design Studio", icon: "🎨", iconClass: "mini-art", next: "Next meetup · Fri, Mar 19" },
    green: { name: "Green Team", icon: "🌱", iconClass: "mini-green", next: "Next meetup · Tue, Mar 16" },
    coding: { name: "Coding Collective", icon: "💻", iconClass: "mini-coding", next: "Next meetup · Mon, Mar 15" }
};

const defaultState = {
    points: 1240,
    clubs: ["robotics", "art"],
    checkInDate: "",
    streak: 8
};

function loadState() {
    try {
        const saved = JSON.parse(localStorage.getItem("northstar-student-life") || "null");
        if (!saved || typeof saved !== "object") return { ...defaultState, clubs: [...defaultState.clubs] };
        return {
            points: Number.isFinite(saved.points) ? saved.points : defaultState.points,
            clubs: Array.isArray(saved.clubs) ? saved.clubs.filter((id) => clubDetails[id]) : [...defaultState.clubs],
            checkInDate: typeof saved.checkInDate === "string" ? saved.checkInDate : "",
            streak: Number.isFinite(saved.streak) ? saved.streak : defaultState.streak
        };
    } catch (error) {
        return { ...defaultState, clubs: [...defaultState.clubs] };
    }
}

let state = loadState();
let toastTimer;

function saveState() {
    try {
        localStorage.setItem("northstar-student-life", JSON.stringify(state));
    } catch (error) {
        showToast("Your browser couldn’t save this update. It will last until you close this tab.");
    }
}

function showToast(message) {
    const toast = document.querySelector("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2800);
}

function renderActivities() {
    const list = document.querySelector("#my-clubs-list");
    if (list) list.replaceChildren();

    state.clubs.forEach((id) => {
        const club = clubDetails[id];
        if (!list) return;
        const row = document.createElement("div");
        row.className = "my-club-row";
        const icon = document.createElement("span");
        icon.className = `mini-club-icon ${club.iconClass}`;
        icon.textContent = club.icon;
        const details = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = club.name;
        const next = document.createElement("span");
        next.textContent = club.next;
        details.append(name, next);
        const status = document.createElement("span");
        status.className = "activity-status";
        status.textContent = "Active";
        row.append(icon, details, status);
        list.append(row);
    });

    const count = state.clubs.length;
    const clubCount = document.querySelector("#club-count");
    const activityCount = document.querySelector("#activity-count");
    if (clubCount) clubCount.textContent = count;
    if (activityCount) {
        activityCount.textContent = `${count} active`;
        activityCount.hidden = count === 0;
    }
    if (list && count === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "You haven’t joined a club yet. Explore clubs to find your people.";
        list.append(empty);
    }
}

function renderState() {
    const points = document.querySelector("#points-total");
    const streak = document.querySelector("#streak-count");
    if (points) points.textContent = state.points.toLocaleString();
    if (streak) streak.textContent = state.streak;
    document.querySelectorAll(".join-button").forEach((button) => {
        const joined = state.clubs.includes(button.dataset.club);
        button.classList.toggle("joined", joined);
        button.innerHTML = joined ? "Joined ✓" : 'Join club <span>＋</span>';
        button.setAttribute("aria-pressed", String(joined));
    });
    renderActivities();

    const checkedIn = state.checkInDate === new Date().toLocaleDateString("en-CA");
    const checkInButton = document.querySelector("#checkin-button");
    if (!checkInButton) return;
    checkInButton.disabled = checkedIn;
    checkInButton.innerHTML = checkedIn ? "Checked in ✓" : 'Check in <span>→</span>';
    document.querySelector("#checkin-title").textContent = checkedIn ? "You’re all checked in!" : "Start your day strong";
    document.querySelector("#checkin-copy").textContent = checkedIn
        ? "Today’s attendance is looking good."
        : "Check in to keep your attendance streak going.";
}

document.querySelectorAll(".join-button").forEach((button) => {
    button.addEventListener("click", () => {
        const clubId = button.dataset.club;
        const club = clubDetails[clubId];
        if (state.clubs.includes(clubId)) {
            state.clubs = state.clubs.filter((id) => id !== clubId);
            showToast(`You’ve left ${club.name}. You can rejoin any time.`);
        } else {
            state.clubs.push(clubId);
            state.points += 25;
            showToast(`You joined ${club.name}! +25 points`);
        }
        saveState();
        renderState();
        updateClubVisibility();
    });
});

document.querySelectorAll(".filter-tab[data-filter]").forEach((tab) => {
    tab.addEventListener("click", () => {
        document.querySelector(".filter-tab.active")?.classList.remove("active");
        tab.classList.add("active");
        updateClubVisibility();
    });
});

function updateClubVisibility() {
    const activeTab = document.querySelector(".filter-tab[data-filter].active");
    const search = document.querySelector("#club-search");
    if (!activeTab || !search) return;
    const filter = activeTab.dataset.filter;
    const query = search.value.trim().toLowerCase();
    let visibleCount = 0;
    document.querySelectorAll(".club-card").forEach((card) => {
        const matchesCategory = filter === "all" || card.dataset.category === filter;
        const matchesQuery = card.dataset.name.includes(query);
        const visible = matchesCategory && matchesQuery;
        card.hidden = !visible;
        if (visible) visibleCount += 1;
    });
    const emptyState = document.querySelector("#empty-clubs");
    if (emptyState) emptyState.hidden = visibleCount > 0;
}

const clubSearch = document.querySelector("#club-search");
if (clubSearch) clubSearch.addEventListener("input", updateClubVisibility);

const checkInButton = document.querySelector("#checkin-button");
if (checkInButton) {
    checkInButton.addEventListener("click", () => {
        state.checkInDate = new Date().toLocaleDateString("en-CA");
        state.points += 10;
        state.streak += 1;
        saveState();
        renderState();
        showToast("You checked in! +10 points. Keep that streak alive.");
    });
}

document.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", () => {
        document.querySelector(".nav-link.active")?.classList.remove("active");
        link.classList.add("active");
    });
});

renderState();
updateClubVisibility();