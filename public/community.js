const communityState = {
    peers: [],
    interest: "all",
    search: "",
    game: "CHESS",
    profile: { visible: false, interests: [] }
};

const interestLabels = { games: "Games", study: "Study", creative: "Creative" };
const gameLabels = { CHESS: "Chess", QUIZ: "Quick quiz", WORDS: "Word challenge" };
let peerSearchTimer;

async function communityApi(path, options = {}) {
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
    if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}).`);
    return data;
}

function setCommunityFeedback(message) {
    document.querySelector("#community-feedback").textContent = message;
}

function interestFilter() {
    return communityState.interest === "all" ? "" : communityState.interest;
}

function addButton(container, label, action, className, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.className = className;
    button.disabled = disabled;
    button.addEventListener("click", action);
    container.append(button);
    return button;
}

function createPeerCard(peer) {
    const card = document.createElement("article");
    card.className = "peer-card";
    card.dataset.peer = "";
    card.dataset.interest = peer.interests.join(" ");

    const heading = document.createElement("div");
    heading.className = "peer-card-heading";
    const avatar = document.createElement("span");
    avatar.className = "peer-avatar peer-avatar-green";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = peer.name.trim().split(/\s+/).slice(0, 2)
        .map((part) => part.charAt(0)).join("").toUpperCase();
    const identity = document.createElement("div");
    const name = document.createElement("h3");
    name.textContent = peer.name;
    const status = document.createElement("span");
    status.className = "peer-status";
    status.textContent = peer.communityVisible ? "Open to connect" : "Connection request";
    identity.append(name, status);
    heading.append(avatar, identity);

    const description = document.createElement("p");
    description.className = "peer-description";
    description.textContent = peer.interests.length
        ? `Interested in ${peer.interests.map((interest) => interestLabels[interest] || interest).join(", ")}.`
        : "This student is open to connecting.";

    const tags = document.createElement("div");
    tags.className = "interest-tags";
    peer.interests.forEach((interest) => {
        const tag = document.createElement("span");
        tag.textContent = interestLabels[interest] || interest;
        tags.append(tag);
    });

    const actions = document.createElement("div");
    actions.className = "peer-actions";
    renderConnectionActions(peer, actions);
    renderGameActions(peer, actions);
    card.append(heading, description, tags, actions);
    return card;
}

function renderConnectionActions(peer, actions) {
    const connection = peer.connection;
    if (!connection) {
        addButton(
            actions,
            peer.communityVisible ? "Connect" : "Profile hidden",
            () => void runPeerAction(async () => {
                await communityApi(`/community/connections/${encodeURIComponent(peer.id)}`, { method: "POST" });
                await loadPeers();
                setCommunityFeedback(`Connection request sent to ${peer.name}.`);
            }),
            "connection-button",
            !peer.communityVisible
        );
        return;
    }

    if (connection.status === "ACCEPTED") {
        addButton(actions, "Connected", () => {}, "connection-button", true);
    } else if (connection.status === "PENDING" && connection.requesterId === peer.id) {
        addButton(actions, "Accept request", () => void runPeerAction(async () => {
            await communityApi(`/community/connections/${encodeURIComponent(connection.id)}`, {
                method: "PATCH",
                body: { status: "ACCEPTED" }
            });
            await loadPeers();
            setCommunityFeedback(`You are now connected with ${peer.name}.`);
        }), "connection-button");
        addButton(actions, "Decline", () => void runPeerAction(async () => {
            await communityApi(`/community/connections/${encodeURIComponent(connection.id)}`, {
                method: "PATCH",
                body: { status: "DECLINED" }
            });
            await loadPeers();
            setCommunityFeedback("Connection request declined.");
        }), "secondary-action");
    } else {
        addButton(
            actions,
            connection.status === "PENDING"
                ? "Request sent"
                : (peer.communityVisible ? "Connect" : "Profile hidden"),
            connection.status === "PENDING" ? () => {} : () => void runPeerAction(async () => {
                await communityApi(`/community/connections/${encodeURIComponent(peer.id)}`, { method: "POST" });
                await loadPeers();
                setCommunityFeedback(`Connection request sent to ${peer.name}.`);
            }),
            "connection-button",
            connection.status === "PENDING" || !peer.communityVisible
        );
    }
}

function renderGameActions(peer, actions) {
    const invite = peer.gameInvite;
    if (invite?.status === "PENDING" && invite.senderId === peer.id) {
        const gameName = gameLabels[invite.game] || invite.game;
        addButton(actions, `Accept ${gameName}`, () => void runPeerAction(async () => {
            await communityApi(`/community/game-invites/${encodeURIComponent(invite.id)}`, {
                method: "PATCH",
                body: { status: "ACCEPTED" }
            });
            await loadPeers();
            setCommunityFeedback(`You accepted ${peer.name}'s ${gameName} invitation.`);
        }), "game-invite-button");
        addButton(actions, "Decline", () => void runPeerAction(async () => {
            await communityApi(`/community/game-invites/${encodeURIComponent(invite.id)}`, {
                method: "PATCH",
                body: { status: "DECLINED" }
            });
            await loadPeers();
            setCommunityFeedback("Game invitation declined.");
        }), "secondary-action");
        return;
    }
    if (invite?.status === "PENDING") {
        addButton(
            actions,
            `Invite sent · ${gameLabels[invite.game] || invite.game}`,
            () => {},
            "game-invite-button",
            true
        );
        return;
    }
    if (!peer.communityVisible) {
        addButton(actions, "Profile hidden", () => {}, "game-invite-button", true);
        return;
    }
    if (peer.connection?.status !== "ACCEPTED") {
        addButton(actions, "Connect first to invite", () => {}, "game-invite-button", true);
        return;
    }
    addButton(actions, `Invite to ${gameLabels[communityState.game]}`, () => void runPeerAction(async () => {
        await communityApi("/community/game-invites", {
            method: "POST",
            body: { recipientId: peer.id, game: communityState.game }
        });
        await loadPeers();
        setCommunityFeedback(`${gameLabels[communityState.game]} invitation sent to ${peer.name}.`);
    }), "game-invite-button");
}

