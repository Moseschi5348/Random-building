const loginError = document.querySelector("#login-error");
if (loginError && new URLSearchParams(window.location.search).has("error")) {
    loginError.hidden = false;
    loginError.textContent = "Google sign-in could not be completed. Please try again.";
}

async function loadNotices() {
    const list = document.querySelector("#notice-list");
    if (!list) return true;
    try {
        const response = await fetch("/api/student-life/notices", {
            credentials: "include",
            headers: { "Accept": "application/json" }
        });

        if (response.status === 401) {
            window.location.replace("login.html");
            return false;
        }
        if (!response.ok) throw new Error(`Notice request failed with status ${response.status}`);

        const payload = await response.json();
        if (!Array.isArray(payload.notices)) throw new Error("The notice response was invalid.");

        const priority = { emergency: 0, important: 1, general: 2 };
        const notices = [...payload.notices].sort((a, b) => priority[a.level] - priority[b.level]);
        if (notices.some((notice) =>
            !notice ||
            !Object.prototype.hasOwnProperty.call(priority, notice.level) ||
            typeof notice.title !== "string" ||
            typeof notice.message !== "string"
        )) {
            throw new Error("The notice response contained an invalid item.");
        }

        list.replaceChildren();
        if (notices.length === 0) {
            const empty = document.createElement("div");
            empty.className = "notice-clear";
            empty.setAttribute("role", "status");
            const icon = document.createElement("span");
            icon.className = "notice-clear-icon";
            icon.textContent = "✓";
            const copy = document.createElement("div");
            const title = document.createElement("strong");
            title.textContent = "No active emergency notices";
            const description = document.createElement("span");
            description.textContent = "There are no current notices from the school.";
            copy.append(title, description);
            empty.append(icon, copy);
            list.append(empty);
            return true;
        }

        notices.forEach((notice) => {
            const item = document.createElement("article");
            item.className = `notice-item notice-${notice.level}`;
            item.setAttribute("role", notice.level === "emergency" ? "alert" : "status");
            const icon = document.createElement("span");
            icon.className = "notice-item-icon";
            icon.textContent = notice.level === "general" ? "i" : "!";
            const copy = document.createElement("div");
            const label = document.createElement("span");
            label.className = "notice-label";
            label.textContent = `${notice.level.toUpperCase()} · ${notice.title}`;
            const message = document.createElement("p");
            message.textContent = notice.message;
            copy.append(label, message);
            item.append(icon, copy);
            list.append(item);
        });
        return true;
    } catch (error) {
        console.error("Could not load school notices.", error);
        list.replaceChildren();
        const unavailable = document.createElement("div");
        unavailable.className = "notice-unavailable";
        unavailable.textContent = "School notices aren’t available right now.";
        list.append(unavailable);
        return true;
    }
}

async function checkDashboardSession() {
    if (!document.body.hasAttribute("data-protected-page")) return;

    const guard = document.querySelector("#session-guard");
    const message = document.querySelector("#session-message");
    try {
        const response = await fetch("/api/auth/session", {
            credentials: "include",
            headers: { "Accept": "application/json" }
        });

        if (response.status === 401) {
            window.location.replace("login.html");
            return;
        }
        if (response.status === 403) throw new Error("forbidden");
        if (!response.ok) throw new Error("unavailable");

        const payload = await response.json();
        if (!payload.user || typeof payload.user.displayName !== "string" || typeof payload.user.role !== "string") {
            throw new Error("invalid-session");
        }
        if (document.body.hasAttribute("data-admin-page") && payload.user.role !== "admin") {
            throw new Error("forbidden");
        }
        const requiredPermission = document.body.hasAttribute("data-community-page")
            ? "community:read"
            : "student-life:read";
        if (
            !Array.isArray(payload.user.permissions) ||
            !payload.user.permissions.includes("student-life:read") ||
            !payload.user.permissions.includes(requiredPermission)
        ) {
            throw new Error("forbidden");
        }
        if (
            typeof payload.csrfToken !== "string" ||
            (document.body.hasAttribute("data-community-page") && payload.user.emailVerified !== true)
        ) {
            throw new Error("forbidden");
        }

        window.clubCsrfToken = payload.csrfToken;
        window.northstarCsrfToken = payload.csrfToken;
        const name = payload.user.displayName;
        document.querySelectorAll("[data-user-name]").forEach((element) => {
            element.textContent = name;
        });
        document.querySelectorAll("[data-user-first]").forEach((element) => {
            element.textContent = name.trim().split(/\s+/)[0];
        });
        document.querySelectorAll("[data-user-initials]").forEach((element) => {
            element.textContent = name.split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("").toUpperCase();
        });
        document.querySelectorAll("[data-user-role]").forEach((element) => {
            element.textContent = payload.user.role;
        });
        if (payload.user.role === "admin") {
            document.querySelectorAll("[data-admin-link]").forEach((element) => {
                element.hidden = false;
            });
        }
        const noticesReady = await loadNotices();
        if (!noticesReady) return;
        document.body.classList.add("session-ready");
        guard.hidden = true;
        window.dispatchEvent(new CustomEvent("club:session-ready", { detail: payload.user }));
        window.dispatchEvent(new CustomEvent("northstar:session-ready", { detail: payload.user }));
    } catch (error) {
        if (error.message === "forbidden") {
            message.textContent = "Your account doesn’t have permission to open this page. Contact your administrator.";
            document.querySelector("#session-link").textContent = "Return to home";
            document.querySelector("#session-link").href = "index.html";
        } else {
            message.textContent = "We can’t verify your session right now. The student portal is unavailable until the DIS service responds.";
        }
        guard.hidden = false;
    }
}

const signOutButton = document.querySelector("#sign-out");
if (signOutButton) {
    signOutButton.addEventListener("click", async () => {
        signOutButton.disabled = true;
        try {
            const response = await fetch("/api/auth/logout", {
                method: "POST",
                credentials: "include",
                headers: {
                    "Accept": "application/json",
                    "X-CSRF-Token": window.northstarCsrfToken || ""
                }
            });
            if (!response.ok) throw new Error("Sign-out failed");
            window.location.replace("login.html");
        } catch (error) {
            signOutButton.disabled = false;
            showToast("We couldn’t sign you out. Please try again.");
        }
    });
}

checkDashboardSession();
