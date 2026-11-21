const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const loginStatus = document.querySelector("#login-status");
const loginButton = document.querySelector("#login-submit");
const loginEndpoint = "/api/auth/login";
const registerForm = document.querySelector("#register-form");
const registerError = document.querySelector("#register-error");
const registerStatus = document.querySelector("#register-status");
const registerButton = document.querySelector("#register-submit");

function setLoginMessage(message, isError) {
    loginError.hidden = !isError;
    loginError.textContent = isError ? message : "";
    loginStatus.textContent = isError ? "" : message;
}

async function loadNotices() {
    const list = document.querySelector("#notice-list");
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

if (loginForm) {
    const passwordInput = document.querySelector("#password");
    const passwordToggle = document.querySelector("#password-toggle");

    passwordToggle.addEventListener("click", () => {
        const showing = passwordInput.type === "text";
        passwordInput.type = showing ? "password" : "text";
        passwordToggle.textContent = showing ? "Show" : "Hide";
        passwordToggle.setAttribute("aria-label", showing ? "Show password" : "Hide password");
        passwordToggle.setAttribute("aria-pressed", String(!showing));
    });

    loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        setLoginMessage("", false);

        if (!loginForm.reportValidity()) return;

        loginButton.disabled = true;
        loginButton.classList.add("is-loading");
        loginButton.querySelector(".submit-label").textContent = "Signing in";

        try {
            const response = await fetch(loginEndpoint, {
                method: "POST",
                credentials: "include",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    email: loginForm.elements.email.value.trim(),
                    password: loginForm.elements.password.value
                })
            });

            if (response.status === 401) {
                setLoginMessage("We couldn’t sign you in with those details. Check them and try again.", true);
                return;
            }
            if (response.status === 429) {
                setLoginMessage("Too many sign-in attempts. Please wait a moment and try again.", true);
                return;
            }
            if (!response.ok) {
                setLoginMessage("Sign-in is temporarily unavailable. Please try again later.", true);
                return;
            }

            window.location.replace("home.html");
        } catch (error) {
            setLoginMessage("We can’t reach the school sign-in service right now. Please try again later.", true);
        } finally {
            loginButton.disabled = false;
            loginButton.classList.remove("is-loading");
            loginButton.querySelector(".submit-label").textContent = "Sign in";
        }
    });
}

if (registerForm) {
    const passwordInput = registerForm.elements.password;
    const confirmPasswordInput = registerForm.elements.confirmPassword;
    const successMessage = document.querySelector("#registration-success");

    registerForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        registerError.hidden = true;
        registerError.textContent = "";
        registerStatus.textContent = "";

        if (!registerForm.reportValidity()) return;
        if (passwordInput.value !== confirmPasswordInput.value) {
            registerError.textContent = "The passwords don’t match. Please check them and try again.";
            registerError.hidden = false;
            confirmPasswordInput.focus();
            return;
        }

        registerButton.disabled = true;
        registerButton.classList.add("is-loading");
        registerButton.querySelector(".submit-label").textContent = "Creating account";

        try {
            const response = await fetch("/api/auth/register", {
                method: "POST",
                credentials: "include",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    name: registerForm.elements.name.value.trim(),
                    email: registerForm.elements.email.value.trim(),
                    password: passwordInput.value
                })
            });

            if (response.status === 409) {
                registerError.textContent = "An account with that email already exists. Sign in instead.";
                registerError.hidden = false;
                return;
            }
            if (response.status === 400) {
                registerError.textContent = "Check your name and email, and use a password between 12 and 128 characters.";
                registerError.hidden = false;
                return;
            }
            if (response.status === 429) {
                registerError.textContent = "Too many account requests. Please wait a moment and try again.";
                registerError.hidden = false;
                return;
            }
            if (!response.ok) {
                registerError.textContent = "Account creation is temporarily unavailable. Please try again later.";
                registerError.hidden = false;
                return;
            }

            registerForm.hidden = true;
            successMessage.hidden = false;
        } catch (error) {
            console.error("Could not create the student account.", error);
            registerError.textContent = "We can’t reach the school account service right now. Please try again later.";
            registerError.hidden = false;
        } finally {
            registerButton.disabled = false;
            registerButton.classList.remove("is-loading");
            registerButton.querySelector(".submit-label").textContent = "Create account";
        }
    });
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
        if (response.status === 403) {
            throw new Error("forbidden");
        }
        if (!response.ok) {
            throw new Error("unavailable");
        }

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
        if (document.body.hasAttribute("data-community-page") && payload.user.schoolEmailVerified !== true) {
            throw new Error("unverified-school-email");
        }

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
        const noticesReady = document.querySelector("#notice-list") ? await loadNotices() : true;
        if (!noticesReady) return;
        document.body.classList.add("session-ready");
        guard.hidden = true;
    } catch (error) {
        if (error.message === "forbidden") {
            message.textContent = "Your school account doesn’t have permission to open this page. Contact your school administrator.";
            document.querySelector("#session-link").textContent = "Return to Northstar";
            document.querySelector("#session-link").href = "index.html";
        } else if (error.message === "unverified-school-email") {
            message.textContent = "Connect is available only to students with a verified NUTM school email. Contact your school administrator if you think this is a mistake.";
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
                headers: { "Accept": "application/json" }
            });
            if (!response.ok) {
                throw new Error("Sign-out failed");
            }
            window.location.replace("login.html");
        } catch (error) {
            signOutButton.disabled = false;
            showToast("We couldn’t sign you out. Please try again.");
        }
    });
}

checkDashboardSession();