async function runPeerAction(action) {
    try {
        await action();
    } catch (error) {
        setCommunityFeedback(error.message || "That action could not be completed.");
    }
}

function renderPeers() {
    const grid = document.querySelector("#peer-grid");
    const empty = document.querySelector("#empty-peers");
    grid.replaceChildren();
    communityState.peers.forEach((peer) => grid.append(createPeerCard(peer)));
    empty.hidden = communityState.peers.length > 0;
    if (communityState.peers.length === 0) {
        empty.textContent = communityState.profile.visible
            ? "No students match that search or interest. Try a different filter."
            : "No opted-in profiles yet. You can still save your interests and check back later.";
    }
}

async function loadPeers() {
    const params = new URLSearchParams();
    if (communityState.search) params.set("search", communityState.search);
    if (interestFilter()) params.set("interest", interestFilter());
    communityState.peers = await communityApi(`/community/peers?${params}`);
    renderPeers();
}

function setProfileForm(profile) {
    communityState.profile = profile;
    document.querySelector("#community-visible").checked = profile.visible;
    document.querySelectorAll('input[name="community-interest"]').forEach((input) => {
        input.checked = profile.interests.includes(input.value);
        input.disabled = !profile.visible;
    });
}

async function loadProfile() {
    setProfileForm(await communityApi("/community/profile"));
    renderPeers();
}

