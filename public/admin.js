const adminStatus = document.querySelector("#admin-status");
const adminRows = document.querySelector("#admin-users");
const adminSearchForm = document.querySelector("#admin-search-form");
const adminSearch = document.querySelector("#admin-search");
const adminPageLabel = document.querySelector("#admin-page-label");
const adminPrev = document.querySelector("#admin-prev");
const adminNext = document.querySelector("#admin-next");
let adminPage = 1;
let adminPageCount = 1;

function formatAdminDate(value) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function addAdminCell(row, value) {
    const cell = document.createElement("td");
    cell.textContent = String(value);
    row.append(cell);
}

function renderAdminUsers(users) {
    adminRows.replaceChildren();
    if (users.length === 0) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.className = "admin-empty";
        cell.colSpan = 8;
        cell.textContent = "No accounts match your search.";
        row.append(cell);
        adminRows.append(row);
        return;
    }

    users.forEach((user) => {
        const row = document.createElement("tr");
        const person = document.createElement("td");
        const name = document.createElement("span");
        name.className = "admin-person-name";
        name.textContent = user.name;
        const email = document.createElement("span");
        email.className = "admin-person-email";
        email.textContent = user.email;
        person.append(name, email);
        row.append(person);

        const role = document.createElement("td");
        const roleBadge = document.createElement("span");
        roleBadge.className = "admin-role";
        roleBadge.textContent = user.role.replaceAll("-", " ");
        role.append(roleBadge);
        row.append(role);

        const statusCell = document.createElement("td");
        const statusBadge = document.createElement("span");
        statusBadge.className = "admin-account-status";
        statusBadge.dataset.active = String(user.isActive);
        statusBadge.textContent = user.isActive ? "Active" : "Inactive";
        statusCell.append(statusBadge);
        row.append(statusCell);

        addAdminCell(row, formatAdminDate(user.createdAt));
        addAdminCell(row, user.points);
        addAdminCell(row, user.counts.memberships);
        addAdminCell(row, user.counts.registrations);
        addAdminCell(row, user.counts.attendance);
        adminRows.append(row);
    });
}

async function loadAdminOverview() {
    adminStatus.textContent = "Loading accounts…";
    adminStatus.dataset.error = "false";
    const params = new URLSearchParams({
        page: String(adminPage),
        limit: "25",
    });
    if (adminSearch.value.trim()) params.set("search", adminSearch.value.trim());

    try {
        const response = await fetch(`/api/admin/overview?${params}`, {
            credentials: "include",
            headers: { "Accept": "application/json" },
        });
        if (response.status === 401) {
            window.location.replace("login.html");
            return;
        }
        if (response.status === 403) throw new Error("You don’t have administrator permission.");
        if (!response.ok) throw new Error("The administrator overview could not be loaded.");
        const payload = await response.json();

        const summaryTargets = {
            "total-users": payload.summary.totalUsers,
            "active-students": payload.summary.activeStudents,
            "active-accounts": payload.summary.activeAccounts,
            "new-users": payload.summary.newUsersLast30Days,
            "attendance-total": payload.summary.totalAttendance,
            "membership-total": payload.summary.activeMemberships,
        };
        Object.entries(summaryTargets).forEach(([id, value]) => {
            document.querySelector(`#${id}`).textContent = Number(value).toLocaleString();
        });

        renderAdminUsers(payload.users);
        adminPageCount = Math.max(payload.pagination.pages, 1);
        adminPageLabel.textContent = `Page ${adminPage} of ${adminPageCount} · ${payload.pagination.total.toLocaleString()} people`;
        adminPrev.disabled = adminPage <= 1;
        adminNext.disabled = adminPage >= adminPageCount;
        adminStatus.textContent = payload.pagination.total === 0
            ? "No accounts found."
            : `Showing ${payload.users.length} of ${payload.pagination.total.toLocaleString()} matching accounts.`;
    } catch (error) {
        console.error("Could not load administrator overview.", error);
        adminRows.replaceChildren();
        adminStatus.dataset.error = "true";
        adminStatus.textContent = error instanceof Error ? error.message : "The administrator overview could not be loaded.";
    }
}

adminSearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    adminPage = 1;
    void loadAdminOverview();
});
adminPrev.addEventListener("click", () => {
    if (adminPage > 1) {
        adminPage -= 1;
        void loadAdminOverview();
    }
});
adminNext.addEventListener("click", () => {
    if (adminPage < adminPageCount) {
        adminPage += 1;
        void loadAdminOverview();
    }
});
document.querySelector("#refresh-admin").addEventListener("click", () => void loadAdminOverview());
window.addEventListener("northstar:session-ready", (event) => {
    if (event.detail.role === "admin") void loadAdminOverview();
});
