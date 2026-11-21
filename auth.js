const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const loginStatus = document.querySelector("#login-status");
const loginButton = document.querySelector("#login-submit");
const registerForm = document.querySelector("#register-form");
const registerError = document.querySelector("#register-error");
const registerStatus = document.querySelector("#register-status");
const registerButton = document.querySelector("#register-submit");
let pendingVerificationEmail = "";

function showFormError(target, message) {
    target.hidden = !message;
    target.textContent = message;
}

async function postJson(path, body) {
    const response = await fetch(path, {
        method: "POST",
        credentials: "include",
        headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            ...(window.northstarCsrfToken
                ? { "X-CSRF-Token": window.northstarCsrfToken }
                : {})
        },
        body: JSON.stringify(body)
    });
    const result = response.status === 204 ? null : await response.json();
    if (!response.ok) {
        throw new Error(result?.error || `Request failed (${response.status}).`);
    }
    return result;
}

if (loginError && new URLSearchParams(window.location.search).has("error")) {
    showFormError(loginError, "We couldn’t complete that request. Please try again or contact your school administrator.");
}

if (loginForm) {
    loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        showFormError(loginError, "");
        loginStatus.textContent = "";
        if (!loginForm.reportValidity()) return;

        loginButton.disabled = true;
        try {
            await postJson("/api/auth/login", {
                email: loginForm.elements.email.value.trim(),
                password: loginForm.elements.password.value
            });
            window.location.replace("home.html");
        } catch (error) {
            showFormError(loginError, error.message || "We couldn’t sign you in. Check your email and password.");
        } finally {
            loginButton.disabled = false;
        }
    });
}

if (registerForm) {
    const passwordInput = registerForm.elements.password;
    const confirmPasswordInput = registerForm.elements.confirmPassword;
    const verificationPanel = document.querySelector("#verification-panel");
    const verificationEmail = document.querySelector("#verification-email");
    const verifyForm = document.querySelector("#verify-email-form");
    const verifyError = document.querySelector("#verify-error");
    const verifyStatus = document.querySelector("#verify-status");
    const verifyButton = document.querySelector("#verify-submit");
    const resendButton = document.querySelector("#resend-code");

    registerForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        showFormError(registerError, "");
        registerStatus.textContent = "";

        if (!registerForm.reportValidity()) return;
        const email = registerForm.elements.email.value.trim().toLowerCase();
        if (!email.endsWith("@nutm.edu.ng")) {
            showFormError(registerError, "Use your school email address ending in @nutm.edu.ng.");
            return;
        }
        if (passwordInput.value !== confirmPasswordInput.value) {
            showFormError(registerError, "The passwords don’t match. Please check them and try again.");
            confirmPasswordInput.focus();
            return;
        }

        registerButton.disabled = true;
        try {
            const result = await postJson("/api/auth/register", {
                name: registerForm.elements.name.value.trim(),
                email,
                password: passwordInput.value
            });
            pendingVerificationEmail = email;
            verificationEmail.textContent = email;
            registerForm.hidden = true;
            verificationPanel.hidden = false;
            verifyStatus.textContent = result.message || "Enter the six-digit code sent to your school email.";
            verifyForm.elements.code.focus();
        } catch (error) {
            showFormError(registerError, error.message || "We couldn’t start account verification. Please try again.");
        } finally {
            registerButton.disabled = false;
        }
    });

    verifyForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        showFormError(verifyError, "");
        if (!verifyForm.reportValidity()) return;

        verifyButton.disabled = true;
        try {
            await postJson("/api/auth/verify-email", {
                email: pendingVerificationEmail,
                code: verifyForm.elements.code.value.trim()
            });
            window.location.replace("home.html");
        } catch (error) {
            showFormError(verifyError, error.message || "That code could not be verified. Request a new code and try again.");
        } finally {
            verifyButton.disabled = false;
        }
    });

    resendButton.addEventListener("click", async () => {
        resendButton.disabled = true;
        showFormError(verifyError, "");
        try {
            const result = await postJson("/api/auth/resend-verification", {
                email: pendingVerificationEmail
            });
            verifyStatus.textContent = result.message || "If the account is eligible, a new code has been sent.";
        } catch (error) {
            showFormError(verifyError, error.message || "We couldn’t send another code yet.");
        } finally {
            resendButton.disabled = false;
        }
    });
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
            (document.body.hasAttribute("data-community-page") && payload.user.schoolEmailVerified !== true)
        ) {
            throw new Error("forbidden");
        }

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
        const noticesReady = await loadNotices();
        if (!noticesReady) return;
        document.body.classList.add("session-ready");
        guard.hidden = true;
        window.dispatchEvent(new CustomEvent("northstar:session-ready", { detail: payload.user }));
    } catch (error) {
        if (error.message === "forbidden") {
            message.textContent = "Your school account doesn’t have permission to open this page. Contact your school administrator.";
            document.querySelector("#session-link").textContent = "Return to Northstar";
            document.querySelector("#session-link").href = "index.html";
        } else {
            message.textContent = "We can’t verify your school session right now. The student portal is unavailable until the school service responds.";
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
