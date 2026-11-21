const peerSearch = document.querySelector("#peer-search");
const peerCards = [...document.querySelectorAll("[data-peer]")];
const emptyPeers = document.querySelector("#empty-peers");
let activeInterest = "all";

function updatePeerVisibility() {
    const query = peerSearch.value.trim().toLowerCase();
    let visibleCount = 0;

    peerCards.forEach((card) => {
        const interests = card.dataset.interest.split(" ");
        const matchesInterest = activeInterest === "all" || interests.includes(activeInterest);
        const matchesSearch = card.dataset.search.includes(query);
        const visible = matchesInterest && matchesSearch;
        card.hidden = !visible;
        if (visible) visibleCount += 1;
    });

    emptyPeers.hidden = visibleCount > 0;
}

document.querySelectorAll("[data-interest]").forEach((button) => {
    button.addEventListener("click", () => {
        document.querySelector(".community-filters .filter-tab.active")?.classList.remove("active");
        button.classList.add("active");
        activeInterest = button.dataset.interest;
        updatePeerVisibility();
    });
});

peerSearch.addEventListener("input", updatePeerVisibility);

document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
        const drafted = button.getAttribute("aria-pressed") === "true";
        const isConnect = button.dataset.action === "connect";
        button.setAttribute("aria-pressed", String(!drafted));
        button.textContent = drafted
            ? (isConnect ? "Connect" : "Invite to a game")
            : (isConnect ? "Request drafted" : "Invite drafted");
        button.classList.toggle("is-selected", !drafted);
        showToast("Preview only: this action won’t reach another student until the school service is connected.");
    });
});

document.querySelectorAll("[data-game], [data-meetup]").forEach((button) => {
    button.addEventListener("click", () => {
        const interested = button.getAttribute("aria-pressed") === "true";
        button.setAttribute("aria-pressed", String(!interested));
        button.classList.toggle("is-selected", !interested);
        button.textContent = interested
            ? (button.hasAttribute("data-game") ? "Find a player" : "I’m interested")
            : (button.hasAttribute("data-game") ? "Search drafted" : "Interest noted");
        showToast("Preview only: interest is not sent or saved yet.");
    });
});

updatePeerVisibility();
