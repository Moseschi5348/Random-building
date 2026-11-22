const themeRoot = document.documentElement;
const themeButtons = document.querySelectorAll("[data-theme-toggle]");
const siteNavLinks = document.querySelectorAll('.site-nav a[href^="#"]');

function updateCurrentSiteNavLink() {
    siteNavLinks.forEach((link) => {
        if (link.getAttribute("href") === window.location.hash) {
            link.setAttribute("aria-current", "location");
        } else {
            link.removeAttribute("aria-current");
        }
    });
}

if (siteNavLinks.length > 0) {
    window.addEventListener("hashchange", updateCurrentSiteNavLink);
    updateCurrentSiteNavLink();
}

let activeTheme = "light";
try {
    const savedTheme = localStorage.getItem("club-theme") || localStorage.getItem("northstar-theme");
    if (savedTheme === "light" || savedTheme === "dark") activeTheme = savedTheme;
} catch (error) {
    console.warn("Theme preference could not be loaded.", error);
}

function applyTheme(theme) {
    activeTheme = theme;
    themeRoot.dataset.theme = theme;
    const isDark = theme === "dark";
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = isDark ? "#26352c" : "#f7f6eb";

    themeButtons.forEach((button) => {
        button.setAttribute("aria-pressed", String(isDark));
        button.setAttribute("aria-label", `Switch to ${isDark ? "bright" : "dark"} theme`);
        button.querySelector(".theme-icon").textContent = isDark ? "☀" : "☾";
        button.querySelector(".theme-label").textContent = isDark ? "Bright" : "Dark";
    });
}

themeButtons.forEach((button) => {
    button.addEventListener("click", () => {
        const nextTheme = activeTheme === "dark" ? "light" : "dark";
        applyTheme(nextTheme);
        try {
            localStorage.setItem("northstar-theme", nextTheme);
        } catch (error) {
            console.warn("Theme preference could not be saved.", error);
        }
    });
});

applyTheme(activeTheme);