async function saveProfile(event) {
    event.preventDefault();
    const button = document.querySelector("#community-profile-save");
    const status = document.querySelector("#community-profile-status");
    const visible = document.querySelector("#community-visible").checked;
    const interests = [...document.querySelectorAll('input[name="community-interest"]:checked')]
        .map((input) => input.value);
    button.disabled = true;
    status.textContent = "Saving…";
    try {
        const profile = await communityApi("/community/profile", {
            method: "PATCH",
            body: { visible, interests }
        });
        setProfileForm(profile);
        status.textContent = profile.visible
            ? "Your profile is visible to other opted-in students."
            : "Your profile is hidden from the student directory.";
        await loadPeers();
    } catch (error) {
        status.textContent = error.message || "Your privacy settings could not be saved.";
    } finally {
        button.disabled = false;
    }
}

async function loadMeetups() {
    const meetups = await communityApi("/community/meetups");
    meetups.forEach((meetup) => {
        const button = document.querySelector(`[data-meetup="${meetup.key}"]`);
        if (!button) return;
        button.classList.toggle("is-selected", meetup.interested);
        button.setAttribute("aria-pressed", String(meetup.interested));
        button.replaceChildren(
            document.createTextNode(meetup.interested ? "Interested ✓ " : "I’m interested "),
            Object.assign(document.createElement("small"), {
                textContent: `${meetup.interestedCount} interested`
            })
        );
    });
}

async function toggleMeetup(button) {
    button.disabled = true;
    try {
        const meetup = await communityApi(
            `/community/meetups/${encodeURIComponent(button.dataset.meetup)}/interest`,
            {
                method: "PATCH",
                body: { interested: button.getAttribute("aria-pressed") !== "true" }
            }
        );
        button.classList.toggle("is-selected", meetup.interested);
        button.setAttribute("aria-pressed", String(meetup.interested));
        button.replaceChildren(
            document.createTextNode(meetup.interested ? "Interested ✓ " : "I’m interested "),
            Object.assign(document.createElement("small"), {
                textContent: `${meetup.interestedCount} interested`
            })
        );
        setCommunityFeedback(meetup.interested ? "Your meetup interest was saved." : "Your meetup interest was removed.");
    } catch (error) {
        setCommunityFeedback(error.message || "Your meetup interest could not be updated.");
    } finally {
        button.disabled = false;
    }
}

document.querySelector("#community-profile-form").addEventListener("submit", (event) => {
    void saveProfile(event);
});

document.querySelector("#community-visible").addEventListener("change", (event) => {
    document.querySelectorAll('input[name="community-interest"]').forEach((input) => {
        input.disabled = !event.target.checked;
    });
});

document.querySelectorAll(".community-filters [data-interest]").forEach((button) => {
    button.addEventListener("click", () => {
        document.querySelector(".community-filters .filter-tab.active")?.classList.remove("active");
        button.classList.add("active");
        communityState.interest = button.dataset.interest;
        loadPeers().catch((error) => setCommunityFeedback(error.message));
    });
});

document.querySelector("#peer-search").addEventListener("input", (event) => {
    communityState.search = event.target.value.trim();
    window.clearTimeout(peerSearchTimer);
    peerSearchTimer = window.setTimeout(() => {
        loadPeers().catch((error) => setCommunityFeedback(error.message));
    }, 200);
});

document.querySelectorAll("[data-game]").forEach((button) => {
    button.addEventListener("click", () => {
        communityState.game = button.dataset.game;
        document.querySelectorAll("[data-game]").forEach((choice) => {
            const selected = choice === button;
            choice.classList.toggle("is-selected", selected);
            choice.textContent = selected ? "Selected" : "Choose game";
        });
        renderPeers();
        setCommunityFeedback(`Choose a connected student to invite to ${gameLabels[communityState.game]}.`);
        document.querySelector("#student-directory-title").scrollIntoView({ behavior: "smooth", block: "start" });
    });
});

document.querySelectorAll("[data-meetup]").forEach((button) => {
    button.addEventListener("click", () => void toggleMeetup(button));
});

window.addEventListener("northstar:session-ready", () => {
    Promise.all([loadProfile(), loadPeers(), loadMeetups()])
        .catch((error) => setCommunityFeedback(error.message || "Community data could not be loaded."));
}, { once: true });
